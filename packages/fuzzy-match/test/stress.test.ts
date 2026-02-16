import { describe, expect, it } from "vitest";
import { findContextLine, findMatch, levenshteinDistance, seekSequence, similarity } from "../src/index.js";

describe("fuzzy-match stress and invariants", () => {
	it("keeps levenshtein/similarity invariants across random inputs", () => {
		const random = createPrng(0xdecafbad);

		for (let i = 0; i < 200; i += 1) {
			const a = randomString(random, 2 + Math.floor(random() * 24));
			const b = randomString(random, 2 + Math.floor(random() * 24));
			const c = randomString(random, 2 + Math.floor(random() * 24));

			const ab = levenshteinDistance(a, b);
			const ba = levenshteinDistance(b, a);
			const bc = levenshteinDistance(b, c);
			const ac = levenshteinDistance(a, c);

			expect(ab).toBe(ba);
			expect(levenshteinDistance(a, a)).toBe(0);
			expect(ac).toBeLessThanOrEqual(ab + bc);

			const simAB = similarity(a, b);
			const simBA = similarity(b, a);
			expect(simAB).toBeGreaterThanOrEqual(0);
			expect(simAB).toBeLessThanOrEqual(1);
			expect(Math.abs(simAB - simBA)).toBeLessThan(1e-12);
		}
	});

	it("finds target sequences near EOF in large files without timeout regressions", () => {
		const lineCount = 12_000;
		const lines = Array.from({ length: lineCount }, (_, index) => `const value_${index} = ${index};`);
		const targetIndex = lineCount - 8;
		const pattern = lines.slice(targetIndex, targetIndex + 4);

		const startedAt = Date.now();
		const result = seekSequence(lines, pattern, 0, true, { allowFuzzy: true });
		const elapsedMs = Date.now() - startedAt;

		expect(result.index).toBe(targetIndex);
		expect(result.confidence).toBeGreaterThanOrEqual(0.99);
		expect(elapsedMs).toBeLessThan(1_500);
	});

	it("reports repeated matches in large content and keeps context fallback behavior", () => {
		const repeated = Array.from({ length: 4_000 }, (_, index) => (index % 150 === 0 ? "needle" : `line-${index}`)).join(
			"\n",
		);
		const match = findMatch(repeated, "needle", { allowFuzzy: true });
		expect(match.occurrences).toBeGreaterThan(20);
		expect(match.match).toBeUndefined();

		const lines = ["function compute(", "value: number", "): number {"];
		const contextResult = findContextLine(lines, "function compute()", 0, { allowFuzzy: true });
		expect(contextResult.index).toBe(0);
		expect(["prefix", "fuzzy"]).toContain(contextResult.strategy);
	});
});

function createPrng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomString(random: () => number, length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_ -";
	let output = "";
	for (let i = 0; i < length; i += 1) {
		output += alphabet[Math.floor(random() * alphabet.length)] ?? "a";
	}
	return output;
}
