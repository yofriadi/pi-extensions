/**
 * Windows path shortening for the edit call header. CI only runs ubuntu, so the
 * `\` separator and mixed-separator paths (`C:\Users\me/notes.md`) are covered
 * here by mocking `homedir()` and `sep` instead of by the platform.
 */

import { describe, expect, it, vi } from "vitest";
import { type CallTheme, formatEditCall } from "../../src/edit-render";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	keyHint: () => "ctrl+o to expand",
}));

// Hyperlinks stay off in this file: the label is what the separator affects,
// and skipping the link keeps real (posix) path resolution out of the picture.
vi.mock("@earendil-works/pi-tui", () => ({
	getCapabilities: () => ({ hyperlinks: false }),
	hyperlink: (text: string) => text,
}));

vi.mock("node:os", () => ({ homedir: () => "C:\\Users\\me" }));

vi.mock("node:path", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:path")>()),
	sep: "\\",
}));

function makeCallTheme(): CallTheme {
	return {
		bold: (text: string) => text,
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	} as CallTheme;
}

function headerLabel(path: string): string {
	const text = formatEditCall({ path, edits: [] }, {}, false, makeCallTheme());
	return text.replace("<toolTitle>edit</toolTitle> ", "");
}

describe("edit call header on Windows", () => {
	it("shortens a backslash path under home", () => {
		expect(headerLabel("C:\\Users\\me\\notes.md")).toBe(
			"<accent>~\\notes.md</accent>",
		);
	});

	it("shortens a mixed-separator path under home", () => {
		expect(headerLabel("C:\\Users\\me/notes.md")).toBe(
			"<accent>~/notes.md</accent>",
		);
	});

	it("shortens a forward-slash path under home", () => {
		expect(headerLabel("C:/Users/me/notes.md")).toBe(
			"<accent>~/notes.md</accent>",
		);
	});

	it("shortens home itself", () => {
		expect(headerLabel("C:\\Users\\me")).toBe("<accent>~</accent>");
	});

	it("does not shorten a sibling directory sharing the home prefix", () => {
		expect(headerLabel("C:\\Users\\me2\\notes.md")).toBe(
			"<accent>C:\\Users\\me2\\notes.md</accent>",
		);
	});
});
