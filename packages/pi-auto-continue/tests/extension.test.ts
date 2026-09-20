import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type EventHandler = (event: object, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const NOW = new Date(2026, 8, 2, 12, 0, 0).getTime();

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    content: [],
    stopReason: "error",
    errorMessage: "fetch failed",
    timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

class MockExtensionAPI {
  handlers = new Map<string, EventHandler[]>();
  commands = new Map<string, Command>();
  sentUserMessages: Array<{
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
    options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
  }> = [];
  sendError?: Error;

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, command: Command): void {
    this.commands.set(name, command);
  }

  sendUserMessage(...[content, options]: Parameters<ExtensionAPI["sendUserMessage"]>): void {
    if (this.sendError) throw this.sendError;
    this.sentUserMessages.push({ content, options });
  }
}

function harness(t: TestContext, config: Record<string, unknown> = {}, tui = false) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-continue-test-"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoContinue: {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      rateLimit: { baseDelayMs: 1000, maxDelayMs: 10000, jitter: false },
      ...config,
    },
  }));
  const api = new MockExtensionAPI();
  const state = { idle: true, queued: false, sessionId: "session-a" };
  const notifications: Array<{ message: string; type?: string }> = [];
  const terminalHandlers = new Set<TerminalInputHandler>();
  const abortController = new AbortController();
  // Only the context methods used by the extension are needed for these unit tests.
  // Loader/session integration tests exercise the complete, real context separately.
  const ctx = {
    mode: tui ? "tui" : "rpc",
    hasUI: true,
    model: { provider: "test", id: "test-model" },
    sessionManager: { getSessionId: () => state.sessionId },
    signal: abortController.signal,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    ui: {
      notify: (message: string, type?: string) => { notifications.push({ message, type }); },
      onTerminalInput: (handler: TerminalInputHandler) => {
        terminalHandlers.add(handler);
        return () => { terminalHandlers.delete(handler); };
      },
    },
  } as unknown as ExtensionCommandContext;
  extension(api as unknown as ExtensionAPI, settingsPath);

  const emit = async (type: string, payload: object = {}) => {
    let result: unknown;
    for (const handler of api.handlers.get(type) ?? []) result = await handler({ type, ...payload }, ctx);
    return result;
  };
  const command = async (args: string) => {
    const registered = api.commands.get("auto-continue");
    assert.ok(registered);
    await registered.handler(args, ctx);
  };
  const settle = async (message: AssistantMessage = assistant()) => {
    await emit("message_end", { message });
    state.idle = true;
    await emit("agent_settled");
  };
  const start = async (text: string, source = "interactive") => {
    const result = await emit("input", { source, text });
    if (source === "extension" && text.startsWith("<!-- auto-continue:")) {
      const prompt = text.slice(text.indexOf("\n") + 1);
      assert.deepEqual(result, { action: "transform", text: prompt });
      text = prompt;
    } else {
      assert.deepEqual(result, { action: "continue" });
    }
    await emit("before_agent_start", { prompt: text, systemPrompt: "Base." });
    state.idle = false;
    await emit("agent_start");
    await emit("turn_start");
    await emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
  };
  const acceptRetry = async () => {
    const sent = api.sentUserMessages.at(-1);
    assert.ok(sent);
    assert.equal(typeof sent.content, "string");
    await start(sent.content as string, "extension");
  };
  t.after(async () => {
    await emit("session_shutdown");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { api, state, ctx, notifications, terminalHandlers, abortController, emit, command, settle, start, acceptRetry };
}

const savedEnv = new Map<string, string | undefined>();
before(() => {
  for (const key of ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID"]) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});
after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("native-aware recovery", () => {
  it("registers lifecycle hooks and only the documented command", (t) => {
    const { api } = harness(t);
    for (const name of ["session_start", "before_provider_request", "after_provider_response", "input", "message_end", "agent_settled", "session_compact_failed"]) {
      assert.ok(api.handlers.has(name), name);
    }
    assert.deepEqual([...api.commands.keys()], ["auto-continue"]);
  });


  it("never sleeps, counts retries, or sends from message_end/agent_end", async (t) => {
    const h = harness(t);
    h.state.idle = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await h.emit("message_end", { message: assistant() });
      await h.emit("agent_end");
      t.mock.timers.tick(60000);
    }
    assert.equal(h.api.sentUserMessages.length, 0);
    assert.equal(h.notifications.length, 0);
    h.state.idle = true;
    await h.emit("agent_settled");
    assert.match(h.notifications[0].message, /attempt #1/);
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("does nothing if native retries recover before settlement", async (t) => {
    const h = harness(t);
    await h.emit("message_end", { message: assistant() });
    await h.emit("agent_start");
    await h.settle(assistant({ stopReason: "stop", errorMessage: undefined }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
    assert.equal(h.notifications.length, 0);
  });

  it("schedules exactly one fallback after native retry exhaustion", async (t) => {
    const h = harness(t);
    const message = assistant();
    await h.settle(message);
    await h.emit("agent_settled");
    await h.emit("message_end", { message });
    await h.emit("agent_settled");
    assert.equal(h.api.sentUserMessages.length, 0);
    t.mock.timers.tick(999);
    assert.equal(h.api.sentUserMessages.length, 0);
    t.mock.timers.tick(1);
    assert.equal(h.api.sentUserMessages.length, 1);
    assert.deepEqual(h.api.sentUserMessages[0].options, { deliverAs: "followUp" });
    await h.emit("agent_settled");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 1);
    assert.equal(h.notifications.some((n) => /Response completed/.test(n.message)), false);
  });

  it("defers even a zero-delay continuation outside the settlement hook", async (t) => {
    const h = harness(t, { baseDelayMs: 0 });
    await h.settle(assistant({ stopReason: "length" }));
    assert.equal(h.api.sentUserMessages.length, 0);
    t.mock.timers.tick(1);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  for (const type of ["text", "toolCall"] as const) {
    it(`continues actual truncation ending in ${type}`, async (t) => {
      const h = harness(t);
      const content: AssistantMessage["content"] = type === "text"
        ? [{ type: "text", text: "partial" }]
        : [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "file.ts" } }];
      await h.settle(assistant({ stopReason: "length", errorMessage: undefined, content }));
      t.mock.timers.tick(1000);
      assert.equal(h.api.sentUserMessages.length, 1);
      assert.match(String(h.api.sentUserMessages[0].content), type === "text" ? /Continue from where you left off/ : /Check existing tool results/);
    });
  }

  it("does not continue a normal zero-argument tool call or unknown error", async (t) => {
    const h = harness(t);
    await h.settle(assistant({ stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "status", arguments: {} }] }));
    await h.settle(assistant({ errorMessage: "Unrecognized request failure" }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("preserves the budget across continuations and only reports a healthy completion", async (t) => {
    const h = harness(t);
    await h.settle(assistant({ stopReason: "length" }));
    t.mock.timers.tick(1000);
    await h.acceptRetry();
    await h.settle(assistant());
    t.mock.timers.tick(1000);
    await h.acceptRetry();
    await h.settle(assistant({ stopReason: "stop", errorMessage: undefined }));
    assert.equal(h.api.sentUserMessages.length, 2);
    assert.ok(h.notifications.some((n) => /Response completed after 2 retry/.test(n.message)));
    await h.command("status");
    assert.match(h.notifications.at(-1)?.message ?? "", /Current retry status: Idle/);
  });

  it("enforces retry counts without resetting at each settlement", async (t) => {
    const h = harness(t, { maxRetries: 2 });
    for (const delay of [1000, 2000]) {
      await h.settle(assistant({ stopReason: "length" }));
      t.mock.timers.tick(delay);
      await h.acceptRetry();
    }
    await h.settle(assistant({ stopReason: "length" }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 2);
    assert.ok(h.notifications.some((n) => /Maximum retries limit of 2/.test(n.message)));
  });

  it("rechecks the duration deadline when a wait becomes due", async (t) => {
    const h = harness(t, { maxRetries: "500ms" });
    await h.settle(assistant({ stopReason: "length" }));
    t.mock.timers.tick(500);
    assert.equal(h.api.sentUserMessages.length, 0);
    assert.ok(h.notifications.some((n) => /Retry deadline/.test(n.message)));
  });

  it("chunks waits beyond Node's timeout range instead of sending immediately", async (t) => {
    const h = harness(t, { rateLimit: { baseDelayMs: 0, maxRetries: "40d", jitter: false } });
    await h.settle(assistant({ errorMessage: "Rate limited. Try again in 30 days." }));
    t.mock.timers.tick(2_147_483_647);
    assert.equal(h.api.sentUserMessages.length, 0);
    t.mock.timers.tick(30 * 86400000 - 2_147_483_647);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  for (const queued of [false, true]) {
    it(`does not enqueue if Pi ${queued ? "has pending messages" : "is busy"} at dispatch`, async (t) => {
      const h = harness(t);
      await h.settle();
      h.state.idle = queued;
      h.state.queued = queued;
      t.mock.timers.tick(1000);
      h.state.idle = true;
      h.state.queued = false;
      await h.emit("agent_settled");
      t.mock.timers.tick(60000);
      assert.equal(h.api.sentUserMessages.length, 0);
    });
  }

  it("stops cleanly when a synchronous send fails", async (t) => {
    const h = harness(t);
    h.api.sendError = new Error("send failed");
    await h.settle();
    t.mock.timers.tick(1000);
    assert.ok(h.notifications.some((n) => n.type === "error" && /Failed to send continuation: send failed/.test(n.message)));
    await h.command("status");
    assert.match(h.notifications.at(-1)?.message ?? "", /Current retry status: Idle/);
  });

  it("pauses an unacknowledged submission instead of silently sticking or resending", async (t) => {
    const h = harness(t);
    await h.settle();
    t.mock.timers.tick(1000);
    const text = h.api.sentUserMessages[0].content;
    t.mock.timers.tick(30000);
    await h.emit("agent_settled");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 1);
    assert.ok(h.notifications.some((n) => n.type === "warning" && /Continuation did not start within 30s/.test(n.message)));
    await h.command("status");
    assert.match(h.notifications.at(-1)?.message ?? "", /Current retry status: Idle/);
    assert.deepEqual(await h.emit("input", { source: "extension", text }), { action: "handled" });
    await h.start("Try a new task", "rpc");
    await h.settle();
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 2);
  });

  it("also times out input accepted by this extension but not started by Pi", async (t) => {
    const h = harness(t, { tokenLimit: { continuePrompt: "Continue" } });
    await h.settle(assistant({ stopReason: "length" }));
    t.mock.timers.tick(1000);
    const text = h.api.sentUserMessages[0].content;
    assert.deepEqual(await h.emit("input", { source: "extension", text }), { action: "transform", text: "Continue" });
    t.mock.timers.tick(30000);
    assert.ok(h.notifications.some((n) => /Continuation did not start within 30s/.test(n.message)));
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("clears the submission watchdog once its user message starts", async (t) => {
    const h = harness(t);
    await h.settle();
    t.mock.timers.tick(1000);
    await h.acceptRetry();
    t.mock.timers.tick(60000);
    assert.equal(h.notifications.some((n) => /did not start/.test(n.message)), false);
    await h.settle(assistant({ stopReason: "stop", errorMessage: undefined }));
    assert.ok(h.notifications.some((n) => /Response completed after 1 retry/.test(n.message)));
  });
});

describe("input and cancellation", () => {
  for (const source of ["interactive", "rpc", "extension"]) {
    it(`passes ${source} input through and cancels the pending continuation`, async (t) => {
      const h = harness(t);
      await h.settle();
      assert.deepEqual(await h.emit("input", { source, text: "Do something else" }), { action: "continue" });
      await h.emit("agent_settled");
      t.mock.timers.tick(60000);
      assert.equal(h.api.sentUserMessages.length, 0);
    });
  }

  it("does not treat a third party's matching prompt as its own while waiting", async (t) => {
    const h = harness(t, { tokenLimit: { continuePrompt: "Continue" } });
    await h.settle(assistant({ stopReason: "length" }));
    assert.deepEqual(await h.emit("input", { source: "extension", text: "Continue" }), { action: "continue" });
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("rejects only its own stale in-flight submission after cancellation", async (t) => {
    const h = harness(t);
    await h.settle();
    t.mock.timers.tick(1000);
    await h.command("off");
    const text = h.api.sentUserMessages[0].content;
    assert.deepEqual(await h.emit("input", { source: "extension", text }), { action: "handled" });
    assert.deepEqual(await h.emit("input", { source: "extension", text: "External follow-up" }), { action: "continue" });
  });

  it("never claims a third party's identical prompt while its own submission is in flight", async (t) => {
    const h = harness(t, { tokenLimit: { continuePrompt: "Continue" } });
    await h.settle(assistant({ stopReason: "length" }));
    t.mock.timers.tick(1000);
    const ownText = h.api.sentUserMessages[0].content;
    assert.deepEqual(await h.emit("input", { source: "extension", text: "Continue" }), { action: "continue" });
    assert.deepEqual(await h.emit("input", { source: "extension", text: ownText }), { action: "handled" });
    assert.deepEqual(await h.emit("input", { source: "extension", text: "Continue" }), { action: "continue" });
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("allows fresh input to start a new independent recovery budget", async (t) => {
    const h = harness(t);
    await h.settle();
    await h.start("New task", "rpc");
    await h.settle();
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
    assert.match(h.notifications.at(-1)?.message ?? "", /attempt #1/);
  });

  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "session_shutdown", "model_select"]) {
    it(`cancels waits on ${event}`, async (t) => {
      const h = harness(t);
      await h.settle();
      await h.emit(event);
      t.mock.timers.tick(60000);
      await h.emit("agent_settled");
      assert.equal(h.api.sentUserMessages.length, 0);
    });
  }

  for (const args of ["off", "reset"]) {
    it(`cancels waits on /auto-continue ${args}`, async (t) => {
      const h = harness(t);
      await h.settle();
      await h.command(args);
      t.mock.timers.tick(60000);
      assert.equal(h.api.sentUserMessages.length, 0);
    });
  }

  it("validates session and model identity again at dispatch", async (t) => {
    const h = harness(t);
    await h.settle();
    h.state.sessionId = "different-session";
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 0);
    await h.start("new task");
    await h.settle();
    assert.ok(h.ctx.model);
    h.ctx.model = { ...h.ctx.model, id: "different-model" };
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("keeps abort monitoring when Pi starts the turn before emitting the user message", async (t) => {
    const h = harness(t);
    await h.start("Start a task");
    await h.emit("message_end", { message: assistant() });
    h.abortController.abort();
    h.state.idle = true;
    await h.emit("agent_settled");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("never resurrects an aborted assistant message even with cached 429", async (t) => {
    const h = harness(t);
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 429, headers: {} });
    await h.settle(assistant({ stopReason: "aborted", errorMessage: "Request timed out." }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  for (const key of ["\x1b", "\x03", "\x1b[27u", "\x1b[99;5u"]) {
    it(`cancels a TUI wait with ${JSON.stringify(key)} without consuming the key`, async (t) => {
      const h = harness(t, {}, true);
      await h.emit("session_start");
      await h.settle();
      for (const handler of h.terminalHandlers) assert.equal(handler(key), undefined);
      t.mock.timers.tick(60000);
      assert.equal(h.api.sentUserMessages.length, 0);
      await h.emit("session_shutdown");
      assert.equal(h.terminalHandlers.size, 0);
    });
  }

  it("detaches old terminal listeners on session restart and ignores ordinary keys", async (t) => {
    const h = harness(t, {}, true);
    await h.emit("session_start");
    await h.emit("session_start");
    assert.equal(h.terminalHandlers.size, 1);
    await h.settle();
    for (const handler of h.terminalHandlers) handler("a");
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });
});

describe("HTTP correlation and compaction", () => {
  it("does not apply an old HTTP failure to a successful reply", async (t) => {
    const h = harness(t);
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 429, headers: { "retry-after": "30" } });
    await h.settle(assistant({ stopReason: "stop", errorMessage: undefined }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("clears HTTP metadata before another provider request and after a message", async (t) => {
    const h = harness(t);
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 429, headers: {} });
    await h.emit("before_provider_request");
    await h.settle(assistant({ errorMessage: "Unknown failure" }));
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 429, headers: {} });
    await h.emit("message_end", { message: assistant() });
    await h.settle(assistant({ errorMessage: "Unknown failure" }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("uses the latest response's remaining reset delay after native retries", async (t) => {
    const h = harness(t);
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 429, headers: { "retry-after": "10" } });
    await h.emit("message_end", { message: assistant() });
    t.mock.timers.tick(3000);
    await h.emit("agent_settled");
    assert.ok(h.notifications.some((n) => /Waiting 8s/.test(n.message)));
    t.mock.timers.tick(7999);
    assert.equal(h.api.sentUserMessages.length, 0);
    t.mock.timers.tick(1);
    assert.equal(h.api.sentUserMessages.length, 1);
    await h.command("status");
    assert.match(h.notifications.at(-1)?.message ?? "", /Expected token reset time: 2026-09-02 12:00:10/);
  });

  it("does not expire HTTP metadata just because tools or settlement took over 30s", async (t) => {
    const h = harness(t);
    await h.emit("turn_start");
    await h.emit("after_provider_response", { status: 503, headers: {} });
    t.mock.timers.tick(60000);
    await h.settle(assistant({ errorMessage: "Opaque provider error" }));
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("ignores summarizer HTTP responses outside an assistant turn", async (t) => {
    const h = harness(t);
    await h.emit("after_provider_response", { status: 429, headers: { "retry-after": "10" } });
    await h.settle(assistant({ errorMessage: "Opaque provider error" }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
    await h.emit("turn_start");
    await h.emit("message_end", { message: assistant({ errorMessage: "Opaque provider error" }) });
    await h.emit("turn_end");
    await h.emit("after_provider_response", { status: 503, headers: {} });
    await h.emit("agent_settled");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("leaves overflow recovery entirely to Pi compaction", async (t) => {
    const h = harness(t);
    await h.emit("message_end", { message: assistant({ errorMessage: "maximum context length exceeded" }) });
    await h.emit("session_before_compact", { reason: "overflow", willRetry: true });
    await h.emit("after_provider_response", { status: 429, headers: {} });
    await h.emit("session_compact", { reason: "overflow", willRetry: true });
    await h.emit("agent_start");
    await h.settle(assistant({ stopReason: "stop", errorMessage: undefined }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
    assert.equal(h.notifications.length, 0);
  });

  it("can continue truncation after successful threshold compaction", async (t) => {
    const h = harness(t);
    await h.emit("message_end", { message: assistant({ stopReason: "length" }) });
    await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
    await h.emit("session_compact", { reason: "threshold", willRetry: false });
    await h.emit("agent_settled");
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("stops rather than continuing when compaction fails or is cancelled", async (t) => {
    const h = harness(t);
    await h.emit("message_end", { message: assistant({ stopReason: "length" }) });
    await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
    await h.emit("session_compact_failed", { aborted: true });
    await h.emit("agent_settled");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("reports unrecovered context and fatal failures without retrying", async (t) => {
    const h = harness(t);
    await h.settle(assistant({ errorMessage: "maximum context length exceeded" }));
    await h.settle(assistant({ errorMessage: "payment required", stopReason: "error" }));
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
    assert.ok(h.notifications.some((n) => /Pi owns compaction/.test(n.message)));
    assert.ok(h.notifications.some((n) => n.type === "error" && /Non-retryable/.test(n.message)));
  });
});

describe("commands and subagent guards", () => {
  it("keeps status timestamped and reports actual configured delays", async (t) => {
    const h = harness(t);
    for (const command of ["on", "off", "reset", "status"]) await h.command(command);
    for (const notification of h.notifications) {
      assert.match(notification.message, /^\[auto-continue\] \[\d{2}:\d{2}:\d{2}\]/);
    }
    const status = h.notifications.at(-1)?.message ?? "";
    assert.match(status, /Base delay: 1s/);
    assert.match(status, /Max delay: 10s/);
    assert.match(status, /Max retries: 5h/);
    assert.match(status, /Current retry status: Idle/);
  });

  it("validates scheduled retry commands without starting work", async (t) => {
    const h = harness(t);
    await h.command("at");
    await h.command("at 25:99");
    await h.command("unknown");
    assert.match(h.notifications[0].message, /Please specify a time/);
    assert.match(h.notifications[1].message, /Invalid time format/);
    assert.match(h.notifications[2].message, /Usage:/);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("schedules a single manual retry and postpones dispatch while Pi is busy", async (t) => {
    const h = harness(t);
    await h.command("at 12:00:05");
    h.state.idle = false;
    t.mock.timers.tick(5000);
    assert.equal(h.api.sentUserMessages.length, 0);
    h.state.idle = true;
    await h.emit("agent_settled");
    assert.equal(h.api.sentUserMessages.length, 1);
    await h.emit("agent_settled");
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("polls a due manual schedule while busy even without another settlement event", async (t) => {
    const h = harness(t);
    await h.command("at 12:00:05");
    h.state.idle = false;
    t.mock.timers.tick(5000);
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 0);
    h.state.idle = true;
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("replaces a manual schedule and cancels it for fresh input", async (t) => {
    const h = harness(t);
    await h.command("at 12:00:05");
    await h.command("at 12:00:10");
    t.mock.timers.tick(5000);
    assert.equal(h.api.sentUserMessages.length, 0);
    await h.emit("input", { source: "rpc", text: "cancel" });
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  for (const key of ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID"]) {
    it(`is inactive by default when ${key} is set`, async (t) => {
      process.env[key] = "child";
      t.after(() => { delete process.env[key]; });
      const h = harness(t);
      await h.settle();
      t.mock.timers.tick(60000);
      assert.equal(h.api.sentUserMessages.length, 0);
      assert.equal(await h.emit("before_agent_start", { systemPrompt: "Base." }), undefined);
    });
  }

  it("supports an explicit subagent opt-in", async (t) => {
    process.env.PI_SUBAGENT_ID = "child";
    t.after(() => { delete process.env.PI_SUBAGENT_ID; });
    const h = harness(t, { subagent: true });
    await h.settle();
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("blocks all recovery after a successful done-tool and re-arms on fresh user input", async (t) => {
    const h = harness(t);
    await h.settle();
    await h.emit("tool_execution_end", { toolName: "subagent_done", isError: false });
    await h.settle(assistant({ stopReason: "length" }));
    await h.command("at 12:00:05");
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
    await h.command("off");
    await h.start("Keep going", "rpc");
    await h.command("on");
    await h.settle();
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });

  it("does not re-arm a done session for third-party extension input", async (t) => {
    const h = harness(t);
    await h.emit("tool_execution_end", { toolName: "subagent_done", isError: false });
    await h.start("External prompt", "extension");
    await h.settle();
    t.mock.timers.tick(60000);
    assert.equal(h.api.sentUserMessages.length, 0);
  });

  it("does not block recovery if the done-tool failed", async (t) => {
    const h = harness(t);
    await h.emit("tool_execution_end", { toolName: "subagent_done", isError: true });
    await h.settle();
    t.mock.timers.tick(1000);
    assert.equal(h.api.sentUserMessages.length, 1);
  });
});
