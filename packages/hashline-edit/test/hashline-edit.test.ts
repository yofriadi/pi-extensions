import { describe, expect, it } from "vitest";
import { applyHashlineEdits, computeLineHash, parseLineRef } from "../src/index.js";
import { HashlineMismatchError } from "../src/types.js";

describe("hashline-edit", () => {
	it("uses whitespace-sensitive hashes", () => {
		const a = computeLineHash(1, "a b");
		const b = computeLineHash(1, "ab");
		expect(a).not.toBe(b);
	});

	it("requires exact 8-hex hash in line refs", () => {
		expect(parseLineRef("12:a3f19c2e")).toEqual({ line: 12, hash: "a3f19c2e" });
		expect(() => parseLineRef("12:ab")).toThrow(/8-hex hash/);
		expect(() => parseLineRef("12:zzzzzzzz")).toThrow(/8-hex hash/);
	});

	it("does not relocate stale anchors even when another line has the same hash", () => {
		const line = "same content";
		const hash = computeLineHash(1, line);

		const staleContent = ["changed content", line].join("\n");
		const edits = [
			{
				set_line: {
					anchor: `1:${hash}`,
					new_text: "edited",
				},
			},
		] as const;

		expect(() => applyHashlineEdits(staleContent, [...edits])).toThrow(HashlineMismatchError);
	});

	it("preserves input order for multiple insert_after edits on the same anchor", () => {
		const content = "a\nb\nc";
		const anchor = `2:${computeLineHash(2, "b")}`;
		const result = applyHashlineEdits(content, [
			{ insert_after: { anchor, text: "first" } },
			{ insert_after: { anchor, text: "second" } },
		]);

		expect(result.content).toBe("a\nb\nfirst\nsecond\nc");
	});

	it("applies insert_after after a same-line multi-line replacement block", () => {
		const content = "a\nb\nc";
		const anchor = `2:${computeLineHash(2, "b")}`;
		const result = applyHashlineEdits(content, [
			{ set_line: { anchor, new_text: "x\ny" } },
			{ insert_after: { anchor, text: "z" } },
		]);

		expect(result.content).toBe("a\nx\ny\nz\nc");
	});
});
