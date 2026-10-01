import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotateReadOutput } from "../../src/lib/annotate";
import type { HashlineCompat } from "../../src/lib/hashline-bridge";

/**
 * Deterministic fake compat: exposes the hashline-edit lines for known
 * fixture paths and records commits. Hashes are faked ("XX") — the
 * recognizer's job is line-level verification and rewriting, and the anchor
 * bits are pi-hashline-edit's (covered by its own compat tests).
 */
function makeFakeCompat(files: Map<string, string[]>): HashlineCompat & {
	commits: Map<string, string>;
} {
	const commits = new Map<string, string>();
	return {
		commits,
		readNormalizedForAnnotate: async (path) => {
			const lines = files.get(path);
			if (!lines) return null;
			return { normalized: lines.join("\n"), lines };
		},
		commitExternalRead: async (path, normalized) => {
			commits.set(path, normalized);
		},
		mintAnchor: () => "XX",
	};
}

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf-8");

describe("annotate — full view", () => {
	it("annotates a small full-file read and commits the snapshot", async () => {
		const output = fixture("read-full.txt");
		const raw = fixture("read-full-source-hashline.ts.txt").split("\n");
		// readNormalizedForAnnotate semantics: drop the trailing empty element
		// produced by a final newline.
		const disk = raw.at(-1) === "" ? raw.slice(0, -1) : raw;
		const files = new Map([["/x/hashline.ts", disk]]);
		const compat = makeFakeCompat(files);

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(22 lines/, "# /x/hashline.ts (22 lines"),
			targetPaths: ["/x/hashline.ts"],
			compat,
		});

		const lines = result.split("\n");
		// Header untouched
		expect(lines[0]).toContain("[full]");
		// Every content line now carries an anchor
		expect(lines[2]).toMatch(/^1#XX:/);
		expect(lines[2]).toBe(`1#XX:${disk[0]}`);
		const last = disk.length - 1;
		expect(lines[2 + last]).toBe(`${last + 1}#XX:${disk[last]}`);
		// Committed exactly once with the full normalized content
		expect(compat.commits.get("/x/hashline.ts")).toBe(disk.join("\n"));
	});

	it("annotates a no-trailing-newline full read including its final line", async () => {
		// Fixture (captured live): a file without a final \n ends the block
		// with content and no trailing blank — the final line must verify and
		// receive an anchor like every other line.
		const output = fixture("read-full-no-trailing-newline.txt");
		const disk = ["no trailing", "second"];
		const compat = makeFakeCompat(new Map([["/x/notrail.txt", disk]]));

		const result = await annotateReadOutput({
			output: output.replace("# /tmp/tilth-review/notrail.txt", "# /x/notrail.txt"),
			targetPaths: ["/x/notrail.txt"],
			compat,
		});

		const lines = result.split("\n");
		expect(lines[2]).toBe("1#XX:no trailing");
		expect(lines[3]).toBe("2#XX:second");
		expect(compat.commits.get("/x/notrail.txt")).toBe("no trailing\nsecond");
	});

	it("passes through untouched on mismatch (file changed since read)", async () => {
		const output = fixture("read-full.txt").replace(/# \S+ \(22 lines/, "# /x/hashline.ts (22 lines");
		const drifted = ["completely", "different", "content"];
		const compat = makeFakeCompat(new Map([["/x/hashline.ts", drifted]]));

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/hashline.ts"],
			compat,
		});

		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("passes through when the file is unreadable (readNormalizedForAnnotate null)", async () => {
		const output = fixture("read-full.txt").replace(/# \S+ \(22 lines/, "# /x/hashline.ts (22 lines");
		const compat = makeFakeCompat(new Map());

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/hashline.ts"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("annotates truncated full reads' verified prefix and commits the snapshot", async () => {
		// Fixture: big.ts full read cut at budget → `... truncated (...)` tail.
		const output = fixture("read-full-truncated.txt");
		const disk = Array.from(
			{ length: 2001 },
			(_, i) => `line ${i + 1} some code content here for probing elisions in long output`,
		);
		const compat = makeFakeCompat(new Map([["/x/big.ts", disk]]));

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(2001 lines/, "# /x/big.ts (2001 lines"),
			targetPaths: ["/x/big.ts"],
			compat,
		});

		const lines = result.split("\n");
		const markerIdx = lines.findIndex((l) => l.startsWith("... truncated"));
		expect(markerIdx).toBeGreaterThan(0);
		// Lines before the marker are annotated...
		expect(lines[2]).toMatch(/^1#XX:/);
		// ...and the marker itself is untouched.
		expect(lines[markerIdx]).toContain("truncated");
		// The verified prefix commits the same semantics as a native truncated
		// read — anchors minted against a later edit must resolve.
		expect(compat.commits.get("/x/big.ts")).toBe(disk.join("\n"));
	});
});

describe("annotate — section view", () => {
	it("annotates guttered section lines with their real numbers", async () => {
		const output = fixture("read-section.txt");
		const disk = Array.from(
			{ length: 2001 },
			(_, i) => `line ${i + 1} some code content here for probing elisions in long output`,
		);
		const compat = makeFakeCompat(new Map([["/x/big.ts", disk]]));

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(11 lines/, "# /x/big.ts (11 lines"),
			targetPaths: ["/x/big.ts"],
			compat,
		});

		const lines = result.split("\n");
		expect(lines[2]).toBe("995#XX:line 995 some code content here for probing elisions in long output");
		expect(lines[3]).toBe("996#XX:line 996 some code content here for probing elisions in long output");
		expect(compat.commits.get("/x/big.ts")).toBe(disk.join("\n"));
	});

	it("annotates multi-section output (─── lines X-Y ─── delimiters)", async () => {
		const output = fixture("read-sections-multi.txt");
		const disk = fixture("read-full-source-hashline.ts.txt").replace(/\r\n/g, "\n").split("\n");
		// disk has 23 elements (split keeps the trailing ""); sections cover 1-5 and 10-12.
		const compat = makeFakeCompat(new Map([["/x/hashline.ts", disk]]));

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(8 lines/, "# /x/hashline.ts (8 lines"),
			targetPaths: ["/x/hashline.ts"],
			compat,
		});

		const lines = result.split("\n");
		// Delimiter untouched
		expect(lines[2]).toBe("─── lines 1-5 ───");
		expect(lines[3]).toBe(`1#XX:${disk[0]}`);
		// Second block keeps the delimiter and annotates its lines
		const delimIdx = lines.indexOf("─── lines 10-12 ───");
		expect(delimIdx).toBeGreaterThan(0);
		expect(lines[delimIdx + 1]).toBe(`10#XX:${disk[9]}`);
		expect(lines[delimIdx + 2]).toBe(`11#XX:${disk[10]}`);
		expect(lines[delimIdx + 3]).toBe(`12#XX:${disk[11]}`);
		expect(compat.commits.get("/x/hashline.ts")).toBe(disk.join("\n"));
	});

	it("passes through when a gutter number is non-contiguous", async () => {
		const output = ["# /x/a.ts (3 lines, ~7 tokens) [section]", "", "1  one", "3  three", "4  four", ""].join("\n");
		const disk = ["one", "two", "three", "four"];
		const compat = makeFakeCompat(new Map([["/x/a.ts", disk]]));

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/a.ts"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});
});

describe("annotate — non-annotatable views", () => {
	it("leaves outline output untransformed and the store untouched", async () => {
		const output = fixture("read-signature-outline.txt");
		const disk = ["x"];
		const compat = makeFakeCompat(new Map([["/x/edit.ts", disk]]));

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(780 lines/, "# /x/edit.ts (780 lines"),
			targetPaths: ["/x/edit.ts"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("leaves generated-skipped sentinels untouched", async () => {
		const output = fixture("read-generated-skipped.txt");
		const compat = makeFakeCompat(new Map());

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/pnpm-lock.yaml"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("leaves empty-file output untouched", async () => {
		const output = fixture("read-empty-and-sentinel.txt");
		const compat = makeFakeCompat(new Map());

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/empty.txt", "/x/sentinel.txt"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("leaves stripped output untouched", async () => {
		const output = fixture("read-stripped.txt");
		const disk = ["# Title", "", "// a comment", "real code", "", "// debug", "more code", ""];
		const compat = makeFakeCompat(new Map([["/x/comments.ts", disk]]));

		const result = await annotateReadOutput({
			output: output.replace(/# \S+ \(8 lines/, "# /x/comments.ts (8 lines"),
			targetPaths: ["/x/comments.ts"],
			compat,
		});
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});
});

describe("annotate — multi-path independence", () => {
	it("annotates and commits CRLF multi-path output (full view preserves \r; anchors embed the \r-stripped form)", async () => {
		const output = fixture("read-multi-crlf.txt");
		// Ground truth (fixture bytes, re-captured live): tilth's full view
		// PRESERVES the \r of CRLF files (`a\r\nb\r\n`), while compat's
		// normalized lines are \r-free. The verifier strips one trailing \r
		// from each shown line so both views verify; anchors carry the
		// \r-stripped content, matching native hashline reads.
		const diskA = ["a", "b"];
		const diskB = ["x1", "x2"];
		const compat = makeFakeCompat(
			new Map([
				["/x/crlf.txt", diskA],
				["/x/crlf2.txt", diskB],
			]),
		);

		const result = await annotateReadOutput({
			output: output
				.replace("# /tmp/tilth-review/crlf.txt", "# /x/crlf.txt")
				.replace("# /tmp/tilth-review/crlf2.txt", "# /x/crlf2.txt"),
			targetPaths: ["/x/crlf.txt", "/x/crlf2.txt"],
			compat,
		});

		const lines = result.split("\n");
		// Content lines keep their positions; \r is stripped in the anchor form.
		expect(lines[2]).toBe("1#XX:a");
		expect(lines[3]).toBe("2#XX:b");
		expect(lines[8]).toBe("1#XX:x1");
		expect(lines[9]).toBe("2#XX:x2");
		expect(compat.commits.get("/x/crlf.txt")).toBe("a\nb");
		expect(compat.commits.get("/x/crlf2.txt")).toBe("x1\nx2");
	});

	it("annotates every verifying file of a multi-path read", async () => {
		const output = [
			"# /x/a.txt (2 lines, ~7 tokens) [full]",
			"",
			"alpha",
			"beta",
			"",
			"# /x/b.txt (2 lines, ~7 tokens) [full]",
			"",
			"gamma",
			"delta",
			"",
		].join("\n");
		const compat = makeFakeCompat(
			new Map([
				["/x/a.txt", ["alpha", "beta"]],
				["/x/b.txt", ["gamma", "delta"]],
			]),
		);

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/a.txt", "/x/b.txt"],
			compat,
		});

		const lines = result.split("\n");
		expect(lines[2]).toBe("1#XX:alpha");
		expect(lines[3]).toBe("2#XX:beta");
		expect(lines[7]).toBe("1#XX:gamma");
		expect(lines[8]).toBe("2#XX:delta");
		expect(compat.commits.get("/x/a.txt")).toBe("alpha\nbeta");
		expect(compat.commits.get("/x/b.txt")).toBe("gamma\ndelta");
	});

	it("keeps verifying files when a sibling drifted (multi-file drift independence)", async () => {
		// hashline-compat spec Scenario: Multi-file read — a file that fails
		// verification passes through unannotated and uncommitted without
		// affecting the others.
		const output = [
			"# /x/good.txt (2 lines, ~7 tokens) [full]",
			"",
			"good alpha",
			"good beta",
			"",
			"# /x/bad.txt (2 lines, ~7 tokens) [full]",
			"",
			"stale content",
			"second line",
			"",
		].join("\n");
		const compat = makeFakeCompat(
			new Map([
				["/x/good.txt", ["good alpha", "good beta"]],
				["/x/bad.txt", ["different", "content"]],
			]),
		);

		const result = await annotateReadOutput({
			output,
			targetPaths: ["/x/good.txt", "/x/bad.txt"],
			compat,
		});

		const lines = result.split("\n");
		// The good file is fully annotated...
		expect(lines[2]).toBe("1#XX:good alpha");
		expect(lines[3]).toBe("2#XX:good beta");
		// ...the drifted sibling is verbatim and uncommitted...
		expect(lines[7]).toBe("stale content");
		expect(lines[8]).toBe("second line");
		// ...and only the good file committed.
		expect(compat.commits.get("/x/good.txt")).toBe("good alpha\ngood beta");
		expect(compat.commits.has("/x/bad.txt")).toBe(false);
	});

	it("annotates whitespace-edge multi-path output (tabs, trailing spaces, no-trailing-newline, ends-with-blank)", async () => {
		// Live-captured: three whitespace edge shapes in one call. The
		// verifier compares raw shown text — trailing spaces survive on disk
		// and must verify byte-equal (hashline's trimEnd applies only inside
		// hash input, never to display or verification).
		const output = fixture("read-multi-whitespace.txt");
		// Real compat semantics: a 3-line file with trailing newline →
		// [l1, l2, l3] (split's trailing empty is dropped), so tilth's
		// "(4 lines)" header counts a phantom blank that is NOT a content
		// line — it stays unannotated (read-multi-crlf exercises the cap).
		const diskWs = ["tabbed:\there", "trailing:   ", "  indented\tline"];
		const diskNt = ["no trailing", "second line"];
		const diskEwb = ["ends with blank", ""];
		const compat = makeFakeCompat(
			new Map([
				["/x/ws.txt", diskWs],
				["/x/nt.txt", diskNt],
				["/x/ewb.txt", diskEwb],
			]),
		);

		const result = await annotateReadOutput({
			output: output
				.replace("# /tmp/tilth-review/ws.txt", "# /x/ws.txt")
				.replace("# /tmp/tilth-review/nt.txt", "# /x/nt.txt")
				.replace("# /tmp/tilth-review/ewb.txt", "# /x/ewb.txt"),
			targetPaths: ["/x/ws.txt", "/x/nt.txt", "/x/ewb.txt"],
			compat,
		});

		const lines = result.split("\n");
		// ws.txt: tabs and trailing spaces verify byte-equal.
		expect(lines[2]).toBe("1#XX:tabbed:\there");
		expect(lines[3]).toBe("2#XX:trailing:   ");
		expect(lines[4]).toBe("3#XX:  indented\tline");
		// The phantom blank after line 3 is not a content line — no anchor.
		expect(lines[5]).toBe("");
		// nt.txt: the final line of a no-trailing-newline file is verified.
		const ntIdx = lines.findIndex((l) => l.startsWith("# /x/nt.txt"));
		expect(ntIdx).toBeGreaterThan(0);
		expect(lines[ntIdx + 2]).toBe("1#XX:no trailing");
		expect(lines[ntIdx + 3]).toBe("2#XX:second line");
		// ewb.txt: a content line that is itself blank receives an anchor.
		const ewbIdx = lines.findIndex((l) => l.startsWith("# /x/ewb.txt"));
		expect(ewbIdx).toBeGreaterThan(0);
		expect(lines[ewbIdx + 2]).toBe("1#XX:ends with blank");
		expect(lines[ewbIdx + 3]).toBe("2#XX:");
		expect(compat.commits.get("/x/ws.txt")).toBe(diskWs.join("\n"));
		expect(compat.commits.get("/x/nt.txt")).toBe(diskNt.join("\n"));
		expect(compat.commits.get("/x/ewb.txt")).toBe(diskEwb.join("\n"));
	});
});

describe("annotate — [shown earlier] elision passthrough", () => {
	it("passes an elided full-view body through untouched and commits nothing", async () => {
		const disk = ["line one", "line two", "line three", "line four"];
		const compat = makeFakeCompat(new Map([["/x/elided.ts", disk]]));
		// A repeat read whose body was replaced by tilth's connection-scoped
		// dedup marker instead of the real content.
		const output = ["# /x/elided.ts (4 lines, ~40 tokens) [full]", "", "[shown earlier]", ""].join("\n");
		const result = await annotateReadOutput({ output, targetPaths: ["/x/elided.ts"], compat });
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});

	it("passes a bare elision response (no header) through untouched", async () => {
		const compat = makeFakeCompat(new Map([["/x/elided.ts", ["a", "b"]]]));
		const output = "[shown earlier]";
		const result = await annotateReadOutput({ output, targetPaths: ["/x/elided.ts"], compat });
		expect(result).toBe(output);
		expect(compat.commits.size).toBe(0);
	});
});
