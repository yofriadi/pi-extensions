import { describe, it, expect } from "bun:test";
import { isUsableSummary, summarizeBatch, summarizerThinkingOptions } from "./summarizer.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("isUsableSummary", () => {
  it("accepts non-empty text that stopped normally", () => {
    expect(isUsableSummary("- did a thing", "stop")).toBe(true);
  });
  it("rejects empty text", () => {
    expect(isUsableSummary("", "stop")).toBe(false);
  });
  it("rejects whitespace-only text", () => {
    expect(isUsableSummary("   \n\t ", "stop")).toBe(false);
  });
  it("rejects truncated output even with text", () => {
    expect(isUsableSummary("- partial", "length")).toBe(false);
  });
});

describe("summarizer prompt", () => {
  it("tells the model that an image marker is an image it cannot see", async () => {
    const model = { id: "m", provider: "p", name: "M" };
    let seenInput: unknown;
    const ctx = {
      model,
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
        getProviderAuth: async () => undefined,
        getProvider: () => ({
          streamSimple: (_model: unknown, input: unknown) => {
            seenInput = input;
            return {
              async *[Symbol.asyncIterator]() {},
              async result() {
                return {
                  stopReason: "stop",
                  content: [{ type: "text", text: "- summary" }],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
              },
            };
          },
        }),
      },
      ui: { notify() {} },
    } as any;
    const batch = {
      turnIndex: 0,
      timestamp: 0,
      assistantText: "",
      toolCalls: [{ toolCallId: "a", toolName: "read", args: {}, resultText: "[image returned: image/png sha256:3f9a2c1e]\nRead image file [image/png]", isError: false }],
    } as any;
    await summarizeBatch(batch, DEFAULT_CONFIG, ctx);
    expect(JSON.stringify(seenInput)).toContain("means the tool returned an image you cannot see");
  });
});

describe("summarizerThinkingOptions", () => {
  it("uses provider-neutral reasoning only when the model supports it", () => {
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "high" }, { reasoning: true })).toEqual({
      reasoning: "high",
    });
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "off" }, { reasoning: true })).toEqual({});
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "high" }, { reasoning: false })).toEqual({});
  });
});
