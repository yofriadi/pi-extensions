/**
 * Trigger decision logic: pure mapping from events + resolved config to
 * "should a sound fire, and from which file list". No spawning here — the
 * player module owns that. All decision helpers take injectable RNG/clock
 * seams so tests are deterministic without mocking the process.
 */

import type { SoundConfig } from "./config";

/** Select one file from a list at random. Empty list → undefined. */
export function pick(files: string[], rng: () => number = Math.random): string | undefined {
	if (files.length === 0) return undefined;
	if (files.length === 1) return files[0];
	const index = Math.floor(rng() * files.length);
	// rng() ∈ [0, 1): floor can never reach files.length, but a stubbed
	// out-of-range rng must not crash either.
	return files[Math.min(index, files.length - 1)];
}

/** Turn-milestone check: turnIndex > 0 and divisible by `every`. */
export function isTurnMilestone(turnIndex: number, every: number): boolean {
	return turnIndex > 0 && every > 0 && turnIndex % every === 0;
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
 * Elapsed-time trigger: arms a timer on agent_start when `elapsed` is
 * configured (one-shot or repeating), clears it on agent_settled /
 * session_shutdown. Timers are unref'd so they never hold the process open.
 */
export class ElapsedTimer {
	private handle: unknown;
	private repeating = false;
	private readonly timers: TimerFns;

	constructor(timers: TimerFns = defaultTimerFns) {
		this.timers = timers;
	}

	/**
	 * Arm the elapsed trigger for a run. Fires after `seconds`, repeating at
	 * the same interval when `repeat` is true. Arming again (a second
	 * agent_start) replaces any previous timer.
	 */
	arm(config: SoundConfig, onFire: () => void): void {
		this.clear();
		const elapsed = config.elapsed;
		if (!elapsed) return;
		const ms = elapsed.seconds * 1000;
		this.repeating = elapsed.repeat;
		if (elapsed.repeat) {
			this.handle = this.timers.setInterval(() => {
				try {
					onFire();
				} catch {
					// Best-effort: a timer callback must never crash the process.
				}
			}, ms);
		} else {
			this.handle = this.timers.setTimeout(() => {
				this.handle = undefined;
				try {
					onFire();
				} catch {
					// Best-effort.
				}
			}, ms);
		}
		this.timers.unref(this.handle);
	}

	/** Clear the armed timer (agent_settled / session_shutdown). */
	clear(): void {
		if (this.handle === undefined) return;
		if (this.repeating) this.timers.clearInterval(this.handle);
		else this.timers.clearTimeout(this.handle);
		this.handle = undefined;
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
