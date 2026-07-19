/**
 * make-model.ts — Test fixture builder for the SDK `Model<any>` type.
 *
 * Model resolution tests only vary `id` / `name` / `provider`; this builder fills
 * the remaining SDK-required fields with inert defaults so fixtures satisfy the
 * real `Model<any>` shape without every test call site repeating them.
 */
import type { Model } from "@earendil-works/pi-ai";

export function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
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
    ...overrides,
  };
}
