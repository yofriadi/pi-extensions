import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "./agent-definition.ts";
import { getAgentConfigDir } from "./agent-definition.ts";
import {
	ABORT_MESSAGE,
	abortableDelay,
	type CompletionResult,
	isPermanentErrorCompletion,
	isRetryableCompletion,
	waitForCompletion,
} from "./completion.ts";
import type { AdmissionLease } from "./coordinator.ts";
import { getAdmissionCoordinator } from "./coordinator.ts";
import {
	deliverBackgroundMessage,
	isSessionRuntimeUnavailable,
	queuePendingDeliveryWithVerification,
	startDeliveryRetry,
} from "./delivery.ts";
import { getForegroundDeliveryBarrier } from "./delivery-barrier.ts";
import { inspectHerdrPane } from "./herdr.ts";
import {
	beginLaunchTransaction,
	finishLaunchTransaction,
	type LaunchStep,
	type LaunchTransaction,
} from "./launch-transaction.ts";
import { attachPaneSerialized, removePaneFromRegion, tryRederiveRegionFromLayout } from "./layout.ts";
import type { PaneInspection } from "./lifecycle.ts";
import {
	clearRetry,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markFailed,
	markRetrying,
	observePaneInspection,
	projectLifecycle,
} from "./lifecycle.ts";
import type { ResolvedRuntimePlan } from "./runtime-routing.ts";
import {
	findLastAssistantMessage,
	findObservedSessionRuntime,
	getNewEntries,
	seedSubagentSessionFile,
} from "./session.ts";
import { getSessionLeaseRegistry } from "./session-leases.ts";
import { getSettlementRegistry, type SettlementSource } from "./settlement.ts";
import type { SelectedSkill } from "./skills.ts";
import { runningSubagents, stickyTerminalRuns } from "./state.ts";
import { inspectHerdrPaneSync, inspectPane, readPaneAsync, safeCloseSubagentPane, shellQuote } from "./terminal.ts";
import type {
	RunningSubagent,
	StableParentContext,
	StickyTerminalKind,
	StickyTerminalRun,
	SubagentResult,
} from "./types.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const ERROR_PANE_MONITOR_INTERVAL_MS = 2000;

/** Total attempts per run: initial + 2 automatic retries. */
export const MAX_RUN_ATTEMPTS = 3;
/** Stepped backoff before attempts 2 and 3. */
export const RETRY_BACKOFF_MS = [5_000, 15_000] as const;
/** Bound on waiting for the failed attempt's pane to be confirmed gone. */
export const PANE_ABSENCE_TIMEOUT_MS = 30_000;
/** Poll interval inside the pane-absence wait and relaunch wait. */
const RELAUNCH_POLL_MS = 250;

/** A never-aborted signal for local cleanup scopes. */
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

type LaunchDeps = {
	resolveBlocking: (params: any) => boolean;
	resolveLayout: (params: any) => any;
	resolveSurface: (params: any) => any;
	resolveDirection: (params: any) => any;
	resolveLaunchBehavior: (definition: AgentDefinition) => {
		inheritsConversationContext: boolean;
		taskDelivery: "direct" | "artifact";
	};
	lifecycleDenySet: () => Set<string>;
	buildSystemPromptFileContent: (input: any) => { content: string; flag: string } | undefined;
	buildSubagentToolAllowlist: (tools?: string) => string;
	safeCommentValue: (value: string) => string;
	createRunId: () => string;
	getShellReadyDelayMs: () => number;
	getSubagentArtifactDir: (sessionFile: string) => string;
	runScriptInPane: (
		paneId: string,
		command: string,
		options?: { scriptPath?: string; scriptPreamble?: string },
	) => string;
	createLifecycle: (startTime: number) => any;
	ensureLifecycle: (running: RunningSubagent) => any;
	observeRunningSubagent: (running: RunningSubagent, observedAt?: number) => void;
	updateWidget: () => void;
	startWidgetRefresh: () => void;
	startStatusRefresh: () => void;
	resolveResultPresentation: (result: SubagentResult, name: string, runId?: string, agentId?: string) => string;
	shouldDeliverSubagentCompletion: (running: RunningSubagent) => boolean;
};

type LaunchOptions = {
	agentDefinition: AgentDefinition;
	selectedSkills: SelectedSkill[];
	runtimePlan: ResolvedRuntimePlan;
	runId?: string;
	admissionClass?: "foreground" | "background";
	admissionLease?: AdmissionLease;
	projectTrusted?: boolean;
	surface?: string;
	/** Caller-supplied resume target; skips session seeding and rollbacks. */
	resumeSessionFile?: string;
};

type LaunchState = {
	params: any;
	ctx: StableParentContext;
	options: LaunchOptions;
	id: string;
	startTime: number;
	sessionFile: string;
	sessionId: string;
	effectiveCwd: string;
	subagentSessionFile: string;
	surfacePreCreated: boolean;
	launchTransaction: ReturnType<typeof beginLaunchTransaction>;
	surface?: string;
	layoutWarning?: string;
	sessionLease?: any;
	/** Per-attempt id; regenerated on every retry relaunch. */
	attemptId: string;
};

type PreparedLaunch = {
	activityFile: string;
	entryCountBefore: number;
	fullTask: string;
};

type LaunchCommand = {
	command: string;
	launchScriptFile: string;
};

export function createSubagentLaunchService(deps: LaunchDeps) {
	function releaseRunOwnership(running: RunningSubagent): void {
		running.sessionLease?.release();
		running.admissionLease?.release();
	}

	function releaseAdmissionOnly(running: RunningSubagent): void {
		running.admissionLease?.release();
	}

	function safeCloseAndReap(running: RunningSubagent): void {
		const parentPaneId = process.env.HERDR_PANE_ID;
		try {
			safeCloseSubagentPane(running.surface);
		} catch {}
		if (!parentPaneId) return;
		try {
			removePaneFromRegion(parentPaneId, running.surface);
		} catch {}
	}

	function startErrorPaneMonitor(running: RunningSubagent): void {
		const parentPaneId = process.env.HERDR_PANE_ID;
		if (running.errorPaneMonitorStarted) return;
		running.errorPaneMonitorStarted = true;
		const surface = running.surface;
		let probeInFlight = false;
		const timer = setInterval(() => {
			if (probeInFlight) return;
			probeInFlight = true;
			void inspectHerdrPane(surface)
				.then((inspection) => inspection.kind === "missing")
				.catch(() => false)
				.then((gone) => {
					probeInFlight = false;
					if (!gone) return;
					clearInterval(timer);
					if (parentPaneId) {
						try {
							removePaneFromRegion(parentPaneId, surface);
						} catch {}
					}
					releaseRunOwnership(running);
				});
		}, ERROR_PANE_MONITOR_INTERVAL_MS);
		(timer as unknown as { unref?: () => void }).unref?.();
	}

	function preserveErrorPane(running: RunningSubagent): boolean {
		try {
			if (inspectHerdrPaneSync(running.surface).kind === "missing") return false;
		} catch {
			// An unavailable probe is never evidence that a pane vanished.
		}
		startErrorPaneMonitor(running);
		return true;
	}

	function fallbackSummary(result: Pick<CompletionResult, "reason" | "exitCode" | "errorMessage">): string {
		if (result.reason === "timeout") return "Sub-agent had produced no output when watching stopped.";
		if (result.errorMessage) return `Subagent error: ${result.errorMessage}`;
		if (result.exitCode !== 0) return `Sub-agent exited with code ${result.exitCode}`;
		return "Sub-agent exited without output";
	}

	function resolveSettlementDisposition(
		result: CompletionResult,
		runningId?: string,
	): {
		watchAbandoned: boolean;
		preservePane: boolean;
		preserveArtifacts: boolean;
		releaseAdmissionNow: boolean;
	} {
		const preserveArtifacts = !completionDeletesArtifacts(result, runningId);
		if (result.reason === "timeout") {
			return { watchAbandoned: true, preservePane: true, preserveArtifacts, releaseAdmissionNow: true };
		}
		if (result.reason === "error") {
			// A settled error run reaps its pane exactly like a success — same site, same
			// order — so the failed session file becomes immediately resumable through
			// the ownership-gated `session` parameter. The carve-outs that still
			// preserve (sticky launch failures, relaunch-mechanics failures, watch
			// abandonment) settle through their own paths and never reach this branch.
			return { watchAbandoned: false, preservePane: false, preserveArtifacts, releaseAdmissionNow: false };
		}
		return { watchAbandoned: false, preservePane: false, preserveArtifacts, releaseAdmissionNow: false };
	}

	function completionDeletesArtifacts(result: CompletionResult, attemptId: string | undefined): boolean {
		if (result.exitCode !== 0) return false;
		if (result.reason === "sentinel") return true;
		return (
			result.reason === "done" &&
			typeof attemptId === "string" &&
			typeof result.runId === "string" &&
			result.runId === attemptId
		);
	}

	function applySettlementDisposition(running: RunningSubagent, result: CompletionResult) {
		// The ownership comparand is the run's CURRENT attempt id — a stale
		// comparand would fail-closed deletion on every retried run.
		const disposition = resolveSettlementDisposition(result, running.attemptId ?? running.id);
		running.watchAbandoned = disposition.watchAbandoned;
		if (!disposition.preserveArtifacts) {
			rmSync(deps.getSubagentArtifactDir(running.sessionFile), { recursive: true, force: true });
		}
		running.errorPanePreserved = disposition.preservePane && preserveErrorPane(running);
		if (!running.errorPanePreserved) safeCloseAndReap(running);
		// Fail-closed reap verification (error sidecars only — the settled outcome
		// whose delivery advertises the session as immediately resumable):
		// safeCloseSubagentPane swallows close failures, so a reaped pane is not
		// guaranteed gone. When the close left the pane present, escalate to the
		// preserve semantics — pane monitor, admission released now, session lease
		// retained until confirmed disappearance — instead of releasing ownership
		// against a pane that may still hold a live writer. The happy path pays
		// one extra sync probe; a pane reporting missing (the normal case)
		// settles exactly as before, and successes/sentinels keep today's
		// unconditional-release behavior.
		if (result.reason === "error" && !running.errorPanePreserved && paneStillPresentAfterReap(running)) {
			// Escalate WITHOUT re-probing: presence was just confirmed by the
			// post-reap probe, so preserve unconditionally and start the monitor.
			// (Re-probing here would race the close and could revert a confirmed
			// survival back to the reaped posture.)
			running.errorPanePreserved = true;
			startErrorPaneMonitor(running);
			releaseAdmissionOnly(running);
		}
		if (disposition.releaseAdmissionNow) releaseAdmissionOnly(running);
		return disposition;
	}

	/** Post-reap probe: did the pane actually close? An unavailable probe is
	 * never evidence a pane survived (fail-open direction) — only an explicit
	 * `present` reading escalates to preserve semantics. */
	function paneStillPresentAfterReap(running: RunningSubagent): boolean {
		const probe = running.verifyPaneClosedOverride ?? inspectHerdrPaneSync;
		try {
			return probe(running.surface).kind === "present";
		} catch {
			return false;
		}
	}

	function classifyStickyTerminal(
		running: RunningSubagent,
		result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "watchAbandoned" | "alreadySettled">,
	): StickyTerminalKind | undefined {
		if (stickyTerminalExcluded(running, result)) return undefined;
		return stickyTerminalKind(running, result);
	}

	function stickyTerminalExcluded(
		running: RunningSubagent,
		result: Pick<SubagentResult, "error" | "alreadySettled">,
	): boolean {
		return result.alreadySettled || result.error === "cancelled" || running.lifecycle.delivery === "suppressed";
	}

	function stickyTerminalKind(
		running: RunningSubagent,
		result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "watchAbandoned">,
	): StickyTerminalKind | undefined {
		if (result.watchAbandoned) return "watch-abandoned";
		if (running.lifecycle.turn.kind === "interrupted") return "stopped";
		return terminalFailure(result) ? "failed" : undefined;
	}

	function terminalFailure(result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage">): boolean {
		return result.exitCode !== 0 || Boolean(result.error) || Boolean(result.errorMessage);
	}

	function captureStickyTerminalRun(
		running: RunningSubagent,
		result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "watchAbandoned" | "alreadySettled">,
		capturedAt = Date.now(),
	): boolean {
		const kind = classifyStickyTerminal(running, result);
		if (!kind) return false;
		captureTerminalActivity(running, capturedAt);
		stickyTerminalRuns.set(running.id, stickyTerminalEntry(running, kind, capturedAt));
		return true;
	}

	function captureTerminalActivity(running: RunningSubagent, capturedAt: number): void {
		if (running.activityFile) deps.observeRunningSubagent(running, capturedAt);
	}

	function stickyTerminalEntry(
		running: RunningSubagent,
		kind: StickyTerminalKind,
		capturedAt: number,
	): StickyTerminalRun {
		const entry = baseStickyTerminalEntry(running, kind, capturedAt);
		addStickyTerminalMetadata(entry, running);
		return entry;
	}

	function baseStickyTerminalEntry(
		running: RunningSubagent,
		kind: StickyTerminalKind,
		capturedAt: number,
	): StickyTerminalRun {
		const projection = projectLifecycle(deps.ensureLifecycle(running), capturedAt);
		return {
			id: running.id,
			name: running.name,
			startTime: running.startTime,
			runtimeEndedAt: projection.runtimeEndedAt ?? capturedAt,
			sessionFile: running.sessionFile,
			kind,
			capturedAt,
		};
	}

	function addStickyTerminalMetadata(entry: StickyTerminalRun, running: RunningSubagent): void {
		addStickyAgentMetadata(entry, running);
		addStickyActivityMetadata(entry, running);
	}

	function addStickyAgentMetadata(entry: StickyTerminalRun, running: RunningSubagent): void {
		if (running.agent) entry.agent = running.agent;
		if (running.admissionClass) entry.admissionClass = running.admissionClass;
	}

	function addStickyActivityMetadata(entry: StickyTerminalRun, running: RunningSubagent): void {
		if (running.activity) entry.activity = { ...running.activity };
	}

	function captureStickyLaunchFailure(params: {
		id: string;
		name: string;
		agent?: string;
		admissionClass?: "foreground" | "background";
		startTime: number;
		error: unknown;
	}): void {
		if (!shouldCaptureLaunchFailure(params)) return;
		stickyTerminalRuns.set(params.id, stickyLaunchFailureEntry(params));
		deps.updateWidget();
	}

	function shouldCaptureLaunchFailure(params: { id: string; error: unknown }): boolean {
		return !stickyTerminalRuns.has(params.id) && !cancelledLaunchError(params.error);
	}

	function cancelledLaunchError(error: unknown): boolean {
		return error instanceof Error && /cancelled/i.test(error.message);
	}

	function stickyLaunchFailureEntry(params: {
		id: string;
		name: string;
		agent?: string;
		admissionClass?: "foreground" | "background";
		startTime: number;
	}): StickyTerminalRun {
		const capturedAt = Date.now();
		const entry: StickyTerminalRun = {
			id: params.id,
			name: params.name,
			startTime: params.startTime,
			runtimeEndedAt: capturedAt,
			kind: "failed",
			capturedAt,
		};
		if (params.agent) entry.agent = params.agent;
		if (params.admissionClass) entry.admissionClass = params.admissionClass;
		return entry;
	}

	function clearStickyTerminalsOnAdmission(): void {
		if (stickyTerminalRuns.size === 0) return;
		stickyTerminalRuns.clear();
		deps.updateWidget();
	}

	async function launchSubagent(
		params: any,
		ctx: StableParentContext,
		options: LaunchOptions,
	): Promise<RunningSubagent> {
		const state = createLaunchState(params, ctx, options);
		try {
			await initializeLaunchSurface(state);
			const prepared = prepareLaunchSession(state);
			const launchCommand = buildLaunchCommand(state, prepared);
			return executeLaunch(state, prepared, launchCommand);
		} catch (error) {
			rollbackLaunch(state);
			throw error;
		}
	}

	function createLaunchState(params: any, ctx: StableParentContext, options: LaunchOptions): LaunchState {
		ensureLaunchIdentity(options.agentDefinition, params.agent);
		const sessionFile = requireParentSessionFile(ctx.sessionFile);
		const id = options.runId ?? deps.createRunId();
		const sessionId = ctx.sessionId;
		assertAdmissionLeaseCurrent(sessionId, options.admissionLease);
		const effectiveCwd = resolve(ctx.cwd);
		const sessionDir = buildChildSessionDirectory(ctx.agentDir, effectiveCwd);
		mkdirSync(sessionDir, { recursive: true });
		return {
			params,
			ctx,
			options,
			id,
			startTime: Date.now(),
			sessionFile,
			sessionId,
			effectiveCwd,
			subagentSessionFile: options.resumeSessionFile ?? buildChildSessionFile(sessionDir, id),
			surfacePreCreated: Boolean(options.surface),
			launchTransaction: createLaunchTransaction(id, options.admissionLease),
			attemptId: id,
		};
	}

	function ensureLaunchIdentity(agentDefinition: AgentDefinition, agent: string): void {
		if (agentDefinition.id !== agent) throw new Error("Subagent identity mismatch.");
	}

	function requireParentSessionFile(sessionFile: string | undefined): string {
		if (!sessionFile) throw new Error("No session file");
		return sessionFile;
	}

	function buildChildSessionDirectory(agentDir: string, cwd: string): string {
		const safeCwd = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		return join(resolve(agentDir), "sessions", safeCwd);
	}

	function buildChildSessionFile(sessionDir: string, id: string): string {
		const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
		const suffix = [id, randomHex(), randomHex(), randomHex(6)].join("-");
		return join(sessionDir, `${timestamp}_${suffix}.jsonl`);
	}

	function randomHex(length = 8): string {
		return Math.random()
			.toString(16)
			.slice(2, length + 2);
	}

	function createLaunchTransaction(id: string, lease: AdmissionLease | undefined) {
		const transaction = beginLaunchTransaction(id);
		if (lease) transaction.own(() => lease.release());
		transaction.throwIfAborted();
		return transaction;
	}

	async function initializeLaunchSurface(state: LaunchState): Promise<void> {
		const preparedSurface = await resolveLaunchSurface(state);
		state.surface = preparedSurface.surface;
		state.layoutWarning = preparedSurface.warning;
		await waitForLaunchShell(state);
	}

	async function resolveLaunchSurface(state: LaunchState): Promise<{ surface: string; warning?: string }> {
		if (state.options.surface) return { surface: state.options.surface };
		return attachLaunchSurface(state);
	}

	async function attachLaunchSurface(state: LaunchState): Promise<{ surface: string; warning?: string }> {
		const parentPaneId = requireParentPaneId();
		const direction = deps.resolveDirection(state.params);
		tryRederiveRegionFromLayout(
			parentPaneId,
			direction,
			Array.from(runningSubagents.values()).map((running) => running.surface),
		);
		const attached = await attachPaneSerialized(parentPaneId, {
			name: displayLaunchName(state.params),
			direction,
			layout: deps.resolveLayout(state.params),
			surface: deps.resolveSurface(state.params),
			cwd: state.effectiveCwd,
		});
		registerSurfaceRollback(state, parentPaneId, attached.paneId);
		state.launchTransaction.advance("pane");
		assertAdmissionCurrent(state);
		return { surface: attached.paneId, warning: attached.warning };
	}

	function requireParentPaneId(): string {
		const parentPaneId = process.env.HERDR_PANE_ID;
		if (!parentPaneId) throw new Error("HERDR_PANE_ID not set");
		return parentPaneId;
	}

	function registerSurfaceRollback(state: LaunchState, parentPaneId: string, surface: string): void {
		state.launchTransaction.own(() => closeAttachedSurface(parentPaneId, surface));
	}

	function closeAttachedSurface(parentPaneId: string, surface: string): void {
		try {
			safeCloseSubagentPane(surface);
		} catch {}
		try {
			removePaneFromRegion(parentPaneId, surface);
		} catch {}
	}

	async function waitForLaunchShell(state: LaunchState): Promise<void> {
		if (state.surfacePreCreated) return;
		await new Promise<void>((done) => setTimeout(done, deps.getShellReadyDelayMs()));
		state.launchTransaction.throwIfAborted();
		assertAdmissionCurrent(state);
	}

	function assertAdmissionCurrent(state: LaunchState): void {
		assertAdmissionLeaseCurrent(state.sessionId, state.options.admissionLease);
	}

	function assertAdmissionLeaseCurrent(sessionId: string, lease: AdmissionLease | undefined): void {
		if (lease && !getAdmissionCoordinator(sessionId).isAdmissionCurrent(lease)) {
			throw new Error("Subagent launch cancelled.");
		}
	}

	function prepareLaunchSession(state: LaunchState): PreparedLaunch {
		const behavior = deps.resolveLaunchBehavior(state.options.agentDefinition);
		if (state.options.resumeSessionFile) {
			// Explicit resume: adopt the caller-supplied session file. The launch
			// transaction never owns pre-existing state — no seeding (seeding
			// truncates and rewrites the transcript), no rollbacks, and the lease is
			// acquired directly against the resumed path.
			const registry = getSessionLeaseRegistry(state.sessionId);
			state.sessionLease = registry.acquire(state.subagentSessionFile, state.id, "starting");
			state.launchTransaction.own(() => state.sessionLease?.release());
			const artifactDir = deps.getSubagentArtifactDir(state.subagentSessionFile);
			mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
			return {
				activityFile: join(artifactDir, "activity.json"),
				entryCountBefore: getNewEntries(state.subagentSessionFile, 0).length,
				fullTask: buildLaunchTask(state.params.task, behavior.inheritsConversationContext),
			};
		}
		registerSessionRollbacks(state);
		const sessionName = displayLaunchName(state.params);
		seedSubagentSessionFile({
			parentSessionFile: state.sessionFile,
			parentSessionId: state.sessionId,
			agentId: state.options.agentDefinition.id,
			childSessionFile: state.subagentSessionFile,
			childCwd: state.effectiveCwd,
			sessionName,
		});
		state.sessionLease = getSessionLeaseRegistry(state.sessionId).acquire(
			state.subagentSessionFile,
			state.id,
			"starting",
		);
		state.launchTransaction.own(() => state.sessionLease?.release());
		const artifactDir = deps.getSubagentArtifactDir(state.subagentSessionFile);
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		const activityFile = join(artifactDir, "activity.json");
		return {
			activityFile,
			entryCountBefore: getNewEntries(state.subagentSessionFile, 0).length,
			fullTask: buildLaunchTask(state.params.task, behavior.inheritsConversationContext),
		};
	}

	/** Prepare the session for an internal retry relaunch: reuse the run's
	 * existing lease, skip acquire/transition/rollbacks/seeding entirely. */
	function prepareRelaunchSession(running: RunningSubagent): PreparedLaunch {
		const behavior = deps.resolveLaunchBehavior(
			running.agentDefinition ?? {
				id: running.agent ?? "",
				sourcePath: "",
				source: "global",
				tools: "",
				body: "",
				frontmatter: "",
			},
		);
		const artifactDir = deps.getSubagentArtifactDir(running.sessionFile);
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		return {
			activityFile: join(artifactDir, "activity.json"),
			entryCountBefore: getNewEntries(running.sessionFile, 0).length,
			fullTask: buildLaunchTask(running.task, behavior.inheritsConversationContext),
		};
	}

	function registerSessionRollbacks(state: LaunchState): void {
		state.launchTransaction.own(() => rmSync(state.subagentSessionFile, { force: true }));
		state.launchTransaction.own(() =>
			rmSync(deps.getSubagentArtifactDir(state.subagentSessionFile), { recursive: true, force: true }),
		);
	}

	function buildLaunchTask(task: string, inheritsConversationContext: boolean): string {
		return inheritsConversationContext
			? task
			: `Complete your task autonomously.\n\n${task}\n\nYour FINAL assistant message should summarize what you accomplished.`;
	}

	function buildLaunchCommand(state: LaunchState, prepared: PreparedLaunch): LaunchCommand {
		const parts = createPiCommandParts(state);
		appendSystemPrompt(parts, state);
		parts.push("--tools", shellQuote(deps.buildSubagentToolAllowlist(state.options.agentDefinition.tools)));
		const environment = buildLaunchEnvironment(state, prepared.activityFile);
		const taskArgument = buildTaskArgument(state, prepared.fullTask);
		appendSelectedSkills(parts, state.options.selectedSkills);
		parts.push(shellQuote(taskArgument));
		return {
			command: `cd ${shellQuote(state.effectiveCwd)} && ${environment.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`,
			launchScriptFile: join(deps.getSubagentArtifactDir(state.subagentSessionFile), "launch.sh"),
		};
	}

	function createPiCommandParts(state: LaunchState): string[] {
		const parts = ["pi"];
		appendExtensionFlag(parts);
		appendApprovalFlag(parts, state.options.projectTrusted);
		parts.push(
			"--session",
			shellQuote(state.subagentSessionFile),
			"-e",
			shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts")),
		);
		appendRuntimeFlags(parts, state.options.runtimePlan);
		return parts;
	}

	function appendExtensionFlag(parts: string[]): void {
		if (process.env.PI_SUBAGENT_NO_EXTENSIONS === "1") parts.push("-ne");
	}

	function appendApprovalFlag(parts: string[], projectTrusted: boolean | undefined): void {
		if (projectTrusted) parts.push("--approve");
	}

	function appendRuntimeFlags(parts: string[], runtimePlan: ResolvedRuntimePlan): void {
		if (runtimePlan.model) parts.push("--model", shellQuote(runtimePlan.model));
		if (runtimePlan.thinking) parts.push("--thinking", shellQuote(runtimePlan.thinking));
	}

	function appendSystemPrompt(parts: string[], state: LaunchState): void {
		const prompt = deps.buildSystemPromptFileContent({
			agentName: state.options.agentDefinition.id,
			identity: state.options.agentDefinition.body,
		});
		if (!prompt) return;
		const path = systemPromptPath(state);
		writeLaunchArtifact(path, prompt.content);
		parts.push(prompt.flag, shellQuote(path));
	}

	function systemPromptPath(state: LaunchState): string {
		return join(deps.getSubagentArtifactDir(state.subagentSessionFile), "sysprompt.md");
	}

	function writeLaunchArtifact(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, content, "utf8");
	}

	function buildLaunchEnvironment(state: LaunchState, activityFile: string): string[] {
		const entries = [
			`PI_CODING_AGENT_DIR=${shellQuote(state.ctx.agentDir)}`,
			`PI_DENY_TOOLS=${shellQuote([...deps.lifecycleDenySet()].join(","))}`,
			`PI_SUBAGENT_NAME=${shellQuote(displayLaunchName(state.params))}`,
			`PI_SUBAGENT_AGENT=${shellQuote(state.options.agentDefinition.id)}`,
			`PI_SUBAGENT_SELECTED_SKILLS=${shellQuote(JSON.stringify(selectedSkillMetadata(state.options.selectedSkills)))}`,
			"PI_SUBAGENT_COMPANION_ORDER=explicit-before-discovered",
			"PI_SUBAGENT_AUTO_EXIT=1",
			`PI_SUBAGENT_SESSION=${shellQuote(state.subagentSessionFile)}`,
			`PI_SUBAGENT_ID=${shellQuote(state.attemptId)}`,
			`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
			`PI_SUBAGENT_SURFACE=${shellQuote(state.surface ?? "")}`,
			`PI_SUBAGENT_PARENT_SESSION=${shellQuote(state.sessionId)}`,
		];
		appendOptionalEnvironment(entries);
		return entries;
	}

	function selectedSkillMetadata(skills: SelectedSkill[]) {
		return skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath }));
	}

	function appendOptionalEnvironment(entries: string[]): void {
		if (process.env.PI_SUBAGENT_NO_EXTENSIONS === "1") entries.push("PI_SUBAGENT_NO_EXTENSIONS=1");
		if (process.env.PI_SUBAGENT_INSPECTION_DIR) {
			entries.push(`PI_SUBAGENT_INSPECTION_DIR=${shellQuote(process.env.PI_SUBAGENT_INSPECTION_DIR)}`);
		}
	}

	function buildTaskArgument(state: LaunchState, fullTask: string): string {
		if (deps.resolveLaunchBehavior(state.options.agentDefinition).taskDelivery === "direct") return fullTask;
		const path = taskArtifactPath(state);
		writeLaunchArtifact(path, fullTask);
		return `@${path}`;
	}

	function taskArtifactPath(state: LaunchState): string {
		return join(deps.getSubagentArtifactDir(state.subagentSessionFile), "task.md");
	}

	function appendSelectedSkills(parts: string[], skills: SelectedSkill[]): void {
		parts.push("--no-skills");
		for (const skill of skills) parts.push("--skill", shellQuote(skill.filePath));
	}

	function executeLaunch(
		state: LaunchState,
		prepared: PreparedLaunch,
		launchCommand: LaunchCommand,
	): RunningSubagent {
		writeLaunchScript(state, launchCommand);
		state.sessionLease.transition("running");
		const running = createRunningSubagent(state, prepared, launchCommand.launchScriptFile);
		runningSubagents.set(state.id, running);
		state.launchTransaction.own(() => runningSubagents.delete(state.id));
		return running;
	}

	function writeLaunchScript(state: LaunchState, launchCommand: LaunchCommand): void {
		state.launchTransaction.throwIfAborted();
		state.launchTransaction.advance("script");
		deps.runScriptInPane(state.surface ?? "", launchCommand.command, {
			scriptPath: launchCommand.launchScriptFile,
			scriptPreamble: launchScriptPreamble(state),
		});
	}

	function launchScriptPreamble(state: LaunchState): string {
		return [
			`# Subagent launch script for ${deps.safeCommentValue(state.params.agent)}`,
			`# Run: ${deps.safeCommentValue(state.id)}`,
			`# Generated: ${deps.safeCommentValue(new Date().toISOString())}`,
			`# Session: ${deps.safeCommentValue(state.subagentSessionFile)}`,
			`# Surface: ${deps.safeCommentValue(state.surface ?? "")}`,
		].join("\n");
	}

	function createRunningSubagent(
		state: LaunchState,
		prepared: PreparedLaunch,
		launchScriptFile: string,
	): RunningSubagent {
		return {
			id: state.id,
			name: displayLaunchName(state.params),
			task: state.params.task,
			agent: state.options.agentDefinition.id,
			parentSessionId: state.sessionId,
			surface: state.surface ?? "",
			startTime: state.startTime,
			sessionFile: state.subagentSessionFile,
			launchScriptFile,
			activityFile: prepared.activityFile,
			...launchPresentationFlags(state),
			runtimePlan: state.options.runtimePlan,
			admissionClass: state.options.admissionClass,
			admissionLease: state.options.admissionLease,
			sessionLease: state.sessionLease,
			entryCountBefore: prepared.entryCountBefore,
			lifecycle: deps.createLifecycle(state.startTime),
			launchTransaction: state.launchTransaction,
			...(state.options.resumeSessionFile ? { resumed: true } : {}),
			attempt: 1,
			maxAttempts: MAX_RUN_ATTEMPTS,
			attemptId: state.attemptId,
			launchParams: state.params,
			agentDefinition: state.options.agentDefinition,
			selectedSkills: state.options.selectedSkills,
			effectiveCwd: state.effectiveCwd,
			agentDir: state.ctx.agentDir,
			projectTrusted: state.options.projectTrusted,
		};
	}

	function launchPresentationFlags(
		state: LaunchState,
	): Pick<RunningSubagent, "suppressStatusSteer" | "layoutWarning"> {
		return {
			...(deps.resolveBlocking(state.params) ? { suppressStatusSteer: true } : {}),
			...(state.layoutWarning ? { layoutWarning: state.layoutWarning } : {}),
		};
	}

	function rollbackLaunch(state: LaunchState): void {
		state.launchTransaction.rollback();
		finishLaunchTransaction(state.id, state.launchTransaction);
		state.sessionLease?.release();
		state.options.admissionLease?.release();
		cleanupLaunchSurface(state);
	}

	function cleanupLaunchSurface(state: LaunchState): void {
		if (!state.surface || state.surfacePreCreated) return;
		const parentPaneId = process.env.HERDR_PANE_ID;
		if (parentPaneId) closeAttachedSurface(parentPaneId, state.surface);
	}

	function displayLaunchName(params: any): string {
		return params.label?.trim() || params.agent;
	}

	async function watchSubagent(
		running: RunningSubagent,
		signal: AbortSignal,
		options: { releaseOwnership?: boolean; timeoutMs?: number } = { releaseOwnership: true },
	): Promise<SubagentResult> {
		try {
			for (;;) {
				const result = await waitForRunCompletion(running, signal, options);
				if (!shouldRetryCompletion(running, result)) return settleWatchedCompletion(running, result);
				const retryOutcome = await retryFailedAttempt(running, signal, options);
				if (!retryOutcome) continue;
				return retryOutcome;
			}
		} catch (error) {
			return handleWatchFailure(running, signal, error);
		} finally {
			finalizeWatchOwnership(running, options);
		}
	}

	/** Retry decision: well-formed error sidecar, attempts remaining, not aborted. */
	function shouldRetryCompletion(running: RunningSubagent, result: CompletionResult): boolean {
		const maxAttempts = running.maxAttempts ?? MAX_RUN_ATTEMPTS;
		return (
			isRetryableCompletion(result) &&
			(running.attempt ?? 1) < maxAttempts &&
			!running.abortController?.signal.aborted
		);
	}

	/** Reap the failed attempt and relaunch. Returns a settled result only when
	 * the relaunch mechanics fail (ordinary reported-error path); undefined means
	 * a new attempt is running and the caller should watch again. */
	async function retryFailedAttempt(
		running: RunningSubagent,
		signal: AbortSignal,
		_options: { timeoutMs?: number },
	): Promise<SubagentResult | undefined> {
		const maxAttempts = running.maxAttempts ?? MAX_RUN_ATTEMPTS;
		const nextAttempt = (running.attempt ?? 1) + 1;
		const previousSurface = running.surface;
		const backoffMs = RETRY_BACKOFF_MS[Math.min(nextAttempt - 2, RETRY_BACKOFF_MS.length - 1)];
		running.lifecycle = markRetrying(running.lifecycle, nextAttempt, maxAttempts, Date.now());
		deps.updateWidget();
		try {
			// Reap the failed attempt's pane, then wait for CONFIRMED absence —
			// pane absence implies the terminal host reaped the child process tree,
			// which is what guarantees single-writer access to the shared .jsonl.
			safeCloseAndReap(running);
			// Bounded absence confirmation and the backoff run CONCURRENTLY: the
			// relaunch waits for both, so the pathological delay is bounded by
			// max(absence bound, backoff) rather than their sum.
			await Promise.all([
				waitForPaneAbsence(previousSurface, signal, running.inspectPaneOverride),
				abortableDelay(backoffMs, signal),
			]);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return settleRelaunchFailure(running, previousSurface, error);
		}
		try {
			await relaunchAttempt(running, nextAttempt);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return settleRelaunchFailure(running, previousSurface, error);
		}
		return undefined;
	}

	/** Bounded, abort-aware wait for the failed attempt's pane to be confirmed gone. */
	async function waitForPaneAbsence(
		surface: string,
		signal: AbortSignal,
		inspectOverride?: () => Promise<PaneInspection>,
	): Promise<void> {
		const deadline = Date.now() + PANE_ABSENCE_TIMEOUT_MS;
		for (;;) {
			throwIfWatchAborted(signal);
			const inspection = await probePaneAbsence(surface, inspectOverride);
			if (inspection.kind === "missing") return;
			if (Date.now() >= deadline) {
				throw new Error(
					`Subagent retry aborted: failed attempt's pane ${surface} still present after ${PANE_ABSENCE_TIMEOUT_MS}ms.`,
				);
			}
			await abortableDelay(RELAUNCH_POLL_MS, signal);
		}
	}

	async function probePaneAbsence(
		surface: string,
		inspectOverride?: () => Promise<PaneInspection>,
	): Promise<{ kind: "present" | "missing" | "unavailable" }> {
		try {
			return await (inspectOverride ? inspectOverride() : inspectPane(surface));
		} catch {
			return { kind: "unavailable" };
		}
	}

	function throwIfWatchAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new Error(ABORT_MESSAGE);
	}

	function isAbortError(error: unknown): boolean {
		return error instanceof Error && error.message === ABORT_MESSAGE;
	}

	/** Settle a relaunch-mechanics failure through the ordinary reported-error path. */
	function settleRelaunchFailure(running: RunningSubagent, previousSurface: string, error: unknown): SubagentResult {
		const message = error instanceof Error ? error.message : String(error);
		running.lifecycle = markFailed(running.lifecycle, `Subagent retry relaunch failed: ${message}`, Date.now(), 1);
		if (running.surface && running.surface !== previousSurface) {
			// Inline relaunch cleanup: close only the replacement pane this relaunch created.
			safeCloseAndReap(running);
		} else {
			running.surface = previousSurface;
		}
		running.errorPanePreserved = preserveErrorPane(running);
		releaseAdmissionOnly(running);
		deps.updateWidget();
		return {
			name: running.name,
			task: running.task,
			summary: `Subagent retry relaunch failed: ${message}`,
			sessionFile: running.sessionFile,
			exitCode: 1,
			elapsed: elapsedSince(running.startTime),
			// `error` (not `errorMessage`): this is an extension-side relaunch
			// mechanics failure, not a provider/agent error — must not render as
			// `failed (provider/agent error)` nor claim the provider failed.
			error: `Subagent retry relaunch failed: ${message}`,
		};
	}

	/** Re-execute the post-admission launch segment for a retry attempt against
	 * a LOCAL non-registered cleanup scope (the original transaction committed at
	 * first launch; own/advance would throw). Inline cleanup on failure. */
	async function relaunchAttempt(running: RunningSubagent, nextAttempt: number): Promise<void> {
		const localScope = createLocalCleanupScope();
		try {
			const parentPaneId = process.env.HERDR_PANE_ID;
			if (!parentPaneId) throw new Error("HERDR_PANE_ID not set");
			// Regenerate the per-attempt id FIRST: the launch command must stamp the
			// child with the SAME id the watch's sidecar ownership check, the activity
			// reads, and the disposition comparand will later validate against.
			running.attemptId = createAttemptId(running.id, nextAttempt);
			running.attempt = nextAttempt;
			const direction = deps.resolveDirection(running.launchParams);
			const attachOptions = {
				name: running.name,
				direction,
				layout: deps.resolveLayout(running.launchParams),
				surface: deps.resolveSurface(running.launchParams),
				cwd: running.effectiveCwd ?? process.cwd(),
			};
			// The surface override mirrors inspectPaneOverride: a test-only seam so
			// the relaunch segment is exercisable without a live herdr binary.
			const attached = running.attachSurfaceOverride
				? await running.attachSurfaceOverride(attachOptions)
				: await (() => {
						tryRederiveRegionFromLayout(
							parentPaneId,
							direction,
							Array.from(runningSubagents.values()).map((entry) => entry.surface),
						);
						return attachPaneSerialized(parentPaneId, attachOptions);
					})();
			localScope.own(() => {
				if (!running.attachSurfaceOverride) closeAttachedSurface(parentPaneId, attached.paneId);
			});
			localScope.advance("pane");
			// Recompute layout warnings for the replacement surface (e.g. a
			// too-small terminal forcing a tab fallback must surface its warning).
			running.layoutWarning = attached.warning;
			await new Promise<void>((done) => setTimeout(done, deps.getShellReadyDelayMs()));
			const prepared = prepareRelaunchSession(running);
			// Re-point the surface BEFORE building the command so PI_SUBAGENT_SURFACE
			// stamps the replacement pane, not the dead one. entryCountBefore re-snapshots
			// only now — after confirmed pane absence — so it cannot capture a count
			// while the dying child still writes.
			running.surface = attached.paneId;
			const launchCommand = buildRelaunchCommand(running, prepared);
			localScope.own(() => rmSync(launchCommand.launchScriptFile, { force: true }));
			deps.runScriptInPane(attached.paneId, launchCommand.command, {
				scriptPath: launchCommand.launchScriptFile,
				scriptPreamble: relaunchScriptPreamble(running, nextAttempt, attached.paneId),
			});
			localScope.advance("script");
			running.activityFile = prepared.activityFile;
			running.launchScriptFile = launchCommand.launchScriptFile;
			running.entryCountBefore = prepared.entryCountBefore;
			resetLifecycleForAttempt(running);
			localScope.commit();
			deps.updateWidget();
		} catch (error) {
			localScope.rollback();
			throw error;
		}
	}

	function createAttemptId(runId: string, attempt: number): string {
		return `${runId}-r${attempt}`;
	}

	/** Reset per-attempt lifecycle activity state: the new attempt's recorder
	 * starts at sequence 0 and isStaleActivity compares sequence only, so without
	 * this reset every attempt-2 write would be discarded as stale. */
	function resetLifecycleForAttempt(running: RunningSubagent): void {
		running.lifecycle = clearRetry(deps.ensureLifecycle(running));
		running.lifecycle = {
			...running.lifecycle,
			turn: { kind: "unknown" },
			activityDetail: null,
			activityHealth: { kind: "unseen" },
			lastActivitySequence: null,
			pane: { kind: "unknown" },
		};
		running.activity = undefined;
		running.activityRead = undefined;
	}

	function buildRelaunchCommand(running: RunningSubagent, prepared: PreparedLaunch): LaunchCommand {
		// Same builder as the initial launch; flags/env reconstructed verbatim from
		// the run's own agent definition and runtime plan. Uses a launch-state shim
		// so all builder code paths are shared, with attemptId threaded through.
		return buildLaunchCommand(relaunchStateShim(running), prepared);
	}

	function relaunchStateShim(running: RunningSubagent): LaunchState {
		return {
			params: running.launchParams ?? { agent: running.agent, task: running.task, label: running.name },
			ctx: {
				cwd: running.effectiveCwd ?? process.cwd(),
				// The retained agent dir reproduces PI_CODING_AGENT_DIR verbatim;
				// re-deriving from the env yields "" when unset, poisoning the child.
				agentDir: running.agentDir ?? getAgentConfigDir(),
				projectTrusted: running.projectTrusted ?? true,
				sessionId: running.parentSessionId ?? "",
			},
			options: {
				// Same fallback as prepareRelaunchSession: an upgraded live run whose
				// RunningSubagent predates agent-definition retention still relaunches.
				agentDefinition: running.agentDefinition ?? {
					id: running.agent ?? "",
					sourcePath: "",
					source: "global",
					tools: "",
					body: "",
					frontmatter: "",
				},
				selectedSkills: running.selectedSkills ?? [],
				runtimePlan: running.runtimePlan as ResolvedRuntimePlan,
				projectTrusted: running.projectTrusted,
			},
			id: running.id,
			startTime: running.startTime,
			sessionFile: running.parentSessionFile ?? "",
			sessionId: running.parentSessionId ?? "",
			effectiveCwd: running.effectiveCwd ?? process.cwd(),
			subagentSessionFile: running.sessionFile,
			surfacePreCreated: false,
			launchTransaction: createLocalCleanupScope(),
			surface: running.surface,
			attemptId: running.attemptId ?? running.id,
		};
	}

	function relaunchScriptPreamble(running: RunningSubagent, attempt: number, surface: string): string {
		return [
			`# Subagent launch script for ${deps.safeCommentValue(running.agent ?? "")}`,
			`# Run: ${deps.safeCommentValue(running.id)} (retry attempt ${attempt})`,
			`# Generated: ${deps.safeCommentValue(new Date().toISOString())}`,
			`# Session: ${deps.safeCommentValue(running.sessionFile)}`,
			`# Surface: ${deps.safeCommentValue(surface)}`,
		].join("\n");
	}

	/** A local, non-registered cleanup scope exposing the LaunchTransaction
	 * own/advance interface without the registered-transaction invariants. */
	function createLocalCleanupScope(): LaunchTransaction {
		const rollbacks: Array<() => void> = [];
		let settled = false;
		return {
			get signal() {
				return NEVER_ABORTED_SIGNAL;
			},
			step: "admitted",
			advance(_step: LaunchStep) {
				if (settled) throw new Error("Launch transaction is already settled.");
			},
			own(rollback: () => void) {
				if (settled) {
					try {
						rollback();
					} catch {}
					return;
				}
				rollbacks.push(rollback);
			},
			throwIfAborted() {},
			abort() {
				if (settled) return;
				for (const rollback of rollbacks.reverse()) {
					try {
						rollback();
					} catch {}
				}
				rollbacks.length = 0;
				settled = true;
			},
			commit() {
				if (settled) throw new Error("Launch transaction is already settled.");
				settled = true;
				rollbacks.length = 0;
			},
			rollback() {
				if (settled) return;
				settled = true;
				for (const rollback of rollbacks.reverse()) {
					try {
						rollback();
					} catch {}
				}
				rollbacks.length = 0;
			},
		} as unknown as LaunchTransaction;
	}

	function waitForRunCompletion(
		running: RunningSubagent,
		signal: AbortSignal,
		options: { timeoutMs?: number },
	): Promise<CompletionResult> {
		return waitForCompletion(signal, {
			intervalMs: 1000,
			sessionFile: running.sessionFile,
			expectedRunId: running.attemptId ?? running.id,
			...watchTimeoutOption(running, options),
			readTerminalTail: () => readPaneAsync(running.surface, 5),
			inspectPane: async () =>
				running.inspectPaneOverride ? running.inspectPaneOverride() : inspectPane(running.surface),
			onPaneInspection: (inspection, observedAt) => updateWatchPaneInspection(running, inspection, observedAt),
			onTick: () => deps.observeRunningSubagent(running),
		});
	}

	function watchTimeoutOption(running: RunningSubagent, options: { timeoutMs?: number }): { timeoutMs?: number } {
		const timeoutMs = options.timeoutMs ?? running.completionTimeoutMs;
		return timeoutMs == null ? {} : { timeoutMs };
	}

	function updateWatchPaneInspection(running: RunningSubagent, inspection: any, observedAt: number): void {
		deps.ensureLifecycle(running);
		running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
		deps.updateWidget();
	}

	function settleWatchedCompletion(running: RunningSubagent, completion: CompletionResult): SubagentResult {
		deps.observeRunningSubagent(running);
		const settlementSource = settlementSourceFor(completion.reason);
		if (!getSettlementRegistry(running.parentSessionId ?? "local").claim(running.id, settlementSource)) {
			return alreadySettledResult(running);
		}
		const detectedAt = Date.now();
		running.lifecycle = markCompletionDetected(running.lifecycle, completion, detectedAt);
		deps.updateWidget();
		const summary = readCompletionSummary(running, completion);
		const disposition = applySettlementDisposition(running, completion);
		running.lifecycle = terminalLifecycle(running, completion, summary);
		return completionResult(running, completion, summary, detectedAt, disposition.watchAbandoned);
	}

	/** Attempt counts for the exhaustion presentation: only a retryable failure
	 * that actually exhausted the attempt cap may claim exhaustion. */
	function exhaustionAttempts(
		running: RunningSubagent,
		completion: CompletionResult,
	):
		| {
				attempts: number;
				maxAttempts: number;
		  }
		| undefined {
		if (!isRetryableCompletion(completion)) return undefined;
		const attempts = running.attempt ?? 1;
		const maxAttempts = running.maxAttempts ?? MAX_RUN_ATTEMPTS;
		// Only a failure that actually exhausted the cap may claim exhaustion —
		// e.g. an abort racing a retryable sidecar at attempt 1 of 3 must not.
		if (attempts < maxAttempts) return undefined;
		return { attempts, maxAttempts };
	}

	function settlementSourceFor(reason: CompletionResult["reason"]): SettlementSource {
		const sources: Partial<Record<CompletionResult["reason"], SettlementSource>> = {
			timeout: "timeout",
			done: "sidecar",
			error: "sidecar",
			sentinel: "sentinel",
		};
		return sources[reason] ?? "pane-disappearance";
	}

	function alreadySettledResult(running: RunningSubagent): SubagentResult {
		return {
			name: running.name,
			task: running.task,
			summary: "Subagent completion was already settled.",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: elapsedSince(running.startTime),
			alreadySettled: true,
		};
	}

	function readCompletionSummary(running: RunningSubagent, completion: CompletionResult): string {
		const fallback = fallbackSummary(completion);
		if (!existsSync(running.sessionFile)) return fallback;
		const entries = getNewEntries(running.sessionFile, running.entryCountBefore ?? 0);
		updateObservedRuntime(running, findObservedSessionRuntime(entries));
		return findLastAssistantMessage(entries) ?? fallback;
	}

	function updateObservedRuntime(
		running: RunningSubagent,
		observed: ReturnType<typeof findObservedSessionRuntime>,
	): void {
		const childRuntime = observedChildRuntime(observed);
		if (!running.runtimePlan || !childRuntime) return;
		running.runtimePlan = mergeObservedRuntime(running.runtimePlan, childRuntime);
	}

	function observedChildRuntime(observed: ReturnType<typeof findObservedSessionRuntime>) {
		if (!observed.provider || !observed.modelId) return undefined;
		const model = `${observed.provider}/${observed.modelId}`;
		const thinking = supportedThinking(observed.thinking);
		return thinking ? { model, thinking } : { model };
	}

	function mergeObservedRuntime(
		runtimePlan: ResolvedRuntimePlan,
		childRuntime: { model: string; thinking?: any },
	): ResolvedRuntimePlan {
		const mismatch = runtimeMismatch(runtimePlan.model, childRuntime.model);
		return {
			...runtimePlan,
			...(childRuntime.thinking ? { thinking: childRuntime.thinking } : {}),
			observed: childRuntime,
			...(mismatch ? { runtimeMismatch: mismatch } : {}),
		};
	}

	function runtimeMismatch(expected: string | undefined, observed: string): string | undefined {
		return expected === observed ? undefined : `Resolved model ${expected} but child reported ${observed}`;
	}

	function supportedThinking(
		value: unknown,
	): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)
			? (value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
			: undefined;
	}

	function terminalLifecycle(running: RunningSubagent, completion: CompletionResult, summary: string) {
		return completion.exitCode === 0
			? markCompleted(running.lifecycle, Date.now())
			: markFailed(running.lifecycle, completion.errorMessage ?? summary, Date.now(), completion.exitCode);
	}

	function completionResult(
		running: RunningSubagent,
		completion: CompletionResult,
		summary: string,
		detectedAt: number,
		watchAbandoned: boolean,
	): SubagentResult {
		const exhausted = exhaustionAttempts(running, completion);
		const permanentError = isPermanentErrorCompletion(completion);
		return {
			name: running.name,
			task: running.task,
			summary,
			sessionFile: running.sessionFile,
			exitCode: completion.exitCode,
			elapsed: Math.floor((detectedAt - running.startTime) / 1000),
			...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
			...(exhausted ? { attempts: exhausted.attempts, maxAttempts: exhausted.maxAttempts } : {}),
			// `attempts` without `maxAttempts` marks the permanent short-circuit: the
			// pattern first matched after earlier retries already ran, so the
			// presentation can state them attempt-accurately without claiming exhaustion.
			...(!exhausted && permanentError && running.attempt != null ? { attempts: running.attempt } : {}),
			...(permanentError ? { permanentError: true } : {}),
			...(running.agent ? { agent: running.agent } : {}),
			...(watchAbandoned ? { watchAbandoned: true } : {}),
		};
	}

	function handleWatchFailure(running: RunningSubagent, signal: AbortSignal, error: unknown): SubagentResult {
		const preserved = preserveWatchFailurePane(running, signal);
		settleWatchFailure(running, signal, error, preserved);
		return watchFailureResult(running, signal, error);
	}

	function preserveWatchFailurePane(running: RunningSubagent, signal: AbortSignal): boolean {
		return !signal.aborted && preserveErrorPane(running);
	}

	function settleWatchFailure(
		running: RunningSubagent,
		signal: AbortSignal,
		error: unknown,
		preserved: boolean,
	): void {
		running.errorPanePreserved = preserved;
		if (preserved) releaseAdmissionOnly(running);
		else safeCloseAndReap(running);
		running.lifecycle = markFailed(running.lifecycle, watchFailureMessage(signal, error), Date.now(), 1);
		deps.updateWidget();
	}

	function watchFailureResult(running: RunningSubagent, signal: AbortSignal, error: unknown): SubagentResult {
		return signal.aborted ? cancelledWatchResult(running) : erroredWatchResult(running, error);
	}

	function watchFailureMessage(signal: AbortSignal, error: unknown): string {
		return signal.aborted ? "Subagent cancelled." : errorMessage(error);
	}

	function cancelledWatchResult(running: RunningSubagent): SubagentResult {
		return {
			name: running.name,
			task: running.task,
			summary: "Subagent cancelled.",
			exitCode: 1,
			elapsed: elapsedSince(running.startTime),
			error: "cancelled",
			sessionFile: running.sessionFile,
		};
	}

	function erroredWatchResult(running: RunningSubagent, error: unknown): SubagentResult {
		const message = errorMessage(error);
		return {
			name: running.name,
			task: running.task,
			summary: `Subagent error: ${message}`,
			exitCode: 1,
			elapsed: elapsedSince(running.startTime),
			error: message,
		};
	}

	function finalizeWatchOwnership(running: RunningSubagent, options: { releaseOwnership?: boolean }): void {
		if (options.releaseOwnership !== false && !running.errorPanePreserved) releaseRunOwnership(running);
	}

	function elapsedSince(startTime: number): number {
		return Math.floor((Date.now() - startTime) / 1000);
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function commitRunningLaunch(running: RunningSubagent): void {
		const transaction = running.launchTransaction;
		if (!transaction) return;
		transaction.advance("watcher");
		transaction.commit();
		finishLaunchTransaction(running.id, transaction);
		running.launchTransaction = undefined;
	}

	function failLaunch(running: RunningSubagent, error: unknown, aborted: boolean): void {
		if (!aborted) {
			const message = error instanceof Error ? error.message : String(error);
			running.lifecycle = markFailed(running.lifecycle, message, Date.now(), 1);
			captureStickyTerminalRun(running, { exitCode: 1, error: message });
		}
		runningSubagents.delete(running.id);
		releaseRunOwnership(running);
	}

	function superviseBackgroundRun(
		parentSessionId: string,
		running: RunningSubagent,
		summarize?: (result: SubagentResult) => SubagentResult,
	): void {
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		deps.startWidgetRefresh();
		deps.startStatusRefresh();
		void watchSubagent(running, watcherAbort.signal, { releaseOwnership: false })
			.then((result) => settleBackgroundWatch(parentSessionId, running, result, summarize))
			.catch((error) => handleBackgroundWatchError(running, error));
		commitBackgroundWatch(running);
	}

	async function settleBackgroundWatch(
		parentSessionId: string,
		running: RunningSubagent,
		rawResult: SubagentResult,
		summarize?: (result: SubagentResult) => SubagentResult,
	): Promise<void> {
		if (backgroundDeliverySuppressed(running, rawResult)) {
			suppressBackgroundResult(running);
			return;
		}
		const result = summarize ? summarize(rawResult) : rawResult;
		const message = backgroundResultMessage(running, result);
		await deliverBackgroundResult(parentSessionId, running, message);
		finishBackgroundResult(running, result);
	}

	function backgroundDeliverySuppressed(running: RunningSubagent, result: SubagentResult): boolean {
		return result.alreadySettled || !deps.shouldDeliverSubagentCompletion(running);
	}

	function suppressBackgroundResult(running: RunningSubagent): void {
		running.lifecycle = markDelivery(running.lifecycle, "suppressed");
		runningSubagents.delete(running.id);
		releaseRunOwnership(running);
		deps.updateWidget();
	}

	function backgroundResultMessage(running: RunningSubagent, result: SubagentResult) {
		return {
			customType: "subagent_result",
			content: backgroundResultContent(running, result),
			display: true,
			details: backgroundResultDetails(running, result),
		};
	}

	function backgroundResultContent(running: RunningSubagent, result: SubagentResult): string {
		const presentation = deps.resolveResultPresentation(result, running.name, running.id, running.agent);
		const mismatch = running.runtimePlan?.runtimeMismatch;
		return mismatch ? `${presentation}\n\nRuntime warning: ${mismatch}` : presentation;
	}

	function backgroundResultDetails(running: RunningSubagent, result: SubagentResult) {
		return {
			id: running.id,
			name: running.name,
			task: running.task,
			agent: running.agent,
			exitCode: result.exitCode,
			elapsed: result.elapsed,
			sessionFile: result.sessionFile,
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
			...(result.attempts != null ? { attempts: result.attempts, maxAttempts: result.maxAttempts } : {}),
			...(result.permanentError ? { permanentError: true } : {}),
			...(result.watchAbandoned ? { watchAbandoned: true } : {}),
			...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
		};
	}

	async function deliverBackgroundResult(
		parentSessionId: string,
		running: RunningSubagent,
		message: any,
	): Promise<void> {
		running.sessionLease?.transition("finalizing");
		try {
			await deliverBackgroundMessage(undefined, parentSessionId, message, deliveryOptions(running));
			running.lifecycle = markDelivery(running.lifecycle, "delivered");
		} catch (error) {
			handleBackgroundDeliveryFailure(parentSessionId, running, message, error);
		}
	}

	function deliveryOptions(running: RunningSubagent) {
		return {
			sessionFile: running.parentSessionFile,
			expectedRunId: running.id,
			onWait: (kind: any) => updateDeliveryWait(running, kind),
		};
	}

	function updateDeliveryWait(running: RunningSubagent, kind: any): void {
		if (running.deliveryWait?.kind === kind) return;
		running.deliveryWait = { kind, since: Date.now() };
		deps.updateWidget();
	}

	function handleBackgroundDeliveryFailure(
		parentSessionId: string,
		running: RunningSubagent,
		message: any,
		error: unknown,
	): void {
		if (getForegroundDeliveryBarrier(parentSessionId).isSuppressed()) {
			running.lifecycle = markDelivery(running.lifecycle, "suppressed");
			return;
		}
		queuePendingDeliveryWithVerification(
			running.id,
			parentSessionId,
			message,
			error,
			{ sessionFile: running.parentSessionFile, expectedRunId: running.id },
			isSessionRuntimeUnavailable(error) ? 0 : 1,
		);
		startDeliveryRetry();
	}

	function finishBackgroundResult(running: RunningSubagent, result: SubagentResult): void {
		running.deliveryWait = undefined;
		captureStickyTerminalRun(running, result);
		runningSubagents.delete(running.id);
		if (!running.errorPanePreserved) releaseRunOwnership(running);
		deps.updateWidget();
	}

	function handleBackgroundWatchError(running: RunningSubagent, error: unknown): void {
		const message = errorMessage(error);
		running.lifecycle = markFailed(running.lifecycle, message, Date.now(), 1);
		running.errorPanePreserved = preserveErrorPane(running);
		captureStickyTerminalRun(running, { exitCode: 1, error: message });
		runningSubagents.delete(running.id);
		if (running.errorPanePreserved) releaseAdmissionOnly(running);
		else releaseRunOwnership(running);
		deps.updateWidget();
	}

	function commitBackgroundWatch(running: RunningSubagent): void {
		try {
			commitRunningLaunch(running);
		} catch (error) {
			handleBackgroundCommitFailure(running, error);
			throw error;
		}
	}

	function handleBackgroundCommitFailure(running: RunningSubagent, error: unknown): void {
		const transaction = running.launchTransaction;
		const aborted = transaction?.signal.aborted ?? false;
		transaction?.rollback();
		if (transaction) finishLaunchTransaction(running.id, transaction);
		running.abortController?.abort();
		failLaunch(running, error, aborted);
		deps.updateWidget();
	}

	async function startBackgroundSpawn(options: {
		params: any;
		ctx: StableParentContext;
		agentDefinition: AgentDefinition;
		selectedSkills: SelectedSkill[];
		runtimePlan: ResolvedRuntimePlan;
		runId: string;
		admissionLease: AdmissionLease;
		projectTrusted: boolean;
		surface?: string;
	}): Promise<RunningSubagent> {
		let running: RunningSubagent | undefined;
		try {
			running = await launchSubagent(options.params, options.ctx, {
				...options,
				admissionClass: "background",
			});
			running.parentSessionFile = options.ctx.sessionFile;
			superviseBackgroundRun(options.ctx.sessionId, running);
			return running;
		} catch (error) {
			rollbackBackgroundSpawn(running);
			handleBackgroundSpawnFailure(options, error);
			throw error;
		}
	}

	function rollbackBackgroundSpawn(running: RunningSubagent | undefined): void {
		const transaction = running?.launchTransaction;
		transaction?.rollback();
		if (running && transaction) finishLaunchTransaction(running.id, transaction);
	}

	function handleBackgroundSpawnFailure(
		options: { params: any; runId: string; admissionLease: AdmissionLease },
		error: unknown,
	): void {
		captureStickyLaunchFailure({
			id: options.runId,
			name: displayLaunchName(options.params),
			agent: options.params.agent,
			admissionClass: "background",
			startTime: options.admissionLease.admittedAt ?? Date.now(),
			error,
		});
		options.admissionLease.release();
	}

	return {
		applySettlementDisposition,
		captureStickyLaunchFailure,
		captureStickyTerminalRun,
		classifyStickyTerminal,
		clearStickyTerminalsOnAdmission,
		commitRunningLaunch,
		failLaunch,
		launchSubagent,
		preserveErrorPane,
		releaseAdmissionOnly,
		releaseRunOwnership,
		safeCloseAndReap,
		startBackgroundSpawn,
		startErrorPaneMonitor,
		superviseBackgroundRun,
		watchSubagent,
		resolveSettlementDisposition,
	};
}
