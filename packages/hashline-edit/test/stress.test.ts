import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	formatHashLines,
	type HashlineEdit,
	streamHashLinesFromUtf8,
} from "../src/index.js";

describe("hashline-edit stress and regression", () => {
	it("applies large deterministic set_line edit batches", () => {
		const lineCount = 2_000;
		const fileLines = Array.from({ length: lineCount }, (_, index) => `let value_${index + 1} = ${index + 1};`);
		const content = fileLines.join("\n");

		const edits: HashlineEdit[] = [];
		for (let line = 15; line <= lineCount; line += 7) {
			const anchorHash = computeLineHash(line, fileLines[line - 1]);
			edits.push({
				set_line: {
					anchor: `${line}:${anchorHash}`,
					new_text: `let value_${line} = ${line}; // edited`,
				},
			});
		}

		const startedAt = Date.now();
		const result = applyHashlineEdits(content, edits);
		const elapsedMs = Date.now() - startedAt;

		expect(result.firstChangedLine).toBe(15);
		expect(elapsedMs).toBeLessThan(2_000);

		const updated = result.content.split("\n");
		for (let line = 15; line <= lineCount; line += 7) {
			expect(updated[line - 1]).toBe(`let value_${line} = ${line}; // edited`);
		}
	});

	it("keeps insert_after ordering stable under many descending anchors", () => {
		const fileLines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`);
		const content = fileLines.join("\n");
		const edits: HashlineEdit[] = [];

		for (let line = 10; line <= 120; line += 10) {
			const anchorHash = computeLineHash(line, fileLines[line - 1]);
			edits.push({
				insert_after: {
					anchor: `${line}:${anchorHash}`,
					text: `inserted-after-${line}`,
				},
			});
		}

		const result = applyHashlineEdits(content, edits);
		const updated = result.content.split("\n");
		for (let line = 10; line <= 120; line += 10) {
			const originalIndex = line - 1;
			const insertedIndex = originalIndex + line / 10;
			expect(updated[insertedIndex]).toBe(`inserted-after-${line}`);
		}
	});

	it("streamHashLinesFromUtf8 matches formatHashLines output for chunked utf8 input", async () => {
		const content = ["alpha", "βeta", "emoji-😀-line", "const value = 42;", "last-line", ""].join("\n");

		const bytes = Buffer.from(content, "utf8");
		const random = createPrng(0x5eed1234);
		const source = chunkedBytes(bytes, random);

		const chunks: string[] = [];
		for await (const chunk of streamHashLinesFromUtf8(source, { maxChunkLines: 2, maxChunkBytes: 64 })) {
			chunks.push(chunk);
		}

		const streamed = chunks.join("\n");
		expect(streamed).toBe(formatHashLines(content));
	});
});

async function* chunkedBytes(bytes: Buffer, random: () => number): AsyncGenerator<Uint8Array> {
	let offset = 0;
	while (offset < bytes.length) {
		const chunkSize = 1 + Math.floor(random() * 13);
		const next = Math.min(bytes.length, offset + chunkSize);
		yield bytes.subarray(offset, next);
		offset = next;
	}
}

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
