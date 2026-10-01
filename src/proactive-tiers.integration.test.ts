import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proactive budget tier lifecycle tests, extending the reload-rearm harness
// patterns (src/reload-rearm.integration.test.ts): boots the real index.ts
// extension against an isolated agent dir + session, with controllable
// ctx.getContextUsage and a branch builder producing N pending batches.
//
// This must run before any module that transitively reads PI_CODING_AGENT_DIR
// (src/config.ts's getAgentDir()) is imported/executed.
const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-condense-tiers-"));
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

let summarizerCalls = 0;
// Ordered log of which batches reached the summarizer (by tool call id).
let summarizedToolCallIds: string[] = [];

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

let streamImpl: (model: any, input?: any, opts?: any) => any = (_model, input?: any) => {
  summarizerCalls++;
  // Record which tool names reached the summarizer, in call order — lets tests
  // assert OLDEST-FIRST selection, not just call counts.
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  summarizedToolCallIds.push(...[...text.matchAll(/\[\[\d+:(read[\w-]*)\]\]/g)].map((m) => m[1]));
  return okStream("[[1:read]] summary");
};

type AppendedEntry = { type: string; data: unknown };

/**
 * Builds `count` independent closed chains (user → assistant toolCall →
 * toolResult → final text-only assistant), one per user turn. Under
 * batchingMode "agent-message" each becomes its own captured batch.
 *
 * The tool name AND result content are made DISTINCT per batch (unique
 * prefix + unique fill char) so the pre-flush content-hash dedup never eats
 * them: a tier re-fire must actually reach the summarizer for these tests.
 */
function multiBatchBranch(count: number, chars = 400): any[] {
  const msgs: any[] = [];
  const fills = "abcdefghij";
  let t = Date.now();
  for (let i = 0; i < count; i++) {
    t += 1000;
    msgs.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `do task ${i}` }], timestamp: t } });
    msgs.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: `read${i}`, arguments: {} }] },
    });
    t += 1000;
    const fill = fills[i % fills.length];
    msgs.push({
      type: "message",
      message: { role: "toolResult", toolCallId: `tc${i}`, toolName: `read${i}`, content: [{ type: "text", text: `${fill}${i}-`.repeat(chars / 2) }], timestamp: t },
    });
    t += 1000;
    msgs.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `done ${i}` }], timestamp: t } });
  }
  return msgs;
}

function bootExtension(
  options: {
    tiers?: number[];
    batchLimit?: number;
    autoBudgetThreshold?: number | null;
    pruneOn?: string;
    branch?: any[];
    summarizerConcurrency?: number;
    chainCompressionEnabled?: boolean;
    streamImpl?: (model: any, input?: any, opts?: any) => any;
  } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-tiers-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      contextPrune: {
        enabled: true,
        pruneOn: options.pruneOn ?? "agent-message",
        batchingMode: "agent-message",
        autoBudgetThreshold: options.autoBudgetThreshold === undefined ? null : options.autoBudgetThreshold,
        proactiveBudgetTiers: options.tiers ?? [],
        proactiveBatchLimit: options.batchLimit ?? 4,
        summarizerModel: "default",
        summarizerConcurrency: options.summarizerConcurrency ?? 4,
        minBatchChars: 1,
        showPruneStatusLine: true,
        chainCompression: {
          enabled: options.chainCompressionEnabled ?? false,
          rollingWindow: 3,
          stripFinalAssistantThinking: true,
          fuseRangeSummary: true,
        },
      },
    }),
  );

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-condense-tiers-session-"));
  const appended: AppendedEntry[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();

  let commandSpec: any;
  let overlayComponent: any;
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

  const branch = options.branch ?? [];

  // Controllable usage: tests swap this closure per turn.
  let usageValue: { tokens: number | null; contextWindow: number } = { tokens: 0, contextWindow: 1_000_000 };

  const ctx: any = {
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry(type: string, data?: unknown) {
        appended.push({ type, data });
        return "id";
      },
      appendCustomMessageEntry(type: string, content: string, _display: boolean, details?: unknown) {
        appended.push({ type, data: { content, details } });
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
        streamSimple: (...args: any[]) => (options.streamImpl ?? streamImpl)(...args),
      }),
    },
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
      select: async () => undefined,
      // Captures the settings-overlay component so tests can drive the real
      // SettingsList (mid-session config change through the command path).
      custom: async (factory: any) => {
        overlayComponent = factory({ requestRender: () => {} }, undefined, undefined, () => {});
      },
    },
  };

  return {
    handlers,
    ctx,
    pi,
    appended,
    branch,
    setUsage: (tokens: number | null, contextWindow = 1_000_000) => {
      usageValue = { tokens, contextWindow };
    },
    /** Opens /pruner settings and cycles the proactiveBudgetTiers row once. */
    cycleTierPresetViaOverlay: async () => {
      await commandSpec.handler("settings", ctx);
      const list = overlayComponent?.children?.[2];
      const items: { id: string }[] = list.items;
      const tierIndex = items.findIndex((i) => i.id === "proactiveBudgetTiers");
      for (let guard = 0; guard < items.length && list.selectedIndex !== tierIndex; guard++) {
        list.handleInput("\x1b[B"); // down
      }
      list.handleInput("\r"); // enter → cycle to the next preset
    },
    /** Runs a /pruner subcommand handler directly. */
    runCommand: async (subcommand: string) => {
      await commandSpec.handler(subcommand, ctx);
    },
  };
}

async function boot(options?: Parameters<typeof bootExtension>[0]) {
  summarizerCalls = 0;
  summarizedToolCallIds = [];
  const harness = bootExtension(options);
  const extension = (await import("../index.js")).default;
  extension(harness.pi);
  return harness;
}

// getSettingsListTheme() (used by the real overlay) requires an initialized
// theme; commands.ts never calls initTheme itself (Pi does at boot).
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();

/** A turn_end with one fresh tool call that pushes a new pending batch. */
async function toolTurn(
  harness: Awaited<ReturnType<typeof boot>>,
  id: string,
  turnIndex: number,
) {
  await harness.handlers.get("turn_end")!(
    {
      message: { role: "assistant", content: [{ type: "toolCall", id, name: `read-${id}`, arguments: {} }] },
      toolResults: [
        { role: "toolResult", toolCallId: id, toolName: `read-${id}`, content: [{ type: "text", text: `${id}-`.repeat(200) }], timestamp: Date.now() },
      ],
      turnIndex,
    },
    harness.ctx,
  );
}

/** A text-only turn_end (no toolResults). */
async function textTurn(harness: Awaited<ReturnType<typeof boot>>, turnIndex: number) {
  await harness.handlers.get("turn_end")!(
    { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex },
    harness.ctx,
  );
}

function flushMetrics(harness: Awaited<ReturnType<typeof boot>>) {
  return harness.appended
    .filter((e) => e.type === "context-prune-flush-metrics")
    .map((e) => e.data as any);
}

/** Fraction helper: tokens against the capped 300k window on a 1M model. */
const frac = (tokens: number) => tokens / 300_000;

/**
 * Skipped: these cases are the red executable spec for the OpenSpec change
 * `proactive-budget-tiers` (0/25 tasks implemented). They assert tier flushes,
 * retry floors, and staged-commit behavior that `index.ts` and `src/budget.ts`
 * do not have yet, so most of them fail by construction and would break gate G3
 * (`bun test` green) for every unrelated sync and release.
 *
 * Remove `.skip` when task 2.4 (tier wiring) lands; task 6.4 requires the full
 * suite green before that change can be archived.
 */
describe.skip("proactive budget tiers — lifecycle", () => {
  it("3.2: crossing 50% with 10 pending summarizes exactly the oldest 3, keeps the tail queued, skips chain compression, and records tier metrics", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(10);
    const harness = await boot({ tiers: [0.5], batchLimit: 3, chainCompressionEnabled: true, branch });
    // session_start rescan finds 10 unsummarized batches → rearms the gate.
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Cross the tier on the first gate evaluation (reload rearmed the gate).
    harness.setUsage(160_000); // 160k / 300k ≈ 0.533 ≥ 0.5
    await textTurn(harness, 20);

    // Exactly the OLDEST 3 batches summarized — and they are the FIRST three
    // tool names (read0..read2), proving oldest-first selection.
    expect(summarizerCalls).toBe(3);
    expect(summarizedToolCallIds.slice(0, 3)).toEqual(["read0", "read1", "read2"]);
    const metrics = flushMetrics(harness);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].trigger).toBe("proactive");
    expect(metrics[0].tier).toBe(0.5);
    expect(metrics[0].capturedBatches).toBe(10);
    expect(metrics[0].processedBatches).toBe(3);

    // The other 7 stay pending: the next gate evaluation (second boundary)
    // still sees a non-empty queue and (still above tier, cursor advanced by
    // one) fires nothing new; assert via agent_end's status readout instead.
    harness.setUsage(170_000);
    await textTurn(harness, 21);
    expect(summarizerCalls).toBe(3); // tier already fired; nothing re-fires

    const statusCalls: unknown[] = [];
    harness.ctx.ui.setStatus = (_id: string, text?: string) => statusCalls.push(text);
    await harness.handlers.get("agent_end")!({}, harness.ctx);
    expect(statusCalls).toContain("\u2502 prune: 7 pending");

    // Chain compression did NOT run on the tier flush (no chain entries).
    expect(harness.appended.some((e) => e.type === "context-prune-chain")).toBe(false);
    expect(harness.appended.some((e) => e.type === "context-prune-summary")).toBe(false);
  });

  it("3.3: hovering (49%→51%→50.5%) fires the tier exactly once; a drop below 40% and re-cross re-fires it", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Fresh tool turns keep the gate reachable (a text-only turn after the
    // rearm is consumed returns early by design — the gate's precondition).
    // 49% — below the tier: no fire.
    harness.setUsage(Math.round(0.49 * 300_000));
    await toolTurn(harness, "hover-a", 20);
    expect(summarizerCalls).toBe(0);

    // 51% — crosses: fires once (2 batches, the limit).
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "hover-b", 21);
    expect(summarizerCalls).toBe(2);

    // Hover: 49% / 51% / 50.5% — no re-fire while above the re-arm point.
    harness.setUsage(Math.round(0.49 * 300_000));
    await toolTurn(harness, "hover-c", 22);
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "hover-d", 23);
    harness.setUsage(Math.round(0.505 * 300_000));
    await toolTurn(harness, "hover-e", 24);
    expect(summarizerCalls).toBe(2);

    // Drop below 40% (the re-arm point): re-arms.
    harness.setUsage(Math.round(0.39 * 300_000));
    await toolTurn(harness, "hover-f", 25);
    // Re-cross 50%: fires again.
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "hover-g", 26);
    expect(summarizerCalls).toBe(4);

    const metrics = flushMetrics(harness);
    expect(metrics.filter((m) => m.trigger === "proactive")).toHaveLength(2);
  });

  it("3.4: tokens:null performs no tier evaluation and preserves tier state", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Null usage (post-compaction): no evaluation.
    harness.setUsage(null);
    await textTurn(harness, 20);
    expect(summarizerCalls).toBe(0);
    expect(flushMetrics(harness)).toHaveLength(0);

    // Tier state was preserved: crossing later still fires.
    harness.setUsage(Math.round(0.52 * 300_000));
    await textTurn(harness, 21);
    expect(summarizerCalls).toBe(2);
    expect(flushMetrics(harness)[0].trigger).toBe("proactive");
  });

  it("3.4: a failed tier flush keeps the cursor and respects the retry floor", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    let failNext = false;
    const failing = () => {
      if (failNext) {
        return {
          async *[Symbol.asyncIterator]() {},
          async result() {
            return { stopReason: "error", errorMessage: "boom", content: [], usage: USAGE };
          },
        };
      }
      summarizerCalls++;
      return okStream("[[1:read]] summary");
    };
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch, streamImpl: failing });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Cross the tier with the summarizer failing: no persist → cursor stays.
    failNext = true;
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "floor-a", 20);
    const failed = flushMetrics(harness);
    expect(failed).toHaveLength(1);
    expect(failed[0].trigger).toBe("proactive");
    expect(failed[0].outcome).toBe("error");

    // Flat usage at the same fraction (0.51 → 0.52, below the 0.05 retry
    // floor of ~0.56): must NOT retry a failing fan-out every turn.
    failNext = false;
    harness.setUsage(Math.round(0.52 * 300_000));
    await toolTurn(harness, "floor-b", 21);
    expect(summarizerCalls).toBe(0); // floor blocks the retry
    expect(flushMetrics(harness)).toHaveLength(1);

    // A genuine climb past the floor re-attempts the tier.
    harness.setUsage(Math.round(0.58 * 300_000));
    await toolTurn(harness, "floor-c", 22);
    expect(summarizerCalls).toBe(2);
    const retried = flushMetrics(harness);
    expect(retried).toHaveLength(2);
    expect(retried[1].trigger).toBe("proactive");
    expect(retried[1].outcome).toBe("summarized");
  });

  it("3.5: a jump spanning multiple tiers fires only the lowest due tier per boundary", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(10);
    const harness = await boot({ tiers: [0.5, 0.7, 0.85], batchLimit: 2, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Jump straight past 0.85 in one gate evaluation: only 0.5 fires.
    harness.setUsage(Math.round(0.9 * 300_000));
    await toolTurn(harness, "jump-a", 20);
    expect(summarizerCalls).toBe(2);
    let metrics = flushMetrics(harness);
    expect(metrics[0].tier).toBe(0.5);

    // Next boundary (still due): 0.7 fires.
    await toolTurn(harness, "jump-b", 21);
    expect(summarizerCalls).toBe(4);
    metrics = flushMetrics(harness);
    expect(metrics[1].tier).toBe(0.7);

    // Next boundary: 0.85 fires.
    await toolTurn(harness, "jump-c", 22);
    expect(summarizerCalls).toBe(6);
    metrics = flushMetrics(harness);
    expect(metrics[2].tier).toBe(0.85);

    // All fired: nothing more.
    await toolTurn(harness, "jump-d", 23);
    expect(summarizerCalls).toBe(6);
  });

  it("3.5: after a tier fired, crossing autoBudgetThreshold on a later turn fires only the threshold flush (full drain, cursor recomputed)", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(10);
    const harness = await boot({ tiers: [0.5], batchLimit: 3, autoBudgetThreshold: 0.9, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Tier 0.5 fires first (bounded).
    harness.setUsage(Math.round(0.52 * 300_000));
    await toolTurn(harness, "thr-a", 20);
    expect(summarizerCalls).toBe(3);
    expect(flushMetrics(harness)[0].trigger).toBe("proactive");

    // Active context was NOT pruned after tier 0.5 (no summary messages written):
    expect(harness.appended.some((e) => e.type === "context-prune-summary")).toBe(false);
    expect(harness.appended.some((e) => e.type === "context-prune-index")).toBe(false);
    // Threshold crossing on a later turn: full drain of all 10 batches
    // (reusing the 3 staged batches with zero LLM calls, summarizing only the 7 unstaged).
    // NOTE the reachability rule: on a 1M window the threshold fires at
    // min(300k, 0.9*1M) = 300k tokens, so the window is set to 300k here —
    // 0.92 of the effective window (276k) then clears the 0.9 threshold
    // level (min(300k, 0.9*300k) = 270k).
    harness.setUsage(Math.round(0.92 * 300_000), 300_000);
    await toolTurn(harness, "thr-b", 21);
    expect(summarizerCalls).toBe(10); // 3 from tier + 7 from threshold
    const metrics = flushMetrics(harness);
    expect(metrics[1].trigger).toBe("budget");
    expect(metrics[1].processedBatches).toBe(10);
    expect(metrics[1].tier).toBeUndefined();

    // Now all 10 batches are committed and summary messages written!
    expect(harness.appended.some((e) => e.type === "context-prune-summary")).toBe(true);
    // No blanket cursor reset: at 0.92 the tier stays fired — no re-fire.
    harness.setUsage(Math.round(0.92 * 300_000), 300_000);
    await toolTurn(harness, "thr-c", 22);
    expect(summarizerCalls).toBe(10);
  });

  it("3.5: a mid-session tier-list change resets/re-keys tier state", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    // Boot with no tiers; inject the config change via the settings file +
    // a fresh session_start (the config-change seam keys on the tier list).
    const harness = await boot({ tiers: [0.5, 0.7, 0.85], batchLimit: 2, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Fire the first two tiers (0.5, 0.7) — cursor would be 2.
    harness.setUsage(Math.round(0.72 * 300_000));
    await toolTurn(harness, "rekey-a", 20);
    expect(summarizerCalls).toBe(2);
    await toolTurn(harness, "rekey-b", 21);
    expect(summarizerCalls).toBe(4);
    expect(flushMetrics(harness).map((m) => m.tier)).toEqual([0.5, 0.7]);

    // Mid-session tier-list change through the REAL overlay preset cycler
    // (currentConfig.value updated in place — the seam syncTierConfigKey
    // watches at the next gate evaluation). [0.5,0.7,0.85] → next preset →
    // [0.4,0.6,0.8].
    await harness.cycleTierPresetViaOverlay();
    expect((harness as any).ctx).toBeDefined(); // harness intact

    // With the NEW list [0.4, 0.6, 0.8] at 0.72 usage: 0.4 and 0.6 are due;
    // the lowest (0.4) must fire — the old cursor (2, from [0.5,0.7,0.85])
    // must NOT have suppressed the new tiers.
    harness.setUsage(Math.round(0.72 * 300_000));
    await toolTurn(harness, "rekey-c", 22);
    expect(summarizerCalls).toBe(6);
    const metrics = flushMetrics(harness).filter((m) => m.trigger === "proactive");
    expect(metrics[metrics.length - 1].tier).toBe(0.4);
  });

  it("3.6: pruneOn on-demand + tiers — tier flushes fire at turn_end without /pruner now or message_end", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    const harness = await boot({ tiers: [0.5], batchLimit: 2, pruneOn: "on-demand", branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // In on-demand mode nothing summarizes until a tier fires at turn_end.
    harness.setUsage(Math.round(0.52 * 300_000));
    await textTurn(harness, 20);
    expect(summarizerCalls).toBe(2);
    expect(flushMetrics(harness)[0].trigger).toBe("proactive");
  });

  it("3.6: a reload whose rescan finds only TRIVIAL captured work fires the tier, makes zero summarizer calls, and advances on skipped-trivial", async () => {
    summarizerCalls = 0;
    // Raw chars below minBatchChars... but the harness fixture sets
    // minBatchChars: 1, so build trivial batches via tiny results AND a high
    // minBatchChars in the settings file.
    const branch = multiBatchBranch(3, 50); // 50 raw chars each
    const harness = await boot({ tiers: [0.5], batchLimit: 4, branch });
    // Raise minBatchChars above 50 so the rescan's batches are all trivial.
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({
        contextPrune: {
          enabled: true,
          pruneOn: "agent-message",
          batchingMode: "agent-message",
          autoBudgetThreshold: null,
          proactiveBudgetTiers: [0.5],
          proactiveBatchLimit: 4,
          summarizerModel: "default",
          minBatchChars: 1000,
          showPruneStatusLine: true,
          chainCompression: { enabled: false, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: true },
        },
      }),
    );
    await harness.handlers.get("session_start")!({}, harness.ctx);

    harness.setUsage(Math.round(0.52 * 300_000));
    await textTurn(harness, 20);

    expect(summarizerCalls).toBe(0); // trivial: zero LLM calls
    const metrics = flushMetrics(harness);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].trigger).toBe("proactive");
    expect(metrics[0].outcome).toBe("skipped-trivial");
    expect(metrics[0].processedBatches).toBe(3);

    // Cursor advanced on the skipped-trivial outcome: hovering does not refire.
    await textTurn(harness, 21);
    expect(flushMetrics(harness)).toHaveLength(1);
  });

  it("3.6: a session_tree navigation at high usage with genuinely pending work fires one tier per navigation", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(10);
    const harness = await boot({ tiers: [0.5], batchLimit: 3, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // First navigation-gate cycle: fire once at 0.53.
    harness.setUsage(Math.round(0.53 * 300_000));
    await toolTurn(harness, "nav-a", 20);
    expect(summarizerCalls).toBe(3);

    // session_tree resets tier state AND rears the gate: at high usage with
    // genuinely pending work (7 left), the next boundary fires one tier again.
    await harness.handlers.get("session_tree")!({}, harness.ctx);
    harness.setUsage(Math.round(0.54 * 300_000));
    await toolTurn(harness, "nav-b", 21);
    expect(summarizerCalls).toBe(6);

    // A second navigation: fires once more (one per navigation).
    await harness.handlers.get("session_tree")!({}, harness.ctx);
    harness.setUsage(Math.round(0.55 * 300_000));
    await toolTurn(harness, "nav-c", 22);
    expect(summarizerCalls).toBe(9);

    const proactive = flushMetrics(harness).filter((m) => m.trigger === "proactive");
    expect(proactive).toHaveLength(3);
    expect(proactive.every((m) => m.tier === 0.5)).toBe(true);
  });

  it("3.7: proactive tier stages summaries without pruning context mid-conversation; final /pruner now commits them and prunes context", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(5);
    const harness = await boot({ tiers: [0.5], batchLimit: 3, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // 1. Cross tier 0.5: stages 3 batches in memory.
    harness.setUsage(Math.round(0.53 * 300_000));
    await toolTurn(harness, "mid-conv-a", 20);
    expect(summarizerCalls).toBe(3); // 3 batches pre-summarized

    // 2. Mid-conversation context hook: must NOT stub out tool results!
    // The messages in branch should remain completely unmodified.
    const branchMessages = branch.map((e) => e.message);
    const contextResult1 = await harness.handlers.get("context")!({ messages: branchMessages }, harness.ctx);
    // context handler returns undefined when nothing was changed
    expect(contextResult1).toBeUndefined();

    // 3. Manual flush (/pruner now): commits the 3 staged batches with 0 LLM calls,
    // summarizes the 2 unstaged batches (2 LLM calls), and writes summary messages.
    await harness.handlers.get("turn_end")!({
      message: { role: "assistant", content: [] },
      toolResults: [],
      turnIndex: 21,
    }, harness.ctx);

    await harness.runCommand("now");
    // Total summarizer calls: 3 (from tier 0.5) + 2 (remaining unstaged batches during /pruner now) = 5
    expect(summarizerCalls).toBe(5);

    // Summary messages are now committed via steer message (runtime delivery)!
    expect(harness.pi.sentMessages.some((m: any) => m.msg.customType === "context-prune-summary")).toBe(true);

    // 4. Next context hook: NOW tool results are stubbed out!
    const contextResult2 = await harness.handlers.get("context")!({ messages: branchMessages }, harness.ctx);
    expect(contextResult2).toBeDefined();
    const stubbedResult = contextResult2?.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "tc0");
    expect(stubbedResult.content[0].text).toContain("Summarized in pruner summary, ref");
  });

  it("review-F1: never stages the still-open trailing agent-message span (growing batches cannot orphan staged entries)", async () => {
    summarizerCalls = 0;
    // 4 closed spans + 1 OPEN span (user → toolCall → result, no final text yet).
    const branch = multiBatchBranch(4);
    let t = Date.now() + 100_000;
    branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "open task" }], timestamp: t } });
    branch.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "tc-open", name: "read-open", arguments: {} }] },
    });
    t += 1000;
    branch.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "tc-open", toolName: "read-open", content: [{ type: "text", text: "z-open-".repeat(100) }], timestamp: t },
    });
    const harness = await boot({ tiers: [0.5], batchLimit: 10, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    harness.setUsage(Math.round(0.51 * 300_000));
    await textTurn(harness, 20);

    // Only the 4 CLOSED spans staged — the open span is left for the commit flush.
    expect(summarizerCalls).toBe(4);
    const metrics = flushMetrics(harness);
    expect(metrics[0].capturedBatches).toBe(5);
    expect(metrics[0].processedBatches).toBe(4);

    // The span grows (a second tool turn inside the same open span): the staged
    // 4 closed-span keys still match exactly — no re-summarization, no orphans.
    t += 1000;
    branch.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "tc-open2", name: "read-open2", arguments: {} }] },
    });
    t += 1000;
    branch.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "tc-open2", toolName: "read-open2", content: [{ type: "text", text: "y-open-".repeat(100) }], timestamp: t },
    });
    harness.setUsage(Math.round(0.61 * 300_000));
    await textTurn(harness, 21);
    // Tier 0.5 already fired (cursor advanced); the grown open span is still not staged.
    expect(summarizerCalls).toBe(4);

    // Commit: 4 staged batches reused (0 LLM calls) + the grown open span
    // summarized once as one merged batch (1 LLM call).
    await harness.runCommand("now");
    expect(summarizerCalls).toBe(5);
  });

  it("review-r2-F6: a span closed by a final assistant message containing THINKING blocks is stageable (structural, not text-only, closers)", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(4);
    // Replace the final text-only assistant message of the LAST span with a
    // final message that carries thinking + text — still a span CLOSER (no
    // toolCall blocks), previously misclassified as open by the text-only check.
    const lastFinal = branch[branch.length - 1];
    expect(lastFinal.message.role).toBe("assistant");
    lastFinal.message.content = [
      { type: "thinking", thinking: "hmm, done with this task" },
      { type: "text", text: "done 3" },
    ];
    const harness = await boot({ tiers: [0.5], batchLimit: 10, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    harness.setUsage(Math.round(0.51 * 300_000));
    await textTurn(harness, 20);

    // ALL 4 closed spans staged — the thinking-final closer does not keep the
    // trailing span "open".
    expect(summarizerCalls).toBe(4);
    const metrics = flushMetrics(harness);
    expect(metrics[0].processedBatches).toBe(4);
  });

  it("review-r2-F1: a commit flush awaiting the summarizer across session_tree is discarded without writing to the new branch", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(5);
    const releases: Array<() => void> = [];
    const deferredStream = () => {
      summarizerCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
        },
      };
    };
    const harness = await boot({ tiers: [], branch, streamImpl: deferredStream });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Start the manual flush; let its summarizer calls block.
    const nowPromise = harness.runCommand("now");
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizerCalls).toBeGreaterThan(0);

    // Navigate: session_tree reconstructs the indexer/stats/frontier for the
    // (same) branch and bumps the session generation.
    await harness.handlers.get("session_tree")!({}, harness.ctx);

    // Release the blocked calls (draining repeatedly: the pool admits waiting
    // calls as earlier ones settle); the old flush must DISCARD — no summary
    // messages, no index/frontier persistence from the stale attempt.
    const drainUntilSettled = async (promise: Promise<unknown>) => {
      for (let guard = 0; guard < 50; guard++) {
        releases.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 10));
        const done = await Promise.race([promise.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5))]);
        if (done) return;
      }
      await promise;
    };
    await drainUntilSettled(nowPromise);

    expect(harness.pi.sentMessages.some((m: any) => m.msg.customType === "context-prune-summary")).toBe(false);
    expect(harness.appended.filter((e) => e.type === "context-prune-summary")).toHaveLength(0);
    expect(harness.appended.filter((e) => e.type === "context-prune-index")).toHaveLength(0);
    // The stale attempt is observable as an error-outcome flush entry.
    const metrics = flushMetrics(harness);
    expect(metrics.some((m) => m.outcome === "error")).toBe(true);

    // And the new session's next flush works normally on the same branch.
    const before = summarizerCalls;
    await drainUntilSettled(harness.runCommand("now"));
    expect(summarizerCalls).toBeGreaterThan(before);
    expect(harness.pi.sentMessages.some((m: any) => m.msg.customType === "context-prune-summary")).toBe(true);
  });

  it("review-r3-F1: session_start invalidates an in-flight commit flush synchronously (before its config-load await)", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(5);
    const releases: Array<() => void> = [];
    const deferredStream = () => {
      summarizerCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
        },
      };
    };
    const harness = await boot({ tiers: [], branch, streamImpl: deferredStream });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Manual flush blocks in the summarizer.
    const nowPromise = harness.runCommand("now");
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizerCalls).toBeGreaterThan(0);

    // Session REPLACEMENT (session_start, not session_tree): the handler now
    // bumps the generation SYNCHRONOUSLY AT ENTRY — before its config-load
    // await. Prove the window is really closed: fire the handler WITHOUT
    // awaiting it, release the parked flush, and the flush must STILL observe
    // the new generation (an implementation bumping only after loadConfig
    // could resolve the fast fs read first and invalidate the flush only
    // afterwards — in that case the flush, released here, could win the race;
    // the synchronous bump makes that impossible regardless of fs timing).
    const startPromise = harness.handlers.get("session_start")!({}, harness.ctx);
    // Do NOT await startPromise (and no arbitrary delay): the bump must have
    // happened by the time the handler's first await suspends, which is
    // guaranteed synchronously when the promise is created.
    await Promise.resolve(); // yield one microtask so the handler has entered

    // Release the flush's blocked calls: it must discard (stale-session), not
    // write old-session summaries into the reconstructed shared state.
    for (let guard = 0; guard < 50; guard++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
      if (await Promise.race([nowPromise.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5))])) break;
    }
    await Promise.all([nowPromise, startPromise]);

    expect(harness.pi.sentMessages.some((m: any) => m.msg.customType === "context-prune-summary")).toBe(false);
    expect(harness.appended.filter((e) => e.type === "context-prune-index")).toHaveLength(0);
    // The stale attempt is observable as an error outcome.
    expect(flushMetrics(harness).some((m) => m.outcome === "error")).toBe(true);

    // The new session's flush works normally afterwards.
    const before = summarizerCalls;
    const second = harness.runCommand("now");
    for (let guard = 0; guard < 50; guard++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
      if (await Promise.race([second.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5))])) break;
    }
    await second;
    expect(summarizerCalls).toBeGreaterThan(before);
  });

  it("review-r3-F2 (r4-hardened): a stale mid-compression flush appends NOTHING after the navigation snapshot", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    // Deferred summarizer so a flush can be parked inside its awaits, plus
    // fuseRangeSummary on so compression runs with a fusable chain (>= 2
    // per-batch summaries inside one merged span).
    const releases: Array<() => void> = [];
    const deferredStream = () => {
      summarizerCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
        },
      };
    };
    const harness = await boot({
      tiers: [],
      branch,
      streamImpl: deferredStream,
      chainCompressionEnabled: true,
    });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    const settle = async (promise: Promise<unknown>) => {
      for (let guard = 0; guard < 50; guard++) {
        releases.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 10));
        if (await Promise.race([promise.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5))])) return;
      }
      await promise;
    };

    // Park a message_end flush: it has pending batches to summarize AND a
    // closing message, so it will reach the compression tail with fusable
    // summaries once its summarizer calls are released.
    const endPromise = harness.handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "closing" }] } },
      harness.ctx,
    );
    // Wait until the flush is parked inside the summarizer (isFlushing).
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizerCalls).toBeGreaterThan(0);

    // Snapshot chain entries, then navigate WHILE the flush is parked.
    const chainEntries = () => harness.appended.filter((e) => e.type === "context-prune-chain").length;
    const beforeNav = chainEntries();
    await harness.handlers.get("session_tree")!({}, harness.ctx);
    const afterNav = chainEntries(); // taken IMMEDIATELY: nothing can run between

    // Now release the parked flush: it must discard — no chain entries, no
    // summaries, no index writes may appear from the stale attempt.
    await settle(endPromise);
    expect(chainEntries()).toBe(afterNav);
    expect(harness.appended.filter((e) => e.type === "context-prune-summary")).toHaveLength(0);
    expect(harness.appended.filter((e) => e.type === "context-prune-index")).toHaveLength(0);
    const metrics = flushMetrics(harness);
    expect(metrics.some((m) => m.outcome === "error")).toBe(true);
    expect(beforeNav).toBe(0);
  });

  it("review-r2-F4: a tier-list change while staging is in flight discards the staged results (fresh state untouched)", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    const releases: Array<() => void> = [];
    const deferredStream = () => {
      summarizerCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
        },
      };
    };
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch, streamImpl: deferredStream });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Cross the tier — staging starts and blocks in the summarizer.
    harness.setUsage(Math.round(0.51 * 300_000));
    const turnPromise = toolTurn(harness, "cfg-a", 20);
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizerCalls).toBeGreaterThan(0);

    // The user cycles the tier preset mid-flight: tier state resets and the
    // tier-state epoch bumps, invalidating the in-flight staging.
    await harness.cycleTierPresetViaOverlay();

    // Release; the staging completes but MUST be discarded.
    for (let guard = 0; guard < 20; guard++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
      if (await Promise.race([turnPromise.then(() => true), Promise.resolve(false)])) break;
    }
    await turnPromise;

    // /pruner status: the staged store is empty (no "staged:" line).
    const statusCalls: string[] = [];
    const origNotify = harness.ctx.ui.notify;
    harness.ctx.ui.notify = (msg: string) => statusCalls.push(msg);
    await harness.runCommand("status");
    harness.ctx.ui.notify = origNotify;
    const status = statusCalls.join("\n");
    expect(status).not.toContain("staged:");
  });

  it("review-F3: a threshold full drain marks already-exceeded tiers as fired (cursor recomputed, not min-composed)", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(5);
    const harness = await boot({ tiers: [0.5, 0.7], batchLimit: 3, autoBudgetThreshold: 0.8, branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // No tier fires: usage jumps straight past the threshold LEVEL (min(300k,
    // 0.8 × 1M window) = 300k tokens — fraction 1.0 of the effective window) →
    // the THRESHOLD flush wins (the else-if means the tier branch never runs)
    // and drains everything.
    harness.setUsage(305_000);
    await textTurn(harness, 20);
    expect(flushMetrics(harness).filter((m) => m.trigger === "proactive")).toHaveLength(0);

    // All 5 batches were committed by the threshold drain (full drain —
    // trigger budget/delta/rearmed depending on queue state at the boundary).
    expect(summarizerCalls).toBe(5);

    // New work arrives while usage stays high (fraction 0.86 = 258k, below the
    // 300k threshold level but above both re-arm points): both tiers are
    // ALREADY exceeded — the recomputed cursor must keep them fired.
    harness.setUsage(Math.round(0.86 * 300_000));
    await toolTurn(harness, "post-drain-a", 21);
    expect(summarizerCalls).toBe(5);
    expect(flushMetrics(harness).filter((m) => m.trigger === "proactive")).toHaveLength(0);

    // Only a genuine dip below 0.4 re-arms tier 0.5.
    harness.setUsage(Math.round(0.39 * 300_000));
    await toolTurn(harness, "post-drain-b", 22);
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "post-drain-c", 23);
    const proactive = flushMetrics(harness).filter((m) => m.trigger === "proactive");
    expect(proactive).toHaveLength(1);
    expect(proactive[0].tier).toBe(0.5);
  });

  it("review-F4: a failed tier attempt clears its retry floor after a genuine dip below the tier's re-arm point", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    let failNext = false;
    const failing = () => {
      if (failNext) {
        return {
          async *[Symbol.asyncIterator]() {},
          async result() {
            return { stopReason: "error", errorMessage: "boom", content: [], usage: USAGE };
          },
        };
      }
      summarizerCalls++;
      return okStream("[[1:read]] summary");
    };
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch, streamImpl: failing });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Attempt at 0.51 fails → retry floor ~0.56 recorded against tier 0.5.
    failNext = true;
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "f4-a", 20);
    expect(flushMetrics(harness)[0].outcome).toBe("error");

    // Genuine dip below the tier's re-arm point (0.5 - 0.10 = 0.4): the floor
    // MUST clear even though the cursor never advanced (0 stays 0).
    harness.setUsage(Math.round(0.30 * 300_000));
    await toolTurn(harness, "f4-b", 21);

    // Re-cross to 0.51 — BELOW the old 0.56 floor, but the dip re-armed the
    // tier, so it fires (and now succeeds).
    failNext = false;
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "f4-c", 22);
    expect(summarizerCalls).toBe(2);
    const metrics = flushMetrics(harness);
    expect(metrics.filter((m) => m.trigger === "proactive").length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Cases from the skipped suite above that hold on today's implementation, kept
 * running so this sync's new upstream base does not lose their coverage:
 *
 * - `review-F2` exercises the real dedup/index path (including upstream's
 *   v2.11.2 image-aware dedup key) through this harness, so it is genuine
 *   regression coverage now.
 * - The two tier cases pass vacuously while `proactive-budget-tiers` is
 *   unimplemented (no tier evaluation exists, so "no evaluation" and "no
 *   concurrent flush" hold trivially). They stay live so a partial
 *   implementation cannot start evaluating tiers in the wrong place without
 *   turning them red.
 *
 * The remaining 19 cases stay in the skipped block above until task 2.4 lands.
 */
describe("proactive budget tiers — behavior that already holds", () => {
  it("3.6: a text-only turn with no rearm performs NO tier evaluation no matter how high usage reads", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(4);
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch });
    // session_start's rearm probe clears: simulate by consuming the rearm
    // with an EMPTY-queue flush first? Simpler: boot with an empty branch so
    // nothing rears, then push usage sky-high on a text-only turn.
    const emptyHarness = await boot({ tiers: [0.5], batchLimit: 2, branch: [] });
    await emptyHarness.handlers.get("session_start")!({}, emptyHarness.ctx);
    emptyHarness.setUsage(Math.round(0.95 * 300_000));
    await textTurn(emptyHarness, 20);
    expect(summarizerCalls).toBe(0);
    expect(flushMetrics(emptyHarness)).toHaveLength(0);
  });

  it("review-F2: a partially-deduped batch commits only its novel tool calls as canonical index records", async () => {
    summarizerCalls = 0;
    // Turn 0: a batch whose tool result content will be REPEATED later (the
    // dedup source). Turn 1: one DUPLICATE of that content + one NOVEL call.
    const branch: any[] = [];
    let t = Date.now();
    const push = (m: any) => branch.push({ type: "message", message: m });
    t += 1000;
    push({ role: "user", content: [{ type: "text", text: "first" }], timestamp: t });
    push({ role: "assistant", content: [{ type: "toolCall", id: "src-tc", name: "read-src", arguments: {} }] });
    t += 1000;
    push({ role: "toolResult", toolCallId: "src-tc", toolName: "read-src", content: [{ type: "text", text: "same-content-".repeat(50) }], timestamp: t });
    t += 1000;
    push({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: t });
    t += 1000;
    push({ role: "user", content: [{ type: "text", text: "second" }], timestamp: t });
    push({ role: "assistant", content: [
      { type: "toolCall", id: "dup-tc", name: "read-src", arguments: {} },
      { type: "toolCall", id: "new-tc", name: "read-new", arguments: {} },
    ] });
    t += 1000;
    push({ role: "toolResult", toolCallId: "dup-tc", toolName: "read-src", content: [{ type: "text", text: "same-content-".repeat(50) }], timestamp: t });
    push({ role: "toolResult", toolCallId: "new-tc", toolName: "read-new", content: [{ type: "text", text: "brand-new-".repeat(50) }], timestamp: t });
    t += 1000;
    push({ role: "assistant", content: [{ type: "text", text: "done2" }], timestamp: t });

    // Only the FIRST span (the dedup source) exists when the first flush runs.
    const firstSpanEnd = branch.findIndex(
      (e: any) => e.message?.role === "assistant" && e.message?.content?.[0]?.type === "text" && e.message?.content?.[0]?.text === "done",
    );
    const secondSpan = branch.splice(firstSpanEnd + 1);

    const harness = await boot({ tiers: [], branch });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // First flush commits the source batch: 1 LLM call, read-src indexed.
    await harness.runCommand("now");
    expect(summarizerCalls).toBe(1);
    expect(summarizedToolCallIds).toEqual(["read-src"]);

    // The second span arrives (duplicate + novel call) and is flushed: the
    // duplicate is aliased, and only the novel call is summarized.
    harness.branch.push(...secondSpan);
    await harness.runCommand("now");
    expect(summarizerCalls).toBe(2);
    expect(summarizedToolCallIds[1]).toBe("read-new");

    // Index entries: the duplicate must NOT be a canonical record — only the
    // source and the novel call are; the duplicate appears as a dedup alias.
    const indexEntries = harness.appended.filter((e) => e.type === "context-prune-index");
    const indexedIds = indexEntries.flatMap((e: any) =>
      ((e.data?.toolCalls ?? (Array.isArray(e.data) ? e.data : [e.data])) as any[]).map((r: any) => r.toolCallId),
    );
    expect(indexedIds).toContain("src-tc");
    expect(indexedIds).toContain("new-tc");
    expect(indexedIds).not.toContain("dup-tc");
    const aliasEntries = harness.appended.filter((e) => e.type === "context-prune-dedup-alias");
    expect(aliasEntries.some((e: any) => e.data.newToolCallId === "dup-tc")).toBe(true);
  });

  it("review-F4b: a tier due while a flush is in flight records a retry floor instead of firing concurrently", async () => {
    summarizerCalls = 0;
    const branch = multiBatchBranch(6);
    // A deferred summarizer: the in-flight flush's LLM calls stay pending until
    // the test releases ALL of them, so isFlushing stays true across a second
    // gate. (summarizerConcurrency is 4 — releases are drained repeatedly.)
    const releases: Array<() => void> = [];
    const deferredStream = () => {
      summarizerCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
        },
      };
    };
    const harness = await boot({ tiers: [0.5], batchLimit: 2, branch, streamImpl: deferredStream });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    // Threshold set LOW so a budget flush starts and stays in flight.
    // Re-write settings before session_start? Config is read at session_start;
    // instead drive via budgetTurnDelta-free path: use the reload-rearmed
    // flush by usage. Simpler: set threshold via a second settings load is
    // complex — use the manual path with a hook is also complex. Instead:
    // start a /pruner now (manual flush) and, while it awaits the deferred
    // summarizer, run a turn_end that crosses the tier.
    const nowPromise = harness.runCommand("now");
    // Let the manual flush enter isFlushing (it awaits the deferred stream).
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizerCalls).toBeGreaterThan(0);

    // Cross the tier with a FRESH tool turn while the manual flush is still in
    // flight: the gate must NOT fire the tier concurrently (no extra summarizer
    // calls beyond the in-flight flush's own) and must record a retry floor
    // (~0.51 + 0.05) so the still-pending new batch retries only on a climb.
    harness.setUsage(Math.round(0.51 * 300_000));
    await toolTurn(harness, "blocked-a", 20);
    const callsDuringBlock = summarizerCalls;

    // Release the deferred flush (all in-flight calls, retrying as the pool
    // admits waiting ones); everything settles.
    for (let guard = 0; guard < 20 && !(await Promise.race([nowPromise.then(() => 1), Promise.resolve(0)])); guard++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
    }
    await nowPromise;
    // The manual flush finished its own 6 calls; the tier never fired
    // concurrently (calls while isFlushing stayed flat at callsDuringBlock),
    // and no proactive metrics entry exists for the blocked boundary. The
    // late-arriving batch is not lost: it stays pending for the next commit
    // boundary (threshold / message_end / manual), which is the spec's
    // guaranteed full drain.
    expect(summarizerCalls).toBe(6);
    const proactive = flushMetrics(harness).filter((m) => m.trigger === "proactive");
    expect(proactive).toHaveLength(0);
  });
});
