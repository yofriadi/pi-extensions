import path from "node:path";
import type { CommitType, NumstatEntry } from "./types.js";

export const TEST_PATTERNS = ["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.", "_spec."];
export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".less", ".sass"]);

export function inferTypeFromFiles(numstat: NumstatEntry[]): CommitType {
	if (numstat.length === 0) {
		return "chore";
	}

	let hasTests = false;
	let hasDocs = false;
	let hasConfig = false;
	let hasStyle = false;
	let hasSource = false;

	for (const entry of numstat) {
		const lowerPath = entry.path.toLowerCase();
		const ext = extension(entry.path);
		if (TEST_PATTERNS.some((pattern) => lowerPath.includes(pattern))) {
			hasTests = true;
		} else if (DOC_EXTENSIONS.has(ext)) {
			hasDocs = true;
		} else if (CONFIG_EXTENSIONS.has(ext)) {
			hasConfig = true;
		} else if (STYLE_EXTENSIONS.has(ext)) {
			hasStyle = true;
		} else {
			hasSource = true;
		}
	}

	if (hasTests && !hasSource && !hasDocs) return "test";
	if (hasDocs && !hasSource && !hasTests) return "docs";
	if (hasStyle && !hasSource && !hasTests) return "style";
	if (hasConfig && !hasSource && !hasTests && !hasDocs) return "chore";
	return "refactor";
}

export function fallbackVerb(type: CommitType): string {
	const map: Record<CommitType, string> = {
		test: "updated tests for",
		docs: "updated documentation for",
		refactor: "refactored",
		style: "formatted",
		chore: "updated",
		feat: "added",
		fix: "fixed",
		perf: "optimized",
		build: "updated",
		ci: "updated",
		revert: "reverted",
	};
	return map[type];
}

export function inferScopeFromFiles(numstat: NumstatEntry[]): string | null {
	const roots = new Set<string>();
	for (const entry of numstat) {
		const root = entry.path.split("/")[0] ?? "";
		if (!root || root.includes(".")) {
			continue;
		}
		roots.add(root.toLowerCase());
	}
	if (roots.size !== 1) {
		return null;
	}
	return Array.from(roots)[0] ?? null;
}

export function isTestPath(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	return TEST_PATTERNS.some((pattern) => lowerPath.includes(pattern));
}

export function isDocPath(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	const ext = path.extname(lowerPath);
	return DOC_EXTENSIONS.has(ext) || lowerPath.startsWith("docs/");
}

function extension(filePath: string): string {
	const name = path.basename(filePath);
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}
