import { describe, it, expect } from "bun:test";
import { isUsableSummary, summarizerThinkingOptions } from "./summarizer.js";
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

describe("summarizerThinkingOptions", () => {
  it("uses provider-neutral reasoning only when the model supports it", () => {
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "high" }, { reasoning: true })).toEqual({
      reasoning: "high",
    });
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "off" }, { reasoning: true })).toEqual({});
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "high" }, { reasoning: false })).toEqual({});
  });
});
