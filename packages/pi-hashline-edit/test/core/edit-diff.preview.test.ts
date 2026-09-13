import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import {
	computePatchRelativePath,
	generateDiffString,
	generateUnifiedPatch,
	quotePatchHeaderPath,
} from "../../src/edit-diff";
import { __resetConfigForTests, __setHashLengthForTests } from "../../src/config";

describe("generateDiffString", () => {
	afterEach(() => {
		__resetConfigForTests();
	});

	it("adds hash hints for context and addition lines but not deletions", () => {
		const diff = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma").diff;

		expect(diff).toContain(" 1#");
		expect(diff).toContain(":alpha");
		expect(diff).toContain("+2#");
		expect(diff).toContain(":BETA");
		expect(diff).toContain("-2    beta");
		expect(diff).toContain(" 3#");
		expect(diff).toContain(":gamma");
	});

	// Regression test for #32: deletion lines have no hash, so their padding
	// must match the `#<hash>:` prefix width, which varies with hashLength.
	it.each([2, 3, 4] as const)(
		"aligns deletion line content with hashed lines at hashLength=%i",
		(hashLength) => {
			__setHashLengthForTests(hashLength);
			const diff = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma").diff;
			const lines = diff.split("\n");

			const contentColumn = (line: string, text: string) => line.indexOf(text);
			const contextCol = contentColumn(
				lines.find((l) => l.startsWith(" 1#"))!,
				"alpha",
			);
			const addedCol = contentColumn(lines.find((l) => l.startsWith("+2#"))!, "BETA");
			const removedCol = contentColumn(lines.find((l) => l.startsWith("-2"))!, "beta");

			expect(addedCol).toBe(contextCol);
			expect(removedCol).toBe(contextCol);
		},
	);
});

describe("generateUnifiedPatch", () => {
	it("emits git-style headers and a hunks body", () => {
		const patch = generateUnifiedPatch(
			"alpha\nbeta\ngamma\n",
			"alpha\nBETA\ngamma\n",
			"src/foo.ts",
		);

		expect(patch).toBe(
			"--- a/src/foo.ts\n" +
				"+++ b/src/foo.ts\n" +
				"@@ -1,3 +1,3 @@\n" +
				" alpha\n" +
				"-beta\n" +
				"+BETA\n" +
				" gamma\n",
		);
	});

	it("emits explicit single-line hunk counts (jsdiff convention)", () => {
		const patch = generateUnifiedPatch("one\n", "ONE\n", "f.txt");

		expect(patch).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n");
	});

	it("emits multiple hunks when changes are far apart", () => {
		const patch = generateUnifiedPatch(
			"a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\na11\na12\na13\na14\na15\n",
			"X1\na2\na3\na4\na5\na6\na7\na8\na9\na10\na11\na12\na13\na14\nY15\n",
			"f.txt",
		);

		expect(patch.match(/^@@/gm)).toHaveLength(2);
		expect(patch).toContain("@@ -1,5 +1,5 @@");
		expect(patch).toContain("@@ -11,5 +11,5 @@");
	});

	it("returns empty string for identical contents", () => {
		expect(generateUnifiedPatch("x\ny", "x\ny", "f.txt")).toBe("");
	});

	it("marks missing trailing newlines", () => {
		const patch = generateUnifiedPatch("x\ny", "x\nz", "f.txt");

		expect(patch).toContain("-y\n\\ No newline at end of file");
		expect(patch).toContain("+z\n\\ No newline at end of file");
	});

	it.each(["app.ts", "space name.txt", "tab\tname.txt", "line\nname.txt", "ctrl\u0001name.txt"])(
		"applies via git apply for %s",
		async (fileName) => {
			const before = "line1\nline2\nline3\nline4\nline5\n";
			const after = "line1\nCHANGED\nline3\nline4\nline5\nNEW\n";
			const patch = generateUnifiedPatch(before, after, fileName);

			const { execFile } = await import("node:child_process");
			const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const dir = await mkdtemp(join(tmpdir(), "pi-hashline-patch-"));
			try {
				await writeFile(join(dir, fileName), before);
				await writeFile(join(dir, "change.patch"), patch);
				await new Promise<void>((resolve, reject) => {
					execFile("git", ["apply", "change.patch"],
						{ cwd: dir }, (error) => (error ? reject(error) : resolve()));
				});
				expect(await readFile(join(dir, fileName), "utf8")).toBe(after);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("computePatchRelativePath", () => {
	it("resolves targets inside the patch root", () => {
		expect(computePatchRelativePath("/proj/src/foo.ts", "/proj")).toBe("src/foo.ts");
		expect(computePatchRelativePath("/proj/foo.txt", "/proj")).toBe("foo.txt");
	});

	it("returns null for targets outside the patch root", () => {
		expect(computePatchRelativePath("/outside.txt", "/proj")).toBeNull();
		expect(computePatchRelativePath("/proj2/x.txt", "/proj")).toBeNull();
	});

	it("does not mistake a sibling directory named like .. for an escape", () => {
		// `..foo` is a legal directory name; only exact ".." segments escape.
		expect(computePatchRelativePath("/proj/..foo/x.txt", "/proj")).toBe("..foo/x.txt");
	});

	it("normalizes backslashes to forward slashes on win32", () => {
		expect(computePatchRelativePath("C:\\proj\\src\\f.txt", "C:\\proj", path.win32)).toBe("src/f.txt");
	});

	it("returns null for cross-drive or escaped targets on win32", () => {
		expect(computePatchRelativePath("D:\\other\\f.txt", "C:\\proj", path.win32)).toBeNull();
		expect(computePatchRelativePath("C:\\other\\f.txt", "C:\\proj", path.win32)).toBeNull();
	});

	it("allows special characters in paths (git C-quoting handles them)", () => {
		expect(computePatchRelativePath("/proj/tab\tname.txt", "/proj")).toBe("tab\tname.txt");
		expect(computePatchRelativePath("/proj/line\nname.txt", "/proj")).toBe("line\nname.txt");
		expect(computePatchRelativePath("/proj/ctrl\u0001name.txt", "/proj")).toBe("ctrl\u0001name.txt");
	});

	it("allows spaces in paths (git-native)", () => {
		expect(computePatchRelativePath("/proj/space name.txt", "/proj")).toBe("space name.txt");
	});
});

describe("quotePatchHeaderPath", () => {
	it("leaves header-safe paths untouched", () => {
		expect(quotePatchHeaderPath("a/src/space name.txt")).toBe("a/src/space name.txt");
	});

	it("quotes and octal-escapes control characters", () => {
		expect(quotePatchHeaderPath("a/tab\tname.txt")).toBe('"a/tab\\011name.txt"');
		expect(quotePatchHeaderPath("a/line\nname.txt")).toBe('"a/line\\012name.txt"');
		expect(quotePatchHeaderPath("a/ctrl\u0001name.txt")).toBe('"a/ctrl\\001name.txt"');
	});

	it("escapes quotes and backslashes inside quoted paths", () => {
		expect(quotePatchHeaderPath('a/q"uote.txt')).toBe('"a/q\\"uote.txt"');
		expect(quotePatchHeaderPath("a/back\\slash.txt")).toBe('"a/back\\\\slash.txt"');
	});
});
