import { describe, expect, it, vi } from "vitest";
import { discoverAntigravityModels } from "../src/model-discovery.ts";

describe("Antigravity model discovery", () => {
	it("normalizes the successful catalog response without account or quota data", async () => {
		const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access-token");
			expect(init?.body).toBe("{}");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(
				JSON.stringify({
					models: {
						"gemini-3.5-flash-extra-low": {
							displayName: "Gemini 3.5 Flash (Low)",
							isInternal: false,
							maxTokens: 1048576,
							maxOutputTokens: 65536,
							recommended: true,
							supportsThinking: true,
							supportsImages: true,
							thinkingBudget: 1000,
							minThinkingBudget: 32,
							supportedMimeTypes: { "image/png": true, "text/plain": true, "image/gif": false },
							quotaInfo: { remainingFraction: 0.5 },
						},
					},
					projectId: "must-not-survive",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const catalog = await discoverAntigravityModels({
			accessToken: "test-access-token",
			fetchImplementation,
			signal: AbortSignal.timeout(1000),
		});

		expect(fetchImplementation).toHaveBeenCalledOnce();
		expect(catalog.endpoint).toBe("https://daily-cloudcode-pa.googleapis.com");
		expect(catalog.models).toEqual([
			{
				id: "gemini-3.5-flash-extra-low",
				displayName: "Gemini 3.5 Flash (Low)",
				internal: false,
				recommended: true,
				contextWindow: 1048576,
				maxOutputTokens: 65536,
				supportsThinking: true,
				supportsImages: true,
				thinkingBudget: 1000,
				minThinkingBudget: 32,
				supportedMimeTypes: ["image/png", "text/plain"],
			},
		]);
		expect(JSON.stringify(catalog)).not.toContain("quotaInfo");
		expect(JSON.stringify(catalog)).not.toContain("must-not-survive");
		expect(JSON.stringify(catalog)).not.toContain("test-access-token");
	});
});
