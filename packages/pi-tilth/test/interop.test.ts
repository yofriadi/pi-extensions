/**
 * Real interop: pi-tilth's annotator driving the actual
 * `pi-hashline-edit/compat` module (workspace devDep — no mocks), committing
 * reads that a native hashline edit can then resolve.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import through the package root to prove the exports map also serves ".".
import * as hashlineEditRoot from "pi-hashline-edit";
import { COMPAT_VERSION, isHashlineEditActive, setHashlineEditActive } from "pi-hashline-edit/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Edit-pipeline import is a relative source import (same repo, workspace
// devDep): the "." entry intentionally exports only the extension factory,
// and the flagship interop scenario must drive the real edit path.
import { computeEditPreview } from "../../pi-hashline-edit/src/edit.ts";
import { annotateReadOutput } from "../src/lib/annotate";
import { isCompatActive, resetCompatModule, resolveCompatModule } from "../src/lib/hashline-bridge";

describe("hashline-bridge — real module resolution", () => {
	it("resolves the compat module through the exports map", async () => {
		resetCompatModule();
		const mod = await resolveCompatModule();
		expect(mod).not.toBeNull();
		expect(mod?.COMPAT_VERSION).toBe(COMPAT_VERSION);
	});

	it("compat activation follows the real activity flag and config switch", async () => {
		const mod = await resolveCompatModule();
		expect(mod).not.toBeNull();
		// The flag state is whatever the loaded pi-hashline-edit module has; the
		// per-call gate must honor it exactly.
		expect(isCompatActive(mod, true)).toBe(isHashlineEditActive());
		expect(isCompatActive(mod, false)).toBe(false);
	});

	it("package root export resolves (exports map '.' entry)", () => {
		expect(hashlineEditRoot).toBeDefined();
	});
});

describe("interop — verify-then-commit with the real compat", () => {
	let dir: string;

	beforeEach(async () => {
		resetCompatModule();
		dir = await mkdtemp(join(tmpdir(), "pi-tilth-interop-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		setHashlineEditActive(false);
	});

	it("annotates a section read and registers a snapshot identical to a native read", async () => {
		const file = join(dir, "code.ts");
		const content = [
			"export function alpha(): number {",
			"\treturn 1;",
			"}",
			"",
			"export function beta(): number {",
			"\treturn alpha() + 1;",
			"}",
			"",
		].join("\n");
		await writeFile(file, content);

		const mod = await resolveCompatModule();
		if (!mod) throw new Error("compat module missing");
		// Flip the real module flag (same instance the annotator will use).
		setHashlineEditActive(true);
		expect(isHashlineEditActive()).toBe(true);
		expect(isCompatActive(mod, true)).toBe(true);

		// Server-shaped section output for lines 5-7.
		const lines = content.replace(/\n$/, "").split("\n");
		const output = [
			`# ${file} (8 lines, ~60 tokens) [section]`,
			"",
			...lines.slice(4, 7).map((l, i) => `${i + 5}  ${l}`),
			"",
		].join("\n");

		const result = await annotateReadOutput({
			output,
			targetPaths: [file],
			compat: mod,
		});

		const outLines = result.split("\n");
		// Section 5-7 maps to output lines 2-4; line 5 declares beta.
		expect(outLines[2]).toMatch(/^5#[A-Z]+:export function beta\(\): number \{$/);
		expect(outLines[3]).toMatch(/^6#[A-Z]+:\treturn alpha\(\) \+ 1;$/);
		expect(outLines[4]).toMatch(/^7#[A-Z]+:\}$/);

		// The commit registered bytes that a native read of the same file
		// would have produced: anchors minted from those lines validate.
		const committed = await mod.readNormalizedForAnnotate(file);
		expect(committed).not.toBeNull();
		// Anchor from committed lines matches the anchor embedded in output.
		const anchorLine = outLines[2] ?? "";
		const num = Number(anchorLine.split("#")[0]);
		const hash = anchorLine.split("#")[1]?.split(":")[0];
		const committedLines = committed?.lines;
		if (!committedLines) throw new Error("file should be readable");
		expect(mod.mintAnchor(committedLines, num)).toBe(hash);
	});

	it("passes through and skips the commit when disk content drifted", async () => {
		const file = join(dir, "drift.ts");
		await writeFile(file, "old content line\nsecond line\n");
		const mod = await resolveCompatModule();
		if (!mod) throw new Error("compat module missing");
		// Flip the real module flag (same instance the annotator will use).
		setHashlineEditActive(true);
		expect(isHashlineEditActive()).toBe(true);
		expect(isCompatActive(mod, true)).toBe(true);

		// Output shows content that is no longer on disk.
		const output = [`# ${file} (2 lines, ~10 tokens) [full]`, "", "changed content line", "second line", ""].join(
			"\n",
		);

		const result = await annotateReadOutput({
			output,
			targetPaths: [file],
			compat: mod,
		});
		expect(result).toBe(output); // untouched
		// The store was never polluted with either version.
		expect(await mod.readNormalizedForAnnotate(file)).not.toBeNull();
	});

	it("output whose file is binary passes through untouched", async () => {
		const file = join(dir, "blob.bin");
		await writeFile(file, Buffer.from([0x00, 0x01, 0x02]));
		const mod = await resolveCompatModule();
		if (!mod) throw new Error("compat module missing");
		// Flip the real module flag (same instance the annotator will use).
		setHashlineEditActive(true);
		expect(isHashlineEditActive()).toBe(true);
		expect(isCompatActive(mod, true)).toBe(true);

		const output = [`# ${file} (1 lines, ~2 tokens) [full]`, "", "\u0000\u0001\u0002", ""].join("\n");
		const result = await annotateReadOutput({
			output,
			targetPaths: [file],
			compat: mod,
		});
		expect(result).toBe(output);
	});

	it("anchor minted in compat mode validates through hashline-edit's edit path (design D9)", async () => {
		const file = join(dir, "editable.ts");
		const content = [
			"export function alpha(): number {",
			"\treturn 1;",
			"}",
			"",
			"export function beta(): number {",
			"\treturn alpha() + 1;",
			"}",
			"",
		].join("\n");
		await writeFile(file, content);

		const mod = await resolveCompatModule();
		if (!mod) throw new Error("compat module missing");
		setHashlineEditActive(true);

		// Server-shaped section view of lines 5-6.
		const lines = content.replace(/\n$/, "").split("\n");
		const output = [
			`# ${file} (8 lines, ~60 tokens) [section]`,
			"",
			...lines.slice(4, 6).map((l, i) => `${i + 5}  ${l}`),
			"",
		].join("\n");

		const result = await annotateReadOutput({
			output,
			targetPaths: [file],
			compat: mod,
		});
		const outLines = result.split("\n");
		expect(outLines[2]).toMatch(/^5#[A-Z]+:export function beta\(\): number \{$/);

		// Copy the annotated line verbatim as an edit anchor — the flagship
		// D9 scenario: the edit pipeline must resolve it against the snapshot
		// the annotator committed and produce a real diff.
		const anchor = outLines[2] ?? "";
		const preview = await computeEditPreview(
			{
				path: file,
				edits: [
					{
						op: "append",
						pos: anchor,
						lines: ["\t// appended via a tilth-minted anchor"],
					},
				],
			},
			join(file, ".."),
		);
		if (!("diff" in preview)) {
			throw new Error(`edit preview failed: ${preview.error}`);
		}
		expect(preview.diff).toContain("appended via a tilth-minted anchor");
	});
});
