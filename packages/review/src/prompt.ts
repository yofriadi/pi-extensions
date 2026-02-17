import { getFileExt, truncatePreview } from "./diff.js";
import type { FindingPriority, ReviewPromptInput } from "./types.js";

const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;

function getRecommendedAgentCount(fileCount: number, totalLines: number): number {
	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

function buildPriorityGuide(): string {
	const rows: Array<{ priority: FindingPriority; meaning: string }> = [
		{ priority: "P0", meaning: "Critical blocker (security, data loss, hard crash)" },
		{ priority: "P1", meaning: "High-impact issue that should be fixed before merge" },
		{ priority: "P2", meaning: "Medium issue worth fixing soon" },
		{ priority: "P3", meaning: "Low-priority note / polish" },
	];

	return rows.map((row) => `- ${row.priority}: ${row.meaning}`).join("\n");
}

function renderFileStats(input: ReviewPromptInput): string {
	if (input.stats.files.length === 0) {
		return "_No reviewable files after filtering._";
	}

	return input.stats.files
		.map((file) => {
			const ext = getFileExt(file.path) || "(none)";
			return `- \`${file.path}\` (+${file.linesAdded}/-${file.linesRemoved}, type: ${ext})`;
		})
		.join("\n");
}

function renderExcludedFiles(input: ReviewPromptInput): string {
	if (input.stats.excluded.length === 0) {
		return "";
	}

	return [
		"\n### Excluded Files",
		...input.stats.excluded.map(
			(file) => `- \`${file.path}\` (+${file.linesAdded}/-${file.linesRemoved}) — ${file.reason}`,
		),
	].join("\n");
}

function renderDistributionGuidance(agentCount: number): string {
	if (agentCount <= 1) {
		return "Use **1 reviewer** for this diff.";
	}

	return [
		`Use **${agentCount} reviewers in parallel** when possible.`,
		"Group files by locality:",
		"- same module/directory -> same reviewer",
		"- related implementation + tests -> same reviewer",
		"- separate concerns (api/ui/data) -> separate reviewers",
	].join("\n");
}

function renderExecutionInstructions(input: ReviewPromptInput): string {
	if (input.executionMode === "task") {
		return [
			"- Use Task tool to spawn reviewer work in parallel.",
			"- Keep each reviewer focused on a subset of files.",
			"- Each reviewer should report findings with `report_finding` and finish with `submit_review`.",
		].join("\n");
	}

	return [
		"- Run review directly in this session.",
		"- For each issue, call `report_finding` with precise location.",
		"- When done, call `submit_review` exactly once.",
	].join("\n");
}

function renderDiffBlock(input: ReviewPromptInput): string {
	const trimmed = input.rawDiff.trim();
	if (!trimmed) {
		return "### Diff\n\n_No diff context available. Use additional instructions and targeted file reads._";
	}

	const skipFullDiff = trimmed.length > MAX_DIFF_CHARS || input.stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	if (!skipFullDiff) {
		return `### Diff\n\n\`\`\`diff\n${trimmed}\n\`\`\``;
	}

	const linesPerFile = Math.max(5, Math.floor(100 / Math.max(1, input.stats.files.length)));
	const previews = input.stats.files
		.map((file) => `#### ${file.path}\n\n\`\`\`diff\n${truncatePreview(file.preview, linesPerFile)}\n\`\`\``)
		.join("\n\n");

	return [
		"### Diff Preview",
		`Full diff omitted (size/files threshold exceeded). Showing first ~${linesPerFile} content lines per file.`,
		previews,
	].join("\n\n");
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	const totalLines = input.stats.totalAdded + input.stats.totalRemoved;
	const agentCount = getRecommendedAgentCount(input.stats.files.length, totalLines);
	const additionalInstructions = input.additionalInstructions?.trim();

	const sections = [
		"## Interactive Code Review Request",
		"",
		"### Mode",
		input.mode,
		"",
		`### Changed Files (${input.stats.files.length} files, +${input.stats.totalAdded}/-${input.stats.totalRemoved} lines)`,
		renderFileStats(input),
		renderExcludedFiles(input),
		"",
		"### Distribution Guidance",
		renderDistributionGuidance(agentCount),
		"",
		"### Review Workflow",
		renderExecutionInstructions(input),
		"- Review only issues introduced by this patch.",
		"- Prioritize correctness, reliability, and security over style nits.",
		"",
		"### Priority Guide",
		buildPriorityGuide(),
		"",
		renderDiffBlock(input),
	];

	if (additionalInstructions) {
		sections.push("", "### Additional Instructions", additionalInstructions);
	}

	sections.push("", "After `submit_review`, provide a short human-readable summary.");

	return sections.join("\n");
}
