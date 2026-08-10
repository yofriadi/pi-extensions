import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open as openAsync, stat as statAsync } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
import type { CompletionResult } from "./completion.ts";
import { waitForCompletion } from "./completion.ts";
import { type AdmissionLease, getAdmissionCoordinator } from "./coordinator.ts";
import { type ForegroundBarrierLease, getForegroundDeliveryBarrier } from "./delivery-barrier.ts";
// Async, non-blocking pane probe for the preserved-pane monitor; terminal.ts does
// not re-export it, so import it from the herdr backend directly.
import { inspectHerdrPane } from "./herdr.ts";
import {
	abortAllLaunchTransactions,
	beginLaunchTransaction,
	finishLaunchTransaction,
	type LaunchTransaction,
} from "./launch-transaction.ts";
import {
	attachPaneSerialized,
	type LayoutDirection,
	type LayoutMode,
	rememberTuiSize,
	removePaneFromRegion,
	type SurfaceMode,
	tryRederiveRegionFromLayout,
} from "./layout.ts";
import {
	createLifecycle,
	formatLifecycleTransitionLine,
	type LifecycleProjection,
	lifecycleTransition,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markFailed,
	markInterruptRequested,
	markProcessRunning,
	observeActivity,
	observePaneInspection,
	type PaneInspection,
	projectLifecycle,
	type SubagentLifecycle,
} from "./lifecycle.ts";
import {
	type ResolvedRuntimePlan,
	resolveRuntimePlan,
	type ThinkingLevel,
	wrapPiModelRegistry,
} from "./runtime-routing.ts";
import {
	findLastAssistantMessage,
	findObservedSessionRuntime,
	getNewEntries,
	readSessionOwner,
	seedSubagentSessionFile,
} from "./session.ts";
import { getSessionLeaseRegistry, type SessionLease } from "./session-leases.ts";
import { getSettlementRegistry } from "./settlement.ts";
import { parseSelectedSkillNames, resolveSelectedSkills, type SelectedSkill } from "./skills.ts";
import {
	capStatusLines,
	DEFAULT_STATUS_LINE_LIMIT,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	type SubagentStatusState,
} from "./status.ts";
import {
	herdrPaneExists,
	inspectHerdrPaneSync,
	inspectPane,
	interruptPane,
	isTerminalAvailable,
	readPaneAsync,
	runScriptInPane,
	safeCloseSubagentPane,
	shellQuote,
	terminalSetupHint,
} from "./terminal.ts";

/** Absolute path to `src`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagent-herdr/runtime");
const DELIVERY_RETRY_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/delivery-retry-interval");
const COMPLETION_RUNTIME_GENERATION_KEY = Symbol.for("pi-subagent-herdr/completion-runtime-generation");
// Per-module-load ownership tokens for presentation timers. Delivery retry is
// deliberately owner-neutral and process-global: old watcher closures may
// enqueue work after a replacement module has already activated.
const WIDGET_OWNER_KEY = Symbol.for("pi-subagent-herdr/widget-interval-owner");
const STATUS_OWNER_KEY = Symbol.for("pi-subagent-herdr/status-interval-owner");
const WIDGET_OWNER = {};
const STATUS_OWNER = {};
// Session-bound completion API ownership. Deliberately a NEW key the old
// `runtime.pi` slot never touches: a mixed-version process (a package-installed
// older Herdr plus this working-tree load) cannot poison the active record,
// and an old closure cannot clear or send through a newer session's runtime.
const ACTIVE_COMPLETION_RUNTIME_KEY = Symbol.for("pi-subagent-herdr/active-completion-runtime");

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
const LIFECYCLE_DENY_TOOLS = ["subagent", "subagent_interrupt", "subagent_resume"] as const;

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

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
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

function muxUnavailableResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: `Subagents require herdr. ${terminalSetupHint()}`,
			},
		],
		details: { error: "herdr not available" },
	};
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
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";

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
		// failure so the orchestrator can decide whether to retry, resume, or
		// change approach instead of silently treating the run as completed.
		return (
			`Sub-agent ${who} failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with subagent_resume.${sessionRef}`
		);
	}

	return result.exitCode !== 0
		? `Sub-agent ${who} failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
		: `Sub-agent ${who} completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
	errorMessage?: string;
	ping?: { name: string; message: string };
	alreadySettled?: boolean;
	/**
	 * The watch deadline expired with no completion evidence. Distinct from a
	 * failure: monitoring stopped, the outcome is unknown, and the pane may still
	 * be alive. Presented separately so it never masquerades as a provider error.
	 */
	watchAbandoned?: boolean;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	parentSessionId?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: {
		ok: boolean;
		reason?: "missing" | "invalid" | "wrong-id";
		error?: string;
	};
	abortController?: AbortController;
	/**
	 * Optional legacy status snapshot retained only for hydrating pre-lifecycle
	 * runtime entries after /reload. Live observation uses `lifecycle` only.
	 */
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	/** Last projected kind used to detect stalled/recovered transitions. */
	lastProjectedKind?: LifecycleProjection["kind"];
	/**
	 * When true, stall/recovery steers from the status watchdog are suppressed.
	 * Set for foreground runs so the parent is not woken by status pings.
	 */
	suppressStatusSteer?: boolean;
	/** Min-size/tab fallback warning from the layout manager (surfaced in tool results). */
	layoutWarning?: string;
	/** Parent-resolved model/thinking selection and provenance. */
	runtimePlan: ResolvedRuntimePlan | undefined;
	admissionClass?: "foreground" | "background";
	admissionLease?: AdmissionLease;
	sessionLease?: SessionLease;
	entryCountBefore?: number;
	foregroundBarrierLease?: ForegroundBarrierLease;
	launchTransaction?: LaunchTransaction;
	/** Immutable parent session log path captured at launch for delivery verification. */
	parentSessionFile?: string;
	/** Error completion was reported while the child pane remains inspectable. */
	errorPanePreserved?: boolean;
	/** Prevents multiple monitor intervals for the same preserved pane. */
	errorPaneMonitorStarted?: boolean;
	/**
	 * Why this run is sitting in `finalizing…`. Both a normal turn-boundary wait
	 * and a genuine verification failure otherwise render identically, which
	 * makes healthy delivery indistinguishable from a stuck one.
	 */
	deliveryWait?: { kind: DeliveryWaitKind; since: number };
	/**
	 * Per-run watch budget override (ms). 0 disables the cap. Defaults to
	 * DEFAULT_COMPLETION_TIMEOUT_MS when unset.
	 */
	completionTimeoutMs?: number;
	/**
	 * The watch deadline expired: watching stopped without any completion
	 * evidence. Capacity was released early because nothing is being observed
	 * any more, yet the pane may still be alive — so it is preserved, not reaped.
	 */
	watchAbandoned?: boolean;
	/** Test-only injection for the pane probe; unset in production (see watchSubagent). */
	inspectPaneOverride?: () => Promise<PaneInspection>;
	/** Sticky predecessor for a manual resume of the same session. */
	resumedStickyId?: string;
}

interface QueuedSubagent {
	id: string;
	name: string;
	agent: string;
	admissionClass: "foreground" | "background";
	queuedAt: number;
	cancel: () => boolean;
}

type StickyTerminalKind = "failed" | "stopped" | "watch-abandoned";

interface StickyTerminalRun {
	id: string;
	name: string;
	agent?: string;
	admissionClass?: "foreground" | "background";
	startTime: number;
	runtimeEndedAt: number;
	sessionFile?: string;
	activity?: SubagentActivityState;
	kind: StickyTerminalKind;
	capturedAt: number;
}

/** Plain, reload-safe inputs captured before a queued launch is admitted.
 * Never retain ExtensionContext in a continuation that survives /reload. */
interface StableParentContext {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionDir: string;
}

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

/**
 * Distinguishable reasons a settled run has not yet been handed to the parent:
 * - `barrier`: held behind an active foreground run (expected, by design).
 * - `turn-boundary`: steer queued into a streaming parent; it persists when the
 *   running loop next drains (expected, latency is the parent's turn length).
 * - `verifying`: written while the parent was idle; awaiting persistence proof
 *   (expected, normally milliseconds).
 */
type DeliveryWaitKind = "barrier" | "turn-boundary" | "verifying";

interface PendingDelivery {
	id: string;
	parentSessionId: string;
	message: any;
	attempts: number;
	nextRetryAt: number;
	lastError?: string;
	delivering: boolean;
	exhausted?: boolean;
	/** Why this entry is terminal: ordinary send-attempt exhaustion is NOT
	 * re-driven on session start; only a deferral-budget exhaustion may be
	 * re-driven (with both flags reset) when a runtime becomes available. */
	exhaustionCause?: "attempts" | "deferral";
	generation: number;
	/** Parent session log path for post-delivery verification (survives retries). */
	sessionFile?: string;
	/** Expected run ID to match in the session log after delivery. */
	expectedRunId?: string;
	/**
	 * First time this entry was deferred because no matching session-bound
	 * runtime was active. Cleared on the first attempt that reaches a matching
	 * active runtime, so the deferral budget measures ONE continuous
	 * unavailable interval and `awaiting runtime` reflects only the most recent
	 * outcome.
	 */
	deferredSince?: number;
}

interface SubagentRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	queuedSubagents: Map<string, QueuedSubagent>;
	pendingDeliveries: Map<string, PendingDelivery>;
	stickyTerminalRuns: Map<string, StickyTerminalRun>;
	latestCtx?: ExtensionContext;
	/** Process-global set of run IDs whose completion message has been sent.
	 * Survives /reload but not process restart. Primary dedup to prevent
	 * duplicate sends regardless of session-log persistence timing. */
	deliveredRunIds: Set<string>;
	/** Parent agent-loop activity, tracked via agent_start/agent_end extension
	 * events. Drives stream-aware delivery acknowledgement (a steer queued into
	 * a running loop persists only at a turn boundary) and wake decisions. */
	parentActivity: { streaming: boolean; turnStartedAtMs: number };
}

const MAX_PENDING_DELIVERY_ATTEMPTS = 8;
/** Bound on ONE continuous interval during which no matching session-bound
 * runtime is active (e.g. a reload gap that never closes). Separate from the
 * send-attempt budget: deferral never consumes ordinary delivery attempts. */
const DEFERRED_DELIVERY_MAX_MS = 60 * 60_000;
/** Grace period for the primary delivery acknowledgement check. A steer sent
 * to an idle parent (the common case when a background subagent completes)
 * flushes promptly; this bounds the wait before engaging the retry pump. */
const PRIMARY_DELIVERY_GRACE_MS = 8000;
function createSubagentRuntime(): SubagentRuntime {
	return {
		runningSubagents: new Map<string, RunningSubagent>(),
		queuedSubagents: new Map<string, QueuedSubagent>(),
		pendingDeliveries: new Map<string, PendingDelivery>(),
		stickyTerminalRuns: new Map<string, StickyTerminalRun>(),
		deliveredRunIds: new Set<string>(),
		parentActivity: { streaming: false, turnStartedAtMs: 0 },
	};
}

/** Runtime state preserved across /reload. */
const runtime: SubagentRuntime =
	(globalThis as any)[RUNTIME_KEY] ?? ((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
const runningSubagents = runtime.runningSubagents;
runtime.queuedSubagents ??= new Map<string, QueuedSubagent>();
const queuedSubagents = runtime.queuedSubagents;
runtime.pendingDeliveries ??= new Map<string, PendingDelivery>();
runtime.stickyTerminalRuns ??= new Map<string, StickyTerminalRun>();
runtime.deliveredRunIds ??= new Set<string>();
// Hydrate fields added after the runtime object was created by an older
// module version — the runtime survives /reload via globalThis.
runtime.parentActivity ??= { streaming: false, turnStartedAtMs: 0 };
const deliveredRunIds = runtime.deliveredRunIds;
const pendingDeliveries = runtime.pendingDeliveries;
const stickyTerminalRuns = runtime.stickyTerminalRuns;
const queuedSubagentMap = queuedSubagents;
/** In-flight delivery acknowledgements: run ID → persistence verification
 * promise. Set inside the foreground barrier after sendMessage is accepted,
 * cleared when verification settles. Concurrent callers for the same run await
 * the existing promise instead of double-sending, mirroring its outcome. Not
 * preserved across /reload. */
const inflightDelivery = new Map<string, Promise<void>>();

/** Static wake nudge — deliberately carries no run metadata, so a
 * caller-controlled label can never inject instructions into the parent's
 * user-role stream, and one queued wake covers every result persisted before
 * the wake turn starts. */
const WAKE_MESSAGE =
	"[pi-subagent-herdr] Automated notice: one or more background subagent results were delivered to this session. Review the latest subagent_result messages and continue.";

const ERROR_PANE_MONITOR_INTERVAL_MS = 2000;

/** Parent sessions with a wake already emitted but not yet consumed by a
 * turn. Prevents duplicate wakes from concurrent phase-2 acks. Cleared on
 * agent_start (the wake turn beginning) or by a fallback timer. */
const wakeInflightByParent = new Set<string>();

/** Strip ANSI escape sequences (CSI, OSC, and single-character Fe forms) and
 * C0/C1 control characters before TUI use. */
function sanitizeWidgetText(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex -- stripping terminal control sequences is the purpose
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ") // OSC … BEL/ST
			// eslint-disable-next-line no-control-regex -- stripping terminal control sequences is the purpose
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ") // CSI (incl. private modes)
			// eslint-disable-next-line no-control-regex -- stripping terminal control sequences is the purpose
			.replace(/\x1b[@-_]/g, " ") // remaining Fe escapes
			// eslint-disable-next-line no-control-regex -- stripping terminal control sequences is the purpose
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
	);
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

// ── Session-bound completion runtime ownership ──
//
// The extension factory registers tools and handlers only. Pi binds the
// runtime's action methods to a session AFTER the factory returns, so the
// factory argument can never be published as the delivery API. `session_start`
// is the activation boundary: Pi has bound the runtime when it emits that
// event. Discovery-only factory evaluations (e.g. a standalone resource loader
// resolving selected skills) therefore cannot replace the live parent API.
interface ActiveCompletionRuntime {
	api: ExtensionAPI;
	parentSessionId: string;
	generation: number;
}

/** Typed condition: no session-bound runtime matches the target session.
 * Distinct from an ordinary send failure — callers defer without consuming
 * the bounded send-attempt budget. */
class SessionRuntimeUnavailableError extends Error {
	constructor(parentSessionId: string) {
		super(`No active session-bound extension runtime for parent session ${parentSessionId}.`);
		this.name = "SessionRuntimeUnavailableError";
	}
}

function isSessionRuntimeUnavailable(error: unknown): boolean {
	return error instanceof SessionRuntimeUnavailableError;
}

/** Resolve the active completion runtime, rejecting absent or
 * session-mismatched records. A captured factory API is NEVER a fallback. */
function requireActiveCompletionRuntime(parentSessionId: string): ActiveCompletionRuntime {
	const record = (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] as ActiveCompletionRuntime | undefined;
	if (!record || record.parentSessionId !== parentSessionId) {
		throw new SessionRuntimeUnavailableError(parentSessionId);
	}
	return record;
}

/** Best-effort variant for optional sends (wakes, status notifications):
 * returns undefined instead of throwing when no matching record is active. */
function resolveActiveCompletionRuntime(parentSessionId: string): ActiveCompletionRuntime | undefined {
	const record = (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] as ActiveCompletionRuntime | undefined;
	return record?.parentSessionId === parentSessionId ? record : undefined;
}

function activateCompletionRuntime(api: ExtensionAPI, parentSessionId: string): ActiveCompletionRuntime {
	const globals = globalThis as any;
	const generation = ((globals[COMPLETION_RUNTIME_GENERATION_KEY] as number | undefined) ?? 0) + 1;
	globals[COMPLETION_RUNTIME_GENERATION_KEY] = generation;
	const record: ActiveCompletionRuntime = {
		api,
		parentSessionId,
		generation,
	};
	globals[ACTIVE_COMPLETION_RUNTIME_KEY] = record;
	return record;
}

/** Clear only when this handler instance still owns the active record — an old
 * extension instance must never clear a replacement session's runtime during
 * reload or session replacement. */
function deactivateCompletionRuntime(record: ActiveCompletionRuntime | undefined): void {
	if (record && (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] === record) {
		delete (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY];
	}
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

export const MAX_QUEUED_WIDGET_ROWS = 3;
export const MAX_STICKY_WIDGET_ROWS = 3;
export const MIN_WIDGET_RUN_ID_LENGTH = 8;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function formatWidgetDuration(durationMs: number): string {
	const tenths = Math.max(0, Math.floor(durationMs / 100)) / 10;
	if (tenths < 60) return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
	const totalSeconds = Math.floor(tenths);
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/** Human-facing label for a delivery wait. Each is an expected state. */
function formatDeliveryWaitLabel(kind: DeliveryWaitKind): string {
	if (kind === "barrier") return "held · foreground busy";
	if (kind === "turn-boundary") return "awaiting turn boundary";
	return "confirming delivery";
}

function formatAgentDisplayName(agent: string | undefined, fallback: string): string {
	if (!agent) return sanitizeWidgetText(fallback).trim() || "subagent";
	return agent
		.split(/[-_.\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function formatContextTokens(tokens: number): string {
	if (Math.abs(tokens) >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
	if (Math.abs(tokens) >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

function buildWidgetRunIdLabels(ids: string[]): Map<string, string> {
	const sanitizedIds = Array.from(new Set(ids)).map((id) => [id, sanitizeWidgetText(id).trim()] as const);
	const opaqueIds = sanitizedIds.filter(([, id]) => /^[0-9a-f]{16,}$/i.test(id));
	const labels = new Map<string, string>();

	for (const [originalId, safeId] of sanitizedIds) {
		if (!/^[0-9a-f]{16,}$/i.test(safeId)) {
			labels.set(originalId, safeId);
			continue;
		}
		let length = Math.min(MIN_WIDGET_RUN_ID_LENGTH, safeId.length);
		while (
			length < safeId.length &&
			opaqueIds.some(([, other]) => other !== safeId && other.startsWith(safeId.slice(0, length)))
		) {
			length += 1;
		}
		labels.set(originalId, safeId.slice(0, length));
	}
	return labels;
}

function fitWidgetLine(prefix: string, content: string, width: number): string {
	if (width <= 0) return "";
	const fittedPrefix = truncateToWidth(prefix, width);
	const remaining = Math.max(0, width - visibleWidth(fittedPrefix));
	return `${fittedPrefix}${truncateToWidth(content, remaining)}`;
}

function fitIdentityContent(params: {
	glyph: string;
	displayName: string;
	id: string;
	admissionClass?: string;
	duration?: string;
	width: number;
}): string {
	const safeName = sanitizeWidgetText(params.displayName).trim() || "subagent";
	const safeId = sanitizeWidgetText(params.id).trim();
	const beforeName = `${params.glyph} `;
	const afterName = `${safeId ? ` · [${safeId}]` : ""}${params.admissionClass ? ` · ${params.admissionClass}` : ""}`;
	const duration = params.duration ? ` · ${params.duration}` : "";
	const full = `${beforeName}${safeName}${afterName}${duration}`;
	if (visibleWidth(full) <= params.width) return full;

	const withoutDuration = `${beforeName}${safeName}${afterName}`;
	if (visibleWidth(withoutDuration) <= params.width) return withoutDuration;

	const nameWidth = Math.max(0, params.width - visibleWidth(beforeName) - visibleWidth(afterName));
	const truncatedName = truncateToWidth(safeName, nameWidth);
	return truncateToWidth(`${beforeName}${truncatedName}${afterName}`, params.width);
}

interface ActivityTelemetryParts {
	turns?: string;
	tools?: string;
	tokenBase?: string;
	percent?: string;
	compactions?: string;
}

function telemetryParts(activity: SubagentActivityState | undefined, theme: Theme): ActivityTelemetryParts {
	if (!activity) return {};
	const turns = activity.turnIndex == null ? undefined : `↻${activity.turnIndex}`;
	const tools = activity.toolCount == null ? undefined : `⚙${activity.toolCount}`;
	const tokenBase = activity.contextTokens == null ? undefined : `◈${formatContextTokens(activity.contextTokens)}`;
	const derivedPercent =
		activity.contextPercent === undefined
			? activity.contextTokens != null && activity.contextWindow != null && activity.contextWindow > 0
				? (activity.contextTokens / activity.contextWindow) * 100
				: undefined
			: (activity.contextPercent ?? undefined);
	const percent =
		derivedPercent == null
			? undefined
			: theme.fg(
					derivedPercent < 70 ? "dim" : derivedPercent < 85 ? "warning" : "error",
					`${Math.round(derivedPercent)}%`,
				);
	const compactions =
		(activity.compactionCount ?? 0) > 0 ? theme.fg("dim", `⇊${activity.compactionCount}`) : undefined;
	return { turns, tools, tokenBase, percent, compactions };
}

function buildTelemetryChunks(parts: ActivityTelemetryParts): string[] {
	const chunks = [parts.turns, parts.tools].filter((part): part is string => part != null);
	if (parts.tokenBase) {
		const annotations = [parts.percent, parts.compactions].filter((part): part is string => part != null);
		chunks.push(`${parts.tokenBase}${annotations.length > 0 ? ` (${annotations.join(" · ")})` : ""}`);
	} else if (parts.compactions) {
		chunks.push(parts.compactions);
	}
	return chunks;
}

function fitActivityContent(
	lead: string | undefined,
	activity: SubagentActivityState | undefined,
	theme: Theme,
	width: number,
	activityPrefix = "⎿  ",
): string {
	const parts = telemetryParts(activity, theme);
	const render = () =>
		[lead, ...buildTelemetryChunks(parts)].filter((part): part is string => Boolean(part)).join(" · ");
	const fits = () => visibleWidth(`${activityPrefix}${render()}`) <= width;
	if (!fits()) parts.compactions = undefined;
	if (!fits()) parts.percent = undefined;
	if (!fits()) parts.tools = undefined;
	if (!fits()) parts.turns = undefined;
	return truncateToWidth(`${activityPrefix}${render()}`, width);
}

function lifecycleGlyph(kind: LifecycleProjection["kind"], now: number): string {
	if (kind === "starting" || kind === "running" || kind === "active") {
		return SPINNER_FRAMES[Math.floor(now / 1000) % SPINNER_FRAMES.length];
	}
	if (kind === "blocked") return "◆";
	if (kind === "waiting") return "◷";
	if (kind === "interrupted") return "■";
	if (kind === "stalled") return "⚠";
	if (kind === "failed") return "✗";
	return "◌";
}

function lifecycleActivityLead(
	agent: RunningSubagent,
	projection: LifecycleProjection,
	now: number,
): string | undefined {
	const runLabel = agent.agent && agent.name !== agent.agent ? sanitizeWidgetText(agent.name).trim() : undefined;
	const stateDuration =
		projection.stateDurationSince == null ? undefined : formatWidgetDuration(now - projection.stateDurationSince);
	if (projection.kind === "starting" || projection.kind === "running" || projection.kind === "active") {
		return runLabel;
	}
	if (projection.kind === "blocked") {
		return [`blocked${stateDuration ? ` ${stateDuration}` : ""}`, runLabel].filter(Boolean).join(" · ");
	}
	if (projection.kind === "waiting" || projection.kind === "interrupted" || projection.kind === "stalled") {
		return `${projection.kind}${stateDuration ? ` ${stateDuration}` : ""}`;
	}
	if (projection.kind === "finalizing" || projection.kind === "completed" || projection.kind === "failed") {
		if (agent.deliveryWait) {
			return `${formatDeliveryWaitLabel(agent.deliveryWait.kind)} ${formatWidgetDuration(now - agent.deliveryWait.since)}`;
		}
		return "finalizing…";
	}
	return undefined;
}

interface WidgetTreeItem {
	identity: (width: number) => string;
	activity?: (width: number) => string;
}

export function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
	theme: Theme,
	queued: QueuedSubagent[] = [],
	pending: PendingDelivery[] = [],
	sticky: StickyTerminalRun[] = [],
): string[] {
	const now = Date.now();
	const rendered = agents.map((agent) => ({ agent, projection: projectLifecycle(ensureLifecycle(agent), now) }));
	const activeCount = rendered.filter(
		({ projection }) =>
			projection.kind === "active" ||
			projection.kind === "starting" ||
			projection.kind === "running" ||
			projection.kind === "blocked",
	).length;
	const openCount = agents.length - activeCount;
	const awaitingRuntimeCount = pending.filter(
		(entry) => !entry.exhausted && entry.deferredSince !== undefined,
	).length;
	const retryingCount = pending.filter((entry) => !entry.exhausted && entry.deferredSince === undefined).length;
	const undeliverableCount = pending.length - retryingCount - awaitingRuntimeCount;
	const liveWork = agents.length > 0 || queued.length > 0 || retryingCount > 0 || awaitingRuntimeCount > 0;
	const countChunks = [
		activeCount > 0 ? `${activeCount} active` : undefined,
		openCount > 0 ? `${openCount} open` : undefined,
		queued.length > 0 ? `${queued.length} queued` : undefined,
		retryingCount > 0 ? `${retryingCount} delivery retrying` : undefined,
		awaitingRuntimeCount > 0 ? `${awaitingRuntimeCount} awaiting runtime` : undefined,
		undeliverableCount > 0 ? `${undeliverableCount} undeliverable` : undefined,
	].filter((chunk): chunk is string => chunk != null);
	const header =
		`${theme.fg(liveWork ? "accent" : "muted", liveWork ? "●" : "○")} ${theme.bold("Subagents")}` +
		(liveWork && countChunks.length > 0 ? ` · ${countChunks.join(" · ")}` : "");
	const lines = [truncateToWidth(header, Math.max(0, width))];
	const runIdLabels = buildWidgetRunIdLabels([
		...agents.map((agent) => agent.id),
		...queued.map((entry) => entry.id),
		...pending.map((entry) => entry.id),
		...sticky.map((entry) => entry.id),
	]);
	const displayRunId = (id: string) => runIdLabels.get(id) ?? sanitizeWidgetText(id).trim();
	const items: WidgetTreeItem[] = [];

	for (const { agent, projection } of rendered) {
		const activity = agent.activity;
		items.push({
			identity: (available) =>
				fitIdentityContent({
					glyph: lifecycleGlyph(projection.kind, now),
					displayName: formatAgentDisplayName(agent.agent, agent.name),
					id: displayRunId(agent.id),
					admissionClass: agent.admissionClass,
					duration: formatWidgetDuration((projection.runtimeEndedAt ?? now) - agent.startTime),
					width: available,
				}),
			activity: (available) =>
				fitActivityContent(lifecycleActivityLead(agent, projection, now), activity, theme, available),
		});
	}

	for (const entry of queued.slice(0, MAX_QUEUED_WIDGET_ROWS)) {
		items.push({
			identity: (available) =>
				truncateToWidth(
					`◷ ${formatAgentDisplayName(entry.agent, entry.name)} [${displayRunId(entry.id)}] · ${entry.admissionClass} · queued`,
					available,
				),
		});
	}
	if (queued.length > MAX_QUEUED_WIDGET_ROWS) {
		items.push({
			identity: (available) =>
				truncateToWidth(`+${queued.length - MAX_QUEUED_WIDGET_ROWS} more queued`, available),
		});
	}

	for (const entry of pending) {
		const details = entry.message?.details ?? {};
		const displayName =
			sanitizeWidgetText(
				typeof details.name === "string"
					? details.name
					: typeof details.agent === "string"
						? details.agent
						: "subagent",
			).trim() || "subagent";
		const errorText = entry.lastError
			? sanitizeWidgetText(entry.lastError).replace(/\s+/g, " ").trim().slice(0, 80)
			: "";
		const error = errorText ? ` · ${errorText}` : "";
		const state = entry.exhausted
			? `undeliverable after ${entry.attempts}`
			: entry.deferredSince !== undefined
				? "awaiting runtime"
				: `delivery retry ${entry.attempts}`;
		items.push({
			identity: (available) =>
				truncateToWidth(`⚠ ${displayName} [${displayRunId(entry.id)}] · ${state}${error}`, available),
		});
	}

	const orderedSticky = sticky.slice().sort((left, right) => right.capturedAt - left.capturedAt);
	for (const terminal of orderedSticky.slice(0, MAX_STICKY_WIDGET_ROWS)) {
		const glyph = terminal.kind === "failed" ? "✗" : terminal.kind === "stopped" ? "■" : "⚠";
		const runLabel =
			terminal.agent && terminal.name !== terminal.agent ? sanitizeWidgetText(terminal.name).trim() : undefined;
		items.push({
			identity: (available) =>
				fitIdentityContent({
					glyph,
					displayName: formatAgentDisplayName(terminal.agent, terminal.name),
					id: displayRunId(terminal.id),
					admissionClass: terminal.admissionClass,
					duration: formatWidgetDuration(terminal.runtimeEndedAt - terminal.startTime),
					width: available,
				}),
			activity: (available) => fitActivityContent(runLabel, terminal.activity, theme, available),
		});
	}
	if (orderedSticky.length > MAX_STICKY_WIDGET_ROWS) {
		items.push({
			identity: (available) =>
				truncateToWidth(`+${orderedSticky.length - MAX_STICKY_WIDGET_ROWS} more`, available),
		});
	}

	items.forEach((item, index) => {
		const last = index === items.length - 1;
		const identityPrefix = last ? "└─ " : "├─ ";
		const identityWidth = Math.max(0, width - visibleWidth(identityPrefix));
		lines.push(fitWidgetLine(identityPrefix, item.identity(identityWidth), width));
		if (item.activity) {
			const activityPrefix = last ? "     " : "│    ";
			const activityWidth = Math.max(0, width - visibleWidth(activityPrefix));
			lines.push(fitWidgetLine(activityPrefix, item.activity(activityWidth), width));
		}
	});
	return lines;
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
				render(width: number) {
					// Feed min-size guard when process.stdout is non-TTY (TUI still knows width).
					rememberTuiSize({ columns: width });
					return renderSubagentWidgetLines(
						Array.from(runningSubagents.values()),
						width,
						theme,
						Array.from(queuedSubagents.values()),
						Array.from(pendingDeliveries.values()),
						Array.from(stickyTerminalRuns.values()),
					);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
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
	let lifecycle = createLifecycle(running.startTime);
	const state = running.statusState;
	if (state?.activityLabel === "interrupted" && state.localOverrideAtMs != null) {
		lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
	} else if (state?.phase === "done") {
		// Legacy activity "done" means the turn ended, not that completion
		// evidence was recorded. Hydrate as Herdr-style waiting and let the
		// preserved watcher consume sidecar/sentinel evidence.
		const observedAt = state.lastActivityAtMs ?? running.startTime;
		lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt, agentStatus: "done" }, observedAt);
	} else if (state?.phase === "active" || state?.phase === "waiting" || state?.phase === "starting") {
		lifecycle = observeActivity(
			lifecycle,
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: running.id,
					createdAt: running.startTime,
					updatedAt: state.lastActivityAtMs ?? running.startTime,
					sequence: state.lastActivitySequence ?? 0,
					latestEvent: state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
					phase: state.phase,
					agentActive: state.phase === "active",
					turnActive: state.phase === "active",
					providerActive: false,
					toolActive: state.activeScope === "tool",
					...(state.activeScope ? { activeScope: state.activeScope as any } : {}),
					...(state.activeSinceMs != null ? { activeSince: state.activeSinceMs } : {}),
					...(state.waitingSinceMs != null ? { waitingSince: state.waitingSinceMs } : {}),
					...(state.activityLabel && state.activeScope === "tool" ? { toolName: state.activityLabel } : {}),
				},
			},
			state.lastActivityAtMs ?? running.startTime,
		);
	} else if (running.startTime) {
		// Pre-lifecycle Pi agents without a known phase still get a running process.
		lifecycle = markProcessRunning(lifecycle, running.startTime);
	}
	running.lifecycle = lifecycle;
	return lifecycle;
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

function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
	}

	const requestedName = params.name?.trim();
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}

	const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
	if (matches.length === 1) return { running: matches[0] };
	if (matches.length === 0) {
		return { error: `No running subagent named "${requestedName}".` };
	}

	const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
	return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
	running: RunningSubagent,
	interruptPaneKey: (surface: string) => void = interruptPane,
	paneExists: (surface: string) => boolean = herdrPaneExists,
): { ok: true } | { error: string } {
	try {
		// When tests inject a custom interrupt delivery fn they also skip real herdr;
		// still existence-check when using the default delivery path.
		if (interruptPaneKey === interruptPane && !paneExists(running.surface)) {
			return {
				error:
					`Failed to send Escape to subagent "${running.name}" via herdr: ` +
					`pane ${running.surface} no longer exists`,
			};
		}
		interruptPaneKey(running.surface);
		return { ok: true };
	} catch (error: any) {
		return {
			error:
				`Failed to send Escape to subagent "${running.name}" via herdr: ` +
				`${error?.message ?? String(error)}`,
		};
	}
}

function handleSubagentInterrupt(
	params: { id?: string; name?: string },
	interruptPaneKey: (surface: string) => void = interruptPane,
) {
	const queuedId = params.id?.trim();
	const queuedById = queuedId ? queuedSubagents.get(queuedId) : undefined;
	const queuedByName =
		!queuedId && params.name
			? Array.from(queuedSubagents.values()).filter((entry) => entry.name === params.name?.trim())
			: [];
	const queued = queuedById ?? (queuedByName.length === 1 ? queuedByName[0] : undefined);
	if (queued) {
		const cancelled = queued.cancel();
		if (cancelled) queuedSubagents.delete(queued.id);
		updateWidget();
		return {
			content: [
				{
					type: "text" as const,
					text: cancelled
						? `Cancelled queued subagent "${queued.name}" [${queued.id}] without creating resources.`
						: `Queued subagent "${queued.name}" [${queued.id}] was already admitted.`,
				},
			],
			details: { id: queued.id, name: queued.name, status: cancelled ? "cancelled" : "admitted" },
		};
	}
	if (!queuedId && queuedByName.length > 1) {
		const candidates = queuedByName.map((entry) => `${entry.name} [${entry.id}]`).join(", ");
		return {
			content: [
				{
					type: "text" as const,
					text: `Ambiguous queued subagent name "${params.name}". Matches: ${candidates}`,
				},
			],
			details: { error: "ambiguous queued name" },
		};
	}
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			details: { error: resolved.error },
		};
	}

	const running = resolved.running;

	const now = Date.now();
	observeRunningSubagent(running, now);

	const interruption = requestSubagentInterrupt(running, interruptPaneKey);
	if ("error" in interruption) {
		return {
			content: [{ type: "text" as const, text: interruption.error }],
			details: { error: interruption.error, id: running.id, name: running.name },
		};
	}

	running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
	running.sessionLease?.transition("interrupted");
	updateWidget();

	return {
		content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
		details: { id: running.id, name: running.name, status: "interrupt_requested" },
	};
}

function startStatusRefresh() {
	if ((globalThis as any)[STATUS_OWNER_KEY] !== STATUS_OWNER) return;
	if (statusInterval) return;

	statusInterval = setInterval(() => {
		if (runningSubagents.size === 0 && pendingDeliveries.size === 0) {
			if (statusInterval) {
				clearInterval(statusInterval);
				statusInterval = null;
				if ((globalThis as any)[STATUS_OWNER_KEY] === STATUS_OWNER)
					(globalThis as any)[STATUS_INTERVAL_KEY] = null;
			}
			return;
		}

		const transitionLines: string[] = [];
		const now = Date.now();
		let shouldRefreshWidget = false;

		for (const running of runningSubagents.values()) {
			// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
			observeRunningSubagent(running, now);
			const projection = projectLifecycle(ensureLifecycle(running), now);
			const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
			if (running.lastProjectedKind !== projection.kind) {
				shouldRefreshWidget = true;
			}
			running.lastProjectedKind = projection.kind;

			// Foreground runs suppress stall steers via suppressStatusSteer.
			if (transition && !running.suppressStatusSteer) {
				transitionLines.push(
					formatLifecycleTransitionLine(
						normalizeStatusName(running.name),
						projection,
						transition,
						now,
						running.startTime,
						formatElapsedDuration,
					),
				);
			}
		}

		if (shouldRefreshWidget) updateWidget();

		if (transitionLines.length > 0) {
			const capped = capStatusLines(transitionLines, STATUS_LINE_LIMIT);
			const parentSessionId = runtime.latestCtx?.sessionManager.getSessionId();
			// Status notifications are best-effort and carry no run ID: while no
			// matching session-bound runtime is active they are DROPPED, never
			// queued into the run-keyed pending store.
			if (parentSessionId && resolveActiveCompletionRuntime(parentSessionId)) {
				void deliverBackgroundMessage(undefined, parentSessionId, {
					customType: "subagent_status",
					content: formatStatusAggregate(transitionLines, STATUS_LINE_LIMIT),
					display: true,
					details: { lines: capped.visibleLines, overflow: capped.overflow },
				}).catch(() => undefined);
			}
		}
	}, 1000);

	(globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

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
	queuedSubagents: queuedSubagentMap,
	stickyTerminalRuns,
	classifyStickyTerminal,
	captureStickyTerminalRun,
	captureStickyLaunchFailure,
	clearStickyTerminalsOnAdmission,
	evictResumedStickyTerminal,
	updateWidget,
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
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
	/** Test-only: unconditionally clear the active record so repeated in-process
	 * factory invocations stay order-independent. */
	resetActiveCompletionRuntime() {
		delete (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY];
	},
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

async function launchSubagent(
	params: typeof SubagentParams.static,
	ctx: StableParentContext,
	options: {
		agentDefinition: AgentDefinition;
		selectedSkills: SelectedSkill[];
		runtimePlan: ResolvedRuntimePlan;
		runId?: string;
		admissionClass?: "foreground" | "background";
		admissionLease?: AdmissionLease;
		projectTrusted?: boolean;
		surface?: string;
	},
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = options.runId ?? createRunId();

	const agentDefs = options.agentDefinition;
	if (agentDefs.id !== params.agent) throw new Error("Subagent identity mismatch.");
	const runtimePlan = options.runtimePlan;
	const effectiveModel = runtimePlan.model;
	const effectiveTools = agentDefs.tools;
	const effectiveThinking = runtimePlan.thinking;

	const sessionFile = ctx.sessionFile;
	if (!sessionFile) throw new Error("No session file");
	const sessionId = ctx.sessionId;
	const artifactDir = getArtifactDir(ctx.sessionDir, sessionId);
	const effectiveCwd = resolve(ctx.cwd);
	const effectiveAgentDir = ctx.agentDir;
	const targetCwdForSession = effectiveCwd;
	const resolvedCwd = resolve(targetCwdForSession);
	const safeCwd = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(resolve(effectiveAgentDir), "sessions", safeCwd);
	mkdirSync(sessionDir, { recursive: true });

	// Generate a deterministic session file path for this subagent.
	// This eliminates race conditions when multiple agents launch simultaneously —
	// each agent knows exactly which file is theirs.
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
	const uuid = [
		id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

	// Use pre-created surface (internal hook) or the layout manager (default attached).
	// options.surface is kept for internal callers; layout manager supersedes slash-command parallel mode.
	// Layout-created panes receive the same shell-ready delay as upstream pre-created surfaces.
	const surfacePreCreated = !!options?.surface;
	let surface!: string;
	let layoutWarning: string | undefined;
	let sessionLease: SessionLease | undefined;
	const rollbackPaths: string[] = [];
	const assertAdmissionCurrent = () => {
		if (!options.admissionLease) return;
		const coordinator = getAdmissionCoordinator(sessionId);
		if (!coordinator.isAdmissionCurrent(options.admissionLease)) {
			throw new Error("Subagent launch cancelled.");
		}
	};
	assertAdmissionCurrent();
	const launchTransaction = beginLaunchTransaction(id);
	if (options.admissionLease) launchTransaction.own(() => options.admissionLease?.release());
	launchTransaction.throwIfAborted();
	try {
		if (options?.surface) {
			surface = options.surface;
		} else {
			const parentPaneId = process.env.HERDR_PANE_ID;
			if (!parentPaneId) throw new Error("HERDR_PANE_ID not set");
			const layoutMode = resolveLayout(params);
			const surfaceMode = resolveSurface(params);
			const direction = resolveDirection(params);
			// Best-effort re-derive region after /reload when children still exist.
			tryRederiveRegionFromLayout(
				parentPaneId,
				direction,
				Array.from(runningSubagents.values()).map((r) => r.surface),
			);
			const attached = await attachPaneSerialized(parentPaneId, {
				name: params.label?.trim() || params.agent,
				direction,
				layout: layoutMode,
				surface: surfaceMode,
				cwd: targetCwdForSession,
			});
			surface = attached.paneId;
			layoutWarning = attached.warning;
			launchTransaction.own(() => {
				try {
					safeCloseSubagentPane(surface);
				} catch {}
				try {
					removePaneFromRegion(parentPaneId, surface);
				} catch {}
			});
			assertAdmissionCurrent();
			launchTransaction.advance("pane");
		}
		if (!surfacePreCreated) {
			await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
			launchTransaction.throwIfAborted();
			assertAdmissionCurrent();
		}

		const launchBehavior = resolveLaunchBehavior(agentDefs);

		// Always seed: fresh (parent link, no history) or fork (parent turns).
		launchTransaction.own(() => rmSync(`${subagentSessionFile}.owner.json`, { force: true }));
		launchTransaction.own(() => rmSync(subagentSessionFile, { force: true }));
		seedSubagentSessionFile({
			mode: launchBehavior.seed,
			parentSessionFile: sessionFile,
			parentSessionId: sessionId,
			agentId: agentDefs.id,
			childSessionFile: subagentSessionFile,
			childCwd: targetCwdForSession,
		});
		sessionLease = getSessionLeaseRegistry(sessionId).acquire(subagentSessionFile, id, "starting");
		launchTransaction.own(() => sessionLease?.release());
		const entryCountBefore = getNewEntries(subagentSessionFile, 0).length;

		const activityFile = getSubagentActivityFile(artifactDir, id);
		mkdirSync(dirname(activityFile), { recursive: true });
		const { inheritsConversationContext } = launchBehavior;

		// Build the task message
		// Only full-context fork mode inherits prior conversation state.
		// Blank-session modes need the wrapper instructions and artifact-backed handoff.
		const modeHint = "Complete your task autonomously.";
		const summaryInstruction = "Your FINAL assistant message should summarize what you accomplished.";
		const denySet = lifecycleDenySet();
		const fullTask = inheritsConversationContext
			? params.task
			: `${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
		// ── Pi CLI path ──

		// Build pi command
		const parts: string[] = ["pi"];
		if (process.env.PI_SUBAGENT_NO_EXTENSIONS === "1") parts.push("-ne");
		if (options.projectTrusted) parts.push("--approve");
		parts.push("--session", shellQuote(subagentSessionFile));

		const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
		parts.push("-e", shellQuote(subagentDonePath));

		if (effectiveModel) {
			parts.push("--model", shellQuote(effectiveModel));
		}
		if (effectiveThinking) {
			parts.push("--thinking", shellQuote(effectiveThinking));
		}

		// One canonical identity tag plus one copy of the definition Markdown body.
		const sysPrompt = buildSystemPromptFileContent({
			agentName: agentDefs.id,
			identity: agentDefs.body,
		});
		if (sysPrompt) {
			const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const spSafeName = params.agent;
			const syspromptPath = join(
				artifactDir,
				`context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}-${id}.md`,
			);
			mkdirSync(dirname(syspromptPath), { recursive: true });
			launchTransaction.own(() => rmSync(syspromptPath, { force: true }));
			writeFileSync(syspromptPath, sysPrompt.content, "utf8");
			rollbackPaths.push(syspromptPath);
			parts.push(sysPrompt.flag, shellQuote(syspromptPath));
		}

		const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
		parts.push("--tools", shellQuote(toolAllowlist));

		// Build env prefix: denied tools + subagent identity + config dir propagation
		const envParts: string[] = [];

		// Preserve the parent's exact Pi agent directory for global config/extensions.
		envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(effectiveAgentDir)}`);

		envParts.push(`PI_DENY_TOOLS=${shellQuote([...denySet].join(","))}`);
		envParts.push(`PI_SUBAGENT_NAME=${shellQuote(params.label?.trim() || params.agent)}`);
		envParts.push(`PI_SUBAGENT_AGENT=${shellQuote(agentDefs.id)}`);
		if (process.env.PI_SUBAGENT_NO_EXTENSIONS === "1") envParts.push("PI_SUBAGENT_NO_EXTENSIONS=1");
		if (process.env.PI_SUBAGENT_INSPECTION_DIR) {
			envParts.push(`PI_SUBAGENT_INSPECTION_DIR=${shellQuote(process.env.PI_SUBAGENT_INSPECTION_DIR)}`);
		}
		envParts.push(
			`PI_SUBAGENT_SELECTED_SKILLS=${shellQuote(
				JSON.stringify(
					options.selectedSkills.map((skill) => ({
						name: skill.name,
						description: skill.description,
						filePath: skill.filePath,
					})),
				),
			)}`,
		);
		envParts.push("PI_SUBAGENT_COMPANION_ORDER=explicit-before-discovered");
		// Always auto-exit.
		envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
		envParts.push(`PI_SUBAGENT_SESSION=${shellQuote(subagentSessionFile)}`);
		envParts.push(`PI_SUBAGENT_ID=${shellQuote(id)}`);
		envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`);
		envParts.push(`PI_SUBAGENT_SURFACE=${shellQuote(surface)}`);
		// Defensive: inert while children have a TTY (ask dialogs render in-pane).
		// Forwards only matter for headless children, and then only if session roots match.
		envParts.push(`PI_SUBAGENT_PARENT_SESSION=${shellQuote(sessionId)}`);
		const envPrefix = envParts.join(" ") + " ";

		// Pass task and skill prompts to the sub-agent.
		// Only full-context fork mode gets a direct task argument because it already
		// inherits the parent conversation. Blank-session modes use artifact-backed
		// handoff so the wrapper instructions arrive as the initial user message.
		let taskArg: string;
		if (launchBehavior.taskDelivery === "direct") {
			taskArg = fullTask;
		} else {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const safeName = params.agent;
			const artifactName = `context/${buildLaunchArtifactName(safeName, timestamp, id)}`;
			const artifactPath = join(artifactDir, artifactName);
			mkdirSync(dirname(artifactPath), { recursive: true });
			launchTransaction.own(() => rmSync(artifactPath, { force: true }));
			writeFileSync(artifactPath, fullTask, "utf8");
			rollbackPaths.push(artifactPath);
			taskArg = `@${artifactPath}`;
		}

		parts.push("--no-skills");
		for (const skill of options.selectedSkills) {
			parts.push("--skill", shellQuote(skill.filePath));
		}
		parts.push(shellQuote(taskArg));

		// Resolve cwd — param overrides agent default, supports absolute and relative paths.
		// This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
		const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";

		const piCommand = cdPrefix + envPrefix + parts.join(" ");
		const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
		const launchScriptName = `${params.agent}-${id}.sh`;
		const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
		launchTransaction.own(() => rmSync(launchScriptFile, { force: true }));
		launchTransaction.throwIfAborted();
		launchTransaction.advance("script");
		rollbackPaths.push(launchScriptFile);
		runScriptInPane(surface, command, {
			scriptPath: launchScriptFile,
			scriptPreamble: [
				`# Subagent launch script for ${safeCommentValue(params.agent)}`,
				`# Run: ${safeCommentValue(id)}`,
				`# Generated: ${safeCommentValue(new Date().toISOString())}`,
				`# Session: ${safeCommentValue(subagentSessionFile)}`,
				`# Surface: ${safeCommentValue(surface)}`,
			].join("\n"),
		});
		sessionLease.transition("running");

		const running: RunningSubagent = {
			id,
			name: params.label?.trim() || params.agent,
			task: params.task,
			agent: agentDefs.id,
			parentSessionId: sessionId,
			surface,
			startTime,
			sessionFile: subagentSessionFile,
			launchScriptFile,
			activityFile,
			...(resolveBlocking(params) ? { suppressStatusSteer: true } : {}),
			...(layoutWarning ? { layoutWarning } : {}),
			runtimePlan,
			admissionClass: options.admissionClass,
			admissionLease: options.admissionLease,
			sessionLease,
			entryCountBefore,
			lifecycle: createLifecycle(startTime),
			launchTransaction,
		};

		runningSubagents.set(id, running);
		launchTransaction.own(() => runningSubagents.delete(id));
		return running;
	} catch (error) {
		launchTransaction.rollback();
		finishLaunchTransaction(id, launchTransaction);
		sessionLease?.release();
		options.admissionLease?.release();
		if (surface && !surfacePreCreated) {
			try {
				safeCloseSubagentPane(surface);
			} catch {}
			const parentPaneId = process.env.HERDR_PANE_ID;
			if (parentPaneId) {
				try {
					removePaneFromRegion(parentPaneId, surface);
				} catch {}
			}
		}
		for (const path of rollbackPaths.reverse()) {
			try {
				rmSync(path, { force: true });
			} catch {}
		}
		throw error;
	}
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */

function releaseRunOwnership(running: RunningSubagent): void {
	running.sessionLease?.release();
	running.admissionLease?.release();
}

/** Free admission capacity while KEEPING session exclusivity.
 *
 * Two independent resources are bundled in `releaseRunOwnership`, and settling a
 * run whose pane is preserved needs exactly one of them released:
 *
 * - admission — bounds concurrent work. A preserved pane holds no slot: nothing
 *   is being supervised, and waiting for the user to close it would let a few
 *   preserved panes block all later work indefinitely.
 * - session lease — guarantees one writer per session path. It must NOT be
 *   released here: delivery transitions the lease immediately afterwards (a
 *   released lease throws on transition), and a preserved pane may still hold a
 *   live child writing to that session, so dropping exclusivity would allow a
 *   concurrent resume against a live writer.
 *
 * The detached pane monitor releases the session lease at explicit pane
 * disappearance. Leases are idempotent, so that later release is safe. */
function releaseAdmissionOnly(running: RunningSubagent): void {
	running.admissionLease?.release();
}

function safeCloseAndReap(running: RunningSubagent): void {
	const parentPaneId = process.env.HERDR_PANE_ID;
	try {
		safeCloseSubagentPane(running.surface);
	} catch {
		// Best-effort idempotent close; preserve the terminal outcome.
	}
	if (parentPaneId) {
		try {
			removePaneFromRegion(parentPaneId, running.surface);
		} catch {
			// Region bookkeeping is best-effort.
		}
	}
}

/** Keep a failed subagent's pane open for inspection (the child declined
 * shutdown by design), and reap region bookkeeping once the pane really
 * exits. Returns true when preservation applied, false if the pane is
 * already gone and normal close/reap should proceed. */
function preserveErrorPane(running: RunningSubagent): boolean {
	let inspection: ReturnType<typeof inspectHerdrPaneSync>;
	try {
		inspection = inspectHerdrPaneSync(running.surface);
	} catch {
		// An inspection failure is itself unexpected; never close a pane merely
		// because its status probe failed. Preserve it and keep monitoring until
		// an explicit missing result allows cleanup.
		startErrorPaneMonitor(running);
		return true;
	}
	// Only an explicit pane_not_found result authorizes cleanup. `unavailable`
	// may be a transient Herdr/socket/timeout failure while the child is alive.
	if (inspection.kind === "missing") return false;
	startErrorPaneMonitor(running);
	return true;
}

/** Detached watcher that removes a preserved error pane from the parent's
 * region once the pane really exits (user closes it, or the pi process
 * inside dies). Ownership is released only at that explicit boundary. */
function startErrorPaneMonitor(running: RunningSubagent): void {
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (running.errorPaneMonitorStarted) return;
	running.errorPaneMonitorStarted = true;
	const surface = running.surface;
	// Probe asynchronously: the sync `pane get` blocks the parent's event loop for
	// the whole subprocess timeout (5s) whenever herdr wedges, and this interval
	// fires every 2s — one wedged pane would repeatedly freeze the parent. The
	// in-flight guard also keeps ticks from piling up while a probe is pending.
	let probeInFlight = false;
	const timer = setInterval(() => {
		if (probeInFlight) return;
		probeInFlight = true;
		void inspectHerdrPane(surface)
			.then((inspection) => {
				// A transient/unavailable probe is not evidence that the pane vanished.
				return inspection.kind === "missing";
			})
			.catch(() => false)
			.then((gone) => {
				probeInFlight = false;
				if (!gone) return;
				clearInterval(timer);
				if (parentPaneId) {
					try {
						removePaneFromRegion(parentPaneId, surface);
					} catch {
						// Region bookkeeping is best-effort.
					}
				}
				releaseRunOwnership(running);
			});
	}, ERROR_PANE_MONITOR_INTERVAL_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
}

/** Fallback summary when the child session yielded no assistant text.
 *
 * An abandoned watch must not borrow the error wording: we do not know the run
 * failed, only that we stopped watching, and the child may still be producing
 * output right now. */
function fallbackSummary(result: Pick<CompletionResult, "reason" | "exitCode" | "errorMessage">): string {
	if (result.reason === "timeout") {
		return "Sub-agent had produced no output when watching stopped.";
	}
	if (result.errorMessage) return `Subagent error: ${result.errorMessage}`;
	if (result.exitCode !== 0) return `Sub-agent exited with code ${result.exitCode}`;
	return "Sub-agent exited without output";
}

/** How a settled run's pane and admission slot are disposed of, by reason.
 *
 * Three distinct cases, and conflating any two of them causes a real defect:
 *
 * - normal completion — close the pane; the caller's usual path releases both
 *   admission and the session lease.
 * - reported error — the child declined shutdown by design, so keep the pane for
 *   inspection. The child has exited, so free its admission slot at once;
 *   otherwise a handful of preserved error panes would block all later work
 *   until the user happened to close them.
 * - abandoned watch (deadline expired, no evidence) — keep the pane, because we
 *   do not know the child finished and it may still hold live work. Free the
 *   admission slot immediately: this is precisely the run least likely to ever
 *   exit, so tying its slot to pane closure leaks it indefinitely.
 *
 * In BOTH preserved cases only admission is freed. The session lease is retained
 * — delivery transitions it immediately afterwards, and a preserved pane may
 * still hold a live writer. See `releaseAdmissionOnly`. */
function resolveSettlementDisposition(reason: CompletionResult["reason"]): {
	watchAbandoned: boolean;
	preservePane: boolean;
	releaseAdmissionNow: boolean;
} {
	if (reason === "timeout") {
		return { watchAbandoned: true, preservePane: true, releaseAdmissionNow: true };
	}
	if (reason === "error") {
		return { watchAbandoned: false, preservePane: true, releaseAdmissionNow: true };
	}
	return { watchAbandoned: false, preservePane: false, releaseAdmissionNow: false };
}

/** Apply the pane/admission policy for a settled run, and report what was done.
 * Kept next to the policy so the decision and its execution cannot drift. */
function applySettlementDisposition(
	running: RunningSubagent,
	reason: CompletionResult["reason"],
): ReturnType<typeof resolveSettlementDisposition> {
	const disposition = resolveSettlementDisposition(reason);
	running.watchAbandoned = disposition.watchAbandoned;
	const errorPanePreserved = disposition.preservePane && preserveErrorPane(running);
	running.errorPanePreserved = errorPanePreserved;
	if (!errorPanePreserved) {
		safeCloseAndReap(running);
	}
	// Admission only — never the session lease. Releasing the session lease here
	// made the next step (`sessionLease.transition("finalizing")`) throw, which
	// silently destroyed delivery of the very result being settled.
	if (disposition.releaseAdmissionNow) releaseAdmissionOnly(running);
	return disposition;
}

function classifyStickyTerminal(
	running: RunningSubagent,
	result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "ping" | "watchAbandoned" | "alreadySettled">,
): StickyTerminalKind | undefined {
	if (result.alreadySettled || result.error === "cancelled" || running.lifecycle.delivery === "suppressed") {
		return undefined;
	}
	if (running.lifecycle.turn.kind === "interrupted" || result.ping) return "stopped";
	if (result.watchAbandoned) return "watch-abandoned";
	if (result.exitCode !== 0 || result.error || result.errorMessage) return "failed";
	return undefined;
}

function captureStickyTerminalRun(
	running: RunningSubagent,
	result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "ping" | "watchAbandoned" | "alreadySettled">,
	capturedAt = Date.now(),
): boolean {
	const kind = classifyStickyTerminal(running, result);
	if (!kind) return false;
	if (running.activityFile) observeRunningSubagent(running, capturedAt);
	const projection = projectLifecycle(ensureLifecycle(running), capturedAt);
	stickyTerminalRuns.set(running.id, {
		id: running.id,
		name: running.name,
		...(running.agent ? { agent: running.agent } : {}),
		...(running.admissionClass ? { admissionClass: running.admissionClass } : {}),
		startTime: running.startTime,
		runtimeEndedAt: projection.runtimeEndedAt ?? capturedAt,
		sessionFile: running.sessionFile,
		...(running.activity ? { activity: { ...running.activity } } : {}),
		kind,
		capturedAt,
	});
	return true;
}

function captureStickyLaunchFailure(params: {
	id: string;
	name: string;
	agent?: string;
	admissionClass?: "foreground" | "background";
	startTime: number;
	error: unknown;
}): void {
	if (stickyTerminalRuns.has(params.id)) return;
	if (params.error instanceof Error && /cancelled/i.test(params.error.message)) return;
	const capturedAt = Date.now();
	stickyTerminalRuns.set(params.id, {
		id: params.id,
		name: params.name,
		...(params.agent ? { agent: params.agent } : {}),
		...(params.admissionClass ? { admissionClass: params.admissionClass } : {}),
		startTime: params.startTime,
		runtimeEndedAt: capturedAt,
		kind: "failed",
		capturedAt,
	});
	updateWidget();
}

function clearStickyTerminalsOnAdmission(): void {
	if (stickyTerminalRuns.size === 0) return;
	stickyTerminalRuns.clear();
	updateWidget();
}

function evictResumedStickyTerminal(
	running: RunningSubagent,
	result: Pick<SubagentResult, "exitCode" | "error" | "errorMessage" | "ping" | "watchAbandoned">,
): void {
	if (
		!running.resumedStickyId ||
		result.exitCode !== 0 ||
		result.error ||
		result.errorMessage ||
		result.ping ||
		result.watchAbandoned
	) {
		return;
	}
	if (running.activityFile) observeRunningSubagent(running);
	if (running.activity?.latestEvent !== "subagent_done") return;
	stickyTerminalRuns.delete(running.resumedStickyId);
}

async function watchSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
	options: { releaseOwnership?: boolean; timeoutMs?: number } = { releaseOwnership: true },
): Promise<SubagentResult> {
	const { name, task, surface, startTime, sessionFile } = running;

	try {
		const result = await waitForCompletion(signal, {
			intervalMs: 1000,
			sessionFile,
			expectedRunId: running.id,
			// Per-run watch budget: caller override first, then the run's own budget,
			// then the module default. Without this the documented override was
			// unreachable in production — nothing passed it through.
			...((options.timeoutMs ?? running.completionTimeoutMs) != null
				? { timeoutMs: (options.timeoutMs ?? running.completionTimeoutMs) as number }
				: {}),
			readTerminalTail: () => readPaneAsync(surface, 5),
			// Injectable for tests: without an override this shells to real herdr, so a
			// fake pane id reports `missing` and settles as an error before the watch
			// deadline can ever be exercised.
			inspectPane: async () =>
				running.inspectPaneOverride ? running.inspectPaneOverride() : inspectPane(surface),
			onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
				ensureLifecycle(running);
				running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
				updateWidget();
			},
			onTick() {
				observeRunningSubagent(running);
			},
		});
		// Completion evidence can land before waitForCompletion's next onTick.
		// Re-read now so terminal snapshots and resume correlation see the child's
		// final counters and explicit subagent_done event.
		observeRunningSubagent(running);

		const settlementSource =
			result.reason === "timeout"
				? "timeout"
				: result.reason === "done" || result.reason === "ping" || result.reason === "error"
					? "sidecar"
					: result.reason === "sentinel"
						? "sentinel"
						: "pane-disappearance";
		const settlement = getSettlementRegistry(running.parentSessionId ?? "local").claim(
			running.id,
			settlementSource,
		);
		if (!settlement)
			return {
				name,
				task,
				summary: "Subagent completion was already settled.",
				sessionFile,
				exitCode: 0,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				alreadySettled: true,
			};
		const detectedAt = Date.now();
		running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
		updateWidget();
		const elapsed = Math.floor((detectedAt - startTime) / 1000);

		// Pi subagent result extraction
		let summary: string;
		if (existsSync(sessionFile)) {
			const allEntries = getNewEntries(sessionFile, running.entryCountBefore ?? 0);
			const observed = findObservedSessionRuntime(allEntries);
			if (running.runtimePlan && observed.provider && observed.modelId) {
				const observedModel = `${observed.provider}/${observed.modelId}`;
				const observedThinking =
					observed.thinking === "off" ||
					observed.thinking === "minimal" ||
					observed.thinking === "low" ||
					observed.thinking === "medium" ||
					observed.thinking === "high" ||
					observed.thinking === "xhigh" ||
					observed.thinking === "max"
						? observed.thinking
						: undefined;
				const mismatch =
					observedModel !== running.runtimePlan.model
						? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
						: undefined;
				running.runtimePlan = {
					...running.runtimePlan,
					...(observedThinking ? { thinking: observedThinking } : {}),
					observed: {
						model: observedModel,
						...(observedThinking ? { thinking: observedThinking } : {}),
					},
					...(mismatch ? { runtimeMismatch: mismatch } : {}),
				};
			}
			summary = findLastAssistantMessage(allEntries) ?? fallbackSummary(result);
		} else {
			summary = fallbackSummary(result);
		}

		const disposition = applySettlementDisposition(running, result.reason);
		running.lifecycle =
			result.exitCode === 0
				? markCompleted(running.lifecycle, Date.now())
				: markFailed(running.lifecycle, result.errorMessage ?? summary, Date.now(), result.exitCode);

		return {
			name,
			task,
			summary,
			sessionFile,
			exitCode: result.exitCode,
			elapsed,
			ping: result.ping,
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
			...(disposition.watchAbandoned ? { watchAbandoned: true } : {}),
		};
	} catch (err: any) {
		// Unexpected watcher failures are not proof that the child pane is dead.
		// Preserve it when possible so the user can inspect the broken worker;
		// only an explicit missing-pane result permits normal close/reap.
		const preserved = !signal.aborted && preserveErrorPane(running);
		running.errorPanePreserved = preserved;
		if (!preserved) safeCloseAndReap(running);
		// A preserved pane means the child may still be live, but the slot must not
		// be held until the user closes it — same policy as a structured error. The
		// session lease stays until explicit pane disappearance.
		if (preserved) releaseAdmissionOnly(running);
		running.lifecycle = markFailed(
			running.lifecycle,
			signal.aborted ? "Subagent cancelled." : (err?.message ?? String(err)),
			Date.now(),
			1,
		);
		updateWidget();

		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				error: "cancelled",
				sessionFile,
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${err?.message ?? String(err)}`,
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			error: err?.message ?? String(err),
		};
	} finally {
		if (options.releaseOwnership !== false && !running.errorPanePreserved) releaseRunOwnership(running);
	}
}

/**
 * Deliver a background completion message to the parent session.
 *
 * Persist-first, then wake: the message is sent WITHOUT `triggerTurn`, so
 * when the parent is idle pi writes the custom entry directly to the session
 * log (agent-session's no-trigger branch) — a synchronous write that bypasses
 * the extension `message_end` hook pipeline. The previous triggerTurn-based
 * delivery made persistence depend on a triggered agent turn surviving every
 * loaded extension's message hooks; a hook that throws on `role: "custom"`
 * killed the turn before persistence, silently, on every retry (the fire-and-
 * forget wrapper swallows the error). When the parent is streaming, the same
 * call queues a steer that the running loop drains and persists.
 *
 * After the entry is durably persisted and verified, the parent is woken
 * with a lightweight follow-up user message so it processes the result. The
 * wake is best-effort: the result is already durable, so a failed wake must
 * not fail delivery.
 */
async function deliverBackgroundMessage(
	// Legacy first parameter: retained for signature compatibility, never used.
	// Delivery ALWAYS resolves the active session-bound record at send time.
	_pi: ExtensionAPI | undefined,
	parentSessionId: string,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: {
		sessionFile?: string;
		expectedRunId?: string;
		graceMs?: number;
		/** Report why delivery is still waiting, so the widget can distinguish a
		 *  normal wait from a stuck one. */
		onWait?: (kind: DeliveryWaitKind) => void;
	} = {},
): Promise<void> {
	// Availability gate BEFORE the foreground barrier: a deferred delivery must
	// never reserve a drain batch's wake slot or run its session-log dedup under
	// the barrier's internal retry. Detected here, no action method,
	// acknowledgement verifier, or delivery bookkeeping is touched.
	requireActiveCompletionRuntime(parentSessionId);
	const barrier = getForegroundDeliveryBarrier(parentSessionId);
	const runId = options.expectedRunId;
	let sendOutcome: "deduped" | "sent" = "deduped";
	let ackPromise: Promise<void> | undefined;
	let mirroredAck: Promise<void> | undefined;
	let wakeRequested = false;
	let queuedIntoStream = false;
	let sentAtMs = 0;
	// Presentation must NEVER fail delivery. A throwing observer after the steer
	// was accepted would reject the barrier callback, and the retry would send a
	// second copy — dedup-before-send cannot see a steer that has not landed yet.
	const reportWait = (kind: DeliveryWaitKind): void => {
		try {
			options.onWait?.(kind);
		} catch {
			// observability only — never propagate
		}
	};
	// Phase 1 — dedup + persist-first send, serialized by the foreground
	// barrier. Bounded and fast: persistence polling is NOT awaited here, so a
	// dropped steer cannot block the drain for other deliveries in the batch.
	// Report a barrier hold up front: while held, no send is even attempted.
	if (barrier.isActive()) reportWait("barrier");
	await barrier.deliver(async (wake) => {
		// Confirmed-delivered in this process: never resend.
		if (runId && deliveredRunIds.has(runId)) {
			sendOutcome = "deduped";
			return;
		}
		// Another caller owns the in-flight acknowledgement for this run;
		// don't double-send — mirror its outcome in phase 2. Capture the
		// reference INSIDE the barrier: the ack may settle and be deleted before
		// phase 2 looks, and re-reading the map then would miss the rejection.
		if (runId && inflightDelivery.has(runId)) {
			mirroredAck = inflightDelivery.get(runId);
			sendOutcome = "deduped";
			return;
		}
		// Secondary dedup: session log (covers cross-restart duplicates — the
		// in-memory set is lost on process restart but the log persists).
		if (options.sessionFile && runId) {
			if (await deliveryEntryExists(options.sessionFile, runId, message.customType)) {
				deliveredRunIds.add(runId);
				sendOutcome = "deduped";
				return;
			}
		}
		// Defensive re-check inside the barrier: the active record may have
		// changed between the pre-check and this send (e.g. reload mid-drain).
		const activeRuntime = requireActiveCompletionRuntime(parentSessionId);
		const api = activeRuntime.api;
		// No triggerTurn: a triggered custom message must survive every loaded
		// extension's message_end hook, and a hook that throws on role:"custom"
		// kills the turn before persistence, silently, on every retry. When the
		// parent is streaming the steer is drained by the running loop; when idle it
		// is NOT guaranteed to persist until a turn runs, which is why the wake
		// below is not gated on acknowledgement.
		queuedIntoStream = runtime.parentActivity.streaming;
		sentAtMs = Date.now();
		api.sendMessage(message, { deliverAs: "steer" });
		sendOutcome = "sent";
		wakeRequested = wake;
		// Register the in-flight acknowledgement before waking the parent. A wake
		// can start a turn immediately; concurrent delivery must see this owner
		// before that turn (or a sibling) can attempt the same run ID.
		if (runId && options.sessionFile) {
			ackPromise = acknowledgeDelivery(options.sessionFile, runId, message.customType, {
				graceMs: options.graceMs ?? PRIMARY_DELIVERY_GRACE_MS,
				queuedIntoStream,
			}).then(
				() => {
					deliveredRunIds.add(runId);
					inflightDelivery.delete(runId);
				},
				(err: unknown) => {
					inflightDelivery.delete(runId);
					throw err;
				},
			);
			inflightDelivery.set(runId, ackPromise);
		}
		// Wake immediately after every accepted idle-parent send. Waiting until
		// this barrier callback's outer promise resolves is too late: a later
		// sibling can fail its defensive runtime check and strand this accepted
		// steer. wakeParent re-checks record identity, so it never sends through
		// a stale runtime if deactivation happened during sendMessage itself.
		if (!queuedIntoStream) {
			const activity = runtime.parentActivity;
			const currentTurnAlreadySeesIt = activity.streaming && activity.turnStartedAtMs >= sentAtMs;
			if (wakeRequested || !currentTurnAlreadySeesIt) wakeParent(parentSessionId, activeRuntime);
		}
		// A steer queued into a streaming parent persists at a turn boundary; an
		// idle-parent steer persists when the wake-triggered turn runs. Report the
		// wait phase after ownership and wake registration, and never fail delivery.
		reportWait(queuedIntoStream ? "turn-boundary" : "verifying");
	});
	// Phase 2 — persistence acknowledgement OUTSIDE the barrier drain.
	if (sendOutcome === "deduped") {
		// Mirror the captured in-flight outcome (rejects on loss → re-queue).
		if (mirroredAck) await mirroredAck;
		return;
	}
	// Wake was issued immediately after the accepted send, before awaiting its
	// acknowledgement. This avoids the idle-parent deadlock and remains safe if
	// another sibling fails during the same barrier drain.
	// We sent. If verification is possible, await the acknowledgement;
	// otherwise the send was accepted and fire-and-forget semantics apply.
	if (ackPromise) {
		await ackPromise; // rejects on loss → caller re-queues
	} else if (runId) {
		deliveredRunIds.add(runId);
	}
}

/** Cap on the stream-aware re-verify wait. A queued steer persists only when
 * the running loop drains it at a turn boundary, so this wait must tolerate the
 * longest legitimate parent turn. It exists solely to stop a *leak*: if the
 * steer was dropped AND `agent_settled` never arrives (lost event, wedged loop),
 * an uncapped loop hangs the run in `finalizing…` forever and it never reaches
 * the bounded retry pump.
 *
 * Deliberately far longer than any plausible turn. Expiry re-queues the
 * delivery, and a re-send can persist a DUPLICATE if the original steer was
 * merely slow rather than dropped (the loop would later drain both copies —
 * dedup-before-send cannot see a steer that has not landed yet). Trading a
 * permanent hang for a duplicate is only correct when expiry means "the parent
 * is broken", never "the parent is busy". */
const STREAM_ACK_MAX_WAIT_MS = 60 * 60_000;

/**
 * Stream-aware acknowledgement. A steer queued while the parent is streaming
 * persists only when the running loop drains it at a turn boundary — which
 * can take far longer than the base grace during a long turn. Re-verify for
 * as long as the parent remains active instead of mistaking a queued steer
 * for a dropped one (re-sending would persist a duplicate when the loop
 * drains both copies). Loss is declared only once the parent has settled AND
 * a final window still finds no entry; that engages the bounded retry pump.
 * The re-verify wait is itself capped (STREAM_ACK_MAX_WAIT_MS) so a dropped
 * steer plus a parent that never settles cannot hang the run indefinitely.
 */
async function acknowledgeDelivery(
	sessionFile: string,
	runId: string,
	customType: string,
	options: { graceMs: number; queuedIntoStream: boolean; streamWaitMs?: number },
): Promise<void> {
	try {
		await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
		return;
	} catch (err) {
		if (!options.queuedIntoStream) throw err;
	}
	const streamDeadline = Date.now() + (options.streamWaitMs ?? STREAM_ACK_MAX_WAIT_MS);
	while (runtime.parentActivity.streaming && Date.now() < streamDeadline) {
		try {
			await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
			return;
		} catch {
			// Not yet drained; parent still active — keep waiting.
		}
	}
	// Parent settled (or was never observed streaming after the send): one
	// final window before declaring loss.
	await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
}

/** Emit the static wake nudge, deduplicated per parent session. Best-effort:
 * the persisted result is the durable record, so a failed wake never fails
 * delivery. */
function wakeParent(parentSessionId: string, expectedRecord?: ActiveCompletionRuntime): void {
	// Optional identity check prevents an accepted send's continuation from
	// using a stale API after a reload/session replacement.
	const record = resolveActiveCompletionRuntime(parentSessionId);
	if (!record || (expectedRecord && record !== expectedRecord)) return;
	if (wakeInflightByParent.has(parentSessionId)) return;
	wakeInflightByParent.add(parentSessionId);
	try {
		record.api.sendUserMessage(WAKE_MESSAGE, { deliverAs: "followUp" });
	} catch {
		// Wake is an optimization; the persisted result surfaces on the next turn.
	}
	const timer = setTimeout(() => {
		wakeInflightByParent.delete(parentSessionId);
	}, 30_000);
	(timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Check whether a custom message with the given run ID already exists in the
 * parent session log. Used for dedup-before-send to prevent duplicate deliveries.
 */
async function deliveryEntryExists(sessionFile: string, expectedRunId: string, customType: string): Promise<boolean> {
	return (await findDeliveryEntry(sessionFile, expectedRunId, customType)) !== null;
}

/** Quick non-throwing JSON parse check for partial-line detection. */
function canParseJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Delivery acknowledgement check. The pi `sendMessage` wrapper is
 * fire-and-forget, so a dropped steer is otherwise silent. This polls the
 * parent session log for a bounded grace period and resolves when the
 * expected custom-message entry appears (the delivery is then confirmed and
 * deduplicated). If the entry is not observed within the grace window, the
 * promise rejects so the caller leaves the run un-confirmed and engages the
 * bounded pending-delivery retry — a silently dropped steer is never
 * permanently deduplicated.
 *
 * The 5000ms default grace accounts for streaming latency; the primary
 * delivery path overrides this with PRIMARY_DELIVERY_GRACE_MS. The
 * `deliveredRunIds` set is the confirmed-delivery dedup; this verification
 * is the acceptance boundary that gates entry into it.
 */
async function verifyDeliveryPersisted(
	sessionFile: string,
	expectedRunId: string,
	customType: string,
	options: { graceMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const graceMs = options.graceMs ?? 5000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (await deliveryEntryExists(sessionFile, expectedRunId, customType)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Delivery verification failed: ${customType} message with run ID ${expectedRunId} not persisted within ${graceMs}ms`,
	);
}

/**
 * Scan the tail of a parent session JSONL for a custom-message entry matching
 * both `customType` and `details.id === expectedRunId`. Normalizes the record
 * format: some pi versions nest fields under `.message`, others are flat.
 * Returns the matching record or null.
 */
async function findDeliveryEntry(sessionFile: string, expectedRunId: string, customType: string): Promise<any | null> {
	try {
		if (!existsSync(sessionFile)) return null;
		// Read backward in expanding chunks until we have enough complete records.
		// A fixed 32 KiB window cannot guarantee 128 records — a single
		// subagent_result with a large runtimePlan can exceed 32 KiB. Start at
		// 32 KiB and double (up to 1 MiB) until 128 complete nonempty lines are
		// found or the file head is reached.
		const { size } = await statAsync(sessionFile);
		let readSize = Math.min(size, 32_768);
		let offset = Math.max(0, size - readSize);
		let tailContent = "";
		const fd = await openAsync(sessionFile, "r");
		try {
			// Six iterations reach the 1 MiB cap (32, 64, 128, 256, 512, 1024 KiB).
			for (let attempt = 0; attempt < 6; attempt++) {
				const buf = Buffer.alloc(readSize);
				const { bytesRead } = await fd.read(buf, 0, readSize, offset);
				const chunk = buf.subarray(0, bytesRead).toString("utf8");
				// Each expanded read is a superset of the previous suffix, so replace
				// the buffer outright. Prepending would duplicate the overlapping
				// newest records and let slice(-128) drop an older delivery that is
				// still within the newest 128 unique records (cross-restart dedup miss
				// → completion resent).
				tailContent = chunk;
				let lines = tailContent.split("\n").filter((l) => l.trim());
				// When reading mid-file, the first line is a cut partial record —
				// drop it before counting so it cannot satisfy the 128-complete-record
				// threshold one record early and exclude a valid older delivery.
				if (offset > 0 && lines.length > 0) lines = lines.slice(1);
				if (lines.length >= 128 || offset === 0) {
					tailContent = lines.slice(-128).join("\n");
					break;
				}
				// Expand: double the read window, capped at 1 MiB. The next iteration
				// reads this larger window from the new offset (no early break here —
				// breaking before reading would skip the head of the file).
				readSize = Math.min(1_048_576, readSize * 2);
				offset = Math.max(0, size - readSize);
			}
		} finally {
			await fd.close();
		}
		// Discard a leading partial record (if the first line was cut mid-record).
		const allLines = tailContent.split("\n").filter((l) => l.trim());
		// If the first line doesn't parse, it's a partial — drop it.
		const completeLines = allLines.length > 0 && !canParseJson(allLines[0]) ? allLines.slice(1) : allLines;
		for (const line of completeLines.slice(-128)) {
			try {
				const record = JSON.parse(line);
				// Normalize: independently test both .message and flat record shapes,
				// requiring customType and run ID to match on the SAME candidate.
				for (const candidate of [record.message, record]) {
					if (candidate && typeof candidate === "object" && candidate.customType === customType) {
						const details = candidate.details ?? candidate.data?.details;
						if (details?.id === expectedRunId) return record;
					}
				}
			} catch {
				// Skip malformed/partial lines (concurrent writes).
			}
		}
	} catch {
		// Read failed — return null (caller retries within grace window).
	}
	return null;
}

function queuePendingDeliveryWithVerification(
	id: string,
	parentSessionId: string,
	message: any,
	error: unknown,
	options: { sessionFile?: string; expectedRunId?: string } = {},
	attempts = 0,
): void {
	const existing = pendingDeliveries.get(id);
	// A first enqueue caused by an unavailable runtime records ZERO ordinary
	// send attempts — nothing was sent — and starts the continuous-deferral
	// interval that the bounded deferral budget measures.
	const runtimeUnavailable = isSessionRuntimeUnavailable(error);
	const now = Date.now();
	pendingDeliveries.set(id, {
		id,
		parentSessionId,
		message,
		attempts,
		delivering: false,
		generation: (existing?.generation ?? 0) + 1,
		nextRetryAt: now + Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)),
		lastError: error instanceof Error ? error.message : String(error),
		sessionFile: options.sessionFile,
		expectedRunId: options.expectedRunId,
		...(runtimeUnavailable ? { deferredSince: existing?.deferredSince ?? now } : {}),
	});
	// Start unconditionally. An unavailable runtime is exactly when the global
	// scheduler is needed to enforce the bounded deferral budget, and an old
	// pre-reload watcher must be able to start it after replacement activation.
	startDeliveryRetry();
}

const DELIVERY_PUMP_KEY = Symbol.for("pi-subagent-herdr/delivery-pump");
async function retryPendingDeliveries(): Promise<void> {
	const globals = globalThis as any;
	const existingPump = globals[DELIVERY_PUMP_KEY] as Promise<void> | undefined;
	if (existingPump) return existingPump;
	const pump = (async () => {
		for (const pending of Array.from(pendingDeliveries.values())) {
			if (getForegroundDeliveryBarrier(pending.parentSessionId).isSuppressed()) {
				pendingDeliveries.delete(pending.id);
				continue;
			}
			const now = Date.now();
			if (pending.exhausted || pending.delivering || pending.nextRetryAt > now) continue;
			// Deferral budget: an entry continuously without a matching active
			// runtime past DEFERRED_DELIVERY_MAX_MS is terminally undeliverable.
			if (pending.deferredSince !== undefined && now - pending.deferredSince >= DEFERRED_DELIVERY_MAX_MS) {
				pending.exhausted = true;
				pending.exhaustionCause = "deferral";
				pending.lastError =
					`No active session-bound runtime for ${Math.round((now - pending.deferredSince) / 1000)}s ` +
					`(deferral budget exceeded). Last: ${pending.lastError ?? "runtime unavailable"}`;
				continue;
			}
			pending.delivering = true;
			const generation = pending.generation;
			try {
				await deliverBackgroundMessage(undefined, pending.parentSessionId, pending.message, {
					sessionFile: pending.sessionFile,
					expectedRunId: pending.expectedRunId,
				});
				const current = pendingDeliveries.get(pending.id);
				if (current?.generation === generation) pendingDeliveries.delete(pending.id);
			} catch (error) {
				const current = pendingDeliveries.get(pending.id);
				if (current?.generation !== generation) continue;
				current.delivering = false;
				if (isSessionRuntimeUnavailable(error)) {
					// Deferred availability, not a failed send: the ordinary attempt
					// budget is untouched and the entry is re-checked promptly.
					current.deferredSince ??= Date.now();
					current.lastError = error instanceof Error ? error.message : String(error);
					current.nextRetryAt = Date.now() + 500;
					continue;
				}
				// Reached a matching active runtime: the continuous deferral interval
				// is over, whether or not this send ultimately succeeds.
				delete current.deferredSince;
				current.attempts++;
				current.lastError = error instanceof Error ? error.message : String(error);
				current.exhausted = current.attempts >= MAX_PENDING_DELIVERY_ATTEMPTS;
				if (current.exhausted) current.exhaustionCause = "attempts";
				current.nextRetryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(current.attempts, 6));
			}
		}
	})();
	const trackedPump = pump.finally(() => {
		if (globals[DELIVERY_PUMP_KEY] === trackedPump) delete globals[DELIVERY_PUMP_KEY];
	});
	globals[DELIVERY_PUMP_KEY] = trackedPump;
	return trackedPump;
}

function commitRunningLaunch(running: RunningSubagent): void {
	const transaction = running.launchTransaction;
	if (!transaction) return;
	transaction.advance("watcher");
	transaction.commit();
	finishLaunchTransaction(running.id, transaction);
	running.launchTransaction = undefined;
}

function superviseBackgroundRun(
	parentSessionId: string,
	running: RunningSubagent,
	summarize?: (result: SubagentResult) => SubagentResult,
): void {
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	startWidgetRefresh();
	startStatusRefresh();
	watchSubagent(running, watcherAbort.signal, { releaseOwnership: false })
		.then(async (rawResult) => {
			if (rawResult.alreadySettled) {
				running.lifecycle = markDelivery(running.lifecycle, "suppressed");
				runningSubagents.delete(running.id);
				releaseRunOwnership(running);
				updateWidget();
				return;
			}
			const result = summarize ? summarize(rawResult) : rawResult;
			if (!shouldDeliverSubagentCompletion(running)) {
				running.lifecycle = markDelivery(running.lifecycle, "suppressed");
				runningSubagents.delete(running.id);
				releaseRunOwnership(running);
				updateWidget();
				return;
			}
			running.sessionLease?.transition("finalizing");
			const message = result.ping
				? {
						customType: "subagent_ping",
						content: `Sub-agent "${result.ping.name}" [${running.id}] needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}\n\nSession: ${result.sessionFile}\nResume with subagent_resume path: ${result.sessionFile}`,
						display: true,
						details: {
							id: running.id,
							name: result.ping.name,
							message: result.ping.message,
							agent: running.agent,
							sessionFile: result.sessionFile,
						},
					}
				: {
						customType: "subagent_result",
						content: running.runtimePlan?.runtimeMismatch
							? `${resolveResultPresentation(result, running.name, running.id)}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
							: resolveResultPresentation(result, running.name, running.id),
						display: true,
						details: {
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
						},
					};
			try {
				await deliverBackgroundMessage(undefined, parentSessionId, message, {
					sessionFile: running.parentSessionFile,
					expectedRunId: running.id,
					onWait: (kind) => {
						// Only re-stamp on a phase change so the widget shows how long this
						// wait has actually lasted, not how long delivery has been running.
						if (running.deliveryWait?.kind === kind) return;
						running.deliveryWait = { kind, since: Date.now() };
						updateWidget();
					},
				});
				running.lifecycle = markDelivery(running.lifecycle, "delivered");
			} catch (error) {
				if (!getForegroundDeliveryBarrier(parentSessionId).isSuppressed()) {
					// A runtime-unavailable failure is a first deferral, not a first
					// failed send: the initial enqueue records zero ordinary attempts.
					const deferred = isSessionRuntimeUnavailable(error);
					queuePendingDeliveryWithVerification(
						running.id,
						parentSessionId,
						message,
						error,
						{
							sessionFile: running.parentSessionFile,
							expectedRunId: running.id,
						},
						deferred ? 0 : 1,
					);
					startDeliveryRetry();
				} else {
					running.lifecycle = markDelivery(running.lifecycle, "suppressed");
				}
			} finally {
				// The row is removed either way; clear the wait so a preserved-pane
				// reference can never render a stale delivery label.
				running.deliveryWait = undefined;
				evictResumedStickyTerminal(running, result);
				captureStickyTerminalRun(running, result);
				runningSubagents.delete(running.id);
				if (!running.errorPanePreserved) releaseRunOwnership(running);
				updateWidget();
			}
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			running.lifecycle = markFailed(running.lifecycle, message, Date.now(), 1);
			running.errorPanePreserved = preserveErrorPane(running);
			captureStickyTerminalRun(running, { exitCode: 1, error: message });
			runningSubagents.delete(running.id);
			if (running.errorPanePreserved) releaseAdmissionOnly(running);
			else releaseRunOwnership(running);
			updateWidget();
		});
	try {
		commitRunningLaunch(running);
	} catch (error) {
		const aborted = running.launchTransaction?.signal.aborted ?? false;
		running.launchTransaction?.rollback();
		finishLaunchTransaction(running.id, running.launchTransaction!);
		running.abortController?.abort();
		if (!aborted) {
			const message = error instanceof Error ? error.message : String(error);
			running.lifecycle = markFailed(running.lifecycle, message, Date.now(), 1);
			captureStickyTerminalRun(running, { exitCode: 1, error: message });
		}
		runningSubagents.delete(running.id);
		releaseRunOwnership(running);
		updateWidget();
		throw error;
	}
}

async function startBackgroundSpawn(options: {
	params: typeof SubagentParams.static;
	ctx: StableParentContext;
	agentDefinition: AgentDefinition;
	selectedSkills: SelectedSkill[];
	runtimePlan: ResolvedRuntimePlan;
	runId: string;
	admissionLease: AdmissionLease;
	projectTrusted: boolean;
}): Promise<RunningSubagent> {
	let running: RunningSubagent | undefined;
	try {
		running = await launchSubagent(options.params, options.ctx, {
			agentDefinition: options.agentDefinition,
			selectedSkills: options.selectedSkills,
			runtimePlan: options.runtimePlan,
			runId: options.runId,
			admissionClass: "background",
			admissionLease: options.admissionLease,
			projectTrusted: options.projectTrusted,
		});
		running.parentSessionFile = options.ctx.sessionFile;
		superviseBackgroundRun(options.ctx.sessionId, running);
		return running;
	} catch (error) {
		running?.launchTransaction?.rollback();
		if (running) finishLaunchTransaction(running.id, running.launchTransaction!);
		captureStickyLaunchFailure({
			id: options.runId,
			name: options.params.label?.trim() || options.params.agent,
			agent: options.params.agent,
			admissionClass: "background",
			startTime: options.admissionLease.admittedAt ?? Date.now(),
			error,
		});
		options.admissionLease.release();
		throw error;
	}
}

function startDeliveryRetry(): void {
	const globals = globalThis as any;
	if (globals[DELIVERY_RETRY_INTERVAL_KEY]) return;
	const interval = setInterval(() => {
		void retryPendingDeliveries().catch(() => undefined);
		if (
			pendingDeliveries.size === 0 ||
			Array.from(pendingDeliveries.values()).every((pending) => pending.exhausted)
		) {
			if (globals[DELIVERY_RETRY_INTERVAL_KEY] === interval) {
				clearInterval(interval);
				globals[DELIVERY_RETRY_INTERVAL_KEY] = null;
			}
		}
	}, 1000);
	globals[DELIVERY_RETRY_INTERVAL_KEY] = interval;
}

function stopDeliveryRetry(): void {
	const globals = globalThis as any;
	const interval = globals[DELIVERY_RETRY_INTERVAL_KEY] as ReturnType<typeof setInterval> | null | undefined;
	if (interval) clearInterval(interval);
	globals[DELIVERY_RETRY_INTERVAL_KEY] = null;
}

interface ShutdownState {
	queued: Map<string, QueuedSubagent>;
	running: Map<string, RunningSubagent>;
	pending: Map<string, PendingDelivery>;
}

export function settleParentShutdown(
	reason: unknown,
	parentSessionId: string,
	state: ShutdownState = { queued: queuedSubagents, running: runningSubagents, pending: pendingDeliveries },
	ops: {
		safeClose?: (running: RunningSubagent) => void;
		release?: (running: RunningSubagent) => void;
		abortTransactions?: () => void;
	} = {},
): void {
	const safeClose = ops.safeClose ?? safeCloseAndReap;
	const release = ops.release ?? releaseRunOwnership;
	if (shouldPreserveSubagentsOnShutdown(reason)) {
		for (const queued of Array.from(state.queued.values())) {
			if (queued.admissionClass !== "foreground") continue;
			queued.cancel();
			state.queued.delete(queued.id);
		}
		for (const running of Array.from(state.running.values())) {
			if (running.admissionClass !== "foreground") continue;
			running.lifecycle = markDelivery(running.lifecycle, "suppressed");
			running.abortController?.abort();
			safeClose(running);
			release(running);
			running.foregroundBarrierLease?.release();
			state.running.delete(running.id);
		}
		return;
	}

	getForegroundDeliveryBarrier(parentSessionId).suppressPending();
	for (const pending of state.pending.values()) pending.exhausted = true;
	state.pending.clear();
	for (const queued of state.queued.values()) queued.cancel();
	state.queued.clear();
	getAdmissionCoordinator(parentSessionId).shutdownNow();
	(ops.abortTransactions ?? abortAllLaunchTransactions)();
	for (const running of state.running.values()) {
		safeClose(running);
		release(running);
		running.foregroundBarrierLease?.release();
	}
	cleanupSubagentsForShutdown(reason, state.running);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	// The factory registers tools and handlers ONLY. Pi binds action methods to
	// a session after the factory returns, so publishing `pi` here would leak an
	// unbound discovery-time API into delivery state. Activation happens at
	// session_start; this instance's ownership token lets its session_shutdown
	// clear only its OWN record (never a replacement session's).
	let ownedCompletionRuntime: ActiveCompletionRuntime | undefined;

	// Track parent agent-loop activity. Stream-queued deliveries persist only
	// at turn boundaries, so acknowledgement waits while the parent is active;
	// wakes are only needed for deliveries persisted while the parent is idle.
	// agent_settled (not agent_end) is the authoritative idle boundary: pi keeps
	// isStreaming true through post-agent_end retry backoff, compaction, and
	// queued continuations — deliveries in that gap are stream-queued, not idle.
	pi.on("agent_start", () => {
		runtime.parentActivity.streaming = true;
		runtime.parentActivity.turnStartedAtMs = Date.now();
		wakeInflightByParent.clear();
	});
	pi.on("agent_settled", () => {
		runtime.parentActivity.streaming = false;
	});

	// Capture the UI context for widget updates and restore presentation for
	// subagents whose watchers survived a reload.
	pi.on("session_start", (_event, ctx) => {
		// Timer takeover is a session-bound lifecycle action. Discovery-only
		// module evaluations never reach this handler and therefore cannot clear
		// the active module's timers.
		claimTimerOwnership();
		runtime.latestCtx = ctx;
		const parentSessionId = ctx.sessionManager.getSessionId();
		// Pi has bound the runtime when it emits session_start: THIS is the
		// delivery-API activation boundary.
		ownedCompletionRuntime = activateCompletionRuntime(pi, parentSessionId);
		getAdmissionCoordinator(parentSessionId); // in-place upgrade of pre-reload coordinator state
		// Keep in-flight ownership across reload; the process-global pump serializes retries.
		const activeForegroundIds = [
			...Array.from(queuedSubagents.values())
				.filter((entry) => entry.admissionClass === "foreground")
				.map((entry) => entry.id),
			...Array.from(runningSubagents.values())
				.filter((entry) => entry.admissionClass === "foreground")
				.map((entry) => entry.id),
		];
		getForegroundDeliveryBarrier(parentSessionId).reconcileActive(activeForegroundIds);
		// Re-drive DEFERRAL-exhausted and still-deferred entries now that a runtime
		// is active: reset BOTH flags so the row leaves the undeliverable count and
		// renders as awaiting the runtime rather than immediately re-exhausting and
		// flapping. Ordinary send-attempt exhaustion stays terminal — a permanent
		// send failure must not receive another attempt on every reload.
		for (const pending of pendingDeliveries.values()) {
			if (pending.parentSessionId !== parentSessionId) continue;
			const deferralExhausted =
				pending.exhausted &&
				(pending.exhaustionCause === "deferral" ||
					(pending.exhaustionCause === undefined && pending.deferredSince !== undefined));
			if (deferralExhausted || (!pending.exhausted && pending.deferredSince !== undefined)) {
				pending.exhausted = false;
				delete pending.exhaustionCause;
				pending.delivering = false;
				delete pending.deferredSince;
				pending.nextRetryAt = Date.now();
			}
		}
		void retryPendingDeliveries().catch(() => undefined);
		if (pendingDeliveries.size > 0) startDeliveryRetry();
		if (
			runningSubagents.size > 0 ||
			queuedSubagents.size > 0 ||
			pendingDeliveries.size > 0 ||
			stickyTerminalRuns.size > 0
		) {
			startWidgetRefresh();
			if (runningSubagents.size > 0 || pendingDeliveries.size > 0) startStatusRefresh();
			updateWidget();
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", (event, _ctx) => {
		// Deactivate only OUR record: during reload/session replacement the new
		// instance may already have activated its own runtime, and this old
		// closure must never clear or send through it.
		deactivateCompletionRuntime(ownedCompletionRuntime);
		ownedCompletionRuntime = undefined;
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
		if ((event as any).reason !== "reload") stopDeliveryRetry();
		// Clear the in-memory delivery dedup set on terminal shutdown (not reload).
		// On reload, the set is preserved so in-flight deliveries aren't duplicated.
		if ((event as any).reason !== "reload") {
			deliveredRunIds.clear();
			stickyTerminalRuns.clear();
		}

		settleParentShutdown((event as any).reason, _ctx.sessionManager.getSessionId());
	});

	// Hard gate: children never register lifecycle tools (Phase 11), independent of denylist env.
	const isChildSubagent = Boolean(process.env.PI_SUBAGENT_ID);
	const deniedTools = new Set(
		(isChildSubagent ? (process.env.PI_DENY_TOOLS ?? "") : "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	for (const name of LIFECYCLE_DENY_TOOLS) {
		if (isChildSubagent) deniedTools.add(name);
	}

	const shouldRegister = (name: string) => !isChildSubagent && !deniedTools.has(name);

	// ── subagent tool ──
	if (shouldRegister("subagent"))
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

			async execute(_toolCallId: any, params: any, signal: any, _onUpdate: any, ctx: ExtensionContext) {
				const stableCtx = snapshotParentContext(ctx);
				const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
				const parentModelRegistry = ctx.modelRegistry;
				let agentDefinition: AgentDefinition;
				let selectedSkills: SelectedSkill[];
				try {
					agentDefinition = loadAgentDefinition({
						id: params.agent,
						cwd: stableCtx.cwd,
						agentDir: stableCtx.agentDir,
						projectTrusted: stableCtx.projectTrusted,
					});
					selectedSkills = await resolveSelectedSkills({
						raw: agentDefinition.skills,
						cwd: stableCtx.cwd,
						agentDir: stableCtx.agentDir,
						projectTrusted: stableCtx.projectTrusted,
					});
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text }],
						details: { error: text },
						isError: true,
					};
				}

				// Definition and selected skills are fully valid before environment/resource creation.
				if (!isTerminalAvailable()) return muxUnavailableResult();
				if (!stableCtx.sessionFile) {
					return {
						content: [{ type: "text", text: "Error: no session file." }],
						details: { error: "no session file" },
					};
				}
				if (!process.env.HERDR_PANE_ID) {
					return {
						content: [{ type: "text", text: "Error: HERDR_PANE_ID not set" }],
						details: { error: "missing HERDR_PANE_ID" },
						isError: true,
					};
				}

				const blocking = resolveBlocking(params);
				const admissionClass = blocking ? "foreground" : "background";
				const runId = createRunId();
				const parentSessionId = stableCtx.sessionId;
				const parentThinking = pi.getThinkingLevel();
				if (
					parentThinking !== "off" &&
					parentThinking !== "minimal" &&
					parentThinking !== "low" &&
					parentThinking !== "medium" &&
					parentThinking !== "high" &&
					parentThinking !== "xhigh" &&
					parentThinking !== "max"
				) {
					throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
				}
				if (!parentModel) throw new Error("Subagent launch requires a resolved parent model");
				const runtimePlan = resolveRuntimePlan(
					{},
					{ model: agentDefinition.model, thinking: agentDefinition.thinking as ThinkingLevel | undefined },
					{ provider: parentModel.provider, modelId: parentModel.id, thinking: parentThinking },
					wrapPiModelRegistry(parentModelRegistry),
				);

				const foregroundBarrierLease = blocking
					? getForegroundDeliveryBarrier(parentSessionId).enter(runId)
					: undefined;
				let ticket: ReturnType<ReturnType<typeof getAdmissionCoordinator>["request"]>;
				try {
					ticket = getAdmissionCoordinator(parentSessionId).request({
						id: runId,
						class: admissionClass,
						...(blocking ? { signal } : {}),
					});
				} catch (error) {
					foregroundBarrierLease?.release();
					throw error;
				}

				const backgroundLaunch = () => {
					clearStickyTerminalsOnAdmission();
					return startBackgroundSpawn({
						params,
						ctx: stableCtx,
						agentDefinition,
						selectedSkills,
						runtimePlan,
						runId,
						admissionLease: ticket.lease,
						projectTrusted: stableCtx.projectTrusted,
					});
				};
				if (!blocking && ticket.queued) {
					const queuedEntry: QueuedSubagent = {
						id: runId,
						name: params.label?.trim() || params.agent,
						agent: params.agent,
						admissionClass: "background",
						queuedAt: Date.now(),
						cancel: () => ticket.lease.cancel(),
					};
					queuedSubagents.set(runId, queuedEntry);
					updateWidget();
					void ticket.admitted
						.then(
							() => {
								queuedSubagents.delete(runId);
								updateWidget();
								return backgroundLaunch();
							},
							() => {
								queuedSubagents.delete(runId);
								updateWidget();
								throw new Error("Subagent admission cancelled.");
							},
						)
						.catch(async (error) => {
							if (ticket.lease.state === "cancelled") return;
							// Detached (queued, non-blocking) shape kept: the tool handler
							// already returned. Terminal rejection handling: a delivery
							// failure during the reload gap is re-queued by run ID (with
							// verification context) and no rejection escapes un-awaited.
							const message = {
								customType: "subagent_result",
								content: `Queued subagent "${params.label?.trim() || params.agent}" [${runId}] failed to launch: ${error instanceof Error ? error.message : String(error)}`,
								display: true,
								details: { id: runId, name: params.label?.trim() || params.agent, agent: params.agent },
							};
							try {
								await deliverBackgroundMessage(undefined, parentSessionId, message, {
									sessionFile: stableCtx.sessionFile,
									expectedRunId: runId,
								});
							} catch (deliveryError) {
								if (!getForegroundDeliveryBarrier(parentSessionId).isSuppressed()) {
									queuePendingDeliveryWithVerification(
										runId,
										parentSessionId,
										message,
										deliveryError,
										{
											sessionFile: stableCtx.sessionFile,
											expectedRunId: runId,
										},
										isSessionRuntimeUnavailable(deliveryError) ? 0 : 1,
									);
									startDeliveryRetry();
								}
							}
						})
						.catch(() => undefined);
					return {
						content: [
							{
								type: "text",
								text: `Sub-agent "${params.label?.trim() || params.agent}" [${runId}] queued for background admission; no pane or session has been created.`,
							},
						],
						details: {
							id: runId,
							name: params.label?.trim() || params.agent,
							agent: params.agent,
							status: "queued",
							class: "background",
						},
					};
				}

				if (blocking && ticket.queued) {
					queuedSubagents.set(runId, {
						id: runId,
						name: params.label?.trim() || params.agent,
						agent: params.agent,
						admissionClass: "foreground",
						queuedAt: Date.now(),
						cancel: () => ticket.lease.cancel(),
					});
					updateWidget();
				}
				try {
					await ticket.admitted;
				} catch (error) {
					queuedSubagents.delete(runId);
					updateWidget();
					foregroundBarrierLease?.release();
					const text = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text }],
						details: { id: runId, status: "cancelled" },
						isError: true,
					};
				}
				if (blocking) clearStickyTerminalsOnAdmission();
				queuedSubagents.delete(runId);
				updateWidget();

				if (!blocking) {
					const running = await backgroundLaunch();
					return {
						content: [
							{
								type: "text",
								text: appendLayoutWarning(
									`Sub-agent "${running.name}" [${running.id}] launched in the background; completion will arrive automatically.`,
									running.layoutWarning,
								),
							},
						],
						details: {
							id: running.id,
							name: running.name,
							task: params.task,
							agent: params.agent,
							sessionFile: running.sessionFile,
							launchScriptFile: running.launchScriptFile,
							model: running.runtimePlan?.model,
							thinking: running.runtimePlan?.thinking,
							runtimePlan: running.runtimePlan,
							status: "started",
							class: "background",
							...(running.layoutWarning ? { layoutWarning: running.layoutWarning } : {}),
						},
					};
				}

				let running: RunningSubagent;
				try {
					running = await launchSubagent(params, stableCtx, {
						agentDefinition,
						selectedSkills,
						runtimePlan,
						runId,
						admissionClass,
						admissionLease: ticket.lease,
						projectTrusted: stableCtx.projectTrusted,
					});
					running.foregroundBarrierLease = foregroundBarrierLease;
				} catch (error) {
					captureStickyLaunchFailure({
						id: runId,
						name: params.label?.trim() || params.agent,
						agent: params.agent,
						admissionClass,
						startTime: ticket.lease.admittedAt ?? Date.now(),
						error,
					});
					ticket.lease.release();
					foregroundBarrierLease?.release();
					throw error;
				}
				// Authoritative: suppress stall steers whenever this spawn is blocking
				// (covers config-default blocking even if launch params were partially applied).
				if (blocking) running.suppressStatusSteer = true;

				// Watcher abort: for async, independent of the tool signal (we return immediately).
				// For blocking, chain the parent tool signal so ESC cancels the watcher.
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;
				if (blocking) {
					signal?.addEventListener("abort", () => watcherAbort.abort(), { once: true });
					if (signal?.aborted) watcherAbort.abort();
				}

				// Register the watcher and presentation resources before committing the transaction.
				let blockingWatch: Promise<SubagentResult> | undefined;
				try {
					blockingWatch = blocking
						? watchSubagent(running, watcherAbort.signal, { releaseOwnership: false })
						: undefined;
					startWidgetRefresh();
					startStatusRefresh();
					commitRunningLaunch(running);
				} catch (error) {
					watcherAbort.abort();
					const aborted = running.launchTransaction?.signal.aborted ?? false;
					running.launchTransaction?.rollback();
					if (running.launchTransaction) finishLaunchTransaction(running.id, running.launchTransaction);
					if (!aborted) {
						const message = error instanceof Error ? error.message : String(error);
						running.lifecycle = markFailed(running.lifecycle, message, Date.now(), 1);
						captureStickyTerminalRun(running, { exitCode: 1, error: message });
					}
					runningSubagents.delete(running.id);
					releaseRunOwnership(running);
					foregroundBarrierLease?.release();
					updateWidget();
					throw error;
				}

				if (blocking) {
					const result = await blockingWatch!;
					running.sessionLease?.transition("finalizing");

					running.lifecycle = markDelivery(
						running.lifecycle,
						shouldDeliverSubagentCompletion(running) ? "delivered" : "suppressed",
					);
					evictResumedStickyTerminal(running, result);
					captureStickyTerminalRun(running, result);
					runningSubagents.delete(running.id);
					if (!running.errorPanePreserved) releaseRunOwnership(running);
					setTimeout(() => running.foregroundBarrierLease?.release(), 0);
					updateWidget();

					if (result.ping) {
						const agentHint = "Answer via subagent_resume with the returned path.";
						const who = `"${running.name}" (${running.agent}) [${running.id}]`;
						const text = appendLayoutWarning(
							`Sub-agent ${who} needs help: ${result.ping.message}

` +
								`Session: ${result.sessionFile}
${agentHint}`,
							running.layoutWarning,
						);
						return {
							content: [{ type: "text", text }],
							details: {
								...result,
								id: running.id,
								status: "ping",
								blocking: true,
								agent: running.agent,
								...(running.layoutWarning ? { layoutWarning: running.layoutWarning } : {}),
							},
						};
					}

					const base = resolveResultPresentation(result, running.name, running.id);
					const mismatch = running.runtimePlan?.runtimeMismatch;
					let text = mismatch
						? `${base}

Runtime warning: ${mismatch}`
						: base;
					text = appendLayoutWarning(text, running.layoutWarning);
					const cancelled = result.error === "cancelled";
					// An abandoned watch is NOT a failure: we stopped observing and the
					// outcome is unknown. Reporting isError would tell the orchestrator the
					// run failed, which is a claim we cannot make — and would contradict the
					// result text, which says the outcome is unknown and the pane may be live.
					const failed =
						!result.watchAbandoned && (cancelled || result.exitCode !== 0 || Boolean(result.errorMessage));
					return {
						content: [{ type: "text", text }],
						details: {
							...result,
							id: running.id,
							status: result.watchAbandoned ? "abandoned" : failed ? "error" : "completed",
							blocking: true,
							agent: running.agent,
							...(running.layoutWarning ? { layoutWarning: running.layoutWarning } : {}),
						},
						isError: failed,
					};
				}
			},

			renderCall(args: any, theme: any) {
				const partialArgs = args as Record<string, unknown>;
				const agentId =
					typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "(agent required)";
				const name = typeof partialArgs.label === "string" && partialArgs.label ? partialArgs.label : agentId;
				const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
				const agent = name !== agentId ? theme.fg("dim", ` (${agentId})`) : "";
				const blockingHint = partialArgs.blocking === true ? theme.fg("dim", " [blocking]") : "";
				let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + blockingHint;

				// Show a one-line task preview. renderCall is called repeatedly as the
				// LLM generates tool arguments, so args.task grows token by token.
				// We keep it compact here — Ctrl+O on renderResult expands the full content.
				if (task) {
					const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
					const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
					if (preview) {
						text += "\n" + theme.fg("toolOutput", preview);
					}
					const totalLines = task.split("\n").length;
					if (totalLines > 1) {
						text += theme.fg("muted", ` (${totalLines} lines)`);
					}
				}

				return new Text(text, 0, 0);
			},

			renderResult(result: any, _opts: any, theme: any) {
				const details = result.details as any;
				const name = details?.name ?? "(unnamed)";

				// "Started" result — tool returned immediately (async mode)
				if (details?.status === "started") {
					const runtime = details?.model
						? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
						: " — started";
					const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							runTag +
							theme.fg("dim", runtime),
						0,
						0,
					);
				}

				// Blocking-mode terminal results (completed / error / ping)
				if (details?.blocking) {
					const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
					if (details.status === "ping") {
						const icon = theme.fg("accent", "?");
						const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
						const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${runTag} ${theme.fg("dim", "— needs help")}`;
						const preview = (typeof result.content[0]?.text === "string" ? result.content[0].text : "")
							.split("\n")[0]
							.slice(0, 120);
						return new Text(`${header}\n${theme.fg("dim", preview)}`, 0, 0);
					}
					// An abandoned watch is neither success nor failure: its outcome is
					// unknown. Rendering it green would assert a completion we cannot claim.
					const abandoned = details.status === "abandoned";
					const failed = details.status === "error" || result.isError;
					const icon = abandoned
						? theme.fg("muted", "?")
						: failed
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					const status = abandoned
						? "watch abandoned (outcome unknown)"
						: failed
							? "failed (blocking)"
							: "completed (blocking)";
					const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
					const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${runTag} ${theme.fg("dim", `— ${status}`)}`;
					const body = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
					const previewLines = body
						.split("\n")
						.slice(0, 4)
						.map((line: string) => theme.fg("dim", line.slice(0, 120)));
					return new Text([header, ...previewLines].join("\n"), 0, 0);
				}

				// Fallback (shouldn't happen for async beyond "started")
				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(theme.fg("dim", text), 0, 0);
			},
		});

	// ── subagent_interrupt tool ──
	if (shouldRegister("subagent_interrupt"))
		(pi.registerTool as any)({
			name: "subagent_interrupt",
			label: "Interrupt Subagent",
			description:
				"Send Escape to the active turn of a currently running Pi-backed subagent. " +
				"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
				"and does not emit a subagent_result solely because of this request.",
			promptSnippet:
				"Send Escape to the active turn of a currently running Pi-backed subagent. " +
				"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
				"and does not emit a subagent_result solely because of this request.",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
				name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
			}),

			async execute(_toolCallId: any, params: any) {
				return handleSubagentInterrupt(params);
			},

			renderCall(args: any, theme: any) {
				const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(target)) +
						theme.fg("dim", " — interrupt turn"),
					0,
					0,
				);
			},

			renderResult(result: any, _opts: any, theme: any) {
				const details = result.details as any;
				if (details?.status === "interrupt_requested") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
							theme.fg("dim", " — interrupt requested"),
						0,
						0,
					);
				}

				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(theme.fg("dim", text), 0, 0);
			},
		});

	// ── subagent_resume tool ──
	if (shouldRegister("subagent_resume"))
		(pi.registerTool as any)({
			name: "subagent_resume",
			label: "Resume Subagent",
			description:
				"Resume a previous sub-agent session in a new herdr pane. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			promptSnippet:
				"Resume a previous sub-agent session in a new herdr pane. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			parameters: Type.Object({
				path: Type.String({ description: "Owned subagent session JSONL path" }),
				message: Type.Optional(Type.String({ description: "Optional follow-up guidance" })),
				label: Type.Optional(Type.String({ description: "Presentation-only run label" })),
				layout: Type.Optional(Type.Union([Type.Literal("attached"), Type.Literal("single")])),
				surface: Type.Optional(Type.Union([Type.Literal("pane"), Type.Literal("tab")])),
				direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
			}),

			renderCall(args: any, theme: any) {
				const name = args.label ?? "Resume";
				return new Text(
					`▸ ${theme.fg("toolTitle", theme.bold(name))}${args.id ? theme.fg("dim", ` [${args.id}]`) : ""}${theme.fg("dim", " — resuming session")}`,
					0,
					0,
				);
			},

			renderResult(result: any, _opts: any, theme: any) {
				const details = result.details as any;
				const name = details?.name ?? "Resume";
				if (details?.status === "started") {
					return new Text(
						`▸ ${theme.fg("toolTitle", theme.bold(name))}${details?.id ? theme.fg("dim", ` [${details.id}]`) : ""}${theme.fg("dim", " — resumed")}`,
						0,
						0,
					);
				}
				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(theme.fg("dim", text), 0, 0);
			},

			async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
				const stableCtx = snapshotParentContext(ctx);
				const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
				const parentModelRegistry = ctx.modelRegistry;
				let owned: ReturnType<typeof readSessionOwner>;
				let agentDefinition: AgentDefinition;
				let selectedSkills: SelectedSkill[];
				try {
					owned = readSessionOwner(params.path);
					agentDefinition = loadAgentDefinition({
						id: owned.owner.agentId,
						cwd: stableCtx.cwd,
						agentDir: stableCtx.agentDir,
						projectTrusted: stableCtx.projectTrusted,
					});
					selectedSkills = await resolveSelectedSkills({
						raw: agentDefinition.skills,
						cwd: stableCtx.cwd,
						agentDir: stableCtx.agentDir,
						projectTrusted: stableCtx.projectTrusted,
					});
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], details: { error: text }, isError: true };
				}
				if (!isTerminalAvailable()) return muxUnavailableResult();

				const sessionPath = owned.sessionFile;
				const resumedStickyId = Array.from(stickyTerminalRuns.values()).find(
					(terminal) => terminal.sessionFile === sessionPath,
				)?.id;
				// Clear any stale completion sidecar left by a previous run on this
				// session (e.g. the failed run's preserved pane) — consumeExitSidecar
				// also drops mismatches, this is belt-and-suspenders.
				try {
					rmSync(`${sessionPath}.exit`, { force: true });
				} catch {}
				const agentId = agentDefinition.id;
				const name = params.label?.trim() || agentId;
				const startTime = Date.now();
				const id = createRunId();
				const parentSessionId = stableCtx.sessionId;
				const parentPaneId = process.env.HERDR_PANE_ID;
				if (owned.owner.parentSessionId !== parentSessionId) {
					return {
						content: [
							{ type: "text", text: "Subagent session ownership does not match this parent session." },
						],
						details: { id, error: "ownership mismatch" },
						isError: true,
					};
				}
				if (!parentPaneId) {
					return {
						content: [{ type: "text", text: "Error: HERDR_PANE_ID not set" }],
						details: { error: "missing HERDR_PANE_ID" },
						isError: true,
					};
				}
				const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
				if (!parentModel) throw new Error("Subagent resume requires a resolved parent model");
				const runtimePlan = resolveRuntimePlan(
					{},
					{ model: agentDefinition.model, thinking: agentDefinition.thinking as ThinkingLevel | undefined },
					{ provider: parentModel.provider, modelId: parentModel.id, thinking: parentThinking },
					wrapPiModelRegistry(parentModelRegistry),
				);
				let sessionLease: SessionLease | undefined;
				let admissionLease: AdmissionLease | undefined;
				let admissionTicket: ReturnType<ReturnType<typeof getAdmissionCoordinator>["request"]>;
				let launchTransaction: LaunchTransaction | undefined;
				try {
					sessionLease = getSessionLeaseRegistry(parentSessionId).acquire(sessionPath, id, "queued");
					admissionTicket = getAdmissionCoordinator(parentSessionId).request({ id, class: "background" });
					admissionLease = admissionTicket.lease;
					launchTransaction = beginLaunchTransaction(id);
					launchTransaction.own(() => admissionLease?.release());
					launchTransaction.own(() => sessionLease?.release());
				} catch (error) {
					sessionLease?.release();
					admissionLease?.release();
					launchTransaction?.rollback();
					if (launchTransaction) finishLaunchTransaction(id, launchTransaction);
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], details: { id, error: text }, isError: true };
				}
				const rollbackResume = () => {
					launchTransaction?.rollback();
					if (launchTransaction) finishLaunchTransaction(id, launchTransaction);
				};
				const assertResumeAdmissionCurrent = () => {
					if (
						!admissionLease ||
						!getAdmissionCoordinator(parentSessionId).isAdmissionCurrent(admissionLease)
					) {
						throw new Error("Subagent launch cancelled.");
					}
				};
				const launchResume = async () => {
					await admissionTicket.admitted;
					assertResumeAdmissionCurrent();
					launchTransaction!.throwIfAborted();
					queuedSubagents.delete(id);
					updateWidget();
					sessionLease!.transition("starting");
					const entryCountBefore = getNewEntries(sessionPath, 0).length;
					const childCwd = resolve(stableCtx.cwd);
					const attached = await attachPaneSerialized(parentPaneId, {
						name,
						direction: resolveDirection(params),
						layout: resolveLayout(params),
						surface: resolveSurface(params),
						cwd: childCwd,
					});
					const surface = attached.paneId;
					launchTransaction!.own(() => {
						try {
							safeCloseSubagentPane(surface);
						} catch {}
						try {
							removePaneFromRegion(parentPaneId, surface);
						} catch {}
					});
					assertResumeAdmissionCurrent();
					launchTransaction!.advance("pane");
					await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
					launchTransaction!.throwIfAborted();
					assertResumeAdmissionCurrent();

					const parts = [
						"pi",
						...(process.env.PI_SUBAGENT_NO_EXTENSIONS === "1" ? ["-ne"] : []),
						...(stableCtx.projectTrusted ? ["--approve"] : []),
						shellQuote(sessionPath),
						"-e",
						shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts")),
						"--model",
						shellQuote(runtimePlan.model),
						"--thinking",
						shellQuote(runtimePlan.thinking),
					];
					const toolAllowlist = buildSubagentToolAllowlist(agentDefinition.tools);
					parts.push("--tools", shellQuote(toolAllowlist));
					parts.push("--no-skills");
					for (const skill of selectedSkills) parts.push("--skill", shellQuote(skill.filePath));

					const artifactDir = getArtifactDir(stableCtx.sessionDir, parentSessionId);
					const activityFile = getSubagentActivityFile(artifactDir, id);
					mkdirSync(dirname(activityFile), { recursive: true });
					const resumePrompt = buildSystemPromptFileContent({
						agentName: agentId,
						identity: agentDefinition.body,
					});
					const spPath = join(artifactDir, `context/resume-sysprompt-${id}.md`);
					mkdirSync(dirname(spPath), { recursive: true });
					launchTransaction!.own(() => rmSync(spPath, { force: true }));
					writeFileSync(spPath, resumePrompt.content, "utf8");
					parts.push(resumePrompt.flag, shellQuote(spPath));

					const resumeMessage =
						typeof params.message === "string" && params.message.trim()
							? params.message
							: "Continue the resumed task and summarize what you accomplish.";
					const resumeMsgFile = join(artifactDir, "subagent-resume", `${agentId}-${id}.md`);
					mkdirSync(dirname(resumeMsgFile), { recursive: true });
					launchTransaction!.own(() => rmSync(resumeMsgFile, { force: true }));
					writeFileSync(resumeMsgFile, resumeMessage, "utf8");
					parts.push(shellQuote(`@${resumeMsgFile}`));

					const metadata = selectedSkills.map((skill) => ({
						name: skill.name,
						description: skill.description,
						filePath: skill.filePath,
					}));
					const envParts = [
						`PI_CODING_AGENT_DIR=${shellQuote(stableCtx.agentDir)}`,
						`PI_SUBAGENT_NAME=${shellQuote(name)}`,
						`PI_SUBAGENT_AGENT=${shellQuote(agentId)}`,
						...(process.env.PI_SUBAGENT_NO_EXTENSIONS === "1" ? ["PI_SUBAGENT_NO_EXTENSIONS=1"] : []),
						...(process.env.PI_SUBAGENT_INSPECTION_DIR
							? [`PI_SUBAGENT_INSPECTION_DIR=${shellQuote(process.env.PI_SUBAGENT_INSPECTION_DIR)}`]
							: []),
						`PI_SUBAGENT_SESSION=${shellQuote(sessionPath)}`,
						`PI_SUBAGENT_ID=${shellQuote(id)}`,
						`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
						`PI_SUBAGENT_PARENT_SESSION=${shellQuote(parentSessionId)}`,
						`PI_SUBAGENT_SELECTED_SKILLS=${shellQuote(JSON.stringify(metadata))}`,
						"PI_SUBAGENT_COMPANION_ORDER=explicit-before-discovered",
						"PI_SUBAGENT_AUTO_EXIT=1",
						`PI_DENY_TOOLS=${shellQuote(LIFECYCLE_DENY_TOOLS.join(","))}`,
					];
					const command = `cd ${shellQuote(childCwd)} && ${envParts.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
					const launchScriptFile = join(artifactDir, "subagent-scripts", `${agentId}-resume-${id}.sh`);
					launchTransaction!.own(() => rmSync(launchScriptFile, { force: true }));
					launchTransaction!.throwIfAborted();
					launchTransaction!.advance("script");
					runScriptInPane(surface, command, {
						scriptPath: launchScriptFile,
						scriptPreamble: [
							`# Subagent resume script for ${safeCommentValue(agentId)}`,
							`# Run: ${safeCommentValue(id)}`,
							`# Session: ${safeCommentValue(sessionPath)}`,
							`# Surface: ${safeCommentValue(surface)}`,
						].join("\n"),
					});

					const running: RunningSubagent = {
						id,
						name,
						task: resumeMessage,
						agent: agentId,
						parentSessionId,
						surface,
						startTime,
						sessionFile: sessionPath,
						launchScriptFile,
						activityFile,
						...(attached.warning ? { layoutWarning: attached.warning } : {}),
						runtimePlan,
						admissionClass: "background",
						admissionLease: admissionLease!,
						sessionLease: sessionLease!,
						entryCountBefore,
						lifecycle: createLifecycle(startTime),
						launchTransaction,
						...(resumedStickyId ? { resumedStickyId } : {}),
					};
					runningSubagents.set(id, running);
					launchTransaction!.own(() => runningSubagents.delete(id));
					sessionLease!.transition("running");
					running.parentSessionFile = stableCtx.sessionFile;

					superviseBackgroundRun(parentSessionId, running, (result) => {
						const allEntries = getNewEntries(sessionPath, entryCountBefore);
						const summary =
							findLastAssistantMessage(allEntries) ??
							(result.errorMessage
								? `Subagent error: ${result.errorMessage}`
								: result.exitCode !== 0
									? `Resumed session exited with code ${result.exitCode}`
									: "Resumed session exited without new output");
						return { ...result, summary };
					});

					return {
						content: [
							{
								type: "text",
								text: appendLayoutWarning(`Session "${name}" [${id}] resumed.`, running.layoutWarning),
							},
						],
						details: { id, name, agent: agentId, path: sessionPath, launchScriptFile, status: "started" },
					};
				};
				if (admissionTicket.queued) {
					queuedSubagents.set(id, {
						id,
						name,
						agent: agentId,
						admissionClass: "background",
						queuedAt: Date.now(),
						cancel: () => {
							const cancelled = admissionTicket.lease.cancel();
							if (cancelled) sessionLease.release();
							return cancelled;
						},
					});
					updateWidget();
					void launchResume()
						.catch(async (error) => {
							rollbackResume();
							queuedSubagents.delete(id);
							updateWidget();
							if (admissionTicket.lease.state === "cancelled") return;
							captureStickyLaunchFailure({
								id,
								name,
								agent: agentId,
								admissionClass: "background",
								startTime,
								error,
							});
							// Detached (queued, non-blocking) shape kept; terminal rejection
							// handling re-queues a delivery failure by run ID so no rejection
							// escapes this un-awaited promise.
							const message = {
								customType: "subagent_result",
								content: `Queued resume "${name}" [${id}] failed to launch: ${error instanceof Error ? error.message : String(error)}`,
								display: true,
								details: { id, name, agent: agentId, path: sessionPath },
							};
							try {
								await deliverBackgroundMessage(undefined, parentSessionId, message, {
									sessionFile: stableCtx.sessionFile,
									expectedRunId: id,
								});
							} catch (deliveryError) {
								if (!getForegroundDeliveryBarrier(parentSessionId).isSuppressed()) {
									queuePendingDeliveryWithVerification(
										id,
										parentSessionId,
										message,
										deliveryError,
										{
											sessionFile: stableCtx.sessionFile,
											expectedRunId: id,
										},
										isSessionRuntimeUnavailable(deliveryError) ? 0 : 1,
									);
									startDeliveryRetry();
								}
							}
						})
						.catch(() => undefined);
					return {
						content: [
							{
								type: "text",
								text: `Session "${name}" [${id}] queued for background admission; no pane or launch artifact has been created.`,
							},
						],
						details: { id, name, agent: agentId, path: sessionPath, status: "queued", class: "background" },
					};
				}
				try {
					return await launchResume();
				} catch (error) {
					rollbackResume();
					captureStickyLaunchFailure({
						id,
						name,
						agent: agentId,
						admissionClass: "background",
						startTime,
						error,
					});
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], details: { id, error: text }, isError: true };
				}
			},
		});

	// ── subagent_result message renderer ──
	(pi.registerMessageRenderer as any)("subagent_result", (message: any, options: any, theme: any) => {
		const details = message.details as any;
		if (!details) return undefined;

		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
				// An abandoned watch carries exit code 1 and an errorMessage, but it is not
				// a failure — the outcome is unknown. Render it distinctly so the row does
				// not contradict its own body text.
				const abandoned = details.watchAbandoned === true;
				const failed = !abandoned && (exitCode !== 0 || !!errorMessage);
				const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: abandoned
						? // Neither success nor failure: a green row would assert an outcome we
							// explicitly do not know.
							(text: string) => theme.bg("customMessageBg", text)
						: (text: string) => theme.bg("toolSuccessBg", text);
				const icon = abandoned
					? theme.fg("muted", "?")
					: failed
						? theme.fg("error", "\u2717")
						: theme.fg("success", "\u2713");
				const status = abandoned
					? "watch abandoned (outcome unknown)"
					: errorMessage
						? "failed (provider/agent error)"
						: failed
							? `failed (exit ${exitCode})`
							: "completed";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${runTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent = typeof message.content === "string" ? message.content : "";

				// Clean summary (remove session ref and leading label for display)
				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+$/, "")
					.replace(
						`Sub-agent "${name}"${details.id ? ` [${details.id}]` : ""} completed (${elapsed}).\n\n`,
						"",
					)
					.replace(
						`Sub-agent "${name}"${details.id ? ` [${details.id}]` : ""} failed (exit code ${exitCode}).\n\n`,
						"",
					)
					.replace(
						new RegExp(
							`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"${details.id ? ` \\[${String(details.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]` : ""} failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
						),
						"",
					);

				// Build content for the box
				const contentLines = [header];

				if (options.expanded) {
					// Full view: complete summary + session info
					if (summary) {
						for (const line of summary.split("\n")) {
							contentLines.push(line.slice(0, width - 6));
						}
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
						contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
					}
				} else {
					// Collapsed: preview + expand hint
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) {
							contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						}
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) {
							contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
						}
					}
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				// Render via Box for background + padding, with blank line above for separation
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_status message renderer ──
	(pi.registerMessageRenderer as any)("subagent_status", (message: any, options: any, theme: any) => {
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
		const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;

		return {
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
				];

				if (overflow > 0) {
					contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				}
				if (!options.expanded) {
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_ping message renderer ──
	(pi.registerMessageRenderer as any)("subagent_ping", (message: any, options: any, theme: any) => {
		const details = message.details as any;
		if (!details) return undefined;

		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const runTag = details.id ? theme.fg("dim", ` [${details.id}]`) : "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);
				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${runTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
					}
				} else {
					const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
