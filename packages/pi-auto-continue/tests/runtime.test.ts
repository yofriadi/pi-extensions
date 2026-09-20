import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionError,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";

const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const NOW = new Date("2026-09-02T12:00:00Z").getTime();
const RETRY_PROMPT = "Resume the interrupted task.";

type Reply = Partial<AssistantMessage> & {
  status?: number;
  headers?: Record<string, string>;
  waitForAbort?: boolean;
};

interface HarnessOptions {
  nativeRetries?: number;
  extraExtension?: string;
  compaction?: boolean;
  mode?: "tui" | "rpc";
}

async function harness(t: TestContext, replies: Reply[], options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-continue-runtime-"));
  const savedEnv = new Map<string, string | undefined>();
  for (const key of ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID"]) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    autoContinue: {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      maxRetries: 2,
      rateLimit: {
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxRetries: 2,
        jitter: false,
        retryPrompt: RETRY_PROMPT,
      },
      tokenLimit: { continuePrompt: RETRY_PROMPT },
    },
  }));

  const paths = [ENTRY];
  if (options.extraExtension) {
    const fixture = join(dir, "observer.ts");
    writeFileSync(fixture, options.extraExtension);
    paths.push(fixture);
  }
  // Exercise the installed loader, not a mocked ExtensionAPI or loader result.
  const loaded = await discoverAndLoadExtensions(paths, dir, dir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((item) => item.path === ENTRY);
  assert.ok(extension, "the published package entry must be discovered");
  assert.ok(extension.commands.has("auto-continue"));
  assert.ok(extension.handlers.has("agent_settled"));

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: options.nativeRetries ?? 1, baseDelayMs: 10 },
    compaction: { enabled: options.compaction ?? false, reserveTokens: 100, keepRecentTokens: 100 },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Test assistant.",
    extensionsOverride: () => loaded,
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const calls: Context[] = [];
  const failures: unknown[] = [];
  runtime.registerProvider("auto-continue-test", {
    api: "openai-completions",
    apiKey: "test-only-no-network",
    baseUrl: "https://example.invalid",
    models: [{
      id: "fake",
      name: "Fake model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 1000,
    }],
    streamSimple(model, context, streamOptions) {
      const stream = createAssistantMessageEventStream();
      const reply = replies[calls.length];
      calls.push(structuredClone(context));
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Completed." }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        ...reply,
      };
      void (async () => {
        try {
          assert.ok(reply, `Unexpected provider request #${calls.length}`);
          await streamOptions?.onPayload?.({ messages: context.messages }, model);
          await streamOptions?.onResponse?.({ status: reply.status ?? 200, headers: reply.headers ?? {} }, model);
          stream.push({ type: "start", partial: message });
          if (reply.waitForAbort) {
            const signal = streamOptions?.signal;
            assert.ok(signal, "active provider requests must receive Pi's abort signal");
            if (!signal.aborted) {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            message.stopReason = "aborted";
            message.errorMessage = "Operation aborted";
          }
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            assert.ok(message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "deferred");
            stream.push({ type: "done", reason: message.stopReason, message });
          }
          stream.end(message);
        } catch (error) {
          failures.push(error);
          message.stopReason = "aborted";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
  });
  const model = runtime.getModel("auto-continue-test", "fake");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
  });
  const runner = session.extensionRunner;
  assert.ok(runner);
  const notifications: string[] = [];
  const errors: ExtensionError[] = [];
  const events: AgentSessionEvent[] = [];
  const terminalHandlers = new Set<TerminalInputHandler>();
  await session.bindExtensions({
    mode: options.mode ?? "rpc",
    uiContext: {
      ...runner.getUIContext(),
      notify: (message) => { notifications.push(message); },
      onTerminalInput: (handler) => {
        terminalHandlers.add(handler);
        return () => { terminalHandlers.delete(handler); };
      },
    },
    onError: (error) => { errors.push(error); },
  });
  session.subscribe((event) => { events.push(event); });
  t.after(async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(terminalHandlers.size, 0);
    await session.abort();
    session.dispose();
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });

  // Drain actual I/O/microtasks without advancing the retry clock. No wall-clock sleeps.
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const userMessages = () => session.messages.filter((message) => message.role === "user");
  return { session, runner, calls, events, notifications, terminalHandlers, flush, tick, userMessages };
}

const transient: Reply = { stopReason: "error", errorMessage: "503 Service unavailable", content: [], status: 503 };

describe("real Pi loader and AgentSession recovery", { concurrency: false }, () => {
  it("lets native retry succeed without appending any continuation prompt", async (t) => {
    const h = await harness(t, [transient, {}]);
    const run = h.session.prompt("Start the task");
    await h.flush();
    assert.equal(h.session.isRetrying, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.userMessages().length, 1);
    assert.equal(h.notifications.length, 0);
    await h.tick(10);
    await run;
    await h.tick(1000);
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 1);
    assert.equal(h.session.pendingMessageCount, 0);
    assert.equal(h.notifications.length, 0);
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
  });

  for (const wait of ["native", "extension"] as const) {
    it(`documents Pi 0.85.1's SDK/RPC abort blind spot during the ${wait} retry wait`, async (t) => {
      const h = await harness(t, [transient, {}], { nativeRetries: wait === "native" ? 1 : 0 });
      const run = h.session.prompt("Start the task");
      await h.flush();
      assert.equal(h.session.isRetrying, wait === "native");
      assert.equal(h.runner.createContext().signal, undefined);
      assert.equal(h.terminalHandlers.size, 0);
      await h.session.abort();
      await run;
      assert.equal(h.calls.length, 1);
      if (wait === "native") {
        assert.ok(h.events.some((event) => event.type === "auto_retry_end" && event.finalError === "Retry cancelled"));
      }
      assert.equal(h.events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted"), false);

      // Characterization, not a cancellation guarantee: the native retry event
      // is SDK-only and there is no active ctx.signal during either wait.
      // Without terminal input or an explicit command, the extension cannot
      // observe session.abort() and its fallback still runs. See README.
      assert.ok(h.notifications.some((message) => /Waiting/.test(message)));
      await h.tick(100);
      await h.session.waitForIdle();
      assert.equal(h.calls.length, 2);
      assert.equal(h.userMessages().length, 2);
      assert.equal(h.session.pendingMessageCount, 0);
      await h.tick(60000);
      assert.equal(h.calls.length, 2);
    });
  }

  it("does not revive an SDK/RPC abort during an active provider request", async (t) => {
    const h = await harness(t, [{ waitForAbort: true, status: 429 }, {}]);
    const run = h.session.prompt("Start the task");
    await h.flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.session.isStreaming, true);
    const signal = h.runner.createContext().signal;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    await h.session.abort();
    await run;
    assert.equal(signal.aborted, true);
    assert.ok(h.events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted"));
    await h.tick(60000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.userMessages().length, 1);
    assert.equal(h.session.pendingMessageCount, 0);
    assert.equal(h.notifications.length, 0);

    await h.session.prompt("Start a new task", { source: "rpc" });
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 2);
  });

  for (const key of ["\x1b", "\x03"]) {
    it(`does not revive a native retry cancelled through TUI ${JSON.stringify(key)}`, async (t) => {
      const h = await harness(t, [transient, {}], { mode: "tui" });
      const run = h.session.prompt("Start the task");
      await h.flush();
      assert.equal(h.session.isRetrying, true);
      assert.equal(h.runner.createContext().signal, undefined);
      assert.equal(h.terminalHandlers.size, 1);
      // The terminal listener runs before Pi's own cancellation handler and
      // leaves the key unconsumed so Pi can abort its native wait as usual.
      for (const handler of h.terminalHandlers) assert.equal(handler(key), undefined);
      await h.session.abort();
      await run;
      await h.tick(60000);
      assert.equal(h.calls.length, 1);
      assert.equal(h.userMessages().length, 1);
      assert.equal(h.session.pendingMessageCount, 0);
      assert.equal(h.notifications.length, 0);

      await h.session.prompt("Start a new task");
      assert.equal(h.calls.length, 2);
      assert.equal(h.userMessages().length, 2);
    });
  }

  for (const command of ["off", "reset"]) {
    for (const wait of ["native", "extension"] as const) {
      it(`cancels the ${wait} retry fallback with /auto-continue ${command} before SDK/RPC abort`, async (t) => {
        const h = await harness(t, [transient], { nativeRetries: wait === "native" ? 1 : 0 });
        const run = h.session.prompt("Start the task");
        await h.flush();
        assert.equal(h.session.isRetrying, wait === "native");
        await h.session.prompt(`/auto-continue ${command}`, { source: "rpc" });
        await h.session.abort();
        await run;
        await h.tick(60000);
        assert.equal(h.calls.length, 1);
        assert.equal(h.userMessages().length, 1);
        assert.equal(h.session.pendingMessageCount, 0);
        assert.equal(h.notifications.some((message) => /Retrying request/.test(message)), false);
      });
    }
  }

  it("dispatches exactly one real follow-up after native retry exhaustion", async (t) => {
    const h = await harness(t, [transient, transient, {}]);
    const run = h.session.prompt("Start the task");
    await h.flush();
    await h.tick(9);
    assert.equal(h.calls.length, 1);
    assert.equal(h.notifications.length, 0);
    await h.tick(1);
    await run;
    assert.equal(h.session.isIdle, true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 1);
    assert.ok(h.notifications.some((message) => /Waiting.*attempt #1/.test(message)));
    await h.tick(99);
    assert.equal(h.calls.length, 2);
    await h.tick(1);
    await h.session.waitForIdle();
    assert.equal(h.calls.length, 3);
    assert.equal(h.userMessages().length, 2);
    assert.equal(h.session.pendingMessageCount, 0);
    assert.match(JSON.stringify(h.userMessages().at(-1)), /Resume the interrupted task/);
    assert.doesNotMatch(JSON.stringify(h.calls), /<!-- auto-continue:/);
    await h.tick(60000);
    assert.equal(h.calls.length, 3);
    assert.ok(h.notifications.some((message) => /Response completed after 1 retry/.test(message)));
  });

  it("processes new user input while cancelling an extension wait", async (t) => {
    const h = await harness(t, [transient, {}], { nativeRetries: 0 });
    await h.session.prompt("Start the task");
    assert.ok(h.notifications.some((message) => /Waiting/.test(message)));
    await h.session.prompt("Do this instead", { source: "rpc" });
    await h.tick(60000);
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 2);
    assert.match(JSON.stringify(h.userMessages().at(-1)), /Do this instead/);
    assert.doesNotMatch(JSON.stringify(h.calls), /Resume the interrupted task/);
  });

  it("does not consume another extension's identical continuation text", async (t) => {
    const h = await harness(t, [transient, {}], { nativeRetries: 0 });
    await h.session.prompt("Start the task");
    await h.session.sendUserMessage(RETRY_PROMPT);
    await h.tick(60000);
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 2);
    assert.match(JSON.stringify(h.userMessages().at(-1)), /Resume the interrupted task/);
  });

  it("continues truncation once and preserves the extension retry budget", async (t) => {
    const length: Reply = { stopReason: "length", content: [{ type: "text", text: "Partial answer" }] };
    const h = await harness(t, [length, length, length], { nativeRetries: 0 });
    await h.session.prompt("Start the task");
    await h.tick(100);
    assert.equal(h.calls.length, 2);
    await h.tick(200);
    assert.equal(h.calls.length, 3);
    await h.tick(60000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.userMessages().length, 3);
    assert.ok(h.notifications.some((message) => /Maximum retries limit of 2/.test(message)));
  });

  it("does not retry a successful empty reply despite a provider's cached 429", async (t) => {
    const h = await harness(t, [{ content: [], status: 429 }]);
    await h.session.prompt("Start the task");
    await h.tick(60000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.userMessages().length, 1);
    assert.equal(h.notifications.length, 0);
  });

  it("lets native overflow compaction retry without adding a resume prompt", async (t) => {
    const h = await harness(t, [
      {},
      { stopReason: "error", errorMessage: "maximum context length exceeded", content: [] },
      {},
    ], {
      compaction: true,
      extraExtension: `export default function (pi) {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "Task in progress.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
      }`,
    });
    await h.session.prompt("Earlier task. ".repeat(200));
    await h.session.prompt("Continue the task. ".repeat(200));
    await h.tick(60000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.notifications.length, 0);
    assert.equal(h.session.pendingMessageCount, 0);
    assert.ok(h.events.some((event) => event.type === "compaction_end" && event.willRetry));
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 2);
    assert.doesNotMatch(JSON.stringify(h.calls), /Resume the interrupted task/);
  });

  it("stops after cancelled native length-recovery compaction", async (t) => {
    const h = await harness(t, [{}, { stopReason: "length" }], {
      compaction: true,
      extraExtension: `export default function (pi) {
        pi.on("session_before_compact", () => ({ cancel: true }));
      }`,
    });
    await h.session.prompt("Earlier task. ".repeat(200));
    await h.session.prompt("Continue the task. ".repeat(200));
    await h.tick(60000);
    assert.equal(h.calls.length, 2);
    assert.equal(h.userMessages().length, 2);
    assert.ok(h.events.some((event) => event.type === "compaction_end" && event.aborted));
    assert.equal(h.notifications.length, 0);
  });

  it("reports an intercepted continuation without repeatedly sending more prompts", async (t) => {
    const h = await harness(t, [transient], {
      nativeRetries: 0,
      extraExtension: `export default function (pi) {
        pi.on("input", (event) => {
          if (event.source === "extension") return { action: "handled" };
        });
      }`,
    });
    await h.session.prompt("Start the task");
    await h.tick(100);
    assert.equal(h.calls.length, 1);
    await h.tick(30000);
    assert.ok(h.notifications.some((message) => /Continuation did not start within 30s/.test(message)));
    await h.tick(60000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.userMessages().length, 1);
    await h.session.prompt("/auto-continue status");
    assert.match(h.notifications.at(-1) ?? "", /Current retry status: Idle/);
  });
});
