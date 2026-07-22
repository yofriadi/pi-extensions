import { describe, expect, it } from "vitest";
import {
	ANTIGRAVITY_CLI_MODELS,
	ANTIGRAVITY_CLI_SELECTIONS,
	ANTIGRAVITY_EXTRA_MODELS,
	ANTIGRAVITY_MODELS,
	getAntigravityRequestModelId,
	getAntigravityRequestModelIds,
} from "../src/models.ts";

describe("Antigravity CLI model parity", () => {
	it("routes the current public CLI choices to their observed backend IDs", () => {
		for (const selection of ANTIGRAVITY_CLI_SELECTIONS) {
			expect(getAntigravityRequestModelId(selection.logicalModelId, selection.reasoning)).toBe(
				selection.wireModelId,
			);
		}
	});

	it("exposes exactly the current CLI model families", () => {
		expect(ANTIGRAVITY_CLI_MODELS.map((model) => model.id).sort()).toEqual(
			[
				"claude-opus-4-6",
				"claude-sonnet-4-6",
				"gemini-3.1-pro",
				"gemini-3.5-flash",
				"gemini-3.6-flash",
				"gpt-oss-120b",
			].sort(),
		);
		expect(ANTIGRAVITY_EXTRA_MODELS).toEqual([]);
		expect(ANTIGRAVITY_CLI_MODELS.length).toBe(ANTIGRAVITY_MODELS.length);
	});

	it("lists every reachable wire ID for catalog comparison", () => {
		expect(getAntigravityRequestModelIds("gemini-3.5-flash").sort()).toEqual(
			["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"].sort(),
		);
	});
});
