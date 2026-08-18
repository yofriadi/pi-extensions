import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "./agent-definition.ts";
import type { CompletionResult } from "./completion.ts";
import { waitForCompletion } from "./completion.ts";
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
import { beginLaunchTransaction, finishLaunchTransaction } from "./launch-transaction.ts";
import { attachPaneSerialized, removePaneFromRegion, tryRederiveRegionFromLayout } from "./layout.ts";
import {
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markFailed,
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

type LaunchDeps = {
	resolveBlocking: (params: any) => boolean;
	resolveLayout: (params: any) => any;
	resolveSurface: (params: any) => any;
	resolveDirection: (params: any) => any;
	resolveLaunchBehavior: (definition: AgentDefinition) => {
		seed: "fresh" | "fork";
		inheritsConversationContext: boolean;
		taskDelivery: "direct" | "artifact";
	};
	lifecycleDenySet: () => Set<string>;
	buildSystemPromptFileContent: (input: any) => { content: string; flag: string } | undefined;
	buildSubagentToolAllowlist: (tools?: string) => string;
	buildLaunchArtifactName: (name: string, timestamp: string, id: string) => string;
	safeCommentValue: (value: string) => string;
	createRunId: () => string;
	getArtifactDir: (sessionDir: string, sessionId: string) => string;
	getShellReadyDelayMs: () => number;
	getSubagentActivityFile: (artifactDir: string, runId: string) => string;
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
	resolveResultPresentation: (result: SubagentResult, name: string, runId?: string) => string;
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
};

type LaunchState = {
	params: any;
	ctx: StableParentContext;
	options: LaunchOptions;
	id: string;
	startTime: number;
	sessionFile: string;
	sessionId: string;
	artifactDir: string;
	effectiveCwd: string;
	subagentSessionFile: string;
	surfacePreCreated: boolean;
	launchTransaction: ReturnType<typeof beginLaunchTransaction>;
	rollbackPaths: string[];
	surface?: string;
	layoutWarning?: string;
	sessionLease?: any;
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

	function resolveSettlementDisposition(reason: CompletionResult["reason"]): {
		watchAbandoned: boolean;
		preservePane: boolean;
		releaseAdmissionNow: boolean;
	} {
		if (reason === "timeout") return { watchAbandoned: true, preservePane: true, releaseAdmissionNow: true };
		if (reason === "error") return { watchAbandoned: false, preservePane: true, releaseAdmissionNow: true };
		return { watchAbandoned: false, preservePane: false, releaseAdmissionNow: false };
	}

	function applySettlementDisposition(running: RunningSubagent, reason: CompletionResult["reason"]) {
		const disposition = resolveSettlementDisposition(reason);
		running.watchAbandoned = disposition.watchAbandoned;
		running.errorPanePreserved = disposition.preservePane && preserveErrorPane(running);
		if (!running.errorPanePreserved) safeCloseAndReap(running);
		if (disposition.releaseAdmissionNow) releaseAdmissionOnly(running);
		return disposition;
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
			artifactDir: deps.getArtifactDir(ctx.sessionDir, sessionId),
			effectiveCwd,
			subagentSessionFile: buildChildSessionFile(sessionDir, id),
			surfacePreCreated: Boolean(options.surface),
			launchTransaction: createLaunchTransaction(id, options.admissionLease),
			rollbackPaths: [],
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
		registerSessionRollbacks(state);
		const sessionName = displayLaunchName(state.params);
		seedSubagentSessionFile({
			mode: behavior.seed,
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
		const activityFile = deps.getSubagentActivityFile(state.artifactDir, state.id);
		mkdirSync(dirname(activityFile), { recursive: true });
		return {
			activityFile,
			entryCountBefore: getNewEntries(state.subagentSessionFile, 0).length,
			fullTask: buildLaunchTask(state.params.task, behavior.inheritsConversationContext),
		};
	}

	function registerSessionRollbacks(state: LaunchState): void {
		state.launchTransaction.own(() => rmSync(`${state.subagentSessionFile}.owner.json`, { force: true }));
		state.launchTransaction.own(() => rmSync(state.subagentSessionFile, { force: true }));
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
			launchScriptFile: join(state.artifactDir, "subagent-scripts", `${state.params.agent}-${state.id}.sh`),
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
		writeLaunchArtifact(state, path, prompt.content);
		parts.push(prompt.flag, shellQuote(path));
	}

	function systemPromptPath(state: LaunchState): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		return join(
			state.artifactDir,
			`context/${state.params.agent || "subagent"}-sysprompt-${timestamp}-${state.id}.md`,
		);
	}

	function writeLaunchArtifact(state: LaunchState, path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		state.launchTransaction.own(() => rmSync(path, { force: true }));
		writeFileSync(path, content, "utf8");
		state.rollbackPaths.push(path);
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
			`PI_SUBAGENT_ID=${shellQuote(state.id)}`,
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
		writeLaunchArtifact(state, path, fullTask);
		return `@${path}`;
	}

	function taskArtifactPath(state: LaunchState): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		return join(
			state.artifactDir,
			`context/${deps.buildLaunchArtifactName(state.params.agent, timestamp, state.id)}`,
		);
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
		state.launchTransaction.own(() => rmSync(launchCommand.launchScriptFile, { force: true }));
		state.launchTransaction.throwIfAborted();
		state.launchTransaction.advance("script");
		state.rollbackPaths.push(launchCommand.launchScriptFile);
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
		cleanupRollbackPaths(state.rollbackPaths);
	}

	function cleanupLaunchSurface(state: LaunchState): void {
		if (!state.surface || state.surfacePreCreated) return;
		const parentPaneId = process.env.HERDR_PANE_ID;
		if (parentPaneId) closeAttachedSurface(parentPaneId, state.surface);
	}

	function cleanupRollbackPaths(paths: string[]): void {
		for (const path of paths.reverse()) {
			try {
				rmSync(path, { force: true });
			} catch {}
		}
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
			const result = await waitForRunCompletion(running, signal, options);
			return settleWatchedCompletion(running, result);
		} catch (error) {
			return handleWatchFailure(running, signal, error);
		} finally {
			finalizeWatchOwnership(running, options);
		}
	}

	function waitForRunCompletion(
		running: RunningSubagent,
		signal: AbortSignal,
		options: { timeoutMs?: number },
	): Promise<CompletionResult> {
		return waitForCompletion(signal, {
			intervalMs: 1000,
			sessionFile: running.sessionFile,
			expectedRunId: running.id,
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
		const disposition = applySettlementDisposition(running, completion.reason);
		running.lifecycle = terminalLifecycle(running, completion, summary);
		return completionResult(running, completion, summary, detectedAt, disposition.watchAbandoned);
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
		return {
			name: running.name,
			task: running.task,
			summary,
			sessionFile: running.sessionFile,
			exitCode: completion.exitCode,
			elapsed: Math.floor((detectedAt - running.startTime) / 1000),
			...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
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
		const presentation = deps.resolveResultPresentation(result, running.name, running.id);
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
