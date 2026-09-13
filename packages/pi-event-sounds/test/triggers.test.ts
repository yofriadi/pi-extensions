/**
 * Trigger unit tests: random pick, turn milestones, quota matching with
 * dedupe window, per-turn error dedupe, elapsed timer lifecycle. Covers
 * every scenario in specs/event-sound-triggers/spec.md.
 */

import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type SoundConfig } from "../src/config";
import { ElapsedTimer, isTurnMilestone, pick, QuotaDetector, TurnErrorDedupe } from "../src/triggers";

describe("pick (random file selection)", () => {
	it("returns undefined for an empty list", () => {
		expect(pick([])).toBeUndefined();
	});

	it("always returns the single element of a one-element list", () => {
		expect(pick(["only.wav"], () => 0.99)).toBe("only.wav");
	});

	it("selects exactly one of three files at random", () => {
		const files = ["a.wav", "b.wav", "c.wav"];
		expect(pick(files, () => 0)).toBe("a.wav");
		expect(pick(files, () => 0.34)).toBe("b.wav");
		expect(pick(files, () => 0.99)).toBe("c.wav");
		for (let i = 0; i < 50; i++) {
			const chosen = pick(files);
			expect(files).toContain(chosen);
		}
	});

	it("never crashes on an out-of-range rng stub", () => {
		expect(["a.wav", "b.wav"]).toContain(pick(["a.wav", "b.wav"], () => 42));
	});
});

describe("turn milestone check", () => {
	it("fires when turnIndex > 0 and divisible by every", () => {
		expect(isTurnMilestone(100, 100)).toBe(true);
		expect(isTurnMilestone(200, 100)).toBe(true);
	});

	it("does not fire mid-interval", () => {
		expect(isTurnMilestone(37, 100)).toBe(false);
		expect(isTurnMilestone(99, 100)).toBe(false);
	});

	it("does not fire on turn zero", () => {
		expect(isTurnMilestone(0, 100)).toBe(false);
	});

	it("does not fire for a non-positive interval", () => {
		expect(isTurnMilestone(100, 0)).toBe(false);
	});
});

describe("quota detection", () => {
	function detector(now: number | (() => number) = 0): QuotaDetector {
		const d = defaultConfig();
		return new QuotaDetector(d.quotaPatterns, d.exhaustedPatterns, typeof now === "function" ? now : () => now);
	}

	const quotaError = (errorMessage: string) => ({ role: "assistant", stopReason: "error", errorMessage });

	it("classifies a transient rate-limit error message as quota", () => {
		expect(detector().classify(quotaError("Rate limit reached (429)"))).toBe("quota");
	});

	it("classifies exhaustion patterns as quotaExhausted", () => {
		expect(detector().classify(quotaError("insufficient_quota: billing hard limit reached"))).toBe(
			"quotaExhausted",
		);
		expect(detector().classify(quotaError("GoUsageLimitError: monthly usage limit reached"))).toBe(
			"quotaExhausted",
		);
	});

	it("exhaustion takes precedence over transient when both match", () => {
		// "quota exceeded" is in both lists; the more specific condition wins.
		expect(detector().classify(quotaError("429 too many requests — quota exceeded"))).toBe("quotaExhausted");
	});

	it("matches case-insensitively", () => {
		expect(detector().classify(quotaError("QUOTA EXCEEDED FOR THIS MONTH"))).toBe("quotaExhausted");
		expect(detector().classify(quotaError("Insufficient_Quota"))).toBe("quotaExhausted");
		expect(detector().classify(quotaError("RATE LIMIT EXCEEDED"))).toBe("quota");
	});

	it("supports regex-ish patterns (rate.?limit)", () => {
		expect(detector().classify(quotaError("rate limit exceeded"))).toBe("quota");
		expect(detector().classify(quotaError("rate-limit exceeded"))).toBe("quota");
	});

	it("returns undefined on a non-quota error message", () => {
		expect(detector().classify(quotaError("Unexpected EOF"))).toBeUndefined();
	});

	it("returns undefined on successful assistant messages", () => {
		expect(detector().classify({ role: "assistant", stopReason: "stop" })).toBeUndefined();
	});

	it("returns undefined for non-assistant roles", () => {
		expect(detector().classify({ role: "user", stopReason: "error", errorMessage: "429" })).toBeUndefined();
		expect(detector().classify({ role: "toolResult" })).toBeUndefined();
	});

	it("returns undefined when errorMessage is missing", () => {
		expect(detector().classify({ role: "assistant", stopReason: "error" })).toBeUndefined();
	});

	it("ignores invalid regex patterns and keeps matching the rest", () => {
		const d = new QuotaDetector(["[unclosed", "429"], [], () => 0);
		expect(d.classify(quotaError("Error 429 too many requests"))).toBe("quota");
	});

	it("dedupes a retry storm within the 5-second window", () => {
		let now = 0;
		const d = detector(() => now);
		expect(d.classify(quotaError("429 rate limit"))).toBe("quota"); // t=0 fires
		now = 1000;
		expect(d.classify(quotaError("429 rate limit"))).toBeUndefined(); // t=1s deduped
		now = 2000;
		expect(d.classify(quotaError("429 rate limit"))).toBeUndefined(); // t=2s deduped
		now = 3500;
		expect(d.classify(quotaError("429 rate limit"))).toBeUndefined(); // t=3.5s deduped
	});

	it("re-fires after the dedupe window passes (exponential backoff gap)", () => {
		let now = 0;
		const d = detector(() => now);
		expect(d.classify(quotaError("429"))).toBe("quota");
		now = 4999;
		expect(d.classify(quotaError("429"))).toBeUndefined();
		now = 5000;
		expect(d.classify(quotaError("429"))).toBe("quota");
	});

	it("honors custom quotaPatterns", () => {
		const d = new QuotaDetector(["capped"], [], () => 0);
		expect(d.classify(quotaError("429"))).toBeUndefined();
		expect(d.classify(quotaError("You are capped for today"))).toBe("quota");
	});

	it("honors custom exhaustedPatterns", () => {
		const d = new QuotaDetector([], ["broke"], () => 0);
		expect(d.classify(quotaError("429"))).toBeUndefined();
		expect(d.classify(quotaError("You are broke"))).toBe("quotaExhausted");
	});
});

describe("turn error dedupe", () => {
	it("claims only the first error of a turn", () => {
		const d = new TurnErrorDedupe();
		expect(d.claim()).toBe(true);
		expect(d.claim()).toBe(false);
		expect(d.claim()).toBe(false);
	});

	it("reset allows the next turn to claim again", () => {
		const d = new TurnErrorDedupe();
		d.claim();
		d.reset();
		expect(d.claim()).toBe(true);
	});
});

/** Fake timer functions recording arm/clear/unref calls; tests fire callbacks manually. */
function fakeTimers() {
	const armed: { kind: "timeout" | "interval"; callback: () => void; ms: number; handle: object }[] = [];
	const cleared: unknown[] = [];
	const unrefd: unknown[] = [];
	let nextHandle = 0;
	const timers = {
		setTimeout: (callback: () => void, ms: number) => {
			const handle = { kind: "timeout", id: nextHandle++ };
			armed.push({ kind: "timeout", callback, ms, handle });
			return handle;
		},
		setInterval: (callback: () => void, ms: number) => {
			const handle = { kind: "interval", id: nextHandle++ };
			armed.push({ kind: "interval", callback, ms, handle });
			return handle;
		},
		clearTimeout: (handle: unknown) => {
			cleared.push(handle);
		},
		clearInterval: (handle: unknown) => {
			cleared.push(handle);
		},
		unref: (handle: unknown) => {
			unrefd.push(handle);
		},
	};
	return { armed, cleared, unrefd, timers };
}

describe("elapsed timer", () => {
	function configWithElapsed(seconds: number, repeat: boolean): SoundConfig {
		return { ...defaultConfig(), elapsed: { seconds, repeat, files: ["tick.wav"] } };
	}

	it("arms a one-shot timeout on arm()", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), () => {});
		expect(f.armed).toHaveLength(1);
		expect(f.armed[0]?.kind).toBe("timeout");
		expect(f.armed[0]?.ms).toBe(300_000);
	});

	it("fires exactly once for a one-shot timer", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), onFire);
		f.armed[0]?.callback();
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it("arms an interval when repeat is true", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, true), () => {});
		expect(f.armed).toHaveLength(1);
		expect(f.armed[0]?.kind).toBe("interval");
	});

	it("repeats at the configured interval (fires at 300 and 600 seconds)", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, true), onFire);
		f.armed[0]?.callback();
		f.armed[0]?.callback();
		expect(onFire).toHaveBeenCalledTimes(2);
	});

	it("clears the armed timer on clear() (agent_settled / session_shutdown)", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), onFire);
		const handle = f.armed[0]?.handle;
		timer.clear();
		expect(f.cleared).toContain(handle);
	});

	it("unrefs the armed timer so it never holds the process open", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), () => {});
		expect(f.unrefd).toContain(f.armed[0]?.handle);
	});

	it("clearing twice is safe", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), () => {});
		timer.clear();
		timer.clear();
		expect(f.cleared).toHaveLength(1);
	});

	it("arm() without elapsed config arms nothing", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(defaultConfig(), () => {});
		expect(f.armed).toHaveLength(0);
	});

	it("re-arming replaces the previous timer", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(300, false), () => {});
		timer.arm(configWithElapsed(60, true), () => {});
		expect(f.armed).toHaveLength(2);
		expect(f.cleared).toContain(f.armed[0]?.handle);
	});

	it("a throwing callback never escapes the timer", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed(1, false), () => {
			throw new Error("boom");
		});
		expect(() => f.armed[0]?.callback()).not.toThrow();
	});
});
