import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import {
	type ActivityReadResult,
	getSubagentActivityFile,
	readSubagentActivityFile,
	type SubagentActivityState,
} from "./activity.ts";
import {
	type AgentDefinition,
	loadAgentDefinition,
	parseAgentDefinition,
	validateCanonicalAgentId,
} from "./agent-definition.ts";
import { getAdmissionCoordinator } from "./coordinator.ts";
import {
	type ActiveCompletionRuntime,
	acknowledgeDelivery,
	activateCompletionRuntime,
	DEFERRED_DELIVERY_MAX_MS,
	deactivateCompletionRuntime,
	deliverBackgroundMessage,
	deliveryEntryExists,
	findDeliveryEntry,
	isSessionRuntimeUnavailable,
	MAX_PENDING_DELIVERY_ATTEMPTS,
	PRIMARY_DELIVERY_GRACE_MS,
	queuePendingDeliveryWithVerification,
	requireActiveCompletionRuntime,
	resetActiveCompletionRuntimeForTest,
	resolveActiveCompletionRuntime,
	retryPendingDeliveries,
	SessionRuntimeUnavailableError,
	startDeliveryRetry,
	stopDeliveryRetry,
	verifyDeliveryPersisted,
	WAKE_MESSAGE,
} from "./delivery.ts";
import { getForegroundDeliveryBarrier } from "./delivery-barrier.ts";
import { abortAllLaunchTransactions } from "./launch-transaction.ts";
import type { LayoutDirection, LayoutMode, SurfaceMode } from "./layout.ts";
import {
	createLifecycle,
	formatLifecycleTransitionLine,
	lifecycleTransition,
	markDelivery,
	markInterruptRequested,
	markProcessRunning,
	observeActivity,
	observePaneInspection,
	projectLifecycle,
	type SubagentLifecycle,
} from "./lifecycle.ts";
import { parseSelectedSkillNames, resolveSelectedSkills } from "./skills.ts";
import {
	DELIVERY_RETRY_INTERVAL_KEY,
	deliveredRunIds,
	inflightDelivery,
	pendingDeliveries,
	queuedSubagents,
	runningSubagents,
	runtime,
	STATUS_INTERVAL_KEY,
	stickyTerminalRuns,
	WIDGET_INTERVAL_KEY,
	wakeInflightByParent,
} from "./state.ts";
import {
	capStatusLines,
	DEFAULT_STATUS_LINE_LIMIT,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
} from "./status.ts";
import { createSubagentLaunchService } from "./subagent-launch.ts";
import { runScriptInPane } from "./terminal.ts";
import { createToolExecute } from "./tool-execute.ts";
import type {
	PendingDelivery,
	QueuedSubagent,
	RunningSubagent,
	StableParentContext,
	StickyTerminalRun,
	SubagentResult,
} from "./types.ts";
import {
	buildWidgetRunIdLabels,
	formatElapsed,
	formatWidgetDuration,
	MAX_QUEUED_WIDGET_ROWS,
	MAX_STICKY_WIDGET_ROWS,
	MIN_WIDGET_RUN_ID_LENGTH,
	renderSubagentResultMessage,
	renderSubagentStatusMessage,
	renderSubagentToolCall,
	renderSubagentToolResult,
	renderSubagentWidget,
	renderSubagentWidgetLines as renderSubagentWidgetLinesRaw,
	sanitizeWidgetText,
} from "./widget.ts";

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
// Per-module-load ownership tokens for presentation timers. Delivery retry is
// deliberately owner-neutral and process-global: old watcher closures may
// enqueue work after a replacement module has already activated.
const WIDGET_OWNER_KEY = Symbol.for("pi-subagent-herdr/widget-interval-owner");
const STATUS_OWNER_KEY = Symbol.for("pi-subagent-herdr/status-interval-owner");
const WIDGET_OWNER = {};
const STATUS_OWNER = {};
let widgetInterval: ReturnType<typeof setInterval> | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Claim shared presentation/retry timer ownership for a session-bound module.
 *
 * This must run only from `session_start`. In particular, do not perform this
 * takeover at module evaluation: selected-skill discovery can evaluate a fresh
 * module without ever starting a session, and such a discovery module must not
 * clear timers owned by the live extension. A real session replacement may claim
 * ownership here and stop the old module's timers before starting its own.
 */
function claimTimerOwnership(): void {
	const globals = globalThis as any;
	const claim = (timerKey: symbol, ownerKey: symbol, owner: object): void => {
		if (globals[ownerKey] === owner) return;
		const previous = globals[timerKey];
		if (previous) clearInterval(previous);
		globals[timerKey] = null;
		globals[ownerKey] = owner;
	};
	claim(WIDGET_INTERVAL_KEY, WIDGET_OWNER_KEY, WIDGET_OWNER);
	claim(STATUS_INTERVAL_KEY, STATUS_OWNER_KEY, STATUS_OWNER);
}

const SubagentParams = Type.Object({
	agent: Type.String({
		description:
			"Canonical agent ID. Resolves trusted project `.pi/agents/<id>.md`, then the global Pi agent directory.",
	}),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	label: Type.Optional(Type.String({ description: "Presentation-only run label; never changes agent authority" })),
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"When true, suspend until this foreground run settles and return its final text as the tool result.",
		}),
	),
	layout: Type.Optional(
		Type.Union([Type.Literal("attached"), Type.Literal("single")], {
			description: 'Pane layout mode. "attached" (default) stacks children; "single" isolates one split.',
		}),
	),
	surface: Type.Optional(
		Type.Union([Type.Literal("pane"), Type.Literal("tab")], {
			description: 'Herdr surface. "pane" (default) or "tab".',
		}),
	),
	direction: Type.Optional(
		Type.Union([Type.Literal("right"), Type.Literal("down")], {
			description: 'Attached layout axis: "right" (default) or "down".',
		}),
	),
});

/** Lifecycle tools always denied in every child (no nested spawns). */
const LIFECYCLE_DENY_TOOLS = ["subagent"] as const;

function lifecycleDenySet(): Set<string> {
	return new Set<string>(LIFECYCLE_DENY_TOOLS);
}

function resolveEffectiveSeed(agentDefs: AgentDefinition): "fresh" | "fork" {
	return agentDefs.seed;
}

function resolveLaunchBehavior(agentDefs: AgentDefinition): {
	seed: "fresh" | "fork";
	inheritsConversationContext: boolean;
	taskDelivery: "direct" | "artifact";
} {
	const seed = resolveEffectiveSeed(agentDefs);
	const inheritsConversationContext = seed === "fork";
	return {
		seed,
		inheritsConversationContext,
		taskDelivery: inheritsConversationContext ? "direct" : "artifact",
	};
}

function loadAgentDefaults(agentName: string, projectTrusted = true, cwd = process.cwd()): AgentDefinition {
	return loadAgentDefinition({
		id: agentName,
		cwd,
		agentDir: getAgentDir(),
		projectTrusted,
	});
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
	const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
	return join(sessionDir, "artifacts", sessionId);
}

const STATUS_LINE_LIMIT = DEFAULT_STATUS_LINE_LIMIT;

/** Hard-coded spawn defaults; per-call tool args still override via resolve helpers. */
interface ExtensionDefaults {
	blocking: boolean;
	layout: LayoutMode;
	surface: SurfaceMode;
	direction: LayoutDirection;
}

const EXTENSION_DEFAULTS: ExtensionDefaults = {
	blocking: false,
	layout: "attached",
	surface: "pane",
	direction: "right",
};
const extensionDefaults = EXTENSION_DEFAULTS;

/** Append layout min-size warning to tool-result text when present. */
function appendLayoutWarning(text: string, warning?: string): string {
	if (!warning) return text;
	return `${text}

Layout warning: ${warning}`;
}

function resolveBlocking(
	params: Static<typeof SubagentParams>,
	defaults: ExtensionDefaults = extensionDefaults,
): boolean {
	if (params.blocking != null) return params.blocking;
	return defaults.blocking;
}

function resolveLayout(params: { layout?: LayoutMode }, defaults: ExtensionDefaults = extensionDefaults): LayoutMode {
	return params.layout ?? defaults.layout;
}

function resolveSurface(
	params: { surface?: SurfaceMode },
	defaults: ExtensionDefaults = extensionDefaults,
): SurfaceMode {
	return params.surface ?? defaults.surface;
}

function resolveDirection(
	params: { direction?: LayoutDirection },
	defaults: ExtensionDefaults = extensionDefaults,
): LayoutDirection {
	return params.direction ?? defaults.direction;
}

function resolveResultPresentation(
	result: Pick<
		SubagentResult,
		"exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "watchAbandoned"
	>,
	name: string,
	runId?: string,
): string {
	const who = `"${name}"${runId ? ` [${runId}]` : ""}`;
	const sessionRef = result.sessionFile ? `\n\nSession log: ${result.sessionFile}` : "";

	if (result.watchAbandoned) {
		// Neither a child failure nor a provider error: watching stopped without
		// evidence, so the outcome is unknown. The child may have produced real
		// output and its pane may still be alive, so never claim it produced no
		// result — report the uncertainty and point at what is recoverable.
		return (
			`Sub-agent ${who} — watch abandoned after ${formatElapsed(result.elapsed)}. ` +
			`No completion evidence was recorded, so monitoring stopped.\n\n` +
			(result.errorMessage ? `Detail: ${result.errorMessage}\n\n` : "") +
			`This is not a reported failure: the run's outcome is unknown. Its pane was ` +
			`left open for inspection and its capacity slot released. Any output it did ` +
			`produce is below and in its session log.\n\n${result.summary}${sessionRef}`
		);
	}

	if (result.errorMessage) {
		// Auto-retry exhausted or other agent-loop error. The subagent did not
		// produce a usable result — surface the underlying provider/network
		// failure so the orchestrator can decide whether to retry or change
		// approach instead of silently treating the run as completed.
		return (
			`Sub-agent ${who} failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent; the user can inspect or continue it directly from its pane.${sessionRef}`
		);
	}

	return result.exitCode !== 0
		? `Sub-agent ${who} failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
		: `Sub-agent ${who} completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */

/**
 * State for a launched (but not yet completed) subagent.
 */

/** Plain, reload-safe inputs captured before a queued launch is admitted.
 * Never retain ExtensionContext in a continuation that survives /reload. */

function snapshotParentContext(ctx: ExtensionContext): StableParentContext {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionDir = ctx.sessionManager.getSessionDir();
	return {
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		projectTrusted: ctx.isProjectTrusted(),
		sessionFile,
		sessionId,
		sessionDir,
	};
}

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
	return reason === "reload";
}

export function cleanupSubagentsForShutdown(
	reason: unknown,
	agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
	if (shouldPreserveSubagentsOnShutdown(reason)) return;

	for (const agent of agents.values()) {
		if (agent.lifecycle) {
			agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
		}
		agent.abortController?.abort();
	}
	agents.clear();
}

export function shouldDeliverSubagentCompletion(running: Pick<RunningSubagent, "lifecycle">): boolean {
	// Authoritative gate: only pending deliveries may be sent.
	// Missing lifecycle (pre-migration fixtures) defaults to pending/true.
	return (running.lifecycle?.delivery ?? "pending") === "pending";
}

function updateWidget() {
	const latestCtx = runtime.latestCtx;
	if (!latestCtx?.hasUI) return;

	if (
		runningSubagents.size === 0 &&
		queuedSubagents.size === 0 &&
		pendingDeliveries.size === 0 &&
		stickyTerminalRuns.size === 0
	) {
		latestCtx.ui.setWidget("subagent-status", undefined);
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			if ((globalThis as any)[WIDGET_OWNER_KEY] === WIDGET_OWNER) (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
		}
		return;
	}

	latestCtx.ui.setWidget(
		"subagent-status",
		(_tui: any, theme: Theme) => {
			return {
				invalidate() {},
				render: renderSubagentWidget.bind(undefined, theme, ensureLifecycle),
			};
		},
		{ placement: "aboveEditor" },
	);
}

const SUBAGENT_CONTROL_TOOLS = ["subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * completion control from subagent-done.ts would otherwise be hidden.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string {
	if (typeof effectiveTools !== "string" || effectiveTools.trim() === "") {
		throw new Error("Invalid subagent tools profile: an explicit non-empty allowlist is required.");
	}
	const requested = effectiveTools.split(",").map((tool) => tool.trim());
	if (requested.length === 0 || requested.some((tool) => tool === "")) {
		throw new Error("Invalid subagent tools profile: an explicit non-empty allowlist is required.");
	}
	const allow = new Set(requested);
	for (const tool of SUBAGENT_CONTROL_TOOLS) {
		allow.add(tool);
	}
	return [...allow].join(",");
}

function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
	if (running.lifecycle) return running.lifecycle;
	running.lifecycle = hydrateLifecycleFromStatus(running);
	return running.lifecycle;
}

function hydrateLifecycleFromStatus(running: RunningSubagent): SubagentLifecycle {
	const lifecycle = createLifecycle(running.startTime);
	const state = running.statusState;
	if (state?.activityLabel === "interrupted" && state.localOverrideAtMs != null) {
		return markInterruptRequested(lifecycle, state.localOverrideAtMs);
	}
	if (state?.phase === "done") return hydrateDoneLifecycle(lifecycle, state, running.startTime);
	if (state && isHydratableActivityPhase(state.phase))
		return hydrateActivityLifecycle(lifecycle, state, running, state.phase);
	return running.startTime ? markProcessRunning(lifecycle, running.startTime) : lifecycle;
}

function hydrateDoneLifecycle(
	lifecycle: SubagentLifecycle,
	state: NonNullable<RunningSubagent["statusState"]>,
	startedAt: number,
): SubagentLifecycle {
	const observedAt = state.lastActivityAtMs ?? startedAt;
	return observePaneInspection(lifecycle, { kind: "present", observedAt, agentStatus: "done" }, observedAt);
}

function isHydratableActivityPhase(
	phase: NonNullable<RunningSubagent["statusState"]>["phase"] | undefined,
): phase is "active" | "waiting" | "starting" {
	return phase === "active" || phase === "waiting" || phase === "starting";
}

function hydrateActivityLifecycle(
	lifecycle: SubagentLifecycle,
	state: NonNullable<RunningSubagent["statusState"]>,
	running: RunningSubagent,
	phase: "active" | "waiting" | "starting",
): SubagentLifecycle {
	const observedAt = state.lastActivityAtMs ?? running.startTime;
	return observeActivity(
		lifecycle,
		{ ok: true, activity: hydrationActivity(state, running, observedAt, phase) },
		observedAt,
	);
}

function hydrationActivity(
	state: NonNullable<RunningSubagent["statusState"]>,
	running: RunningSubagent,
	observedAt: number,
	phase: "active" | "waiting" | "starting",
): SubagentActivityState {
	return {
		version: 1,
		runningChildId: running.id,
		createdAt: running.startTime,
		updatedAt: observedAt,
		sequence: state.lastActivitySequence ?? 0,
		latestEvent: hydrationLatestEvent(state.latestEvent),
		...hydrationActivityFlags(phase, state.activeScope),
		...hydrationActivityTiming(state),
		...hydrationToolName(state),
	};
}

function hydrationLatestEvent(value: string | null): SubagentActivityState["latestEvent"] {
	return value === "agent_end" ? "agent_end" : "agent_start";
}

function hydrationActivityFlags(
	phase: "active" | "waiting" | "starting",
	activeScope: string | null,
): Pick<
	SubagentActivityState,
	"phase" | "agentActive" | "turnActive" | "providerActive" | "toolActive" | "activeScope"
> {
	const active = phase === "active";
	return {
		phase,
		agentActive: active,
		turnActive: active,
		providerActive: false,
		toolActive: activeScope === "tool",
		...(activeScope ? { activeScope: activeScope as SubagentActivityState["activeScope"] } : {}),
	};
}

function hydrationActivityTiming(
	state: NonNullable<RunningSubagent["statusState"]>,
): Pick<SubagentActivityState, "activeSince" | "waitingSince"> {
	return {
		...(state.activeSinceMs != null ? { activeSince: state.activeSinceMs } : {}),
		...(state.waitingSinceMs != null ? { waitingSince: state.waitingSinceMs } : {}),
	};
}

function hydrationToolName(
	state: NonNullable<RunningSubagent["statusState"]>,
): Pick<SubagentActivityState, "toolName"> {
	return state.activityLabel && state.activeScope === "tool" ? { toolName: state.activityLabel } : {};
}

/** Preserve the historical test helper's legacy lifecycle hydration boundary. */
function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
	theme: Theme,
	queued: QueuedSubagent[] = [],
	pending: PendingDelivery[] = [],
	sticky: StickyTerminalRun[] = [],
): string[] {
	return renderSubagentWidgetLinesRaw(agents, width, theme, queued, pending, sticky, ensureLifecycle);
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
	ensureLifecycle(running);

	const activityFile = running.activityFile;
	const read: ActivityReadResult = activityFile
		? readSubagentActivityFile(activityFile, running.id)
		: { ok: false, reason: "missing" };

	if (read.ok === true) {
		running.activityRead = { ok: true };
	} else {
		running.activityRead = { ok: false, reason: read.reason, ...(read.error ? { error: read.error } : {}) };
	}

	if (read.ok) running.activity = read.activity;
	running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

function startStatusRefresh() {
	if ((globalThis as any)[STATUS_OWNER_KEY] !== STATUS_OWNER) return;
	if (statusInterval) return;
	statusInterval = setInterval(tickStatusRefresh, 1000);
	(globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function tickStatusRefresh(): void {
	if (stopStatusRefreshWhenIdle()) return;
	const { transitionLines, shouldRefreshWidget } = collectStatusTransitions(Date.now());
	if (shouldRefreshWidget) updateWidget();
	deliverStatusTransitions(transitionLines);
}

function stopStatusRefreshWhenIdle(): boolean {
	if (runningSubagents.size > 0 || pendingDeliveries.size > 0) return false;
	if (!statusInterval) return true;
	clearInterval(statusInterval);
	statusInterval = null;
	if ((globalThis as any)[STATUS_OWNER_KEY] === STATUS_OWNER) (globalThis as any)[STATUS_INTERVAL_KEY] = null;
	return true;
}

function collectStatusTransitions(now: number): { transitionLines: string[]; shouldRefreshWidget: boolean } {
	const transitionLines: string[] = [];
	let shouldRefreshWidget = false;
	for (const running of runningSubagents.values()) {
		const transition = observeStatusTransition(running, now);
		shouldRefreshWidget ||= transition.changed;
		if (transition.line) transitionLines.push(transition.line);
	}
	return { transitionLines, shouldRefreshWidget };
}

function observeStatusTransition(running: RunningSubagent, now: number): { changed: boolean; line?: string } {
	// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
	observeRunningSubagent(running, now);
	const projection = projectLifecycle(ensureLifecycle(running), now);
	const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
	const changed = running.lastProjectedKind !== projection.kind;
	running.lastProjectedKind = projection.kind;
	if (!transition || running.suppressStatusSteer) return { changed };
	return {
		changed,
		line: formatLifecycleTransitionLine(
			normalizeStatusName(running.name),
			projection,
			transition,
			now,
			running.startTime,
			formatElapsedDuration,
		),
	};
}

function deliverStatusTransitions(transitionLines: string[]): void {
	if (transitionLines.length === 0) return;
	const parentSessionId = runtime.latestCtx?.sessionManager.getSessionId();
	if (!parentSessionId || !resolveActiveCompletionRuntime(parentSessionId)) return;
	const capped = capStatusLines(transitionLines, STATUS_LINE_LIMIT);
	void deliverBackgroundMessage(undefined, parentSessionId, {
		customType: "subagent_status",
		content: formatStatusAggregate(transitionLines, STATUS_LINE_LIMIT),
		display: true,
		details: { lines: capped.visibleLines, overflow: capped.overflow },
	}).catch(() => undefined);
}

const {
	applySettlementDisposition,
	captureStickyLaunchFailure,
	captureStickyTerminalRun,
	classifyStickyTerminal,
	clearStickyTerminalsOnAdmission,
	commitRunningLaunch,
	failLaunch,
	launchSubagent,
	preserveErrorPane,
	releaseRunOwnership,
	safeCloseAndReap,
	startBackgroundSpawn,
	startErrorPaneMonitor,
	watchSubagent,
	resolveSettlementDisposition,
} = createSubagentLaunchService({
	resolveBlocking,
	resolveLayout,
	resolveSurface,
	resolveDirection,
	resolveLaunchBehavior,
	lifecycleDenySet,
	buildSystemPromptFileContent,
	buildSubagentToolAllowlist,
	buildLaunchArtifactName,
	safeCommentValue,
	createRunId,
	getArtifactDir,
	getShellReadyDelayMs,
	getSubagentActivityFile,
	runScriptInPane,
	createLifecycle,
	ensureLifecycle,
	observeRunningSubagent,
	updateWidget,
	startWidgetRefresh,
	startStatusRefresh,
	resolveResultPresentation,
	shouldDeliverSubagentCompletion,
});

const executeSubagentTool = createToolExecute({
	snapshotParentContext,
	resolveBlocking,
	createRunId,
	clearStickyTerminalsOnAdmission,
	startBackgroundSpawn,
	captureStickyLaunchFailure,
	launchSubagent,
	watchSubagent,
	commitRunningLaunch,
	failLaunch,
	releaseRunOwnership,
	captureStickyTerminalRun,
	updateWidget,
	startWidgetRefresh,
	startStatusRefresh,
	appendLayoutWarning,
	resolveResultPresentation,
	shouldDeliverSubagentCompletion,
});

export const __test__ = {
	formatWidgetDuration,
	getShellReadyDelayMs,
	renderSubagentWidgetLines,
	loadAgentDefaults,
	loadAgentDefinition,
	parseAgentDefinition,
	validateCanonicalAgentId,
	buildActiveAgentTag,
	buildSystemPromptFileContent,
	resolveEffectiveSeed,
	resolveLaunchBehavior,
	resolveBlocking,
	resolveLayout,
	resolveSurface,
	resolveDirection,
	EXTENSION_DEFAULTS,
	appendLayoutWarning,
	buildSubagentToolAllowlist,
	buildLaunchArtifactName,
	safeCommentValue,
	parseSelectedSkillNames,
	resolveSelectedSkills,
	observeRunningSubagent,
	lifecycleDenySet,
	LIFECYCLE_DENY_TOOLS,
	queuedSubagents,
	stickyTerminalRuns,
	classifyStickyTerminal,
	captureStickyTerminalRun,
	captureStickyLaunchFailure,
	clearStickyTerminalsOnAdmission,
	updateWidget,
	resolveResultPresentation,
	resolveSettlementDisposition,
	applySettlementDisposition,
	watchSubagent,
	runningSubagents,
	formatElapsed,
	verifyDeliveryPersisted,
	deliveryEntryExists,
	findDeliveryEntry,
	deliverBackgroundMessage,
	acknowledgeDelivery,
	WAKE_MESSAGE,
	sanitizeWidgetText,
	PRIMARY_DELIVERY_GRACE_MS,
	deliveredRunIds,
	inflightDelivery,
	parentActivity: runtime.parentActivity,
	preserveErrorPane,
	startErrorPaneMonitor,
	pendingDeliveries,
	MAX_QUEUED_WIDGET_ROWS,
	MAX_STICKY_WIDGET_ROWS,
	MIN_WIDGET_RUN_ID_LENGTH,
	buildWidgetRunIdLabels,
	DEFERRED_DELIVERY_MAX_MS,
	MAX_PENDING_DELIVERY_ATTEMPTS,
	SessionRuntimeUnavailableError,
	isSessionRuntimeUnavailable,
	requireActiveCompletionRuntime,
	resolveActiveCompletionRuntime,
	activateCompletionRuntime,
	deactivateCompletionRuntime,
	timerSnapshot() {
		const globals = globalThis as any;
		return {
			widget: globals[WIDGET_INTERVAL_KEY],
			status: globals[STATUS_INTERVAL_KEY],
			deliveryRetry: globals[DELIVERY_RETRY_INTERVAL_KEY],
		};
	},
	/** Test-only: keep repeated in-process factory invocations order-independent. */
	resetActiveCompletionRuntime: resetActiveCompletionRuntimeForTest,
	startDeliveryRetry,
	stopDeliveryRetry,
	retryPendingDeliveries,
	queuePendingDeliveryWithVerification,
	getForegroundDeliveryBarrier,
	snapshotParentContext,
	setLatestWidgetContext(ctx: ExtensionContext | undefined) {
		runtime.latestCtx = ctx;
	},
};

function startWidgetRefresh() {
	if ((globalThis as any)[WIDGET_OWNER_KEY] !== WIDGET_OWNER) return;
	if (widgetInterval) return;
	updateWidget(); // immediate first render
	widgetInterval = setInterval(() => {
		updateWidget();
	}, 1000);
	(globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */

/**
 * Pi-only backend guard. Agents may omit `cli` (implied pi) or set `cli: pi`.
 * Any other value fails with a clear error.
 */

/** Build the canonical permission identity tag. */
function buildActiveAgentTag(agentName: string): string {
	return `<active_agent name="${validateCanonicalAgentId(agentName)}"/>`;
}

/** The canonical identity tag and Markdown body are always appended exactly once. */
export function buildSystemPromptFileContent(options: { agentName: string; identity: string }): {
	content: string;
	flag: "--append-system-prompt";
} {
	const tag = buildActiveAgentTag(options.agentName);
	return {
		content: options.identity ? `${tag}\n${options.identity}` : tag,
		flag: "--append-system-prompt",
	};
}

export function buildLaunchArtifactName(agentName: string, timestamp: string, runId: string): string {
	return `${agentName || "subagent"}-${timestamp}-${runId}.md`;
}

function createRunId(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Strip line-breaking and control characters so a value is safe to embed in a
 * single shell-comment line. Without this, a model-supplied session path containing
 * a newline (legal in POSIX filenames) could break out of a `# Session: <path>`
 * comment in the launch script and execute arbitrary shell.
 */
export function safeCommentValue(value: string): string {
	// eslint-disable-next-line no-control-regex -- stripping control chars is the purpose of this sanitizer
	return value.replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]/g, " ").trim();
}

interface ShutdownState {
	queued: Map<string, QueuedSubagent>;
	running: Map<string, RunningSubagent>;
	pending: Map<string, PendingDelivery>;
}

type ShutdownOperations = {
	safeClose?: (running: RunningSubagent) => void;
	release?: (running: RunningSubagent) => void;
	abortTransactions?: () => void;
};

export function settleParentShutdown(
	reason: unknown,
	parentSessionId: string,
	state: ShutdownState = { queued: queuedSubagents, running: runningSubagents, pending: pendingDeliveries },
	ops: ShutdownOperations = {},
): void {
	const safeClose = ops.safeClose ?? safeCloseAndReap;
	const release = ops.release ?? releaseRunOwnership;
	if (shouldPreserveSubagentsOnShutdown(reason)) {
		settleReloadShutdown(state, safeClose, release);
		return;
	}
	settleTerminalShutdown(
		reason,
		parentSessionId,
		state,
		safeClose,
		release,
		ops.abortTransactions ?? abortAllLaunchTransactions,
	);
}

function settleReloadShutdown(
	state: ShutdownState,
	safeClose: (running: RunningSubagent) => void,
	release: (running: RunningSubagent) => void,
): void {
	cancelForegroundQueuedSubagents(state.queued);
	reapForegroundRunningSubagents(state.running, safeClose, release);
}

function cancelForegroundQueuedSubagents(queued: Map<string, QueuedSubagent>): void {
	for (const entry of Array.from(queued.values())) {
		if (entry.admissionClass !== "foreground") continue;
		entry.cancel();
		queued.delete(entry.id);
	}
}

function reapForegroundRunningSubagents(
	running: Map<string, RunningSubagent>,
	safeClose: (running: RunningSubagent) => void,
	release: (running: RunningSubagent) => void,
): void {
	for (const entry of Array.from(running.values())) {
		if (entry.admissionClass !== "foreground") continue;
		entry.lifecycle = markDelivery(entry.lifecycle, "suppressed");
		entry.abortController?.abort();
		closeAndReleaseRunning(entry, safeClose, release);
		running.delete(entry.id);
	}
}

function settleTerminalShutdown(
	reason: unknown,
	parentSessionId: string,
	state: ShutdownState,
	safeClose: (running: RunningSubagent) => void,
	release: (running: RunningSubagent) => void,
	abortTransactions: () => void,
): void {
	getForegroundDeliveryBarrier(parentSessionId).suppressPending();
	for (const pending of state.pending.values()) pending.exhausted = true;
	state.pending.clear();
	for (const entry of state.queued.values()) entry.cancel();
	state.queued.clear();
	getAdmissionCoordinator(parentSessionId).shutdownNow();
	abortTransactions();
	for (const entry of state.running.values()) closeAndReleaseRunning(entry, safeClose, release);
	cleanupSubagentsForShutdown(reason, state.running);
}

function closeAndReleaseRunning(
	running: RunningSubagent,
	safeClose: (running: RunningSubagent) => void,
	release: (running: RunningSubagent) => void,
): void {
	safeClose(running);
	release(running);
	running.foregroundBarrierLease?.release();
}

interface SubagentsExtensionInstanceState {
	ownedCompletionRuntime?: ActiveCompletionRuntime;
}

function handleParentAgentStart(): void {
	runtime.parentActivity.streaming = true;
	runtime.parentActivity.turnStartedAtMs = Date.now();
	wakeInflightByParent.clear();
}

function handleParentAgentSettled(): void {
	runtime.parentActivity.streaming = false;
}

function handleParentSessionStart(
	pi: ExtensionAPI,
	instanceState: SubagentsExtensionInstanceState,
	ctx: ExtensionContext,
): void {
	claimTimerOwnership();
	runtime.latestCtx = ctx;
	const parentSessionId = ctx.sessionManager.getSessionId();
	instanceState.ownedCompletionRuntime = activateCompletionRuntime(pi, parentSessionId);
	getAdmissionCoordinator(parentSessionId); // in-place upgrade of pre-reload coordinator state
	getForegroundDeliveryBarrier(parentSessionId).reconcileActive(activeForegroundRunIds());
	redriveDeferredPendingDeliveries(parentSessionId);
	void retryPendingDeliveries().catch(() => undefined);
	if (pendingDeliveries.size > 0) startDeliveryRetry();
	startPresentationTimersIfNeeded();
}

function activeForegroundRunIds(): string[] {
	return [...foregroundQueuedIds(), ...foregroundRunningIds()];
}

function foregroundQueuedIds(): string[] {
	return Array.from(queuedSubagents.values())
		.filter((entry) => entry.admissionClass === "foreground")
		.map((entry) => entry.id);
}

function foregroundRunningIds(): string[] {
	return Array.from(runningSubagents.values())
		.filter((entry) => entry.admissionClass === "foreground")
		.map((entry) => entry.id);
}

function redriveDeferredPendingDeliveries(parentSessionId: string): void {
	for (const pending of pendingDeliveries.values()) {
		if (!shouldRedrivePendingDelivery(pending, parentSessionId)) continue;
		pending.exhausted = false;
		delete pending.exhaustionCause;
		pending.delivering = false;
		delete pending.deferredSince;
		pending.nextRetryAt = Date.now();
	}
}

function shouldRedrivePendingDelivery(pending: PendingDelivery, parentSessionId: string): boolean {
	if (pending.parentSessionId !== parentSessionId || pending.deferredSince === undefined) return false;
	return !pending.exhausted || resettableDeferralExhaustion(pending.exhaustionCause);
}

function resettableDeferralExhaustion(cause: PendingDelivery["exhaustionCause"]): boolean {
	return cause === "deferral" || cause === undefined;
}

function startPresentationTimersIfNeeded(): void {
	if (!hasPresentationWork()) return;
	startWidgetRefresh();
	if (runningSubagents.size > 0 || pendingDeliveries.size > 0) startStatusRefresh();
	updateWidget();
}

function hasPresentationWork(): boolean {
	return (
		runningSubagents.size > 0 ||
		queuedSubagents.size > 0 ||
		pendingDeliveries.size > 0 ||
		stickyTerminalRuns.size > 0
	);
}

function handleParentSessionShutdown(
	instanceState: SubagentsExtensionInstanceState,
	event: any,
	ctx: ExtensionContext,
): void {
	// Deactivate only OUR record: during reload/session replacement the new
	// instance may already have activated its own runtime, and this old
	// closure must never clear or send through it.
	deactivateCompletionRuntime(instanceState.ownedCompletionRuntime);
	instanceState.ownedCompletionRuntime = undefined;
	if (widgetInterval) {
		clearInterval(widgetInterval);
		widgetInterval = null;
		if ((globalThis as any)[WIDGET_OWNER_KEY] === WIDGET_OWNER) (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
	}
	if (statusInterval) {
		clearInterval(statusInterval);
		statusInterval = null;
		if ((globalThis as any)[STATUS_OWNER_KEY] === STATUS_OWNER) (globalThis as any)[STATUS_INTERVAL_KEY] = null;
	}
	// Retry is a process-global service, not presentation owned by this module.
	// Keep it alive through reload gaps so pending work remains bounded and old
	// watcher closures can enqueue after replacement activation. Only terminal
	// shutdown suppresses pending work and stops the service.
	if (event.reason !== "reload") stopDeliveryRetry();
	// Clear the in-memory delivery dedup set on terminal shutdown (not reload).
	// On reload, the set is preserved so in-flight deliveries aren't duplicated.
	if (event.reason !== "reload") {
		deliveredRunIds.clear();
		stickyTerminalRuns.clear();
	}

	settleParentShutdown(event.reason, ctx.sessionManager.getSessionId());
}

function shouldRegisterSubagentTool(): boolean {
	// Hard gate: children never register lifecycle tools (Phase 11), independent of denylist env.
	const isChildSubagent = Boolean(process.env.PI_SUBAGENT_ID);
	const deniedTools = new Set(
		(isChildSubagent ? (process.env.PI_DENY_TOOLS ?? "") : "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);
	for (const name of LIFECYCLE_DENY_TOOLS) {
		if (isChildSubagent) deniedTools.add(name);
	}
	return !isChildSubagent && !deniedTools.has("subagent");
}

function registerSubagentTool(pi: ExtensionAPI): void {
	if (!shouldRegisterSubagentTool()) return;
	(pi.registerTool as any)({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a sub-agent in a dedicated herdr surface (pane or tab). " +
			"Default is async (fire-and-forget): the call returns immediately and the harness steers the result back when the child finishes. " +
			"Pass blocking: true to await the child's final text as the tool result instead of a steer. " +
			"The child auto-exits on normal completion (errors may leave the surface open) and always opens a real surface. " +
			"DO NOT fabricate results. After an async spawn, end your turn or work on other independent tasks.",
		promptSnippet:
			"Spawn a sub-agent in a herdr surface (pane or tab). Async (default): returns immediately; the result is steered back when the child finishes. " +
			"blocking: true awaits the final text as the tool result (no steer). " +
			"The child auto-exits on normal completion (errors may leave the surface open) and always opens a real surface.",
		parameters: SubagentParams,
		execute(_toolCallId: any, params: any, signal: any, _onUpdate: any, ctx: ExtensionContext) {
			return executeSubagentTool(pi, _toolCallId, params, signal, _onUpdate, ctx);
		},
		renderCall: renderSubagentToolCall,
		renderResult: renderSubagentToolResult,
	});
}

function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
	(pi.registerMessageRenderer as any)("subagent_result", renderSubagentResultRenderer);
	(pi.registerMessageRenderer as any)("subagent_status", renderSubagentStatusRenderer);
}

function renderSubagentResultRenderer(message: any, options: any, theme: any) {
	if (!message.details) return undefined;
	return { render: renderSubagentResultMessage.bind(undefined, message, options, theme) };
}

function renderSubagentStatusRenderer(message: any, options: any, theme: any) {
	const details = message.details as any;
	const lines = Array.isArray(details?.lines) ? details.lines : [];
	const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
	if (lines.length === 0 && overflow === 0) return undefined;
	return { render: renderSubagentStatusMessage.bind(undefined, lines, overflow, options, theme) };
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const instanceState: SubagentsExtensionInstanceState = {};
	pi.on("agent_start", handleParentAgentStart);
	pi.on("agent_settled", handleParentAgentSettled);
	pi.on("session_start", (_event, ctx) => handleParentSessionStart(pi, instanceState, ctx));
	pi.on("session_shutdown", (event, ctx) => handleParentSessionShutdown(instanceState, event, ctx));
	registerSubagentTool(pi);
	registerSubagentMessageRenderers(pi);
}
