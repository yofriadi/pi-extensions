/**
 * Trigger decision logic: pure mapping from events + resolved config to
 * "should a sound fire, and from which file list". No spawning here — the
 * player module owns that. All decision helpers take injectable RNG/clock
 * seams so tests are deterministic without mocking the process.
 */

import type { ElapsedTriggerSpec, SoundConfig, TurnTriggerSpec } from "./config";

/** Select one file from a list at random. Empty list → undefined. */
export function pick(files: string[], rng: () => number = Math.random): string | undefined {
	if (files.length === 0) return undefined;
	if (files.length === 1) return files[0];
	const index = Math.floor(rng() * files.length);
	// rng() ∈ [0, 1): floor can never reach files.length, but a stubbed
	// out-of-range rng must not crash either.
	return files[Math.min(index, files.length - 1)];
}

/**
 * Turn-trigger block check. A block fires when either condition matches:
 * its periodic `every` (turnIndex > 0 and divisible) or its one-shot `at`
 * (turnIndex equals one of the listed values — once per listed turn,
 * never at other multiples). A block with neither condition never fires.
 */
export function turnSpecFires(turnIndex: number, spec: TurnTriggerSpec): boolean {
	if (turnIndex <= 0) return false;
	if (spec.every !== undefined && spec.every > 0 && turnIndex % spec.every === 0) return true;
	const at = spec.at;
	if (at === undefined) return false;
	if (typeof at === "number") return at > 0 && turnIndex === at;
	return at.includes(turnIndex);
}

/**
 * Compile quota patterns to a case-insensitive matcher. Invalid regex entries
 * are ignored; remaining entries still apply. An empty result matches nothing.
 */
export function compileQuotaPatterns(patterns: string[]): (text: string) => boolean {
	const regexes: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			regexes.push(new RegExp(pattern, "i"));
		} catch {
			// Ignore invalid regex entries — the rest still apply.
		}
	}
	if (regexes.length === 0) return () => false;
	return (text: string) => regexes.some((re) => re.test(text));
}

/** Quota-trigger dedupe window in milliseconds. */
export const QUOTA_DEDUPE_MS = 5_000;

/** Minimum shape of an assistant message needed for quota detection. */
export interface QuotaMessage {
	role: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Minimum shape of a message needed for settle-outcome classification. */
export interface OutcomeMessage {
	role: string;
	stopReason?: string;
	/** Present on real agent_end messages; ignored by classification. */
	errorMessage?: string;
}

/**
 * Quota-trigger state: pattern matchers for transient throttling and terminal
 * exhaustion, plus last-fire timestamps (injectable clock). `classify` inspects
 * assistant error messages and returns which trigger — if any — should fire;
 * exhaustion takes precedence over transient when both match (the more
 * specific, actionable condition wins). Either fire consumes the shared
 * 5-second dedupe window so a retry burst plays at most one sound.
 */
export type QuotaTriggerKind = "quota" | "quotaExhausted" | undefined;

export class QuotaDetector {
	private readonly matchTransient: (text: string) => boolean;
	private readonly matchExhausted: (text: string) => boolean;
	private readonly now: () => number;
	private lastFiredAt: number | undefined;

	constructor(transientPatterns: string[], exhaustedPatterns: string[], now: () => number = Date.now) {
		this.matchTransient = compileQuotaPatterns(transientPatterns);
		this.matchExhausted = compileQuotaPatterns(exhaustedPatterns);
		this.now = now;
	}

	/** Classify one assistant error message; consumes the dedupe window on a fire. */
	classify(message: QuotaMessage): QuotaTriggerKind {
		if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
		const text = message.errorMessage ?? "";
		const exhausted = this.matchExhausted(text);
		const transient = this.matchTransient(text);
		if (!exhausted && !transient) return undefined;
		const t = this.now();
		if (this.lastFiredAt !== undefined && t - this.lastFiredAt < QUOTA_DEDUPE_MS) return undefined;
		this.lastFiredAt = t;
		return exhausted ? "quotaExhausted" : "quota";
	}
}

/** Terminal outcome of a run, classified from the last assistant message's `stopReason` on `agent_end`. */
export type RunOutcome = "settled" | "failed" | "aborted" | "unknown";

/**
 * Settle-run outcome latch: `agent_settled` is payload-free, so the
 * outcome of the run is recorded from `agent_end` (the only lifecycle
 * event carrying messages) and consumed at settle time. Reset on every
 * `agent_start` — automatic retries and compaction continuations re-enter
 * the loop with a fresh `agent_start`, so the last attempt's verdict wins —
 * and on `session_start`; `take()` consumes the verdict so a stale outcome
 * never leaks into the next run. Classification reads `stopReason` only,
 * never `errorMessage` text.
 */
export class SettleOutcome {
	private outcome: RunOutcome = "unknown";

	/** Re-arm for a new run (agent_start / session_start). */
	reset(): void {
		this.outcome = "unknown";
	}

	/** Classify one `agent_end` payload from its last assistant message, if any. */
	noteAgentEnd(messages: OutcomeMessage[]): void {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				this.outcome = this.classify(message);
				return;
			}
		}
		// No assistant message: leave the outcome as-is (unknown after reset).
	}

	/** Consume the recorded outcome and reset to `unknown` (agent_settled). */
	take(): RunOutcome {
		const outcome = this.outcome;
		this.outcome = "unknown";
		return outcome;
	}

	/** `error` → failed, `aborted` → aborted, any other value → settled. */
	private classify(message: OutcomeMessage): RunOutcome {
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "aborted";
		return "settled";
	}
}

/**
 * File list to play for a settled run, by outcome: `failed` uses
 * `agentFailed` when configured and inherits the `error` list otherwise — a
 * reuse of the file list only, never of the `error` trigger's per-turn
 * dedupe state; `aborted` uses `agentAborted` with no fallback; `settled`
 * and `unknown` use `agentSettled` (an unknown outcome degrades to the
 * success sound rather than silencing it).
 */
export function settleFiles(config: SoundConfig, outcome: RunOutcome): string[] {
	if (outcome === "failed") {
		return config.events.agentFailed.length > 0 ? config.events.agentFailed : config.events.error;
	}
	if (outcome === "aborted") return config.events.agentAborted;
	return config.events.agentSettled;
}

/** Injectable timer functions for tests. */
export interface TimerFns {
	setTimeout: (callback: () => void, ms: number) => unknown;
	setInterval: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	clearInterval: (handle: unknown) => void;
	unref: (handle: unknown) => void;
}

const defaultTimerFns: TimerFns = {
	setTimeout: (callback, ms) => {
		const t = setTimeout(callback, ms);
		t.unref();
		return t;
	},
	setInterval: (callback, ms) => {
		const t = setInterval(callback, ms);
		t.unref();
		return t;
	},
	clearTimeout: (handle) => {
		if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
	},
	clearInterval: (handle) => {
		if (handle !== undefined) clearInterval(handle as NodeJS.Timeout);
	},
	unref: (handle) => {
		(handle as NodeJS.Timeout | undefined)?.unref?.();
	},
};

/**
 * Elapsed-time trigger: arms timers on agent_start across every configured
 * block — one per listed second-mark, one-shot or repeating per block — and
 * clears them on agent_settled / session_shutdown. The callback receives the
 * fired block so each block plays its own files. Timers are unref'd so they
 * never hold the process open.
 */
export class ElapsedTimer {
	private handles: { handle: unknown; interval: boolean }[] = [];
	private readonly timers: TimerFns;

	constructor(timers: TimerFns = defaultTimerFns) {
		this.timers = timers;
	}

	/**
	 * Arm the elapsed trigger for a run. Every block in `config.elapsed`
	 * contributes one timer per listed `seconds` value, repeating on its
	 * own interval when that block's `repeat` is true; `onFire` receives
	 * the fired block. Arming again (a second agent_start) replaces all
	 * previous timers.
	 */
	arm(config: SoundConfig, onFire: (spec: ElapsedTriggerSpec) => void): void {
		this.clear();
		const fire = (spec: ElapsedTriggerSpec): void => {
			try {
				onFire(spec);
			} catch {
				// Best-effort: a timer callback must never crash the process.
			}
		};
		for (const spec of config.elapsed) {
			const values = Array.isArray(spec.seconds) ? spec.seconds : [spec.seconds];
			for (const seconds of values) {
				const ms = seconds * 1000;
				let handle: unknown;
				if (spec.repeat) {
					handle = this.timers.setInterval(() => fire(spec), ms);
				} else {
					handle = this.timers.setTimeout(() => {
						// One-shot: drop the handle so a later clear() is a no-op.
						this.handles = this.handles.filter((h) => h.handle !== handle);
						fire(spec);
					}, ms);
				}
				this.handles.push({ handle, interval: spec.repeat });
				this.timers.unref(handle);
			}
		}
	}

	/** Clear every armed timer (agent_settled / session_shutdown). */
	clear(): void {
		for (const { handle, interval } of this.handles) {
			if (interval) this.timers.clearInterval(handle);
			else this.timers.clearTimeout(handle);
		}
		this.handles = [];
	}
}

/**
 * Per-turn tool-error dedupe: the `error` trigger fires at most once per
 * turn. State resets on turn_start and session_start.
 */
export class TurnErrorDedupe {
	private firedThisTurn = false;

	/** Take the once-per-turn slot; true when this call is the first error of the turn. */
	claim(): boolean {
		if (this.firedThisTurn) return false;
		this.firedThisTurn = true;
		return true;
	}

	/** Reset on turn_start / session_start. */
	reset(): void {
		this.firedThisTurn = false;
	}
}
