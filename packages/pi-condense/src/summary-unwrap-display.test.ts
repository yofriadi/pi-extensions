import { describe, it, expect } from "bun:test";
import { registerCommands } from "./commands.js";
import { buildPruneTree } from "./tree-browser.js";
import { DEFAULT_CONFIG, type ContextPruneConfig, type SummarizerStats } from "./types.js";
import { wrapSummaryForContext, SUMMARY_CONTEXT_OPEN, SUMMARY_CONTEXT_CLOSE } from "./summary-refs.js";
import type { ToolCallIndexer } from "./indexer.js";

// Display-surface unwrapping tests (tasks 4.1-4.3): the expanded renderer view
// and the /pruner tree browser both strip the summary-context wrapper before
// showing content to the user; legacy unwrapped content passes through
// unchanged.


describe("message renderer unwrapping (4.1)", () => {
  function setupRenderer() {
    let renderer: ((message: any, state: any, theme: any) => any) | undefined;
    const pi: any = {
      registerCommand() {},
      registerMessageRenderer(_type: string, fn: any) {
        renderer = fn;
      },
    };
    const currentConfig = { value: { ...DEFAULT_CONFIG, enabled: true } as ContextPruneConfig };
    registerCommands(
      pi,
      currentConfig,
      async () => ({ ok: false, reason: "empty" }),
      () => [],
      () => ({ callCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 } as SummarizerStats),
      () => undefined,
      {} as any,
      async () => ({ compressedEntries: [], skipped: 0 }),
      undefined,
      undefined,
      undefined,
      undefined,
    );
    return renderer!;
  }

  const theme = {
    fg: (_color: string, text: string) => text,
  };

  it("expanded view unwraps wrapped summary content", () => {
    const renderer = setupRenderer();
    const body = wrapSummaryForContext("did stuff");
    const out = renderer(
      { content: body, details: { toolCallRefs: [], turnIndex: 1, toolNames: [] } },
      { expanded: true },
      theme,
    );
    const lines = out.render(200);
    expect(lines.join("\n")).toContain("did stuff");
    expect(lines.join("\n")).not.toContain(SUMMARY_CONTEXT_OPEN);
    expect(lines.join("\n")).not.toContain(SUMMARY_CONTEXT_CLOSE);
  });

  it("legacy unwrapped content renders unchanged", () => {
    const renderer = setupRenderer();
    const out = renderer(
      { content: "old bare summary", details: { toolCallRefs: [], turnIndex: 1, toolNames: [] } },
      { expanded: true },
      theme,
    );
    const lines = out.render(200);
    expect(lines.join("\n")).toContain("old bare summary");
    expect(lines.join("\n")).not.toContain(SUMMARY_CONTEXT_OPEN);
  });

  it("collapsed view shows only the header (no body)", () => {
    const renderer = setupRenderer();
    const out = renderer(
      { content: wrapSummaryForContext("did stuff"), details: { toolCallRefs: [], turnIndex: 1, toolNames: [] } },
      { expanded: false },
      theme,
    );
    const lines = out.render(200);
    expect(lines.join("\n")).toContain("[pruner] Turn 1 summary (0 tools)");
    expect(lines.join("\n")).not.toContain("did stuff");
  });
});

describe("tree browser unwrapping (4.2)", () => {
  const summaryEntry = (content: string) => ({
    type: "custom_message",
    customType: "context-prune-summary",
    content,
    details: { toolCallRefs: [], toolCallIds: [], turnIndex: 1, toolNames: [], timestamp: 1700000000000 },
  });

  const ctx = (branch: any[]): any => ({
    sessionManager: { getBranch: () => branch },
  });

  const indexerStub = {
    getRecord: () => undefined,
  } as unknown as ToolCallIndexer;

  it("buildPruneTree unwraps content for the header char count and detail overlay", () => {
    const body = "did stuff";
    const nodes = buildPruneTree(ctx([summaryEntry(wrapSummaryForContext(body))]), indexerStub);
    expect(nodes).toHaveLength(1);
    // Header counts the body chars, not the wrapper.
    const bodyChars = body.length;
    expect(nodes[0].label).toContain(`${bodyChars} chars`);
    expect(nodes[0].detail).toBe(body);
    expect(nodes[0].charCount).toBe(bodyChars);
  });

  it("legacy unwrapped content passes through unchanged", () => {
    const body = "old bare summary";
    const nodes = buildPruneTree(ctx([summaryEntry(body)]), indexerStub);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].detail).toBe(body);
    expect(nodes[0].charCount).toBe(body.length);
  });

  it("legacy notice-line content inside the wrapper is stripped", () => {
    const legacy = [
      SUMMARY_CONTEXT_OPEN,
      "Internal pruner context; not a user request.",
      "Do not answer directly; use only for prior tool-output context.",
      "",
      "actual body",
      SUMMARY_CONTEXT_CLOSE,
    ].join("\n");
    const nodes = buildPruneTree(ctx([summaryEntry(legacy)]), indexerStub);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].detail).toBe("actual body");
  });
});
