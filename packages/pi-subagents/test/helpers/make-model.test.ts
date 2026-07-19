import { describe, expect, it } from "vitest";
import { makeModel } from "./make-model";

describe("makeModel", () => {
  it("returns a fully-shaped Model<any> with defaults", () => {
    const model = makeModel();
    expect(model).toEqual({
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    });
  });

  it("applies overrides while keeping other defaults", () => {
    const model = makeModel({ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" });
    expect(model.id).toBe("claude-opus-4-6");
    expect(model.name).toBe("Claude Opus 4.6");
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBe(200000);
  });
});
