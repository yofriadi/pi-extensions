import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { filterAvailableAntigravityModels, validateAntigravityCatalog } from "../src/catalog-validation.ts";
import type { DiscoveredAntigravityModel } from "../src/model-discovery.ts";
import type { AntigravityCliSelection } from "../src/models.ts";

function discovered(id: string, internal = false): DiscoveredAntigravityModel {
	return {
		id,
		internal,
		recommended: false,
		supportsThinking: false,
		supportsImages: false,
		supportedMimeTypes: [],
	};
}

const selections: AntigravityCliSelection[] = [
	{ label: "Public", logicalModelId: "public", reasoning: "low", wireModelId: "public-low" },
	{ label: "Internal", logicalModelId: "internal", reasoning: "high", wireModelId: "internal-only" },
];

describe("Antigravity catalog validation", () => {
	it("excludes internal entries and reports unavailable CLI routes", () => {
		const result = validateAntigravityCatalog(
			[discovered("public-low"), discovered("internal-only", true)],
			selections,
		);
		expect([...result.availableModelIds]).toEqual(["public-low"]);
		expect(result.missingWireModelIds).toEqual(["internal-only"]);
		expect(result.internalSelectionWireModelIds).toEqual(["internal-only"]);
	});

	it("filters unavailable Antigravity logical models but preserves other providers", () => {
		const model = (id: string, provider: string): Model<Api> => ({
			id,
			name: id,
			api: "google-gemini-cli",
			provider,
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const filtered = filterAvailableAntigravityModels(
			[
				model("gemini-3.5-flash", "google-antigravity"),
				model("claude-opus-4-5", "google-antigravity"),
				model("other", "other"),
			],
			new Set(["gemini-3.5-flash-low"]),
		);
		expect(filtered.map((entry) => entry.id)).toEqual(["gemini-3.5-flash", "other"]);
	});
});
