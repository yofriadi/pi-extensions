export const SNAPSHOT_STALLED_AFTER_MS = 60_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "running";
export type SubagentStatusSource = "pi";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusConfig {
	enabled: boolean;
	lineLimit: number;
}

/** Status is always enabled; package config is not consulted. */
export const STATUS_CONFIG: StatusConfig = {
	enabled: true,
	lineLimit: DEFAULT_STATUS_LINE_LIMIT,
};

export type StatusObservation =
	| {
			snapshot: "present";
			updatedAt: number;
			sequence: number;
			phase: StatusActivityPhase;
			active?: boolean;
			activeScope?: string;
			activeSince?: number;
			waitingSince?: number;
			latestEvent?: string;
			activityLabel?: string;
	  }
	| {
			snapshot: "missing" | "invalid" | "wrong-id";
			snapshotError?: string;
	  };

export interface SubagentStatusState {
	source: SubagentStatusSource;
	startTimeMs: number;
	firstObservationAtMs: number | null;
	lastActivityAtMs: number | null;
	lastActivitySequence: number | null;
	localOverrideAtMs: number | null;
	localOverrideSequence: number | null;
	activeNow: boolean;
	activeSinceMs: number | null;
	activeScope: string | null;
	waitingSinceMs: number | null;
	phase: StatusActivityPhase | null;
	latestEvent: string | null;
	activityLabel: string | null;
	snapshotState: StatusSnapshotState;
	snapshotProblemSinceMs: number | null;
	snapshotError: string | null;
	currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
	kind: SubagentStatusKind;
	elapsedMs: number;
	elapsedText: string;
	activeSinceMs: number | null;
	activeDurationText: string | null;
	activeScope: string | null;
	waitingSinceMs: number | null;
	waitingDurationText: string | null;
	latestEvent: string | null;
	activityLabel: string | null;
	snapshotState: StatusSnapshotState;
	snapshotError: string | null;
	snapshotProblemText: string | null;
	statusLabel: string | null;
}

export interface CappedStatusLines {
	visibleLines: string[];
	overflow: number;
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 1) return text.slice(0, maxLength);
	return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
	const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
	return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
	return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
	if (snapshotState === "wrong-id") return "wrong activity id";
	return null;
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
	return snapshot.activityLabel ?? snapshot.activeScope;
}

export function formatElapsedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;

	return `${minutes}m`;
}

export function createStatusState(params: { source: SubagentStatusSource; startTimeMs: number }): SubagentStatusState {
	const initialKind = "starting";
	return {
		source: params.source,
		startTimeMs: params.startTimeMs,
		firstObservationAtMs: null,
		lastActivityAtMs: null,
		lastActivitySequence: null,
		localOverrideAtMs: null,
		localOverrideSequence: null,
		activeNow: false,
		activeSinceMs: null,
		activeScope: null,
		waitingSinceMs: null,
		phase: null,
		latestEvent: null,
		activityLabel: null,
		snapshotState: "unseen",
		snapshotProblemSinceMs: null,
		snapshotError: null,
		currentKind: initialKind,
	};
}

type PresentStatusObservation = Extract<StatusObservation, { snapshot: "present" }>;
type ProblemStatusObservation = Exclude<StatusObservation, PresentStatusObservation>;

export function observeStatus(
	state: SubagentStatusState,
	observation: StatusObservation,
	now: number,
): SubagentStatusState {
	return observation.snapshot === "present"
		? observePresentStatus(state, observation, now)
		: observeProblemStatus(state, observation, now);
}

function observeProblemStatus(
	state: SubagentStatusState,
	observation: ProblemStatusObservation,
	now: number,
): SubagentStatusState {
	return {
		...state,
		firstObservationAtMs: state.firstObservationAtMs ?? now,
		snapshotState: observation.snapshot,
		snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
		snapshotError: observation.snapshotError ?? null,
	};
}

function observePresentStatus(
	state: SubagentStatusState,
	observation: PresentStatusObservation,
	now: number,
): SubagentStatusState {
	if (isOlderActivityObservation(state, observation)) return state;
	if (isBlockedByLocalOverride(state, observation)) return state;
	return applyPresentStatus(state, observation, now);
}

function isOlderActivityObservation(state: SubagentStatusState, observation: PresentStatusObservation): boolean {
	return activityObservationOrder(state, observation) < 0;
}

function isBlockedByLocalOverride(state: SubagentStatusState, observation: PresentStatusObservation): boolean {
	return localOverrideOrder(state, observation) <= 0;
}

function activityObservationOrder(state: SubagentStatusState, observation: PresentStatusObservation): number {
	return compareObservationOrder(
		observation.updatedAt,
		observation.sequence,
		state.lastActivityAtMs,
		state.lastActivitySequence,
	);
}

function localOverrideOrder(state: SubagentStatusState, observation: PresentStatusObservation): number {
	return compareObservationOrder(
		observation.updatedAt,
		observation.sequence,
		state.localOverrideAtMs,
		state.localOverrideSequence,
	);
}

function compareObservationOrder(
	incomingAt: number,
	incomingSequence: number,
	referenceAt: number | null,
	referenceSequence: number | null,
): number {
	if (referenceAt == null) return 1;
	const timeOrder = incomingAt - referenceAt;
	return timeOrder || incomingSequence - (referenceSequence ?? -1);
}

function applyPresentStatus(
	state: SubagentStatusState,
	observation: PresentStatusObservation,
	now: number,
): SubagentStatusState {
	const activity = presentActivityState(state, observation);
	return {
		...state,
		firstObservationAtMs: state.firstObservationAtMs ?? now,
		lastActivityAtMs: observation.updatedAt,
		lastActivitySequence: observation.sequence,
		...activity,
		phase: observation.phase,
		latestEvent: observation.latestEvent ?? null,
		activityLabel: observation.activityLabel ?? null,
		snapshotState: "present",
		snapshotProblemSinceMs: null,
		snapshotError: null,
		localOverrideAtMs: null,
		localOverrideSequence: null,
	};
}

function presentActivityState(
	state: SubagentStatusState,
	observation: PresentStatusObservation,
): Pick<SubagentStatusState, "activeNow" | "activeSinceMs" | "activeScope" | "waitingSinceMs"> {
	const activeNow = observation.phase === "active" || observation.active === true;
	return {
		activeNow,
		...activeActivityFields(activeNow, state, observation),
		waitingSinceMs: waitingSince(state, observation),
	};
}

function activeActivityFields(
	activeNow: boolean,
	state: SubagentStatusState,
	observation: PresentStatusObservation,
): Pick<SubagentStatusState, "activeSinceMs" | "activeScope"> {
	if (!activeNow) return { activeSinceMs: null, activeScope: null };
	return {
		activeSinceMs: observation.activeSince ?? state.activeSinceMs ?? observation.updatedAt,
		activeScope: observation.activeScope ?? null,
	};
}

function waitingSince(state: SubagentStatusState, observation: PresentStatusObservation): number | null {
	if (observation.phase !== "waiting") return null;
	return observation.waitingSince ?? state.waitingSinceMs ?? observation.updatedAt;
}

export function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
	return {
		...state,
		firstObservationAtMs: state.firstObservationAtMs ?? now,
		lastActivityAtMs: now,
		localOverrideAtMs: now,
		localOverrideSequence: state.lastActivitySequence,
		activeNow: false,
		activeSinceMs: null,
		activeScope: null,
		waitingSinceMs: now,
		phase: "waiting",
		latestEvent: "interrupt_requested",
		activityLabel: "interrupted",
		snapshotState: "present",
		snapshotProblemSinceMs: null,
		snapshotError: null,
		currentKind: "waiting",
	};
}

type StatusClassification = Pick<StatusSnapshot, "kind" | "statusLabel">;

function classifyProblemState(state: SubagentStatusState, now: number): StatusClassification {
	const statusLabel = snapshotProblemLabel(state.snapshotState);
	if (state.lastActivityAtMs == null) return classifyUnobservedProblem(state, now, statusLabel);
	return classifyObservedProblem(state, now, statusLabel);
}

function classifyUnobservedProblem(
	state: SubagentStatusState,
	now: number,
	statusLabel: string | null,
): StatusClassification {
	return stalledOrStarting(now - (state.firstObservationAtMs ?? state.startTimeMs), statusLabel);
}

function classifyObservedProblem(
	state: SubagentStatusState,
	now: number,
	statusLabel: string | null,
): StatusClassification {
	if (isStatusStalled(now - (state.snapshotProblemSinceMs ?? now))) return { kind: "stalled", statusLabel };
	return { kind: lastHealthyStatusKind(state), statusLabel };
}

function stalledOrStarting(elapsedMs: number, statusLabel: string | null): StatusClassification {
	return isStatusStalled(elapsedMs) ? { kind: "stalled", statusLabel } : { kind: "starting", statusLabel: null };
}

function isStatusStalled(elapsedMs: number): boolean {
	return Math.max(0, elapsedMs) >= SNAPSHOT_STALLED_AFTER_MS;
}

function lastHealthyStatusKind(state: SubagentStatusState): SubagentStatusKind {
	return activeStatusKind(state) ?? waitingStatusKind(state) ?? unstalledStatusKind(state.currentKind);
}

function activeStatusKind(state: SubagentStatusState): SubagentStatusKind | undefined {
	return state.activeNow ? "active" : undefined;
}

function waitingStatusKind(state: SubagentStatusState): SubagentStatusKind | undefined {
	return state.waitingSinceMs != null || state.phase === "done" ? "waiting" : undefined;
}

function unstalledStatusKind(kind: SubagentStatusKind): SubagentStatusKind {
	return kind === "stalled" ? "starting" : kind;
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
	const classification = classifyStatusKind(state, now);
	const durations = statusDurations(state, now);
	return {
		...durations,
		kind: classification.kind,
		activeSinceMs: state.activeSinceMs,
		activeScope: state.activeScope,
		waitingSinceMs: state.waitingSinceMs,
		latestEvent: state.latestEvent,
		activityLabel: state.activityLabel,
		snapshotState: state.snapshotState,
		snapshotError: state.snapshotError,
		statusLabel: classification.statusLabel,
	};
}

type PresentStatusClassifier = (state: SubagentStatusState, now: number) => StatusClassification;

const presentStatusClassifiers: Record<StatusActivityPhase | "unknown", PresentStatusClassifier> = {
	active: () => ({ kind: "active", statusLabel: null }),
	waiting: () => ({ kind: "waiting", statusLabel: null }),
	done: () => ({ kind: "waiting", statusLabel: "done" }),
	starting: classifyPresentWithoutPhase,
	unknown: classifyPresentWithoutPhase,
};

function classifyStatusKind(state: SubagentStatusState, now: number): StatusClassification {
	if (state.snapshotState !== "present") return classifyProblemState(state, now);
	const phase = state.activeNow ? "active" : (state.phase ?? "unknown");
	return presentStatusClassifiers[phase](state, now);
}

function classifyPresentWithoutPhase(state: SubagentStatusState, now: number): StatusClassification {
	return stalledOrStarting(now - (state.firstObservationAtMs ?? state.startTimeMs), null);
}

function statusDurations(
	state: SubagentStatusState,
	now: number,
): Pick<
	StatusSnapshot,
	"elapsedMs" | "elapsedText" | "activeDurationText" | "waitingDurationText" | "snapshotProblemText"
> {
	const elapsedMs = Math.max(0, now - state.startTimeMs);
	return {
		elapsedMs,
		elapsedText: formatElapsedDuration(elapsedMs),
		activeDurationText: durationSince(state.activeSinceMs, now),
		waitingDurationText: durationSince(state.waitingSinceMs, now),
		snapshotProblemText: durationSince(state.snapshotProblemSinceMs, now),
	};
}

function durationSince(since: number | null, now: number): string | null {
	return since == null ? null : formatElapsedDuration(now - since);
}

export function advanceStatusState(
	state: SubagentStatusState,
	now: number,
): {
	nextState: SubagentStatusState;
	snapshot: StatusSnapshot;
	transition: SubagentStatusTransition;
} {
	const snapshot = classifyStatus(state, now);
	return {
		snapshot,
		transition: statusTransition(state.currentKind, snapshot.kind),
		nextState: { ...state, currentKind: snapshot.kind },
	};
}

type StatusTransitionHandler = (next: SubagentStatusKind) => SubagentStatusTransition;

const statusTransitionHandlers: Record<SubagentStatusKind, StatusTransitionHandler> = {
	starting: enteredStalledTransition,
	running: enteredStalledTransition,
	active: enteredStalledTransition,
	waiting: enteredStalledTransition,
	stalled: recoveredStatusTransition,
};

function statusTransition(previous: SubagentStatusKind, next: SubagentStatusKind): SubagentStatusTransition {
	return statusTransitionHandlers[previous](next);
}

function enteredStalledTransition(next: SubagentStatusKind): SubagentStatusTransition {
	return next === "stalled" ? "stalled" : null;
}

function recoveredStatusTransition(next: SubagentStatusKind): SubagentStatusTransition {
	return next === "active" || next === "waiting" ? "recovered" : null;
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
	const label = activityLabel(snapshot);
	if (!label) return "active";
	const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
	return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
	const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
	return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
	const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
	const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
	return `stalled${duration}${detail}`;
}

type StatusLineBuilder = (name: string, snapshot: StatusSnapshot) => string;

const statusLineBuilders: Record<SubagentStatusKind, StatusLineBuilder> = {
	starting: (name, snapshot) => {
		const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
		return `${name} running ${snapshot.elapsedText}, starting${label}.`;
	},
	running: (name, snapshot) => `${name} running ${snapshot.elapsedText}.`,
	active: (name, snapshot) => `${name} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`,
	waiting: (name, snapshot) =>
		`${name} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${waitingProblem(snapshot)}.`,
	stalled: (name, snapshot) => `${name} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`,
};

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
	return boundStatusLine(statusLineBuilders[snapshot.kind](normalizeStatusName(name), snapshot));
}

function waitingProblem(snapshot: StatusSnapshot): string {
	if (!snapshot.statusLabel) return "";
	return snapshot.statusLabel === "done" ? " (done)" : ` (${snapshot.statusLabel})`;
}

export function formatTransitionLine(
	name: string,
	snapshot: StatusSnapshot,
	transition: Exclude<SubagentStatusTransition, null>,
): string {
	const boundedName = normalizeStatusName(name);

	if (transition === "recovered") {
		const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
		return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
	}

	return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
	const visibleLines = lines.slice(0, lineLimit);
	return {
		visibleLines,
		overflow: Math.max(0, lines.length - visibleLines.length),
	};
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
	const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
	const bulletLines = visibleLines.map((line) => `• ${line}`);
	if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
	return `Subagent status:\n${bulletLines.join("\n")}`;
}
