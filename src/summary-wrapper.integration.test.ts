import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Summary-context wrapper delivery-path integration tests, following the
// proactive-tiers harness pattern: boots the real index.ts extension against
// an isolated agent dir + session, with a scripted summarizer, and asserts
// that BOTH flush delivery paths (runtime `pi.sendMessage` steer via
// `/pruner now`, and session `appendCustomMessageEntry` via the budget gate)
// plus the in-memory summary-body registry (`registerSummaryBody`, consumed
// by chain compression) all receive content wrapped in the
// `<context-prune-summary>` tag pair.
//
// Must run before any module that transitively reads PI_CODING_AGENT_DIR
// (src/config.ts's getAgentDir()) is imported/executed. Config loads on
// session_start; each test fires it after boot so loadConfig() reads the
// freshly-written settings.json.
const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-condense-wrap-"));
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function okStream(text: string) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

const SUMMARY_BODY = "[[1:read]] summary body";
let streamImpl: (model: any, input?: any, opts?: any) => any = (_model, _input?: any) =>
  okStream(SUMMARY_BODY);

type AppendedEntry = { type: string; data: unknown };

function bootExtension(
  options: { autoBudgetThreshold?: number | null; branch?: any[] } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-wrap-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      contextPrune: {
        enabled: true,
        pruneOn: "agent-message",
        batchingMode: "agent-message",
        autoBudgetThreshold:
          options.autoBudgetThreshold === undefined ? null : options.autoBudgetThreshold,
        summarizerModel: "default",
        summarizerConcurrency: 4,
        minBatchChars: 1,
        showPruneStatusLine: true,
        chainCompression: {
          enabled: true,
          rollingWindow: 3,
          stripFinalAssistantThinking: true,
          fuseRangeSummary: true,
        },
      },
    }),
  );

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-condense-wrap-session-"));
  const appended: AppendedEntry[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let commandSpec: any;

  const pi: any = {
    on(name: string, fn: (event: any, ctx: any) => any) {
      handlers.set(name, fn);
    },
    appendEntry(type: string, data?: unknown) {
      appended.push({ type, data });
    },
    sentMessages: [] as any[],
    sendMessage(msg: any, opts: any) {
      pi.sentMessages.push({ msg, opts });
    },
    registerCommand(_name: string, spec: any) {
      commandSpec = spec;
    },
    registerTool() {},
    registerMessageRenderer() {},
    events: { emit() {} },
  };

  const branch: any[] =
    options.branch ??
    (() => {
      // One closed chain: user → assistant toolCall → toolResult → final assistant.
      let t = Date.now();
      return [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "do task" }], timestamp: t } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc0", name: "read", arguments: {} }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc0", toolName: "read", content: [{ type: "text", text: "z0-".repeat(200) }], timestamp: t + 1000 } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: t + 2000 } },
      ];
    })();

  let usageValue: { tokens: number | null; contextWindow: number } = {
    tokens: 0,
    contextWindow: 1_000_000,
  };

  const ctx: any = {
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry(type: string, data?: unknown) {
        appended.push({ type, data });
        return "id";
      },
      appendCustomMessageEntry(type: string, content: string, _display: boolean, details?: unknown) {
        appended.push({ type, data: { customType: type, content, details } });
        return "id";
      },
      getSessionDir: () => sessionDir,
      getSessionId: () => "test",
    },
    getContextUsage: () => usageValue,
    model: { id: "m", provider: "p", name: "M" },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
      getProviderAuth: async () => undefined,
      getProvider: () => ({
        streamSimple: (...args: any[]) => streamImpl(...args),
      }),
    },
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
      select: async () => undefined,
      custom: async () => {},
    },
  };

  return {
    handlers,
    ctx,
    pi,
    appended,
    branch,
    runCommand: async (subcommand: string) => {
      await commandSpec.handler(subcommand, ctx);
    },
    setUsage: (tokens: number | null, contextWindow = 1_000_000) => {
      usageValue = { tokens, contextWindow };
    },
  };
}

async function boot(options?: Parameters<typeof bootExtension>[0]) {
  const harness = bootExtension(options);
  const extension = (await import("../index.js")).default;
  extension(harness.pi);
  // Config loads on session_start: fire it so loadConfig() reads the
  // freshly-written settings.json (default harnesses rely on the default
  // enabled config otherwise).
  await harness.handlers.get("session_start")!({}, harness.ctx);
  return harness;
}

// getSettingsListTheme() (used by the real overlay) requires an initialized
// theme; commands.ts never calls initTheme itself (Pi does at boot).
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();

const SUMMARY_CUSTOM_TYPE = "context-prune-summary";
const SUMMARY_CONTEXT_OPEN = "<context-prune-summary>";
const SUMMARY_CONTEXT_CLOSE = "</context-prune-summary>";

/** A turn_end with one fresh tool call that pushes a new pending batch. */
async function toolTurn(
  harness: Awaited<ReturnType<typeof boot>>,
  id: string,
  turnIndex: number,
  fill = `${id}-`,
) {
  await harness.handlers.get("turn_end")!(
    {
      message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }] },
      toolResults: [
        { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: fill.repeat(200) }], timestamp: Date.now() },
      ],
      turnIndex,
    },
    harness.ctx,
  );
}

describe("summary context wrapper — delivery paths (integration)", () => {
  it("runtime steer delivery: /pruner now flush persists a wrapped summary via pi.sendMessage", async () => {
    const harness = await boot();
    // turn_end captures the batch; /pruner now flushes with delivery "runtime".
    await toolTurn(harness, "tc0", 0, "a");
    await harness.runCommand("now");

    const steered = harness.pi.sentMessages.filter((s: any) => s.msg?.customType === SUMMARY_CUSTOM_TYPE);
    expect(steered.length).toBeGreaterThanOrEqual(1);
    for (const s of steered) {
      expect(s.msg.content.startsWith(SUMMARY_CONTEXT_OPEN)).toBe(true);
      expect(s.msg.content.endsWith(SUMMARY_CONTEXT_CLOSE)).toBe(true);
      expect(s.msg.display).toBe(false);
    }
  });

  it("session delivery: budget-gate flush persists a wrapped summary via appendCustomMessageEntry", async () => {
    const harness = await boot({ autoBudgetThreshold: 0.000001 });
    harness.setUsage(500_000); // nonzero fraction → budgetHit fires
    await toolTurn(harness, "tc0", 0, "b");
    // turn_end gate: budgetHit → flushPending(delivery: "session").
    await new Promise((r) => setTimeout(r, 50));

    const sessionEntries = harness.appended.filter(
      (e) =>
        e.type === SUMMARY_CUSTOM_TYPE ||
        (e.data && (e.data as any).customType === SUMMARY_CUSTOM_TYPE),
    );
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
    for (const e of sessionEntries) {
      const content = (e.data as any).content;
      expect(content.startsWith(SUMMARY_CONTEXT_OPEN)).toBe(true);
      expect(content.endsWith(SUMMARY_CONTEXT_CLOSE)).toBe(true);
    }
  });

  it("both delivery paths receive identically wrapped content", async () => {
    // One harness, one turn: runtime delivery via /pruner now.
    const rt = await boot();
    await toolTurn(rt, "tc0", 0, "c");
    await rt.runCommand("now");
    const steered = rt.pi.sentMessages.filter((s: any) => s.msg?.customType === SUMMARY_CUSTOM_TYPE);

    // Separate harness: session delivery via the budget gate.
    const se = await boot({ autoBudgetThreshold: 0.000001 });
    se.setUsage(500_000); // nonzero fraction → budgetHit fires
    await toolTurn(se, "tc0", 0, "c");
    await new Promise((r) => setTimeout(r, 50));
    const sessionEntries = se.appended.filter(
      (e) =>
        e.type === SUMMARY_CUSTOM_TYPE ||
        (e.data && (e.data as any).customType === SUMMARY_CUSTOM_TYPE),
    );

    expect(steered.length).toBeGreaterThanOrEqual(1);
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
    // Identical summary body + refs footer → identical wrapped content.
    expect(steered[0].msg.content).toBe(sessionEntries[0].data.content);
  });

  it("registerSummaryBody receives wrapped content (chain compression input)", async () => {
    const harness = await boot();
    await toolTurn(harness, "tc0", 0, "d");
    await harness.runCommand("now");

    // registerSummaryBody receives the same wrapped `summaryText` variable as
    // the delivery paths above; the in-memory registry is what chain
    // compression's fuseRange reads via getPerBatchSummariesForToolCallIds.
    // The registry itself is not directly observable, so assert on the
    // persisted summary entry: same variable, same wrapped content. Chain
    // compression's registry consumption is covered by the
    // chain-compressor fuseRange tests (task 3.4).
    const steered = harness.pi.sentMessages.filter((s: any) => s.msg?.customType === SUMMARY_CUSTOM_TYPE);
    expect(steered.length).toBeGreaterThanOrEqual(1);
    expect(steered[0].msg.content.startsWith(SUMMARY_CONTEXT_OPEN)).toBe(true);
    expect(steered[0].msg.content.endsWith(SUMMARY_CONTEXT_CLOSE)).toBe(true);
  });
});
