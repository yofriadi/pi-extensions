import { homedir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildAppliedChangedResultText,
	colorDiffLines,
	type CallTheme,
	formatDiff,
	formatEditCall,
	type FgTheme,
} from "../../src/edit-render";
import { resolveToCwd } from "../../src/path-utils";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	keyHint: () => "ctrl+o to expand",
}));

const tuiState = vi.hoisted(() => ({ hyperlinks: true }));

vi.mock("@earendil-works/pi-tui", () => ({
	getCapabilities: () => ({ hyperlinks: tuiState.hyperlinks }),
	hyperlink: (text: string, url: string) => `<link url="${url}">${text}</link>`,
}));

function makeTokenTheme(): FgTheme {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	} as FgTheme;
}

describe("edit diff rendering", () => {
	it("colors added, removed, and context diff lines without treating headers as changes", () => {
		const result = colorDiffLines(
			[
				"+++ b/sample.txt",
				"--- a/sample.txt",
				" unchanged",
				"+added",
				"-removed",
			],
			makeTokenTheme(),
		);

		expect(result).toEqual([
			"<dim>+++ b/sample.txt</dim>",
			"<dim>--- a/sample.txt</dim>",
			"<dim> unchanged</dim>",
			"<success>+added</success>",
			"<error>-removed</error>",
		]);
	});

	it("collapses preview and result diffs to ten lines until expanded", () => {
		const diff = Array.from({ length: 12 }, (_, index) => ` line-${String(index + 1).padStart(2, "0")}`).join(
			"\n",
		);
		const theme = makeTokenTheme();

		const collapsedPreview = formatDiff(diff, false, theme);
		expect(collapsedPreview).toContain("line-10");
		expect(collapsedPreview).not.toContain("line-11");
		expect(collapsedPreview).toContain("ctrl+o to expand");

		const expandedPreview = formatDiff(diff, true, theme);
		expect(expandedPreview).toContain("line-12");
		expect(expandedPreview).not.toContain("to expand");

		const details = {
			classification: "applied",
			diff,
			patch: "",
			warnings: [],
		} as NonNullable<Parameters<typeof buildAppliedChangedResultText>[1]>;
		expect(buildAppliedChangedResultText(undefined, details, undefined, false, theme)).toBe(collapsedPreview);
		expect(buildAppliedChangedResultText(undefined, details, undefined, true, theme)).toBe(expandedPreview);

		const collapsedAgain = formatDiff(diff, false, theme);
		expect(collapsedAgain).not.toContain("line-11");
	});

	it("ignores the trailing newline sentinel when counting hidden diff lines", () => {
		const theme = makeTokenTheme();
		const makeLines = (count: number) =>
			Array.from({ length: count }, (_, index) => ` line-${String(index + 1).padStart(2, "0")}`).join("\n");

		const collapsedEleven = formatDiff(`${makeLines(11)}\n`, false, theme);
		expect(collapsedEleven).toContain("(1 more diff lines,");

		const collapsedTen = formatDiff(`${makeLines(10)}\n`, false, theme);
		expect(collapsedTen).toContain("line-10");
		expect(collapsedTen).not.toContain("to expand");

		const expandedEleven = formatDiff(`${makeLines(11)}\n`, true, theme);
		expect(expandedEleven.endsWith("<dim></dim>")).toBe(false);
	});
});

describe("edit call header", () => {
	function makeCallTheme(): CallTheme {
		return {
			bold: (text: string) => text,
			fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
		} as CallTheme;
	}

	it("renders the header path as a file:// hyperlink with a ~-shortened label", () => {
		tuiState.hyperlinks = true;
		const homePath = join(homedir(), "notes.md");
		const text = formatEditCall(
			{ path: homePath, edits: [] },
			{},
			false,
			makeCallTheme(),
			"/tmp",
		);
		expect(text).toBe(
			`<toolTitle>edit</toolTitle> <link url="${pathToFileURL(homePath).href}"><accent>~${sep}notes.md</accent></link>`,
		);
	});

	it("resolves relative paths against cwd for the hyperlink target", () => {
		tuiState.hyperlinks = true;
		const text = formatEditCall(
			{ path: "src/a.ts", edits: [] },
			{},
			false,
			makeCallTheme(),
			"/repo",
		);
		expect(text).toContain(
			`url="${pathToFileURL(resolveToCwd("src/a.ts", "/repo")).href}"`,
		);
		expect(text).toContain("<accent>src/a.ts</accent>");
	});

	it("expands a ~/ path for the hyperlink target while keeping the short label", () => {
		tuiState.hyperlinks = true;
		const text = formatEditCall(
			{ path: "~/notes.md", edits: [] },
			{},
			false,
			makeCallTheme(),
			"/tmp",
		);
		expect(text).toContain(
			`url="${pathToFileURL(join(homedir(), "notes.md")).href}"`,
		);
		expect(text).toContain("<accent>~/notes.md</accent>");
	});

	// The header link and the file the edit actually writes must resolve
	// identically; join() and resolve() disagree on Windows drive-relative paths
	// such as `C:notes.md`.
	it("resolves the hyperlink target exactly like the edit pipeline does", () => {
		tuiState.hyperlinks = true;
		const cwd = "/repo";
		for (const rawPath of [
			"src/a.ts",
			"./src/a.ts",
			"../sibling/a.ts",
			"/tmp/notes.md",
			"~/notes.md",
			"C:notes.md",
		]) {
			const text = formatEditCall(
				{ path: rawPath, edits: [] },
				{},
				false,
				makeCallTheme(),
				cwd,
			);
			expect(text).toContain(
				`url="${pathToFileURL(resolveToCwd(rawPath, cwd)).href}"`,
			);
		}
	});

	it("does not shorten a sibling directory that merely shares the home prefix", () => {
		tuiState.hyperlinks = false;
		const siblingPath = join(`${homedir()}2`, "notes.md");
		const text = formatEditCall(
			{ path: siblingPath, edits: [] },
			{},
			false,
			makeCallTheme(),
			"/tmp",
		);
		expect(text).toBe(
			`<toolTitle>edit</toolTitle> <accent>${siblingPath}</accent>`,
		);
	});

	it("drops the hyperlink but keeps the ~-shortened label without terminal support", () => {
		tuiState.hyperlinks = false;
		const text = formatEditCall(
			{ path: join(homedir(), "notes.md"), edits: [] },
			{},
			false,
			makeCallTheme(),
			"/tmp",
		);
		expect(text).toBe(
			`<toolTitle>edit</toolTitle> <accent>~${sep}notes.md</accent>`,
		);
	});

	it("falls back to plain text when the terminal lacks hyperlink support", () => {
		tuiState.hyperlinks = false;
		const text = formatEditCall(
			{ path: "/tmp/notes.md", edits: [] },
			{},
			false,
			makeCallTheme(),
			"/tmp",
		);
		expect(text).toBe("<toolTitle>edit</toolTitle> <accent>/tmp/notes.md</accent>");
	});
});
