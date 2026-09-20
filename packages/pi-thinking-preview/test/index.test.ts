import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension } from "@earendil-works/pi-coding-agent";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clipLine, escapeMarkdown, resolveMarker, resolveToggleKey } from "../src/index.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");
const extensionPath = join(packageRoot, "src", "index.ts");

let tempDir: string;
let agentDir: string;
let previousEnv: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-thinking-preview-test-"));
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	previousEnv = process.env.PI_THINKING_PREVIEW_MARKER;
	delete process.env.PI_THINKING_PREVIEW_MARKER;
});

afterEach(() => {
	if (previousEnv === undefined) delete process.env.PI_THINKING_PREVIEW_MARKER;
	else process.env.PI_THINKING_PREVIEW_MARKER = previousEnv;
	rmSync(tempDir, { recursive: true, force: true });
});

async function loadExtension(): Promise<Extension> {
	const result = await discoverAndLoadExtensions([extensionPath], tempDir, agentDir);
	expect(result.errors).toEqual([]);
	expect(result.extensions.length).toBe(1);
	const extension = result.extensions[0];
	if (!extension) throw new Error("Expected pi-thinking-preview to load as one extension");
	return extension;
}

function firstTransformer(extension: Extension): (markdown: string, context: unknown) => string {
	const transformer = extension.markdownTransformer;
	if (!transformer) throw new Error("Expected one registered markdown transformer");
	return transformer as unknown as (markdown: string, context: unknown) => string;
}

function thinkingContext(availableWidth = 80) {
	return { messageType: "assistant-thinking", isStreaming: true, availableWidth };
}

describe("loader integration", () => {
	it("discovers the package and registers transformer, shortcut, command, and flags", async () => {
		const extension = await loadExtension();

		expect(extension.commands.has("thinking-preview")).toBe(true);
		expect(extension.shortcuts.has("alt+t")).toBe(true);
		expect([...extension.flags.keys()].sort()).toEqual(["thinking-marker", "thinking-toggle-key"]);
		expect(extension.flags.get("thinking-marker")?.default).toBeUndefined();
		expect(extension.flags.get("thinking-toggle-key")?.default).toBeUndefined();
		expect(typeof extension.markdownTransformer).toBe("function");
	});

	it("collapses an assistant-thinking block into a three-line blockquote", async () => {
		const extension = await loadExtension();
		const transform = firstTransformer(extension);
		const source = [
			"Let me check the README first.",
			"",
			"Then the loader path needs a second pass over the anchors.",
			"Finally I will run the tests.",
		].join("\n");

		expect(transform(source, thinkingContext())).toBe(
			[
				"> ✶ thinking · 4 lines · alt\\+t to expand\\",
				"> Then the loader path needs a second pass over the anchors\\.\\",
				"> Finally I will run the tests\\.",
			].join("\n"),
		);
	});

	it("leaves non-thinking and empty-thinking markdown untouched", async () => {
		const extension = await loadExtension();
		const transform = firstTransformer(extension);

		expect(transform("# Hello", { messageType: "user", isStreaming: false, availableWidth: 80 })).toBe("# Hello");
		expect(transform("# Hello", { messageType: "assistant", isStreaming: false, availableWidth: 80 })).toBe(
			"# Hello",
		);
		expect(transform("   \n  ", thinkingContext())).toBe("   \n  ");
	});

	it("escapes markdown punctuation in tail lines", async () => {
		const extension = await loadExtension();
		const transform = firstTransformer(extension);

		const out = transform("first\n*emphasis* and `code` here", thinkingContext());
		expect(out).toContain("> \\*emphasis\\* and \\`code\\` here");
		expect(out).toContain("> ✶ thinking · 2 lines · alt\\+t to expand");
	});

	it("clips the status line to the available width minus the quote bar", async () => {
		const extension = await loadExtension();
		const transform = firstTransformer(extension);

		const status = transform("only line", thinkingContext(20)).split("\n")[0] ?? "";
		// status line = "> " + content clipped to width-2 + trailing hard-break backslash
		const content = status.slice(2);
		const withoutHardBreak = content.endsWith("\\") ? content.slice(0, -1) : content;
		expect(status.length).toBeLessThanOrEqual(22);
		expect([...withoutHardBreak].length).toBeLessThanOrEqual(18);
	});

	it("re-renders as full text after the toggle command runs", async () => {
		const extension = await loadExtension();
		const transform = firstTransformer(extension);
		const command = extension.commands.get("thinking-preview");
		if (!command) throw new Error("Expected thinking-preview command");

		let notified = "";
		await command.handler("", {
			ui: {
				notify: (message: string) => {
					notified = message;
				},
				setHiddenThinkingLabel: () => {},
			},
		} as never);

		expect(notified).toBe("Thinking: full text");
		expect(transform("line one\nline two", thinkingContext())).toBe(
			"> ✶ thinking · 2 lines · alt\\+t to collapse\\\n> line one\\\n> line two\\",
		);
	});

	it("honors env overrides for marker and toggle key", async () => {
		process.env.PI_THINKING_PREVIEW_MARKER = "●";
		process.env.PI_THINKING_PREVIEW_TOGGLE_KEY = "alt+o";
		try {
			const extension = await loadExtension();
			const transform = firstTransformer(extension);
			const out = transform("hello world", thinkingContext());
			expect(out.split("\n")[0]).toContain("● thinking · 1 line · alt\\+o to expand");
			expect(extension.shortcuts.has("alt+o")).toBe(true);
			expect(extension.shortcuts.has("alt+t")).toBe(false);
		} finally {
			delete process.env.PI_THINKING_PREVIEW_MARKER;
			delete process.env.PI_THINKING_PREVIEW_TOGGLE_KEY;
		}
	});
});

describe("resolveMarker / resolveToggleKey", () => {
	it("defaults the marker to ✶ and the key to alt+t", () => {
		expect(resolveMarker(undefined, undefined)).toBe("✶");
		expect(resolveToggleKey(undefined, undefined)).toBe("alt+t");
	});

	it("prefers flag over env over default", () => {
		expect(resolveMarker("●", "✳")).toBe("●");
		expect(resolveMarker(undefined, "✳")).toBe("✳");
		expect(resolveMarker("", "●")).toBe("●");
		expect(resolveToggleKey("alt+o", "alt+u")).toBe("alt+o");
		expect(resolveToggleKey(undefined, "alt+u")).toBe("alt+u");
	});

	it("trims and takes the first grapheme of the marker", () => {
		expect(resolveMarker("  ✻  ", undefined)).toBe("✻");
		expect(resolveMarker("✻✶ ✻", undefined)).toBe("✻");
		expect(resolveMarker("   ", "✶")).toBe("✶");
	});
});

describe("clipLine", () => {
	it("clips by character count, keeping wide characters whole", () => {
		expect(clipLine("abcde", 3)).toBe("abc");
		expect(clipLine("你好世界", 2)).toBe("你好");
		expect(clipLine("a👨‍👩‍👧b", 2)).toBe("a👨");
	});

	it("returns the line unchanged for non-positive or non-finite budgets", () => {
		expect(clipLine("abc", 0)).toBe("abc");
		expect(clipLine("abc", Number.NaN)).toBe("abc");
		expect(clipLine("abc", Number.POSITIVE_INFINITY)).toBe("abc");
	});
});

describe("escapeMarkdown", () => {
	it("backslash-escapes markdown punctuation and leaves newlines alone", () => {
		expect(escapeMarkdown("a*b_#`_")).toBe("a\\*b\\_\\#\\`\\_");
		expect(escapeMarkdown("line1\nline2")).toBe("line1\nline2");
		expect(escapeMarkdown("plain")).toBe("plain");
	});
});
