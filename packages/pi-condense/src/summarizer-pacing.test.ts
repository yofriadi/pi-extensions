import { describe, it, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, SummarizerPacing } from "./types.js";
import { RateLimitGate, isRateLimited, parseRetryDelayMs } from "./summarizer-pacing.js";

// ── Fake provider harness (copied from src/summarizer-wiring.test.ts) ────────

interface TestModel {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
}

interface TestStreamOptions {
  apiKey?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  signal?: AbortSignal;
}

interface TestStreamResult {
  stopReason: string;
  errorMessage?: string;
  content: Array<{ type: string; text?: string }>;
  usage: typeof USAGE;
}

interface TestStream {
  [Symbol.asyncIterator](): AsyncGenerator<{ type: string }>;
  result(): Promise<TestStreamResult>;
}

type StreamImpl = (model: TestModel, input?: unknown, options?: TestStreamOptions) => TestStream;

let streamImpl: StreamImpl = () => {
  throw new Error("streamImpl not set");
};

const { summarizeBatch, summarizeBatches } = await import("./summarizer.js");
const { FallbackController } = await import("./summarizer-fallback.js");
const { DEFAULT_CONFIG } = await import("./types.js");

const PRIMARY: TestModel = { id: "primary-model", provider: "provider-a", name: "Primary", reasoning: true };
const SESSION: TestModel = { id: "session-model", provider: "provider-b", name: "Session" };

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function okStream(text: string): TestStream {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

function errStream(message: string): TestStream {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "error", errorMessage: message, content: [], usage: USAGE };
    },
  };
}

function hangingStream(options?: TestStreamOptions): TestStream {
  const signal = options?.signal;
  const untilAbort = () =>
    new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return {
    async *[Symbol.asyncIterator]() {
      await untilAbort();
    },
    async result() {
      return untilAbort();
    },
  };
}

interface Note {
  msg: string;
  level: string;
}

function makeCtx(notes: Note[], sessionModel: TestModel = SESSION, primaryModel: TestModel = PRIMARY): ExtensionContext {
  return {
    model: sessionModel,
    modelRegistry: {
      find: () => primaryModel,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
      getProviderAuth: async () => undefined,
      getProvider: () => ({
        streamSimple: (model: TestModel, input: unknown, options?: TestStreamOptions) =>
          streamImpl(model, input, options),
      }),
    },
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
  } as unknown as ExtensionContext;
}

function makeBatch(toolName: string): CapturedBatch {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls: [
      { toolCallId: `${toolName}-id`, toolName, args: {}, resultText: "x".repeat(50), isError: false },
    ],
  };
}

/** Serialized batches carry `Tool: <toolName>(` — used to tell calls apart. */
function toolNameOf(input: unknown): string {
  const text = (input as { messages?: Array<{ content?: Array<{ text?: string }> }> })?.messages?.[0]
    ?.content?.[0]?.text ?? "";
  return /Tool: (\w+)\(/.exec(text)?.[1] ?? "";
}

/** Instant sleep stub that records planned waits. */
function sleepStub(calls: number[]): SummarizerPacing["sleep"] {
  return async (ms: number) => {
    calls.push(ms);
  };
}

// ── 5.1: pacing primitives ───────────────────────────────────────────────────

describe("isRateLimited", () => {
  it("matches the provider-agnostic markers, case-insensitively", () => {
    expect(isRateLimited("Cloud Code Assist API error (429): Resource has been exhausted")).toBe(true);
    expect(isRateLimited("HTTP 429")).toBe(true);
    expect(isRateLimited("RESOURCE_EXHAUSTED: quota exceeded")).toBe(true);
    expect(isRateLimited("Rate Limit exceeded for model")).toBe(true);
    expect(isRateLimited("Too Many Requests")).toBe(true);
    expect(isRateLimited("You exceeded your current quota")).toBe(true);
    expect(isRateLimited("provider is currently Overloaded")).toBe(true);
  });

  it("matches server retry-delay phrasing", () => {
    expect(isRateLimited("Server requested 30s retry delay")).toBe(true);
    expect(isRateLimited("Error: retry in 5s")).toBe(true);
  });

  it("treats separators as whitespace and 429 as a standalone token", () => {
    expect(isRateLimited("rate_limit_exceeded")).toBe(true);
    expect(isRateLimited("rate-limit exceeded for model")).toBe(true);
    expect(isRateLimited("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isRateLimited("HTTP 429: too many requests")).toBe(true);
    expect(isRateLimited("request id abc429xyz failed")).toBe(false);
  });

  it("does not match idle-timeout, ceiling, or generic failure wording", () => {
    expect(isRateLimited("summarizer Primary stalled (no output for 20s)")).toBe(false);
    expect(isRateLimited("summarizer Primary exceeded 180s ceiling")).toBe(false);
    expect(isRateLimited("connection reset by peer")).toBe(false);
    expect(isRateLimited("weird boom")).toBe(false);
    expect(isRateLimited("")).toBe(false);
  });
});

describe("parseRetryDelayMs", () => {
  it("parses each supported phrase", () => {
    expect(parseRetryDelayMs("Server requested 30s retry delay")).toBe(30_000);
    expect(parseRetryDelayMs("Server requested 1.5s retry delay")).toBe(1500);
    expect(parseRetryDelayMs("Please retry in 5s")).toBe(5000);
    expect(parseRetryDelayMs("retry in 500ms")).toBe(500);
    expect(parseRetryDelayMs('"retryDelay": "30s"')).toBe(30_000);
    expect(parseRetryDelayMs('"retryDelay":"45s"')).toBe(45_000);
    expect(parseRetryDelayMs("quota will reset after 1h 2m 3s")).toBe(3_723_000);
    expect(parseRetryDelayMs("quota will reset after 45s")).toBe(45_000);
    expect(parseRetryDelayMs("quota will reset after 10m")).toBe(600_000);
    expect(parseRetryDelayMs("QUOTA WILL RESET AFTER 1H 2M")).toBe(3_720_000);
  });

  it("returns undefined for absent or garbled input", () => {
    expect(parseRetryDelayMs("429 too many requests")).toBeUndefined();
    expect(parseRetryDelayMs("")).toBeUndefined();
    expect(parseRetryDelayMs("retry in a bit")).toBeUndefined();
    expect(parseRetryDelayMs("quota will reset after a while")).toBeUndefined();
    expect(parseRetryDelayMs("Server requested a retry delay")).toBeUndefined();
  });
});

describe("RateLimitGate", () => {
  it("opens immediately when never penalized", async () => {
    const gate = new RateLimitGate();
    const start = Date.now();
    await gate.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("penalize only ever extends the open time", async () => {
    const gate = new RateLimitGate();
    gate.penalize(100);
    gate.penalize(50); // must not shorten the existing penalty
    const start = Date.now();
    await gate.wait();
    // Would resolve in ~50ms if the second penalize had shortened the window.
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  it("a penalize landing mid-wait extends the wait", async () => {
    const gate = new RateLimitGate();
    gate.penalize(80);
    const start = Date.now();
    const waited = gate.wait();
    await new Promise((r) => setTimeout(r, 30));
    gate.penalize(120); // extends the open time to ~t+150 while the waiter sleeps
    await waited;
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
  });

  it("abort releases a pending wait", async () => {
    const gate = new RateLimitGate();
    gate.penalize(60_000);
    const ac = new AbortController();
    const pending = gate.wait(ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow();
  });

  it("a wait on an already-aborted signal rejects even when the gate is closed", async () => {
    const gate = new RateLimitGate();
    gate.penalize(60_000);
    const ac = new AbortController();
    ac.abort();
    await expect(gate.wait(ac.signal)).rejects.toThrow();
  });
});

// ── 5.2: bounded fan-out ─────────────────────────────────────────────────────

describe("summarizeBatches worker pool", () => {
  /** Stream impl that tracks concurrency; delay can vary per call-start ordinal. */
  function trackImpl(delays: (ordinal: number) => number) {
    const state = { inFlight: 0, peak: 0, starts: 0 };
    streamImpl = () => {
      const ordinal = state.starts++;
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise((r) => setTimeout(r, delays(ordinal)));
          state.inFlight--;
          return { stopReason: "stop", content: [{ type: "text", text: `- s${ordinal}` }], usage: USAGE };
        },
      };
    };
    return state;
  }

  function batches(n: number): CapturedBatch[] {
    return Array.from({ length: n }, (_, i) => makeBatch(`tool${i}`));
  }

  it("never exceeds the configured width and summarizes everything (10 batches, width 4)", async () => {
    const state = trackImpl(() => 15);
    const notes: Note[] = [];
    const results = await summarizeBatches(
      batches(10),
      { ...DEFAULT_CONFIG, summarizerConcurrency: 4 },
      makeCtx(notes),
    );
    expect(state.peak).toBe(4); // exactly the configured width, not just bounded by it
    expect(results).toHaveLength(10);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(notes).toHaveLength(0);
  });

  it("keeps results index-aligned under out-of-order completion and reports progress by index", async () => {
    // All start together (width >= count), later-started calls finish first.
    const state = trackImpl((ordinal) => (10 - ordinal) * 10);
    const notes: Note[] = [];
    const progressIndices = new Set<number>();
    const results = await summarizeBatches(
      batches(10),
      { ...DEFAULT_CONFIG, summarizerConcurrency: 10 },
      makeCtx(notes),
      {
        onBatchTextProgress: (index, total) => {
          expect(total).toBe(10);
          progressIndices.add(index);
        },
      },
    );
    expect(state.peak).toBe(10);
    // Start order == input order, so ordinal i belongs to batch i even though
    // completion order was reversed.
    for (let i = 0; i < 10; i++) {
      expect(results[i]?.summaryText).toBe(`- s${i}`);
    }
    expect(progressIndices.size).toBe(10);
    for (let i = 0; i < 10; i++) expect(progressIndices.has(i)).toBe(true);
  });

  it("width 0 is unbounded: all 10 calls start together", async () => {
    const state = trackImpl(() => 15);
    const notes: Note[] = [];
    const results = await summarizeBatches(
      batches(10),
      { ...DEFAULT_CONFIG, summarizerConcurrency: 0 },
      makeCtx(notes),
    );
    expect(state.peak).toBe(10);
    expect(results).toHaveLength(10);
  });

  it("width greater than batch count starts one call per batch", async () => {
    const state = trackImpl(() => 15);
    const notes: Note[] = [];
    const results = await summarizeBatches(
      batches(3),
      { ...DEFAULT_CONFIG, summarizerConcurrency: 8 },
      makeCtx(notes),
    );
    expect(state.starts).toBe(3);
    expect(state.peak).toBe(3);
    expect(results).toHaveLength(3);
  });

  it("empty input returns [] without any call; single batch takes the single-batch path", async () => {
    const state = trackImpl(() => 1);
    const notes: Note[] = [];
    expect(await summarizeBatches([], { ...DEFAULT_CONFIG }, makeCtx(notes))).toEqual([]);
    expect(state.starts).toBe(0);
    const single = await summarizeBatches(batches(1), { ...DEFAULT_CONFIG }, makeCtx(notes));
    expect(single).toHaveLength(1);
    expect(single[0]?.summaryText).toBe("- s0");
  });
});

// ── 5.3: fan-out abort ───────────────────────────────────────────────────────

describe("summarizeBatches abort", () => {
  it("stops handing out queued batches, rejects with the abort error, no failure notify", async () => {
    let starts = 0;
    streamImpl = (_m, _i, opts) => {
      starts++;
      return hangingStream(opts);
    };
    const notes: Note[] = [];
    const ac = new AbortController();
    const pending = summarizeBatches(
      Array.from({ length: 5 }, (_, i) => makeBatch(`tool${i}`)),
      { ...DEFAULT_CONFIG, summarizerConcurrency: 2 },
      makeCtx(notes),
      { signal: ac.signal },
    );
    // Let the first wave start, then abort mid-fan-out.
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(starts).toBe(2); // queued batches never started
    expect(notes.filter((n) => n.msg.includes("summarization failed"))).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });
});

// ── 5.4: in-place rate-limit retry ───────────────────────────────────────────

describe("runOnce rate-limit retry", () => {
  const RL = "Cloud Code Assist API error (429): Resource has been exhausted";

  it("429 then success: returns the summary, no notify, no fallback call", async () => {
    const seen: string[] = [];
    let primaryCalls = 0;
    streamImpl = (model) => {
      seen.push(model.id);
      if (model.id === PRIMARY.id) {
        primaryCalls++;
        return primaryCalls === 1 ? errStream(RL) : okStream("- retried ok");
      }
      return okStream("- fallback");
    };
    const notes: Note[] = [];
    const controller = new FallbackController();
    const sleeps: number[] = [];
    const result = await summarizeBatch(
      makeBatch("toolA"),
      { ...DEFAULT_CONFIG, summarizerModel: "provider-a/primary-model" },
      makeCtx(notes),
      { controller, pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub(sleeps) } },
    );
    expect(result?.summaryText).toBe("- retried ok");
    expect(seen).toEqual([PRIMARY.id, PRIMARY.id]); // same model, session model never called
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(0);
    expect(sleeps).toHaveLength(1);
  });

  it("all attempts rate-limited: null + today's single error notify", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return errStream(RL);
    };
    const notes: Note[] = [];
    const sleeps: number[] = [];
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub(sleeps) },
    });
    expect(result).toBeNull();
    expect(calls).toBe(3); // 1 + 2 retries
    expect(sleeps).toHaveLength(2);
    const errors = notes.filter((n) => n.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain("Resource has been exhausted");
  });

  it("server delay above the per-wait cap returns immediately without sleeping", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return errStream("Cloud Code Assist API error (429): Server requested 300s retry delay");
    };
    const notes: Note[] = [];
    const sleeps: number[] = [];
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 2, baseDelayMs: 1, maxWaitMs: 1000, sleep: sleepStub(sleeps) },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1); // no retry started
    expect(sleeps).toHaveLength(0);
  });

  it("summarizerMaxTimeoutMs budget stops a further retry", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return errStream(RL);
    };
    const notes: Note[] = [];
    const sleeps: number[] = [];
    const result = await summarizeBatch(
      makeBatch("toolA"),
      { ...DEFAULT_CONFIG, summarizerMaxTimeoutMs: 1000 },
      makeCtx(notes),
      { pacing: { retries: 3, baseDelayMs: 2000, sleep: sleepStub(sleeps), now: () => 0 } },
    );
    expect(result).toBeNull();
    expect(calls).toBe(1); // planned 2000ms wait would exceed the 1000ms ceiling
    expect(sleeps).toHaveLength(0);
  });

  it("idle timeout gets exactly one attempt (never retried)", async () => {
    let calls = 0;
    streamImpl = (_m, _i, opts) => {
      calls++;
      return hangingStream(opts);
    };
    const notes: Note[] = [];
    const sleeps: number[] = [];
    const result = await summarizeBatch(
      makeBatch("toolA"),
      { ...DEFAULT_CONFIG, summarizerIdleTimeoutMs: 20, summarizerMaxTimeoutMs: 0 },
      makeCtx(notes),
      { pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub(sleeps) } },
    );
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(notes.filter((n) => n.level === "warning" && n.msg.includes("stalled"))).toHaveLength(1);
  });

  it("unrecognized errors get exactly one attempt", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return errStream("weird boom");
    };
    const notes: Note[] = [];
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub([]) },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("auth failure is not retried", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return okStream("- never");
    };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    (ctx.modelRegistry as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders = async () => ({
      ok: false,
      error: "no api key",
    });
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, ctx, {
      pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub([]) },
    });
    expect(result).toBeNull();
    expect(calls).toBe(0); // auth fails pre-stream
    expect(notes.filter((n) => n.level === "error")).toHaveLength(1);
  });

  it("unusable summary is not retried", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return okStream("   ");
    };
    const notes: Note[] = [];
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 2, baseDelayMs: 1, sleep: sleepStub([]) },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(notes).toHaveLength(0);
  });
});

// ── 5.5: shared gate per fan-out ─────────────────────────────────────────────

describe("rate-limit gate across a fan-out", () => {
  it("one rate-limited call defers the pool-mate's next attempt until the gate opens", async () => {
    // toolA: first attempt 429 with a server-requested 150ms delay, then ok.
    // toolB: first attempt plain 429 (exponential 50ms), then ok.
    // Without the shared gate toolB's second attempt would fire at ~50ms; the
    // gate (extended to 150ms by toolA) must defer it to ~150ms.
    const starts: Record<string, number[]> = { toolA: [], toolB: [] };
    let xStart = 0;
    streamImpl = (_m, input) => {
      const name = toolNameOf(input);
      starts[name].push(Date.now() - xStart);
      if (name === "toolA") {
        return starts.toolA.length === 1
          ? errStream("Cloud Code Assist API error (429): retry in 150ms")
          : okStream("- a");
      }
      return starts.toolB.length === 1 ? errStream("HTTP 429 too many requests") : okStream("- b");
    };
    const notes: Note[] = [];
    xStart = Date.now();
    const results = await summarizeBatches(
      [makeBatch("toolA"), makeBatch("toolB")],
      { ...DEFAULT_CONFIG },
      makeCtx(notes),
      { pacing: { retries: 1, baseDelayMs: 50 } },
    );
    expect(results.map((r) => r?.summaryText)).toEqual(["- a", "- b"]);
    expect(starts.toolA).toHaveLength(2);
    expect(starts.toolB).toHaveLength(2);
    // toolB's retry lands at ~150ms (gate), not ~50ms (its own backoff).
    expect(starts.toolB[1]).toBeGreaterThanOrEqual(120);
    expect(notes).toHaveLength(0);
  });

  it("a separate fan-out does not inherit a closed gate", async () => {
    // Fan-out X closes its gate for 150ms; fan-out Y (started while X's gate
    // is still closed) must begin with an open gate and finish fast.
    let xStart = 0;
    const xStarts: number[] = [];
    streamImpl = (_m, input) => {
      const name = toolNameOf(input);
      if (name === "toolX") {
        xStarts.push(Date.now() - xStart);
        return xStarts.length === 1 ? errStream("HTTP 429: retry in 150ms") : okStream("- x");
      }
      return okStream("- y");
    };
    const notes: Note[] = [];
    xStart = Date.now();
    const x = summarizeBatches([makeBatch("toolX")], { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 1, baseDelayMs: 50 },
    });
    // Start Y ~20ms in, while X's gate is firmly closed.
    await new Promise((r) => setTimeout(r, 20));
    const yStart = Date.now();
    const y = await summarizeBatches([makeBatch("toolY")], { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 1, baseDelayMs: 50 },
    });
    const yElapsed = Date.now() - yStart;
    await x;
    expect(y[0]?.summaryText).toBe("- y");
    expect(yElapsed).toBeLessThan(120); // not parked behind X's 150ms gate
  });
});

// ── Review regression tests ──────────────────────────────────────────────────

describe("runOnce retry — review regressions", () => {
  it("a final failed attempt still penalizes the gate before giving up", async () => {
    // retries: 0 — the first (and only) failure must still stamp the shared
    // gate so pool-mates don't unpark into the wall that just 429'd.
    const gate = new RateLimitGate();
    streamImpl = () => errStream("HTTP 429 too many requests");
    const notes: Note[] = [];
    const results = await summarizeBatches(
      [makeBatch("toolA"), makeBatch("toolB")],
      { ...DEFAULT_CONFIG },
      makeCtx(notes),
      { pacing: { retries: 0, baseDelayMs: 80, gate } },
    );
    expect(results).toEqual([null, null]);
    const start = Date.now();
    await gate.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("a gate extension past the ceiling stops a pool-mate's retry", async () => {
    // toolA's server-requested 200ms delay exceeds its own ceiling budget
    // (150ms) but still closes the gate; toolB's own 10ms backoff fits, yet
    // the gate carries it past the ceiling — its retry must not start.
    const calls: Record<string, number> = { toolA: 0, toolB: 0 };
    streamImpl = (_m, input) => {
      const name = toolNameOf(input);
      calls[name]++;
      return name === "toolA"
        ? errStream("HTTP 429: retry in 200ms")
        : errStream("HTTP 429 too many requests");
    };
    const notes: Note[] = [];
    const start = Date.now();
    const results = await summarizeBatches(
      [makeBatch("toolA"), makeBatch("toolB")],
      { ...DEFAULT_CONFIG, summarizerMaxTimeoutMs: 150 },
      makeCtx(notes),
      { pacing: { retries: 1, baseDelayMs: 10 } },
    );
    const elapsed = Date.now() - start;
    expect(results).toEqual([null, null]);
    expect(calls).toEqual({ toolA: 1, toolB: 1 }); // no second attempt for either
    expect(elapsed).toBeGreaterThanOrEqual(150); // toolB really waited out the gate
  });

  it("a backoff wait longer than the idle timeout is not counted as a stall", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return calls === 1 ? errStream("HTTP 429 too many requests") : okStream("- waited ok");
    };
    const notes: Note[] = [];
    const result = await summarizeBatch(
      makeBatch("toolA"),
      { ...DEFAULT_CONFIG, summarizerIdleTimeoutMs: 20, summarizerMaxTimeoutMs: 0 },
      makeCtx(notes),
      { pacing: { retries: 1, baseDelayMs: 60 } }, // real 60ms wait > 20ms idle window
    );
    expect(result?.summaryText).toBe("- waited ok");
    expect(calls).toBe(2);
    expect(notes).toHaveLength(0); // no stall warning, no error
  });

  it("a thrown rate-limit error (not stopReason: error) is retried too", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      if (calls > 1) return okStream("- thrown ok");
      return {
        async *[Symbol.asyncIterator]() {
          throw new Error("HTTP 429 Too Many Requests");
        },
        async result() {
          throw new Error("HTTP 429 Too Many Requests");
        },
      };
    };
    const notes: Note[] = [];
    const result = await summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx(notes), {
      pacing: { retries: 1, baseDelayMs: 1, sleep: sleepStub([]) },
    });
    expect(result?.summaryText).toBe("- thrown ok");
    expect(calls).toBe(2);
    expect(notes).toHaveLength(0);
  });

  it("abort during the backoff wait propagates without retrying", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return errStream("HTTP 429 too many requests");
    };
    const ac = new AbortController();
    const pending = summarizeBatch(makeBatch("toolA"), { ...DEFAULT_CONFIG }, makeCtx([]), {
      signal: ac.signal,
      pacing: { retries: 2, baseDelayMs: 5000 }, // real sleep, aborted mid-wait
    });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
