import { existsSync, readFileSync, rmSync } from "node:fs";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
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
	reason: "done" | "ping" | "sentinel" | "error" | "timeout";
	exitCode: number;
	ping?: { name: string; message: string };
	errorMessage?: string;
	runId?: string;
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
	if (payload?.type === "ping") {
		return {
			reason: "ping",
			exitCode: 0,
			ping: {
				name: typeof payload.name === "string" ? payload.name : "subagent",
				message: typeof payload.message === "string" ? payload.message : "",
			},
			...(runId ? { runId } : {}),
		};
	}

	if (payload?.type === "error") {
		const errorMessage =
			typeof payload.errorMessage === "string" && payload.errorMessage.trim()
				? payload.errorMessage
				: "Subagent exited with stopReason=error (no errorMessage in sidecar).";
		return { reason: "error", exitCode: 1, errorMessage, ...(runId ? { runId } : {}) };
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

function consumeExitSidecar(sessionFile: string | undefined, expectedRunId?: string): CompletionResult | null {
	if (!sessionFile) return null;
	const exitFile = `${sessionFile}.exit`;
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

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export async function waitForCompletion(signal: AbortSignal, options: CompletionOptions): Promise<CompletionResult> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
	const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY;

	for (;;) {
		if (signal.aborted) throw new Error(ABORT_MESSAGE);

		// Hard cap: never watch forever. A pane that neither publishes completion
		// evidence nor disappears (hung child, unwritten sidecar, wedged herdr)
		// would otherwise strand the watcher and leave the delivery permanently
		// "pending". Sweep every evidence source first — a run that finished must
		// never be reported as unwitnessed — then settle as an explicit timeout so
		// the run still flows through the normal delivery path instead of hanging.
		if (Date.now() >= deadline) {
			const raced = await sweepFinalEvidence(signal, options);
			if (raced) return raced;
			return {
				reason: "timeout",
				exitCode: 1,
				errorMessage:
					`Subagent recorded no completion evidence within ${formatTimeoutBudget(timeoutMs)}; ` +
					"stopped watching. The pane may still be open — inspect it directly.",
			};
		}

		const sidecarResult = consumeExitSidecar(options.sessionFile, options.expectedRunId);
		if (sidecarResult) return sidecarResult;

		if (options.sentinelFile && existsSync(options.sentinelFile)) {
			const preferred = await waitForPreferredSidecar(signal, options, { reason: "sentinel", exitCode: 0 });
			if (preferred) return preferred;
		}

		// Inspect the pane BEFORE reading the terminal tail. A hung or slow
		// `pane read` (e.g. when the pane is in a transitional state during
		// closure, or the herdr subprocess is unresponsive) would otherwise block
		// the pane-missing detection below indefinitely, stranding the watcher
		// and leaving the subagent's delivery permanently "pending".
		if (options.inspectPane) {
			let inspection: import("./lifecycle.ts").PaneInspection;
			try {
				inspection = (await probeWithTimeout(options.inspectPane(), probeTimeoutFor(options))) ?? {
					kind: "unavailable",
					error: "inspectPane exceeded probe timeout",
				};
			} catch {
				inspection = { kind: "unavailable", error: "inspectPane threw" };
			}
			const observedAt = Date.now();
			options.onPaneInspection?.(inspection, observedAt);
			if (inspection.kind === "missing") {
				// Pane closure and atomic artifact publication are separate operations.
				// Allow a short bounded grace window before declaring evidence lost.
				const racedCompletion = await waitForPreferredSidecar(signal, options, null);
				if (racedCompletion) return racedCompletion;
				return {
					reason: "error",
					exitCode: 1,
					errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
				};
			}
		}

		try {
			const tail = await probeWithTimeout(options.readTerminalTail(), probeTimeoutFor(options));
			const exitCode = tail == null ? null : terminalExitCode(tail);
			if (exitCode !== null) {
				const preferred = await waitForPreferredSidecar(signal, options, { reason: "sentinel", exitCode });
				if (preferred) return preferred;
			}
		} catch {
			// Terminal reads are only sentinel/output probes; pane inspection above
			// is the authoritative completion signal.
		}

		options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
		await abortableDelay(options.intervalMs, signal);
	}
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
