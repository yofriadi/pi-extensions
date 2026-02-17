import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stageFiles } from "./git.js";
import type { CommitProposal } from "./types.js";

const CHANGELOG_BASENAME = "CHANGELOG.md";
const UNRELEASED_PATTERN = /^##\s+\[?unreleased\]?/i;
const SECTION_PATTERN = /^###\s+(.*)$/;

const CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

export async function applyChangelogForCommit(input: {
	pi: ExtensionAPI;
	cwd: string;
	proposal: CommitProposal;
	files: string[];
	dryRun: boolean;
}): Promise<{ updated: string[]; warnings: string[] }> {
	const warnings: string[] = [];
	const targets = await findChangelogTargets(input.cwd, input.files);
	if (targets.length === 0) {
		return { updated: [], warnings };
	}

	const category = categoryFromType(input.proposal.type);
	const entry = formatEntry(input.proposal);
	const updated: string[] = [];

	for (const changelogPath of targets) {
		const current = await readFile(changelogPath, "utf8");
		const next = upsertChangelogEntry(current, category, entry);
		if (next === current) {
			continue;
		}

		if (!input.dryRun) {
			await writeFile(changelogPath, next, "utf8");
			const relativePath = path.relative(input.cwd, changelogPath);
			const stageResult = await stageFiles(input.pi, input.cwd, [relativePath]);
			if (!stageResult.ok) {
				warnings.push(`Failed to stage changelog ${relativePath}: ${stageResult.message}`);
				continue;
			}
		}

		updated.push(changelogPath);
	}

	return { updated, warnings };
}

async function findChangelogTargets(cwd: string, files: string[]): Promise<string[]> {
	const targets = new Set<string>();
	const existsCache = new Map<string, boolean>();
	const rootChangelog = path.join(cwd, CHANGELOG_BASENAME);
	if (await existsCached(rootChangelog, existsCache)) {
		targets.add(rootChangelog);
	}

	const startDirectories = new Set<string>();
	for (const file of files) {
		const absolute = path.resolve(cwd, file);
		startDirectories.add(path.dirname(absolute));
	}

	for (const startDirectory of startDirectories) {
		let directory = startDirectory;
		while (directory.startsWith(cwd)) {
			const candidate = path.join(directory, CHANGELOG_BASENAME);
			if (await existsCached(candidate, existsCache)) {
				targets.add(candidate);
				break;
			}
			if (directory === cwd) {
				break;
			}
			const parent = path.dirname(directory);
			if (parent === directory) {
				break;
			}
			directory = parent;
		}
	}

	return Array.from(targets).sort();
}

function upsertChangelogEntry(content: string, category: string, entry: string): string {
	const lines = content.split("\n");
	const unreleasedStart = lines.findIndex((line) => UNRELEASED_PATTERN.test(line.trim()));

	if (unreleasedStart === -1) {
		return createUnreleasedSection(lines, category, entry);
	}

	const unreleasedEnd = findSectionEnd(lines, unreleasedStart + 1);
	const unreleasedLines = lines.slice(unreleasedStart + 1, unreleasedEnd);
	const updatedUnreleased = upsertWithinUnreleased(unreleasedLines, category, entry);

	if (updatedUnreleased.join("\n") === unreleasedLines.join("\n")) {
		return content;
	}

	return [...lines.slice(0, unreleasedStart + 1), ...updatedUnreleased, ...lines.slice(unreleasedEnd)].join("\n");
}

function createUnreleasedSection(lines: string[], category: string, entry: string): string {
	const block = ["## [Unreleased]", "", `### ${category}`, `- ${entry}`, ""];

	const firstReleaseIndex = lines.findIndex((line) => /^##\s+/.test(line));
	if (firstReleaseIndex === -1) {
		const joined = [...lines, ...(lines[lines.length - 1] === "" ? [] : [""]), ...block].join("\n");
		return joined;
	}

	return [...lines.slice(0, firstReleaseIndex), ...block, ...lines.slice(firstReleaseIndex)].join("\n");
}

function upsertWithinUnreleased(lines: string[], category: string, entry: string): string[] {
	const output = [...lines];
	const normalizedEntry = normalizeEntry(entry);
	let sectionStart = -1;
	let sectionEnd = -1;

	for (let index = 0; index < output.length; index += 1) {
		const match = output[index]?.match(SECTION_PATTERN);
		if (!match) {
			continue;
		}

		if ((match[1] ?? "").trim().toLowerCase() === category.toLowerCase()) {
			sectionStart = index;
			sectionEnd = findSubsectionEnd(output, index + 1);
			break;
		}
	}

	if (sectionStart === -1) {
		const insertion = renderSection(category, [entry]);
		return mergeSection(output, insertion, category);
	}

	const existingEntries = output
		.slice(sectionStart + 1, sectionEnd)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("-"))
		.map((line) => normalizeEntry(line.replace(/^[-*]\s*/, "")));
	if (existingEntries.includes(normalizedEntry)) {
		return output;
	}

	const insertionLine = findBulletInsertionLine(output, sectionStart + 1, sectionEnd);
	output.splice(insertionLine, 0, `- ${entry}`);
	return output;
}

function mergeSection(lines: string[], sectionLines: string[], category: string): string[] {
	const targetOrder = CATEGORY_ORDER.indexOf(category);
	if (targetOrder === -1) {
		const base = lines[lines.length - 1] === "" ? [...lines] : [...lines, ""];
		return [...base, ...sectionLines];
	}

	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index]?.match(SECTION_PATTERN);
		if (!match) {
			continue;
		}
		const existingOrder = CATEGORY_ORDER.indexOf((match[1] ?? "").trim());
		if (existingOrder >= 0 && existingOrder > targetOrder) {
			const before = lines.slice(0, index);
			const after = lines.slice(index);
			const withSpacing = before.length > 0 && before[before.length - 1] !== "" ? [...before, ""] : before;
			return [...withSpacing, ...sectionLines, ...after];
		}
	}

	const base = lines[lines.length - 1] === "" ? [...lines] : [...lines, ""];
	return [...base, ...sectionLines];
}

function renderSection(category: string, entries: string[]): string[] {
	const lines = [`### ${category}`];
	for (const entry of entries) {
		lines.push(`- ${entry}`);
	}
	lines.push("");
	return lines;
}

function findSectionEnd(lines: string[], fromIndex: number): number {
	for (let index = fromIndex; index < lines.length; index += 1) {
		if (lines[index]?.startsWith("## ")) {
			return index;
		}
	}
	return lines.length;
}

function findSubsectionEnd(lines: string[], fromIndex: number): number {
	for (let index = fromIndex; index < lines.length; index += 1) {
		if (lines[index]?.startsWith("### ") || lines[index]?.startsWith("## ")) {
			return index;
		}
	}
	return lines.length;
}

function findBulletInsertionLine(lines: string[], fromIndex: number, toIndex: number): number {
	let insertion = toIndex;
	for (let index = fromIndex; index < toIndex; index += 1) {
		if (lines[index]?.trim().startsWith("-")) {
			insertion = index + 1;
		}
	}
	return insertion;
}

function categoryFromType(type: CommitProposal["type"]): string {
	switch (type) {
		case "feat":
			return "Added";
		case "fix":
			return "Fixed";
		case "perf":
			return "Changed";
		case "revert":
			return "Changed";
		default:
			return "Changed";
	}
}

function formatEntry(proposal: CommitProposal): string {
	const summary = proposal.summary.trim().replace(/[.]$/, "");
	if (proposal.issueRefs.length === 0) {
		return summary;
	}
	return `${summary} (${proposal.issueRefs.join(", ")})`;
}

function normalizeEntry(entry: string): string {
	return entry.trim().toLowerCase().replace(/[.]$/, "");
}

async function existsCached(filePath: string, cache: Map<string, boolean>): Promise<boolean> {
	const cached = cache.get(filePath);
	if (cached !== undefined) {
		return cached;
	}
	const value = await exists(filePath);
	cache.set(filePath, value);
	return value;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
