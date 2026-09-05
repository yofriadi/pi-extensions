import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSubagentArtifactDir } from "./session.ts";

export const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

/** Default hard cap on watching a single subagent run. A watcher that never
 * settles never attempts delivery, which surfaces as a permanently "pending"
 * delivery in the widget.
 *
 * Deliberately generous: the cap exists to stop a *stranded* watcher (hung
 * child, unwritten sidecar, wedged herdr) from leaking forever, not to impose
 * a work SLA. A legitimately long background run looks identical to a hung one
 * from here — pane present, no completion evidence yet — so a tight cap would
 * falsely settle real work as an error. Override per-run with
 * CompletionOptions.timeoutMs; 0 disables the cap. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 4 * 60 * 60_000;

export interface CompletionResult {
	reason: "done" | "sentinel" | "error" | "timeout";
	exitCode: number;
	errorMessage?: string;
	runId?: string;
	/** True only for a well-formed child error sidecar (`type: "error"`) — the
	 * sole retryable failure kind. Malformed sidecars, unsupported payloads,
	 * and pane disappearance are shape-identical otherwise and are never retried. */
	fromErrorSidecar?: boolean;
}

export interface CompletionOptions {
	intervalMs: number;
	readTerminalTail: () => Promise<string>;
	inspectPane?: () => Promise<import("./lifecycle.ts").PaneInspection>;
	/** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
	paneDisappearanceGraceMs?: number;
	onPaneInspection?: (inspection: import("./lifecycle.ts").PaneInspection, observedAt: number) => void;
	sessionFile?: string;
	sentinelFile?: string;
	onTick?: (elapsedSeconds: number) => void;
	expectedRunId?: string;
	/** Hard cap on the total wait. On expiry the watcher settles as an error
	 *  result so the run still flows through the normal delivery path instead of
	 *  hanging forever. Default: DEFAULT_COMPLETION_TIMEOUT_MS. 0 disables. */
	timeoutMs?: number;
	/** Cap on any single evidence probe (pane inspect / terminal read). A probe is
	 *  advisory, so exceeding this is treated as "no reading", never as evidence.
	 *  Default: EVIDENCE_PROBE_TIMEOUT_MS. */
	probeTimeoutMs?: number;
}

export function interpretExitSidecar(data: unknown): CompletionResult {
	const payload = data as {
		type?: unknown;
		name?: unknown;
		message?: unknown;
		errorMessage?: unknown;
		runId?: unknown;
	};

	const runId = typeof payload?.runId === "string" ? payload.runId : undefined;

	if (payload?.type === "error") {
		const errorMessage =
			typeof payload.errorMessage === "string" && payload.errorMessage.trim()
				? payload.errorMessage
				: "Subagent exited with stopReason=error (no errorMessage in sidecar).";
		return {
			reason: "error",
			exitCode: 1,
			errorMessage,
			fromErrorSidecar: true,
			...(runId ? { runId } : {}),
		};
	}

	if (payload?.type === "done") {
		return { reason: "done", exitCode: 0, ...(runId ? { runId } : {}) };
	}

	return {
		reason: "error",
		exitCode: 1,
		errorMessage: "Invalid subagent completion sidecar: unsupported payload type.",
		// Carry runId so consumeExitSidecar's ownership check still applies. Without
		// it, a CURRENT-run sidecar with an unknown `type` is deleted then discarded
		// as "stale" (runId === undefined !== expectedRunId), hiding a malformed
		// artifact that the spec requires be surfaced as a visible error outcome.
		...(runId ? { runId } : {}),
	};
}

/** Conservative permanent-failure pattern for the retry short-circuit: obvious
 * quota exhaustion, billing, and authentication/authorization failures are
 * never worth retrying, so the run settles immediately instead of burning the
 * attempt budget. Deliberately narrow — the classifier is an attempt-saving
 * optimization, not the classifier of record: a transient 429 phrased as a
 * plain "rate limit" does NOT match and keeps the full retry policy, and the
 * delivered permanent-error rule leaves the parent's judgment final.
 *
 * The quota family allows a bounded word gap between the noun and its verb
 * ("Quota has been exhausted", "exceeded your quota limit") because providers
 * interleave words there; the quota verbs are exhaust/exceed only (a bare
 * "limit" is ambiguous — "quota limit resets at midnight" is transient);
 * authentication must co-occur with a failure verb ("authentication backend
 * timeout, retry" is transient). */
export const PERMANENT_ERROR_RE =
	/(?:\bquota\b[^.]{0,40}?\b(?:exhaust\w+|exceed\w+)\b|\b(?:exceed\w+|exhaust\w+)\b[^.]{0,20}?\bquota\b|\bbilling\b|\binvalid[\s_-]*api[\s_-]*key\b|\bunauthorized\b|\bauthentication\s+(?:failed|failure|error|required)\b|\b(?:failed|invalid)\s+authentication\b)/i;

/** Explicitly-transient markers: a message that says it retries, resets, or is
 * per-minute/temporary can never be classified permanent — providers phrase
 * rolling-window 429s and quota-reset notices textually near-identically to
 * permanent quota exhaustion, and a false positive skips the retry policy
 * AND burns a resume on an account that is merely cooling down. This guard
 * only ever REMOVES matches, so a miss degrades to the full 3-attempt
 * policy — never to wrong delivery. */
export const TRANSIENT_HINT_RE = /\b(?:retry\w*|resets?|per[- ]minute|temporarily?|cooldown|backoff)\b/i;

/** True for a well-formed child error sidecar whose message matches the
 * conservative permanent-failure pattern without any explicit transient
 * marker. Malformed sidecars, pane disappearance, and non-sidecar errors
 * never qualify — they are not retried for different reasons and must keep
 * their distinct presentations. */
export function isPermanentErrorCompletion(result: CompletionResult): boolean {
	return (
		result.reason === "error" &&
		result.fromErrorSidecar === true &&
		typeof result.errorMessage === "string" &&
		PERMANENT_ERROR_RE.test(result.errorMessage) &&
		!TRANSIENT_HINT_RE.test(result.errorMessage)
	);
}

/** A retryable attempt outcome: a well-formed child error sidecar (provider
 * rate limit or an error-terminated child turn) that does not look permanent.
 * Every other error-shaped outcome — malformed sidecar, unsupported payload,
 * pane disappearance, a permanent-looking quota/billing/auth failure — plus
 * timeout and abort settles immediately. */
export function isRetryableCompletion(result: CompletionResult): boolean {
	return result.reason === "error" && result.fromErrorSidecar === true && !isPermanentErrorCompletion(result);
}

function consumeExitSidecar(sessionFile: string | undefined, expectedRunId?: string): CompletionResult | null {
	if (!sessionFile) return null;
	const exitFile = join(getSubagentArtifactDir(sessionFile), "exit.json");
	if (!existsSync(exitFile)) return null;
	try {
		const result = interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf8")));
		rmSync(exitFile, { force: true });
		if (expectedRunId && result.runId !== expectedRunId) {
			// Stale artifact from a previous run on this session file (e.g. the
			// failed run's pane was preserved and later closed). Already deleted
			// above — treat as no sidecar and keep waiting for this run's outcome
			// rather than failing the current run with someone else's result.
			return null;
		}
		return result;
	} catch {
		rmSync(exitFile, { force: true });
		return { reason: "error", exitCode: 1, errorMessage: "Malformed subagent completion sidecar." };
	}
}

function terminalExitCode(screen: string): number | null {
	const match = screen.match(TERMINAL_SENTINEL);
	return match ? Number.parseInt(match[1], 10) : null;
}

/** Cap on any single evidence probe. `inspectPane` and `readTerminalTail` reach
 * a herdr subprocess; a wedged one must not stall the watch loop or the final
 * sweep. Generous relative to herdr's own subprocess timeout, so this fires only
 * when that safety net has itself failed. */
const EVIDENCE_PROBE_TIMEOUT_MS = 10_000;

function probeTimeoutFor(options: CompletionOptions): number {
	const configured = options.probeTimeoutMs;
	return configured != null && configured > 0 ? configured : EVIDENCE_PROBE_TIMEOUT_MS;
}

/** Await a probe with a hard cap, resolving `undefined` on timeout OR rejection.
 * A probe is advisory: never let one hang or fail the watch. The pending promise
 * is abandoned, not cancelled — callers must treat `undefined` as "no reading". */
function probeWithTimeout<T>(probe: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		let settled = false;
		const finish = (value: T | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(undefined);
		}, timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		probe.then(
			(value) => finish(value),
			() => finish(undefined),
		);
	});
}

/** Bounded final sweep at the watch deadline.
 *
 * The deadline check necessarily runs before the loop's own probes, so settling
 * on the deadline alone would report "no evidence" for a run that had just
 * finished. Probe EVERY source the loop uses — terminal tail, sentinel file, and
 * exit sidecar — and prefer real evidence over the synthetic timeout.
 *
 * The terminal tail matters most in production: `watchSubagent` passes no
 * `sentinelFile`, so the tail is the only sentinel channel that actually runs.
 * Every probe is bounded, so the timeout path cannot itself hang. */
async function sweepFinalEvidence(signal: AbortSignal, options: CompletionOptions): Promise<CompletionResult | null> {
	const probeBudget = probeTimeoutFor(options);
	let tailExitCode: number | null = null;
	try {
		const tail = await probeWithTimeout(options.readTerminalTail(), probeBudget);
		if (tail != null) tailExitCode = terminalExitCode(tail);
	} catch {
		// Advisory probe only.
	}
	const fallback: CompletionResult | null =
		tailExitCode !== null
			? { reason: "sentinel", exitCode: tailExitCode }
			: options.sentinelFile && existsSync(options.sentinelFile)
				? { reason: "sentinel", exitCode: 0 }
				: null;
	return waitForPreferredSidecar(signal, options, fallback);
}

async function waitForPreferredSidecar(
	signal: AbortSignal,
	options: CompletionOptions,
	fallback: CompletionResult | null,
	graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500),
): Promise<CompletionResult | null> {
	if (!options.sessionFile) return fallback;
	const immediate = consumeExitSidecar(options.sessionFile, options.expectedRunId);
	if (immediate) return immediate;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		await abortableDelay(Math.min(25, remaining), signal);
		const sidecar = consumeExitSidecar(options.sessionFile, options.expectedRunId);
		if (sidecar) return sidecar;
	}
	return fallback;
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(ABORT_MESSAGE));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type WatchTiming = { startedAt: number; timeoutMs: number; deadline: number };

export async function waitForCompletion(signal: AbortSignal, options: CompletionOptions): Promise<CompletionResult> {
	const timing = createWatchTiming(options);
	for (;;) {
		throwIfAborted(signal);
		const deadlineResult = await completionAtDeadline(signal, options, timing);
		if (deadlineResult) return deadlineResult;
		const evidence = await pollCompletionEvidence(signal, options);
		if (evidence) return evidence;
		options.onTick?.(elapsedWatchSeconds(timing.startedAt));
		await abortableDelay(options.intervalMs, signal);
	}
}

function createWatchTiming(options: CompletionOptions): WatchTiming {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
	return {
		startedAt,
		timeoutMs,
		deadline: timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY,
	};
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error(ABORT_MESSAGE);
}

async function completionAtDeadline(
	signal: AbortSignal,
	options: CompletionOptions,
	timing: WatchTiming,
): Promise<CompletionResult | null> {
	if (Date.now() < timing.deadline) return null;
	return (await sweepFinalEvidence(signal, options)) ?? timeoutResult(timing.timeoutMs);
}

function timeoutResult(timeoutMs: number): CompletionResult {
	return {
		reason: "timeout",
		exitCode: 1,
		errorMessage:
			`Subagent recorded no completion evidence within ${formatTimeoutBudget(timeoutMs)}; ` +
			"stopped watching. The pane may still be open — inspect it directly.",
	};
}

async function pollCompletionEvidence(
	signal: AbortSignal,
	options: CompletionOptions,
): Promise<CompletionResult | null> {
	const sidecar = consumeExitSidecar(options.sessionFile, options.expectedRunId);
	if (sidecar) return sidecar;
	const sentinel = await sentinelFileEvidence(signal, options);
	if (sentinel) return sentinel;
	const pane = await paneInspectionEvidence(signal, options);
	if (pane) return pane;
	return terminalTailEvidence(signal, options);
}

async function sentinelFileEvidence(signal: AbortSignal, options: CompletionOptions): Promise<CompletionResult | null> {
	if (!options.sentinelFile || !existsSync(options.sentinelFile)) return null;
	return waitForPreferredSidecar(signal, options, { reason: "sentinel", exitCode: 0 });
}

async function paneInspectionEvidence(
	signal: AbortSignal,
	options: CompletionOptions,
): Promise<CompletionResult | null> {
	if (!options.inspectPane) return null;
	const inspection = await inspectCompletionPane(options);
	options.onPaneInspection?.(inspection, Date.now());
	if (inspection.kind !== "missing") return null;
	const racedCompletion = await waitForPreferredSidecar(signal, options, null);
	return racedCompletion ?? missingPaneResult();
}

async function inspectCompletionPane(options: CompletionOptions): Promise<import("./lifecycle.ts").PaneInspection> {
	const inspectPane = options.inspectPane;
	if (!inspectPane) return { kind: "unavailable", error: "inspectPane was unavailable" };
	try {
		return (
			(await probeWithTimeout(inspectPane(), probeTimeoutFor(options))) ?? {
				kind: "unavailable",
				error: "inspectPane exceeded probe timeout",
			}
		);
	} catch {
		return { kind: "unavailable", error: "inspectPane threw" };
	}
}

function missingPaneResult(): CompletionResult {
	return {
		reason: "error",
		exitCode: 1,
		errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
	};
}

async function terminalTailEvidence(signal: AbortSignal, options: CompletionOptions): Promise<CompletionResult | null> {
	try {
		const tail = await probeWithTimeout(options.readTerminalTail(), probeTimeoutFor(options));
		const exitCode = tail == null ? null : terminalExitCode(tail);
		return exitCode === null
			? null
			: await waitForPreferredSidecar(signal, options, { reason: "sentinel", exitCode });
	} catch {
		// Terminal reads are only sentinel/output probes; pane inspection is authoritative.
		return null;
	}
}

function elapsedWatchSeconds(startedAt: number): number {
	return Math.floor((Date.now() - startedAt) / 1000);
}

/** Render a watch budget for a human-facing message: "4h", "90m", "45s", "40ms".
 * Sub-second budgets (tests, deliberately tiny caps) must not render as "0s". */
export function formatTimeoutBudget(milliseconds: number): string {
	const round1 = (value: number) => (Number.isInteger(value) ? value : Math.round(value * 10) / 10);
	if (milliseconds >= 3_600_000) return `${round1(milliseconds / 3_600_000)}h`;
	if (milliseconds >= 60_000) return `${round1(milliseconds / 60_000)}m`;
	if (milliseconds >= 1_000) return `${round1(milliseconds / 1_000)}s`;
	return `${Math.max(0, Math.round(milliseconds))}ms`;
}
