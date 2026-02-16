import { describe, expect, it } from "vitest";
import { findMatch } from "../src/index.js";

describe("fuzzy-match", () => {
	it("returns duplicate occurrence metadata without allocating split-based count", () => {
		const content = ["alpha", "beta", "alpha", "gamma", "alpha"].join("\n");
		const result = findMatch(content, "alpha", { allowFuzzy: true });
		expect(result.occurrences).toBe(3);
		expect(result.occurrenceLines).toEqual([1, 3, 5]);
		expect(result.occurrencePreviews?.length).toBe(3);
	});

	it("counts repeated matches as non-overlapping occurrences", () => {
		const result = findMatch("aaaa", "aa", { allowFuzzy: true });
		expect(result.occurrences).toBe(2);
	});

	it("returns exact match when unique", () => {
		const content = ["one", "two", "three"].join("\n");
		const result = findMatch(content, "two", { allowFuzzy: true });
		expect(result.match?.startLine).toBe(2);
		expect(result.match?.confidence).toBe(1);
	});
});
