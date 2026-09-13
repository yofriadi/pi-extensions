import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../src/index.ts";

type EventHandler = (event: any, ctx: any) => Promise<any> | any;

class MockExtensionAPI {
  public handlers: Map<string, EventHandler[]> = new Map();
  public commands: Map<string, any> = new Map();
  public sentUserMessages: Array<{ content: any; options?: any }> = [];

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, command: any): void {
    this.commands.set(name, command);
  }

  sendUserMessage(content: any, options?: any): void {
    this.sentUserMessages.push({ content, options });
  }

  async emit(event: string, payload: any, ctx: any): Promise<any> {
    const list = this.handlers.get(event) || [];
    let lastResult: any;
    for (const h of list) {
      lastResult = await h(payload, ctx);
    }
    return lastResult;
  }
}

class MockContext {
  public notifications: Array<{ message: string; type?: string }> = [];
  public hasUI = true;
  public ui = {
    notify: (message: string, type?: string) => {
      this.notifications.push({ message, type });
    },
  };
  isIdle() {
    return true;
  }
}

describe("pi-auto-continue extension", () => {
  let tmpDir: string;
  let testSettingsPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
    testSettingsPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      testSettingsPath,
      JSON.stringify({
        autoContinue: {
          enabled: true,
          baseDelayMs: 20,
          rateLimit: {
            baseDelayMs: 20,
          },
        },
      })
    );
  });

  after(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers event listeners and slash commands", () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    assert.ok(pi.handlers.has("session_start"));
    assert.ok(pi.handlers.has("after_provider_response"));
    assert.ok(pi.handlers.has("input"));
    assert.ok(pi.handlers.has("before_agent_start"));
    assert.ok(pi.handlers.has("message_end"));
    assert.ok(pi.handlers.has("agent_settled"));

    assert.ok(pi.commands.has("auto-continue"));
    assert.equal(pi.commands.has("auto-resume"), false);
  });

  it("adds guidance to system prompt in before_agent_start", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const result = await pi.emit(
      "before_agent_start",
      { systemPrompt: "Base prompt." },
      ctx
    );

    assert.ok(result?.systemPrompt?.includes("Auto-Continue Behavior"));
    assert.ok(result?.systemPrompt?.includes("Base prompt."));
  });

  it("handles token limit truncation with auto-continuation message", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Trigger message_end with stopReason: length
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Partially completed code..." }],
          timestamp: 1000,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 1);
    assert.ok(
      typeof pi.sentUserMessages[0].content === "string" &&
        pi.sentUserMessages[0].content.includes("Continue from where you left off")
    );
    assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp");
    assert.equal(pi.sentUserMessages[0].options?.streamingBehavior, "followUp");

    assert.ok(ctx.notifications.some((n) => n.message.includes("Response truncated")));
  });

  it("handles rate limit errors with warning notification and retry message", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Rate limit reached (429): Please try again in 0.05 seconds.",
          timestamp: 2000,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 1);
    assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp");
    assert.equal(pi.sentUserMessages[0].options?.streamingBehavior, "followUp");
    assert.ok(
      typeof pi.sentUserMessages[0].content === "string" &&
        pi.sentUserMessages[0].content.includes("rate/quota limit")
    );

    // Verify informational messages in UI
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Rate limit / quota error detected") && n.type === "warning"
      )
    );
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Retrying request") && n.type === "info"
      )
    );

    // Settling after recovery triggers success notification
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Successfully recovered from rate limit") && n.type === "info"
      )
    );
  });

  it("drops third-party extension messages and notifies UI when in retrying state", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Trigger a rate limit to enter retrying state
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "HTTP 429: Too Many Requests",
          timestamp: 3000,
        },
      },
      ctx
    );

    // External extension attempts to send a message during retrying
    const extInputResult = await pi.emit(
      "input",
      {
        type: "input",
        source: "extension",
        text: "Plan mode requires a TODO list before finishing the turn.",
      },
      ctx
    );

    // Message should be cleanly handled (suppressed)
    assert.deepEqual(extInputResult, { action: "handled" });

    // Warning notification should be visible in UI
    assert.ok(
      ctx.notifications.some(
        (n) =>
          n.type === "warning" &&
          n.message.includes("Dropped extension message while waiting for retry/continuation") &&
          n.message.includes("Plan mode requires a TODO list")
      )
    );

    // Auto-continue's own retry message should pass through
    const ownInputResult = await pi.emit(
      "input",
      {
        type: "input",
        source: "extension",
        text: "The previous request encountered a rate/quota limit. Please continue with your task.",
      },
      ctx
    );
    assert.deepEqual(ownInputResult, { action: "continue" });
  });

  it("allows interactive user input to cancel active retry loop", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Trigger rate limit
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Rate limit exceeded (429)",
          timestamp: 4000,
        },
      },
      ctx
    );

    // User types interactive message
    const userInputResult = await pi.emit(
      "input",
      {
        type: "input",
        source: "interactive",
        text: "Forget that, help me with a new task instead",
      },
      ctx
    );

    assert.deepEqual(userInputResult, { action: "continue" });
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("User input received: cancelling active retry/continuation loop")
      )
    );

    // Subsequent extension message now passes because retry loop was cancelled
    const extResult = await pi.emit(
      "input",
      {
        type: "input",
        source: "extension",
        text: "Normal extension message",
      },
      ctx
    );
    assert.deepEqual(extResult, { action: "continue" });
  });

  it("handles /auto-continue status command", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");
    assert.ok(cmd);

    await cmd.handler("status", ctx);

    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Auto-Continue Status:") && n.message.includes("Max retries:")
      )
    );
  });

  it("includes timestamp [HH:MM:SS] in all UI notifications", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");
    await cmd.handler("enable", ctx);
    await cmd.handler("disable", ctx);
    await cmd.handler("reset", ctx);

    assert.equal(ctx.notifications.length, 3);
    const timeRegex = /^\[auto-continue\] \[\d{2}:\d{2}:\d{2}\]/;
    for (const notif of ctx.notifications) {
      assert.ok(
        timeRegex.test(notif.message),
        `Notification "${notif.message}" should match [auto-continue] [HH:MM:SS]`
      );
    }
  });

  it("formats /auto-continue status response with global retry parameters and removes token limit section", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");
    await cmd.handler("status", ctx);

    assert.equal(ctx.notifications.length, 1);
    const msg = ctx.notifications[0].message;

    assert.ok(msg.includes("Auto-Continue Status:"));
    assert.ok(msg.includes("Global:"));
    assert.ok(msg.includes("Base delay / Max delay:"));
    assert.ok(msg.includes("Max retries:"));
    assert.ok(msg.includes("Backoff multiplier:"));
    assert.ok(msg.includes("Rate Limit Settings & Status:"));
    assert.ok(msg.includes("Base delay: 20ms"));
    assert.ok(msg.includes("Max delay: 10m"));
    assert.ok(msg.includes("Max retries: 5h"));
    assert.equal(msg.includes("20ms (uses global)"), false);
    assert.equal(msg.includes("Token Limit Settings & Status:"), false);
    // When idle and no Retry-After header received, expected token reset time is omitted
    assert.equal(msg.includes("Expected token reset time:"), false);
  });

  it("displays custom rateLimit.baseDelayMs in /auto-continue status", async () => {
    const customTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-custom-"));
    const customSettings = path.join(customTmp, "settings.json");
    fs.writeFileSync(
      customSettings,
      JSON.stringify({
        autoContinue: {
          enabled: true,
          baseDelayMs: "5s",
          rateLimit: {
            baseDelayMs: "15s",
          },
        },
      })
    );

    try {
      const pi = new MockExtensionAPI();
      extension(pi as any, customSettings);

      const ctx = new MockContext();
      const cmd = pi.commands.get("auto-continue");
      await cmd.handler("status", ctx);

      assert.equal(ctx.notifications.length, 1);
      const msg = ctx.notifications[0].message;
      assert.ok(msg.includes("Base delay: 15s"));
      assert.equal(msg.includes("15s (uses global)"), false);
    } finally {
      fs.rmSync(customTmp, { recursive: true, force: true });
    }
  });

  it("displays default 1m rateLimit.baseDelayMs in /auto-continue status when unspecified", async () => {
    const defaultTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-default-"));
    const defaultSettings = path.join(defaultTmp, "settings.json");
    fs.writeFileSync(
      defaultSettings,
      JSON.stringify({
        autoContinue: {
          enabled: true,
          baseDelayMs: "5s",
        },
      })
    );

    try {
      const pi = new MockExtensionAPI();
      extension(pi as any, defaultSettings);

      const ctx = new MockContext();
      const cmd = pi.commands.get("auto-continue");
      await cmd.handler("status", ctx);

      assert.equal(ctx.notifications.length, 1);
      const msg = ctx.notifications[0].message;
      assert.ok(msg.includes("Base delay: 1m"));
      assert.ok(msg.includes("Max delay: 10m"));
      assert.ok(msg.includes("Max retries: 5h"));
      assert.equal(msg.includes("1m (uses global)"), false);
    } finally {
      fs.rmSync(defaultTmp, { recursive: true, force: true });
    }
  });

  it("displays custom rateLimit.maxDelayMs and rateLimit.maxRetries in /auto-continue status", async () => {
    const customTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-custom-limits-"));
    const customSettings = path.join(customTmp, "settings.json");
    fs.writeFileSync(
      customSettings,
      JSON.stringify({
        autoContinue: {
          enabled: true,
          rateLimit: {
            maxDelayMs: "2m",
            maxRetries: 10,
          },
        },
      })
    );

    try {
      const pi = new MockExtensionAPI();
      extension(pi as any, customSettings);

      const ctx = new MockContext();
      const cmd = pi.commands.get("auto-continue");
      await cmd.handler("status", ctx);

      assert.equal(ctx.notifications.length, 1);
      const msg = ctx.notifications[0].message;
      assert.ok(msg.includes("Max delay: 2m"));
      assert.ok(msg.includes("Max retries: 10"));
    } finally {
      fs.rmSync(customTmp, { recursive: true, force: true });
    }
  });

  it("prints expected token reset time in YYYY-MM-DD HH:MM:SS format when Retry-After header is received", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Provider sends 429 with retry-after header (20ms delay for fast test execution)
    await pi.emit(
      "after_provider_response",
      {
        status: 429,
        headers: { "retry-after": "0.02" },
      },
      ctx
    );

    // Message ends with rate limit error
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "HTTP 429 Too Many Requests",
          timestamp: 5000,
        },
      },
      ctx
    );

    // 1. Notification should contain Expected token reset time in YYYY-MM-DD HH:MM:SS format
    const warningNotif = ctx.notifications.find((n) =>
      n.message.includes("Rate limit / quota error detected")
    );
    assert.ok(warningNotif, "Warning notification should be emitted");
    assert.ok(
      warningNotif.message.includes("Expected token reset time:"),
      "Should include expected token reset time label"
    );
    const dateRegex = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
    assert.ok(
      dateRegex.test(warningNotif.message),
      `Expected date format YYYY-MM-DD HH:MM:SS in notification: ${warningNotif.message}`
    );

    // 2. Status command should also display the expected token reset time in YYYY-MM-DD HH:MM:SS format
    const cmd = pi.commands.get("auto-continue");
    await cmd.handler("status", ctx);

    const statusNotif = ctx.notifications.find((n) =>
      n.message.includes("Auto-Continue Status:")
    );
    assert.ok(statusNotif, "Status notification should be emitted");
    assert.ok(
      statusNotif.message.includes("Expected token reset time:"),
      "Status should print expected token reset time"
    );
    assert.ok(
      dateRegex.test(statusNotif.message),
      `Expected date format YYYY-MM-DD HH:MM:SS in status: ${statusNotif.message}`
    );
  });

  it("handles consecutive token continuations and notifies completion on settle", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Continuation 1: attempt #1
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Part 1..." }],
          timestamp: 10000,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 1);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("attempt #1") && n.message.includes("Response truncated")
      )
    );

    // Continuation 2: attempt #2
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Part 2..." }],
          timestamp: 10001,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 2);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("attempt #2") && n.message.includes("Response truncated")
      )
    );

    // Settle -> completion notice with attempt count 2
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(
      ctx.notifications.some(
        (n) =>
          n.message.includes("Successfully completed response after 2 continuation attempt(s)") &&
          n.type === "info"
      )
    );
  });

  it("consolidates attempt counter across token truncation followed by rate limit retry", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();

    // Attempt 1: Token limit truncation
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Partially emitted code..." }],
          timestamp: 20000,
        },
      },
      ctx
    );
    assert.equal(pi.sentUserMessages.length, 1);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("attempt #1") && n.message.includes("Response truncated")
      )
    );

    // Attempt 2: Rate limit error when agent continues
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Rate limit reached (429)",
          timestamp: 20001,
        },
      },
      ctx
    );
    assert.equal(pi.sentUserMessages.length, 2);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("attempt #2") && n.message.includes("Rate limit / quota error")
      )
    );

    // Settle -> recovery notice with attempt count 2
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(
      ctx.notifications.some(
        (n) =>
          n.message.includes("Successfully recovered from rate limit after 2 retry attempt(s)") &&
          n.type === "info"
      )
    );
  });

  it("handles /auto-continue at <HH:MM> command and prints retry notice", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");
    assert.ok(cmd, "auto-continue command should be registered");

    // Target 1 hour in the future
    const d = new Date(Date.now() + 3600000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const timeStr = `${hh}:${mm}`;

    await cmd.handler(`at ${timeStr}`, ctx);

    // Should emit retry notice: "Waiting XXs before retry (attempt #1, elapsed: 0s / max: 5h)..."
    const retryNotif = ctx.notifications.find((n) =>
      n.message.includes("before retry (attempt #1, elapsed: 0s / max: 5h")
    );
    assert.ok(retryNotif, "Retry notification should be emitted");
    assert.ok(retryNotif.message.includes("Waiting"), "Notification should include 'Waiting'");
    assert.ok(
      retryNotif.message.includes("attempt #1, elapsed: 0s / max: 5h"),
      `Notification should format attempt and elapsed: ${retryNotif.message}`
    );
    assert.ok(
      retryNotif.message.includes("Expected token reset time:"),
      "Notification should include expected token reset time"
    );
    assert.equal(retryNotif.type, "warning");

    // Status command should reflect active retry loop and expected token reset time
    await cmd.handler("status", ctx);
    const statusNotif = ctx.notifications.find((n) =>
      n.message.includes("Auto-Continue Status:")
    );
    assert.ok(statusNotif, "Status notification should be emitted");
    assert.ok(
      statusNotif.message.includes("Active (attempt #1"),
      "Status should report active attempt #1"
    );
    assert.ok(
      statusNotif.message.includes("Expected token reset time:"),
      "Status should report expected reset time"
    );

    // Clean up timer
    await cmd.handler("reset", ctx);
  });

  it("validates arguments for /auto-continue at command", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");

    // Missing time argument
    await cmd.handler("at", ctx);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Please specify a time in HH:MM format") && n.type === "warning"
      )
    );

    // Invalid time argument
    await cmd.handler("at 25:99", ctx);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes('Invalid time format "25:99"') && n.type === "warning"
      )
    );
  });

  it("cancels scheduled retry when interactive user input is received", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");

    const d = new Date(Date.now() + 3600000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    // Schedule retry
    await cmd.handler(`at ${hh}:${mm}`, ctx);

    // Interactive user input arrives
    await pi.emit("input", { source: "interactive", text: "cancel task" }, ctx);

    assert.ok(
      ctx.notifications.some(
        (n) =>
          n.message.includes("🛑 User input received: cancelling active retry/continuation loop.") &&
          n.type === "info"
      )
    );

    // Status should be Idle
    ctx.notifications = [];
    await cmd.handler("status", ctx);
    const statusNotif = ctx.notifications.find((n) =>
      n.message.includes("Auto-Continue Status:")
    );
    assert.ok(
      statusNotif?.message.includes("Current retry status: Idle"),
      "Retry state should be reset to Idle"
    );
  });

  it("correctly parses ChatGPT usage limit error, extracts estimated token reset time, and notifies UI", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any, testSettingsPath);

    const ctx = new MockContext();
    const chatGptError = '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.';

    // Emit message_end with ChatGPT error (starts retry wait asynchronously)
    const messagePromise = pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: chatGptError,
          timestamp: 5000,
        },
      },
      ctx
    );

    // Yield to allow message_end handler to process up to sleep
    await new Promise((resolve) => setImmediate(resolve));

    // 1. Warning notification emitted with expected reset time
    const warningNotif = ctx.notifications.find((n) =>
      n.message.includes("Rate limit / quota error detected")
    );
    assert.ok(warningNotif, "Warning notification should be emitted");
    assert.ok(
      warningNotif.message.includes("Expected token reset time:"),
      "Warning notification should include Expected token reset time label"
    );
    const dateRegex = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
    assert.ok(
      dateRegex.test(warningNotif.message),
      `Expected date format YYYY-MM-DD HH:MM:SS in notification: ${warningNotif.message}`
    );

    // 2. Status command should also display expected token reset time
    const cmd = pi.commands.get("auto-continue");
    await cmd.handler("status", ctx);

    const statusNotif = ctx.notifications.find((n) =>
      n.message.includes("Auto-Continue Status:")
    );
    assert.ok(statusNotif, "Status notification should be emitted");
    assert.ok(
      statusNotif.message.includes("Expected token reset time:"),
      "Status should print expected token reset time"
    );
    assert.ok(
      dateRegex.test(statusNotif.message),
      `Expected date format YYYY-MM-DD HH:MM:SS in status: ${statusNotif.message}`
    );

    // Cancel retry wait via interactive input to cleanly terminate promise
    await pi.emit(
      "input",
      { type: "input", source: "interactive", text: "cancel" },
      ctx
    );
    await messagePromise;
  });
});
