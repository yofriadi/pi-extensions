import type { ActivityReadResult, SubagentActivityScope, SubagentActivityState } from "./activity.ts";
import type { CompletionResult } from "./completion.ts";

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type PaneInspection =
	| {
			kind: "present";
			agent?: string;
			agentStatus: HerdrAgentStatus;
			observedAt: number;
	  }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error?: string };

export type ProcessState =
	| { kind: "starting"; startedAt: number }
	| { kind: "running"; startedAt: number; confirmedAt: number }
	| { kind: "finalizing"; startedAt: number; detectedAt: number; completion: CompletionResult }
	| { kind: "completed"; startedAt: number; detectedAt: number; completedAt: number; completion: CompletionResult }
	| { kind: "failed"; startedAt: number; detectedAt: number; completedAt: number; error: string; exitCode?: number };

export type ActivityDetail =
	| { kind: "none"; observedAt: number }
	| {
			kind: "scope";
			scope: SubagentActivityScope;
			label?: string;
			since: number;
			observedAt: number;
			sequence: number;
	  };

export type TurnState =
	| { kind: "unknown" }
	| { kind: "starting"; observedAt: number }
	| { kind: "active"; startedAt: number; source: "activity" | "herdr" | "fallback"; activity?: ActivityDetail }
	| { kind: "blocked"; startedAt: number }
	| { kind: "waiting"; startedAt: number }
	| { kind: "interrupted"; requestedAt: number; previousActivitySequence: number | null };

export type ActivityHealth =
	| { kind: "unseen" }
	| { kind: "healthy"; observedAt: number }
	| { kind: "problem"; reason: "missing" | "invalid" | "wrong-id"; since: number; error?: string };

export type PaneObservation =
	| { kind: "unknown" }
	| { kind: "present"; observedAt: number; agentStatus: HerdrAgentStatus }
	| { kind: "read-error"; firstFailedAt: number; lastFailedAt: number; consecutiveFailures: number; error?: string }
	| { kind: "missing"; detectedAt: number; error?: string };

export type CompletionDelivery = "pending" | "delivered" | "suppressed";

export interface SubagentLifecycle {
	process: ProcessState;
	turn: TurnState;
	activityHealth: ActivityHealth;
	/** Latest optional Pi detail, independent of Herdr coarse turn state. */
	activityDetail: ActivityDetail | null;
	pane: PaneObservation;
	/** Durable across unavailable/missing observations. */
	hasWorked: boolean;
	lastActivitySequence: number | null;
	delivery: CompletionDelivery;
}

export interface LifecycleProjection {
	kind:
		| "starting"
		| "running"
		| "active"
		| "blocked"
		| "waiting"
		| "interrupted"
		| "stalled"
		| "finalizing"
		| "completed"
		| "failed";
	label?: string;
	runtimeEndedAt?: number;
	stateDurationSince?: number;
}

export function createLifecycle(startedAt: number): SubagentLifecycle {
	return {
		process: { kind: "starting", startedAt },
		turn: { kind: "unknown" },
		activityHealth: { kind: "unseen" },
		activityDetail: null,
		pane: { kind: "unknown" },
		hasWorked: false,
		lastActivitySequence: null,
		delivery: "pending",
	};
}

function isTerminal(process: ProcessState): boolean {
	return process.kind === "completed" || process.kind === "failed";
}

function startedAt(process: ProcessState): number {
	return process.startedAt;
}

type PaneInspectionHandler = (
	lifecycle: SubagentLifecycle,
	inspection: PaneInspection,
	observedAt: number,
) => SubagentLifecycle;

const paneInspectionHandlers: Record<PaneInspection["kind"], PaneInspectionHandler> = {
	unavailable: observeUnavailablePane,
	missing: observeMissingPane,
	present: observePresentPane,
};

export function observePaneInspection(
	lifecycle: SubagentLifecycle,
	inspection: PaneInspection,
	observedAt: number,
): SubagentLifecycle {
	if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
	return paneInspectionHandlers[inspection.kind](lifecycle, inspection, observedAt);
}

function observeUnavailablePane(
	lifecycle: SubagentLifecycle,
	inspection: PaneInspection,
	observedAt: number,
): SubagentLifecycle {
	if (inspection.kind !== "unavailable") return lifecycle;
	const previous = lifecycle.pane.kind === "read-error" ? lifecycle.pane : undefined;
	return {
		...lifecycle,
		pane: {
			kind: "read-error",
			firstFailedAt: previous?.firstFailedAt ?? observedAt,
			lastFailedAt: observedAt,
			consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
			error: inspection.error,
		},
	};
}

function observeMissingPane(
	lifecycle: SubagentLifecycle,
	inspection: PaneInspection,
	observedAt: number,
): SubagentLifecycle {
	if (inspection.kind !== "missing") return lifecycle;
	return {
		...lifecycle,
		pane: { kind: "missing", detectedAt: observedAt, ...(inspection.error ? { error: inspection.error } : {}) },
	};
}

function observePresentPane(
	lifecycle: SubagentLifecycle,
	inspection: PaneInspection,
	observedAt: number,
): SubagentLifecycle {
	if (inspection.kind !== "present") return lifecycle;
	const hasWorked = lifecycle.hasWorked || paneStatusShowsWork(inspection.agentStatus);
	const process = processAfterPaneObservation(lifecycle.process, observedAt);
	const pane: PaneObservation = { kind: "present", observedAt, agentStatus: inspection.agentStatus };
	if (lifecycle.turn.kind === "interrupted") return { ...lifecycle, process, pane, hasWorked };
	const turn = paneTurnForStatus({ lifecycle, hasWorked, observedAt }, inspection.agentStatus);
	if (!turn) return { ...lifecycle, process, pane };
	return { ...lifecycle, process, turn, pane, hasWorked };
}

function paneStatusShowsWork(status: HerdrAgentStatus): boolean {
	return status === "working" || status === "blocked" || status === "done";
}

function processAfterPaneObservation(process: ProcessState, observedAt: number): ProcessState {
	return process.kind === "starting"
		? { kind: "running", startedAt: process.startedAt, confirmedAt: observedAt }
		: process;
}

type PaneTurnContext = { lifecycle: SubagentLifecycle; hasWorked: boolean; observedAt: number };
type PaneTurnHandler = (context: PaneTurnContext) => TurnState | undefined;

const paneTurnHandlers: Record<HerdrAgentStatus, PaneTurnHandler> = {
	blocked: blockedPaneTurn,
	working: activePaneTurn,
	done: idlePaneTurn,
	idle: idlePaneTurn,
	unknown: () => undefined,
};

function paneTurnForStatus(context: PaneTurnContext, status: HerdrAgentStatus): TurnState | undefined {
	return paneTurnHandlers[status](context);
}

function blockedPaneTurn(context: PaneTurnContext): TurnState {
	if (!context.hasWorked) return startingPaneTurn(context);
	return {
		kind: "blocked",
		startedAt: context.lifecycle.turn.kind === "blocked" ? context.lifecycle.turn.startedAt : context.observedAt,
	};
}

function activePaneTurn(context: PaneTurnContext): TurnState {
	return {
		kind: "active",
		startedAt: context.lifecycle.turn.kind === "active" ? context.lifecycle.turn.startedAt : context.observedAt,
		source: "herdr",
		...(context.lifecycle.activityDetail ? { activity: context.lifecycle.activityDetail } : {}),
	};
}

function idlePaneTurn(context: PaneTurnContext): TurnState {
	if (!context.hasWorked) return startingPaneTurn(context);
	return {
		kind: "waiting",
		startedAt: context.lifecycle.turn.kind === "waiting" ? context.lifecycle.turn.startedAt : context.observedAt,
	};
}

function startingPaneTurn(context: PaneTurnContext): TurnState {
	return {
		kind: "starting",
		observedAt: context.lifecycle.turn.kind === "starting" ? context.lifecycle.turn.observedAt : context.observedAt,
	};
}

type SuccessfulActivityRead = Extract<ActivityReadResult, { ok: true }>;
type FailedActivityRead = Extract<ActivityReadResult, { ok: false }>;

export function observeActivity(
	lifecycle: SubagentLifecycle,
	read: ActivityReadResult,
	observedAt: number,
): SubagentLifecycle {
	if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
	return read.ok
		? observeSuccessfulActivity(lifecycle, read, observedAt)
		: observeFailedActivity(lifecycle, read, observedAt);
}

function observeFailedActivity(
	lifecycle: SubagentLifecycle,
	read: FailedActivityRead,
	observedAt: number,
): SubagentLifecycle {
	const since = lifecycle.activityHealth.kind === "problem" ? lifecycle.activityHealth.since : observedAt;
	return {
		...lifecycle,
		activityHealth: {
			kind: "problem",
			reason: read.reason,
			since,
			...(read.error ? { error: read.error } : {}),
		},
	};
}

function observeSuccessfulActivity(
	lifecycle: SubagentLifecycle,
	read: SuccessfulActivityRead,
	observedAt: number,
): SubagentLifecycle {
	const activity = read.activity;
	if (isStaleActivity(lifecycle, activity.sequence)) return lifecycle;
	if (hasInterruptEvidence(activity)) return observeInterruptedActivity(lifecycle, activity, observedAt);
	const detail = activityDetailFor(activity);
	return detail
		? observeActiveActivity(lifecycle, detail, observedAt)
		: observeInactiveActivity(lifecycle, activity.sequence, activity.updatedAt, observedAt);
}

function isStaleActivity(lifecycle: SubagentLifecycle, sequence: number): boolean {
	return lifecycle.lastActivitySequence != null && sequence < lifecycle.lastActivitySequence;
}

function hasInterruptEvidence(activity: SubagentActivityState): boolean {
	return activity.interruptedAt != null && activity.interruptedSequence != null;
}

type ScopedActivityDetail = Extract<ActivityDetail, { kind: "scope" }>;
type ActivityDetailHandler = (activity: SubagentActivityState) => ScopedActivityDetail;

const activityDetailHandlers: Record<SubagentActivityScope, ActivityDetailHandler> = {
	agent: (activity) => scopedActivityDetail(activity, "agent", activity.activeSince ?? activity.updatedAt),
	turn: (activity) => scopedActivityDetail(activity, "turn", activity.activeSince ?? activity.updatedAt),
	provider: (activity) =>
		scopedActivityDetail(activity, "provider", activity.activeSince ?? activity.updatedAt, "provider"),
	streaming: (activity) =>
		scopedActivityDetail(activity, "streaming", activity.activeSince ?? activity.updatedAt, "streaming"),
	tool: (activity) =>
		scopedActivityDetail(
			activity,
			"tool",
			activity.toolStartedAt ?? activity.activeSince ?? activity.updatedAt,
			activity.toolName,
		),
};

function activityDetailFor(activity: SubagentActivityState): ScopedActivityDetail | null {
	if (activity.phase !== "active" || !activity.activeScope) return null;
	return activityDetailHandlers[activity.activeScope](activity);
}

function scopedActivityDetail(
	activity: SubagentActivityState,
	scope: SubagentActivityScope,
	since: number,
	label?: string,
): ScopedActivityDetail {
	return {
		kind: "scope",
		scope,
		since,
		observedAt: activity.updatedAt,
		sequence: activity.sequence,
		...(label ? { label } : {}),
	};
}

function observeInterruptedActivity(
	lifecycle: SubagentLifecycle,
	activity: SubagentActivityState,
	observedAt: number,
): SubagentLifecycle {
	const interruptedAt = activity.interruptedAt as number;
	const interruptedSequence = activity.interruptedSequence as number;
	if (isStaleInterrupt(lifecycle, interruptedAt, interruptedSequence)) return lifecycle;
	return {
		...lifecycle,
		process: processAfterPaneObservation(lifecycle.process, observedAt),
		turn: { kind: "interrupted", requestedAt: interruptedAt, previousActivitySequence: interruptedSequence },
		activityDetail: null,
		activityHealth: { kind: "healthy", observedAt },
		lastActivitySequence: Math.max(lifecycle.lastActivitySequence ?? -1, interruptedSequence),
	};
}

function isStaleInterrupt(lifecycle: SubagentLifecycle, interruptedAt: number, interruptedSequence: number): boolean {
	if (lifecycle.turn.kind !== "interrupted") return false;
	return (
		interruptedAt < lifecycle.turn.requestedAt ||
		(interruptedAt === lifecycle.turn.requestedAt &&
			lifecycle.turn.previousActivitySequence != null &&
			interruptedSequence <= lifecycle.turn.previousActivitySequence)
	);
}

function observeInactiveActivity(
	lifecycle: SubagentLifecycle,
	sequence: number,
	updatedAt: number,
	observedAt: number,
): SubagentLifecycle {
	const clearsInterruptedTurn =
		lifecycle.turn.kind === "interrupted" &&
		(lifecycle.turn.previousActivitySequence == null || sequence > lifecycle.turn.previousActivitySequence);
	return {
		...lifecycle,
		...(clearsInterruptedTurn ? { turn: { kind: "waiting" as const, startedAt: updatedAt } } : {}),
		activityDetail: null,
		activityHealth: { kind: "healthy", observedAt },
		lastActivitySequence: Math.max(lifecycle.lastActivitySequence ?? -1, sequence),
	};
}

function observeActiveActivity(
	lifecycle: SubagentLifecycle,
	detail: ScopedActivityDetail,
	observedAt: number,
): SubagentLifecycle {
	if (isStaleActiveDetail(lifecycle, detail)) return lifecycle;
	return {
		...lifecycle,
		process: processAfterPaneObservation(lifecycle.process, observedAt),
		turn: activeTurnForDetail(lifecycle, detail),
		activityDetail: detail,
		activityHealth: { kind: "healthy", observedAt },
		lastActivitySequence: detail.sequence,
	};
}

function isStaleActiveDetail(lifecycle: SubagentLifecycle, detail: ScopedActivityDetail): boolean {
	if (lifecycle.turn.kind !== "interrupted") return false;
	return (
		detail.observedAt < lifecycle.turn.requestedAt ||
		(detail.observedAt === lifecycle.turn.requestedAt &&
			lifecycle.turn.previousActivitySequence != null &&
			detail.sequence <= lifecycle.turn.previousActivitySequence)
	);
}

type ActivityTurnSource = "activity" | "fallback" | undefined;
type ActivityTurnSourceHandler = (pane: PaneObservation) => ActivityTurnSource;

const activityTurnSourceHandlers: Record<PaneObservation["kind"], ActivityTurnSourceHandler> = {
	present: (pane) => (pane.kind === "present" && pane.agentStatus === "working" ? "activity" : undefined),
	unknown: () => "fallback",
	"read-error": () => "fallback",
	missing: () => undefined,
};

function activeTurnForDetail(lifecycle: SubagentLifecycle, detail: ScopedActivityDetail): TurnState {
	if (lifecycle.turn.kind === "interrupted") return activityDetailTurn(lifecycle, detail, "activity");
	const source = activityTurnSourceHandlers[lifecycle.pane.kind](lifecycle.pane);
	return source ? activityDetailTurn(lifecycle, detail, source) : lifecycle.turn;
}

function activityDetailTurn(
	lifecycle: SubagentLifecycle,
	detail: ScopedActivityDetail,
	source: Exclude<ActivityTurnSource, undefined>,
): TurnState {
	const sameDetail =
		lifecycle.activityDetail?.kind === "scope" &&
		lifecycle.activityDetail.scope === detail.scope &&
		lifecycle.activityDetail.label === detail.label;
	return {
		kind: "active",
		startedAt: sameDetail && lifecycle.turn.kind === "active" ? lifecycle.turn.startedAt : detail.since,
		source,
		activity: detail,
	};
}

export function markProcessRunning(lifecycle: SubagentLifecycle, confirmedAt: number): SubagentLifecycle {
	if (lifecycle.process.kind !== "starting") return lifecycle;
	return {
		...lifecycle,
		process: { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt },
	};
}

export function markInterruptRequested(lifecycle: SubagentLifecycle, requestedAt: number): SubagentLifecycle {
	if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
	return {
		...lifecycle,
		turn: {
			kind: "interrupted",
			requestedAt,
			previousActivitySequence: lifecycle.lastActivitySequence,
		},
	};
}

export function markCompletionDetected(
	lifecycle: SubagentLifecycle,
	completion: CompletionResult,
	detectedAt: number,
): SubagentLifecycle {
	if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
	return {
		...lifecycle,
		process: {
			kind: "finalizing",
			startedAt: startedAt(lifecycle.process),
			detectedAt: Math.max(startedAt(lifecycle.process), detectedAt),
			completion,
		},
	};
}

export function markCompleted(lifecycle: SubagentLifecycle, completedAt: number): SubagentLifecycle {
	if (isTerminal(lifecycle.process)) return lifecycle;
	if (lifecycle.process.kind !== "finalizing") return lifecycle;
	return {
		...lifecycle,
		process: {
			kind: "completed",
			startedAt: lifecycle.process.startedAt,
			detectedAt: lifecycle.process.detectedAt,
			completedAt: Math.max(lifecycle.process.detectedAt, completedAt),
			completion: lifecycle.process.completion,
		},
	};
}

export function markFailed(
	lifecycle: SubagentLifecycle,
	error: string,
	detectedAt: number,
	exitCode?: number,
): SubagentLifecycle {
	if (isTerminal(lifecycle.process)) return lifecycle;
	const start = startedAt(lifecycle.process);
	const detected =
		lifecycle.process.kind === "finalizing" ? lifecycle.process.detectedAt : Math.max(start, detectedAt);
	return {
		...lifecycle,
		process: {
			kind: "failed",
			startedAt: start,
			detectedAt: detected,
			completedAt: Math.max(detected, detectedAt),
			error,
			...(exitCode == null ? {} : { exitCode }),
		},
	};
}

export function markDelivery(lifecycle: SubagentLifecycle, delivery: CompletionDelivery): SubagentLifecycle {
	if (lifecycle.delivery !== "pending") return lifecycle;
	return { ...lifecycle, delivery };
}

export function projectLifecycle(lifecycle: SubagentLifecycle, now: number): LifecycleProjection {
	const process = lifecycle.process;
	if (process.kind === "finalizing") return { kind: "finalizing", runtimeEndedAt: process.detectedAt };
	if (process.kind === "completed") return { kind: "completed", runtimeEndedAt: process.completedAt };
	if (process.kind === "failed") return { kind: "failed", label: process.error, runtimeEndedAt: process.completedAt };

	// Pi activity is optional enrichment. Only authoritative Herdr inspection
	// unavailability may produce a stalled projection.
	if (lifecycle.pane.kind === "read-error" && now - lifecycle.pane.firstFailedAt >= 60_000) {
		return { kind: "stalled", stateDurationSince: lifecycle.pane.firstFailedAt };
	}

	const turn = lifecycle.turn;
	switch (turn.kind) {
		case "interrupted":
			return { kind: "interrupted", stateDurationSince: turn.requestedAt };
		case "active": {
			if (turn.activity?.kind === "scope") {
				const label = turn.activity.label ?? turn.activity.scope;
				return { kind: "active", label, stateDurationSince: turn.startedAt };
			}
			return {
				kind: "active",
				label: turn.source === "herdr" ? "agent working" : "agent active",
				stateDurationSince: turn.startedAt,
			};
		}
		case "blocked":
			return { kind: "blocked", stateDurationSince: turn.startedAt };
		case "waiting":
			return { kind: "waiting", stateDurationSince: turn.startedAt };
		case "starting":
			return { kind: "starting", stateDurationSince: turn.observedAt };
		case "unknown":
			return process.kind === "running" ? { kind: "running" } : { kind: "starting" };
	}
}

export type LifecycleTransition = "stalled" | "recovered" | null;

export function lifecycleTransition(
	previous: LifecycleProjection["kind"] | undefined,
	next: LifecycleProjection["kind"],
): LifecycleTransition {
	if (previous !== "stalled" && next === "stalled") return "stalled";
	if (
		previous === "stalled" &&
		(next === "active" ||
			next === "blocked" ||
			next === "waiting" ||
			next === "interrupted" ||
			next === "running" ||
			next === "starting")
	) {
		return "recovered";
	}
	return null;
}

type RecoveredLifecycleLine = (context: LifecycleLineContext) => string;

type LifecycleLineContext = {
	name: string;
	runtime: string;
	duration: string;
	projection: LifecycleProjection;
};

const recoveredLifecycleLines: Record<LifecycleProjection["kind"], RecoveredLifecycleLine> = {
	waiting: (context) => `${context.name} running ${context.runtime}, recovered; waiting${context.duration}.`,
	active: (context) => activeRecoveryLine(context),
	blocked: (context) => `${context.name} running ${context.runtime}, recovered; blocked${context.duration}.`,
	interrupted: (context) => `${context.name} running ${context.runtime}, recovered; interrupted${context.duration}.`,
	starting: runningRecoveryLine,
	running: runningRecoveryLine,
	stalled: runningRecoveryLine,
	finalizing: runningRecoveryLine,
	completed: runningRecoveryLine,
	failed: runningRecoveryLine,
};

export function formatLifecycleTransitionLine(
	name: string,
	projection: LifecycleProjection,
	transition: Exclude<LifecycleTransition, null>,
	now: number,
	startedAt: number,
	formatElapsed: (ms: number) => string,
): string {
	const runtime = formatElapsed(Math.max(0, now - startedAt));
	const duration = transitionDuration(projection, now, formatElapsed);
	const context = { name, runtime, duration, projection };
	return transition === "stalled" ? stalledLifecycleLine(context) : recoveredLifecycleLines[projection.kind](context);
}

function transitionDuration(
	projection: LifecycleProjection,
	now: number,
	formatElapsed: (ms: number) => string,
): string {
	return projection.stateDurationSince == null ? "" : ` ${formatElapsed(now - projection.stateDurationSince)}`;
}

function stalledLifecycleLine(context: LifecycleLineContext): string {
	return `${context.name} running ${context.runtime}, stalled${context.duration}.`;
}

function activeRecoveryLine(context: LifecycleLineContext): string {
	const detail = context.projection.label ? ` (${context.projection.label}${context.duration})` : context.duration;
	return `${context.name} running ${context.runtime}, recovered; active${detail}.`;
}

function runningRecoveryLine(context: LifecycleLineContext): string {
	return `${context.name} running ${context.runtime}, recovered; running.`;
}
