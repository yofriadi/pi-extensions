import type { ThinkingLevel } from "@earendil-works/pi-ai";
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
				"gemini-3.7-flash",
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
		expect(getAntigravityRequestModelIds("gemini-3.7-flash")).toEqual(["gemini-3.7-flash-tiered"]);
	});

	it("routes efforts above the highest configured rung to the strongest route", () => {
		// `xhigh` sits above every configured rung, and newer pi releases add a
		// stronger `max` level that this package's pi-ai version does not declare.
		const aboveHighestRung: ThinkingLevel[] = ["xhigh", "max" as ThinkingLevel];
		for (const effort of aboveHighestRung) {
			expect(getAntigravityRequestModelId("gemini-3.6-flash", effort)).toBe("gemini-3.6-flash-high");
			expect(getAntigravityRequestModelId("gemini-3.5-flash", effort)).toBe("gemini-3-flash-agent");
			expect(getAntigravityRequestModelId("gemini-3.1-pro", effort)).toBe("gemini-pro-agent");
			expect(getAntigravityRequestModelId("claude-opus-4-6", effort)).toBe("claude-opus-4-6-thinking");
		}
	});

	it("falls back to the nearest configured rung below the requested effort", () => {
		expect(getAntigravityRequestModelId("gemini-3.1-pro", "medium")).toBe("gemini-3.1-pro-low");
	});
});
