import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";
import { attachPane, MIN_ATTACHED_COLS_RIGHT, resetLayoutStoreForTests } from "../src/layout.ts";

const testApi = (subagentsModule as any).__test__;

describe("layout warning plumbing", () => {
	it("appendLayoutWarning suffixes tool text", () => {
		assert.equal(testApi.appendLayoutWarning("ok"), "ok");
		assert.match(
			testApi.appendLayoutWarning("ok", "Caller terminal too small; fell back to tab."),
			/Layout warning:.*too small|fell back to tab/i,
		);
	});

	it("min-size attach produces warning suitable for tool results", () => {
		resetLayoutStoreForTests();
		const result = attachPane(
			"parent",
			{ name: "Tiny", direction: "right" },
			{
				splitFn: () => {
					throw new Error("should not split");
				},
				tabCreateFn: () => "tab-pane",
				measure: { columns: MIN_ATTACHED_COLS_RIGHT - 1, rows: 40 },
			},
		);
		assert.equal(result.fellBackToTab, true);
		assert.match(result.warning ?? "", /too small|fell back to tab/i);
		// Same string the tool result will surface
		assert.match(testApi.appendLayoutWarning("Sub-agent launched", result.warning), /Layout warning:.*too small/i);
	});
});
