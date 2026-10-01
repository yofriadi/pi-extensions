/**
 * Trigger unit tests: random pick, turn milestones, quota matching with
 * dedupe window, per-turn error dedupe, elapsed timer lifecycle, settle-run
 * outcome latch and outcome-specific settle file lists. Covers every
 * scenario in specs/event-sound-triggers/spec.md.
 */

import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type EventTriggerName, type SoundConfig } from "../src/config";
import {
	ElapsedTimer,
	type OutcomeMessage,
	pick,
	QuotaDetector,
	SettleOutcome,
	settleFiles,
	TurnErrorDedupe,
	turnSpecFires,
} from "../src/triggers";

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

describe("turn trigger blocks", () => {
	it("periodic every fires when turnIndex > 0 and divisible", () => {
		const spec = { every: 100, files: [] };
		expect(turnSpecFires(100, spec)).toBe(true);
		expect(turnSpecFires(200, spec)).toBe(true);
	});

	it("periodic every does not fire mid-interval, on turn zero, or for a non-positive interval", () => {
		expect(turnSpecFires(37, { every: 100, files: [] })).toBe(false);
		expect(turnSpecFires(99, { every: 100, files: [] })).toBe(false);
		expect(turnSpecFires(0, { every: 100, files: [] })).toBe(false);
		expect(turnSpecFires(100, { every: 0, files: [] })).toBe(false);
	});

	it("scalar at fires exactly once at that turn", () => {
		expect(turnSpecFires(25, { at: 25, files: [] })).toBe(true);
		expect(turnSpecFires(26, { at: 25, files: [] })).toBe(false);
		expect(turnSpecFires(0, { at: 25, files: [] })).toBe(false);
	});

	it("at list fires exactly at listed turns", () => {
		const spec = { at: [25, 50, 100], files: [] };
		expect(turnSpecFires(25, spec)).toBe(true);
		expect(turnSpecFires(50, spec)).toBe(true);
		expect(turnSpecFires(100, spec)).toBe(true);
		expect(turnSpecFires(37, spec)).toBe(false);
		expect(turnSpecFires(75, spec)).toBe(false);
		// 125 is a multiple of 25 — `at` is exact-match, not modulo.
		expect(turnSpecFires(125, spec)).toBe(false);
		expect(turnSpecFires(0, spec)).toBe(false);
	});

	it("an empty at list never fires", () => {
		expect(turnSpecFires(25, { at: [], files: [] })).toBe(false);
	});

	it("a block may combine every and at — either condition fires it", () => {
		const spec = { every: 25, at: 100, files: [] };
		expect(turnSpecFires(25, spec)).toBe(true);
		expect(turnSpecFires(50, spec)).toBe(true);
		expect(turnSpecFires(75, spec)).toBe(true);
		expect(turnSpecFires(100, spec)).toBe(true);
		expect(turnSpecFires(60, spec)).toBe(false);
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
	function configWithElapsed(seconds: number | number[], repeat: boolean): SoundConfig {
		return { ...defaultConfig(), elapsed: [{ seconds, repeat, files: ["tick.wav"] }] };
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

	it("arms one one-shot timeout per listed value", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed([300, 1000], false), () => {});
		expect(f.armed).toHaveLength(2);
		expect(f.armed.map((t) => t.kind)).toEqual(["timeout", "timeout"]);
		expect(f.armed.map((t) => t.ms)).toEqual([300_000, 1_000_000]);
		expect(f.unrefd).toHaveLength(2);
	});

	it("a seconds list fires once at each mark", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed([300, 1000], false), onFire);
		f.armed[0]?.callback();
		f.armed[1]?.callback();
		expect(onFire).toHaveBeenCalledTimes(2);
	});

	it("arms one timer per block and passes the fired block to the callback", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(
			{
				...defaultConfig(),
				elapsed: [
					{ seconds: 300, repeat: false, files: ["first.wav"] },
					{ seconds: 1000, repeat: true, files: ["second.wav"] },
				],
			},
			onFire,
		);
		expect(f.armed).toHaveLength(2);
		expect(f.armed[0]?.kind).toBe("timeout");
		expect(f.armed[1]?.kind).toBe("interval");
		f.armed[0]?.callback();
		f.armed[1]?.callback();
		expect(onFire).toHaveBeenCalledTimes(2);
		expect(onFire.mock.calls[0]?.[0]?.files).toEqual(["first.wav"]);
		expect(onFire.mock.calls[1]?.[0]?.files).toEqual(["second.wav"]);
	});

	it("clear() clears handles of every block, mixing one-shot and repeating kinds", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(
			{
				...defaultConfig(),
				elapsed: [
					{ seconds: 300, repeat: false, files: ["a.wav"] },
					{ seconds: 60, repeat: true, files: ["b.wav"] },
				],
			},
			() => {},
		);
		timer.clear();
		expect(f.cleared).toEqual(f.armed.map((t) => t.handle));
	});

	it("a repeating list arms one interval per value", () => {
		const f = fakeTimers();
		const onFire = vi.fn();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed([300, 1000], true), onFire);
		expect(f.armed).toHaveLength(2);
		expect(f.armed.every((t) => t.kind === "interval")).toBe(true);
		f.armed[0]?.callback();
		f.armed[0]?.callback();
		f.armed[1]?.callback();
		expect(onFire).toHaveBeenCalledTimes(3);
	});

	it("clear() clears every handle of an armed list", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed([300, 1000], true), () => {});
		timer.clear();
		expect(f.cleared).toEqual(f.armed.map((t) => t.handle));
	});

	it("a fired one-shot of a list is dropped, remaining handles still clear", () => {
		const f = fakeTimers();
		const timer = new ElapsedTimer(f.timers);
		timer.arm(configWithElapsed([300, 1000], false), () => {});
		f.armed[0]?.callback();
		timer.clear();
		expect(f.cleared).toEqual([f.armed[1]?.handle]);
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

describe("settle-run outcome latch", () => {
	const msg = (role: string, stopReason?: string): OutcomeMessage => ({ role, stopReason });

	it("error stopReason → failed", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "error")]);
		expect(latch.take()).toBe("failed");
	});

	it("aborted stopReason → aborted (not failed)", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "aborted")]);
		expect(latch.take()).toBe("aborted");
	});

	it("length stopReason → settled", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "length")]);
		expect(latch.take()).toBe("settled");
	});

	it("any other stopReason → settled", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "stop")]);
		expect(latch.take()).toBe("settled");
		latch.noteAgentEnd([msg("assistant", undefined)]);
		expect(latch.take()).toBe("settled");
	});

	it("last assistant message wins when earlier messages errored", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("user"), msg("assistant", "error"), msg("user"), msg("assistant", "stop")]);
		expect(latch.take()).toBe("settled");
	});

	it("no assistant message leaves unknown", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("user", "error")]);
		expect(latch.take()).toBe("unknown");
	});

	it("empty message array leaves unknown", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([]);
		expect(latch.take()).toBe("unknown");
	});

	it("take() clears the outcome back to unknown", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "error")]);
		expect(latch.take()).toBe("failed");
		expect(latch.take()).toBe("unknown");
	});

	it("reset() re-arms to unknown", () => {
		const latch = new SettleOutcome();
		latch.noteAgentEnd([msg("assistant", "error")]);
		latch.reset();
		expect(latch.take()).toBe("unknown");
	});

	it("classifies on stopReason only, never errorMessage text", () => {
		// An error-message text that would match quota patterns must not
		// influence classification: latch reads stopReason only.
		const latch = new SettleOutcome();
		latch.noteAgentEnd([{ role: "assistant", stopReason: "stop", errorMessage: "429 quota" }]);
		expect(latch.take()).toBe("settled");
	});
});

describe("outcome-specific settle sounds", () => {
	function configWith(events: Partial<Record<EventTriggerName, string[]>>): SoundConfig {
		return { ...defaultConfig(), events: { ...defaultConfig().events, ...events } };
	}

	it("failed → agentFailed when configured, else error (D4)", () => {
		expect(settleFiles(configWith({ agentFailed: ["fail.wav"], error: ["err.wav"] }), "failed")).toEqual([
			"fail.wav",
		]);
		expect(settleFiles(configWith({ error: ["err.wav"] }), "failed")).toEqual(["err.wav"]);
	});

	it("aborted → agentAborted with no fallback (D6)", () => {
		expect(settleFiles(configWith({ agentAborted: ["abort.wav"], error: ["err.wav"] }), "aborted")).toEqual([
			"abort.wav",
		]);
		expect(settleFiles(configWith({ error: ["err.wav"] }), "aborted")).toEqual([]);
	});

	it("settled → agentSettled", () => {
		expect(settleFiles(configWith({ agentSettled: ["ok.wav"] }), "settled")).toEqual(["ok.wav"]);
	});

	it("unknown degrades to the success list (settled)", () => {
		expect(settleFiles(configWith({ agentSettled: ["ok.wav"] }), "unknown")).toEqual(["ok.wav"]);
	});
});
