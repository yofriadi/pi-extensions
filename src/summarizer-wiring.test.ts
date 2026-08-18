import { describe, it, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch } from "./types.js";

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

const { summarizeBatch } = await import("./summarizer.js");
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

function drippingStream(options: TestStreamOptions | undefined, text: string, events: number, gapMs: number): TestStream {
  const signal = options?.signal;
  const sleepOrAbort = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events; i++) {
        await sleepOrAbort(gapMs);
        yield { type: "thinking_delta" };
      }
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
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

function makeBatch(): CapturedBatch {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls: [
      { toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(50), isError: false },
    ],
  };
}

describe("runSummarization wiring - host provider dispatch", () => {
  it("uses streamSimple with resolved auth and provider-neutral reasoning", async () => {
    let received: TestStreamOptions | undefined;
    streamImpl = (_model, _input, options) => {
      received = options;
      return okStream("- summary");
    };
    const notes: Note[] = [];
    const result = await summarizeBatch(
      makeBatch(),
      { ...DEFAULT_CONFIG, summarizerModel: "provider-a/primary-model", summarizerThinking: "high" },
      makeCtx(notes),
    );
    expect(result?.summaryText).toBe("- summary");
    expect(received).toMatchObject({ apiKey: "k", reasoning: "high" });
    expect(received).not.toHaveProperty("reasoningEffort");
    expect(notes).toHaveLength(0);
  });
});


const distinctConfig = { ...DEFAULT_CONFIG, summarizerModel: "provider-a/primary-model" };

describe("runSummarization wiring — same-model no-op (legacy path)", () => {
  it("summarizerModel=default: transient failure notifies error, returns null, controller untouched", async () => {
    streamImpl = () => errStream("provider overloaded");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), { ...DEFAULT_CONFIG, summarizerModel: "default" }, ctx, {
      controller,
      // "provider overloaded" is rate-limit-shaped: in-place retry applies, so
      // stub the backoff sleep (instant) to keep the legacy-path assertions fast.
      pacing: { retries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    expect(r).toBeNull();
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].msg).toContain("provider overloaded");
  });
});

describe("runSummarization wiring — enter fallback", () => {
  it("primary transient + fallback ok: returns summary, one warning, no error notify, sticky", async () => {
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("down") : okStream("- fallback summary"));
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r?.summaryText).toBe("- fallback summary");
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toContain("Primary");
    expect(warnings[0].msg).toContain("Session");
    expect(warnings[0].msg).toContain("down"); // primary's caught error is surfaced in the enter warning
    expect(errors).toHaveLength(0);
  });

  it("steady-state after enter routes to the session model only (no primary call, no notify)", async () => {
    const seen: string[] = [];
    streamImpl = (model) => {
      seen.push(model.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("- ok");
    };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController(); // real clock: cooldown (10m) will not elapse in-test
    await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // enter
    seen.length = 0;
    notes.length = 0;
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // steady-state
    expect(r?.summaryText).toBe("- ok");
    expect(seen).toEqual([SESSION.id]); // primary never called again before cooldown
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — both-down + deferred warning", () => {
  it("primary + fallback both transient: null, error notify, enters fallback with owed warning", async () => {
    streamImpl = () => errStream("everything down");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r).toBeNull();
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(0); // warning is owed, not yet fired
    expect(errors).toHaveLength(1);

    // Next flush: fallback now succeeds -> owed warning fires once.
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("still down") : okStream("- rescued"));
    notes.length = 0;
    const r2 = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r2?.summaryText).toBe("- rescued");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
  });
});

describe("runSummarization wiring — abort", () => {
  it("re-throws when the signal is already aborted", async () => {
    streamImpl = () => okStream("- never");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const ac = new AbortController();
    ac.abort();
    await expect(
      summarizeBatch(makeBatch(), distinctConfig, ctx, { controller, signal: ac.signal }),
    ).rejects.toThrow();
  });
});

describe("runSummarization wiring — timeouts", () => {
  it("idle timeout (default model): transient warning, returns null", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 20, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r).toBeNull();
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/stalled/);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("ceiling timeout (idle disabled): transient warning mentioning ceiling", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r).toBeNull();
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/ceiling/);
  });

  it("option B: primary idle-times-out, session model rescues", async () => {
    streamImpl = (model, _i, opts) => (model.id === PRIMARY.id ? hangingStream(opts) : okStream("- rescued"));
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(r?.summaryText).toBe("- rescued");
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/stalled/); // enter warning carries the primary timeout reason
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("both time out: null, both-down notice at warning severity", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(r).toBeNull();
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("pre-aborted signal is not a timeout (throws, no warning)", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const ac = new AbortController();
    ac.abort();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    await expect(summarizeBatch(makeBatch(), cfg, ctx, { signal: ac.signal })).rejects.toThrow();
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });

  it("both timeouts disabled: okStream succeeds unchanged", async () => {
    streamImpl = () => okStream("- ok");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r?.summaryText).toBe("- ok");
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — idle reset keeps a flowing stream alive", () => {
  it("does not time out while events keep arriving within the idle window", async () => {
    // 6 events, 10ms apart = 60ms total > 25ms idle window; only survives if
    // the idle timer resets on every event (bumpIdle() inside the loop).
    streamImpl = (_m, _i, opts) => drippingStream(opts, "- flowing summary", 6, 10);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 25, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r?.summaryText).toBe("- flowing summary");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });
});
