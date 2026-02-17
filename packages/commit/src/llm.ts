import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { summarizeHunksForPrompt } from "./diff.js";
import type { FileSelection, NumstatEntry, SplitCommitItem, SplitCommitPlan } from "./types.js";
import { COMMIT_TYPES, type CommitProposal } from "./types.js";

const MAX_DIFF_CHARS = 16_000;

const SECRET_BLOCK_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g];

const SECRET_INLINE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /\b(?:sk|pk|rk)_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED_TOKEN]" },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, replacement: "[REDACTED_GITHUB_TOKEN]" },
	{ pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: "[REDACTED_GOOGLE_KEY]" },
	{
		pattern: /(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*[^\s"']+/gi,
		replacement: "$1=[REDACTED]",
	},
];

const SYSTEM_PROPOSAL_PROMPT = [
	"You generate high-quality conventional commit proposals.",
	"Return JSON only. Do not wrap in markdown or code fences.",
	"Schema:",
	'{"type":"feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert","scope":"string|null","summary":"string","details":["string"],"issue_refs":["#123"]}',
	"Rules:",
	"- summary: max 72 chars, single line, no trailing period, start with a past-tense verb",
	"- scope: null for cross-cutting changes, lowercase slug or slug/slug",
	"- details: 0-6 concise items, each ending with a period",
	"- avoid filler words and meta phrases (e.g., 'this commit', 'various', 'enhanced')",
	"- choose the most specific commit type",
].join("\n");

const SYSTEM_SPLIT_PROMPT = [
	"You split git changes into atomic conventional commits.",
	"Return JSON only.",
	"Schema:",
	'{"commits":[{"type":"feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert","scope":"string|null","summary":"string","details":["string"],"issue_refs":["#123"],"changes":[{"path":"file","hunks":{"type":"all"|"indices"|"lines","indices":[1],"start":1,"end":10}}],"dependencies":[0],"rationale":"optional"}]}',
	"Rules:",
	"- generate 2..N commits if changes are unrelated; prefer file-level splits first",
	"- when one file has mixed concerns, use hunk indices or line ranges",
	"- every changed file must be covered at least once",
	"- dependencies use 0-based indices and must be acyclic",
	"- each summary must be <=72 chars, past tense, no trailing period",
].join("\n");

interface GenerateProposalInput {
	model: Model<Api>;
	apiKey: string;
	diff: string;
	stat: string;
	numstat: NumstatEntry[];
	recentCommits: string[];
	context?: string;
}

interface GenerateSplitPlanInput {
	model: Model<Api>;
	apiKey: string;
	diff: string;
	stat: string;
	files: string[];
	recentCommits: string[];
	maxSplitCommits: number;
	context?: string;
}

export async function generateProposalWithModel(input: GenerateProposalInput): Promise<CommitProposal> {
	const firstAttempt = await requestProposal(input, buildProposalPrompt(input));
	if (firstAttempt.valid) {
		return firstAttempt.proposal;
	}

	const retryPrompt = [
		buildProposalPrompt(input),
		"",
		"Previous output (invalid):",
		firstAttempt.raw,
		"",
		"Validation errors to fix:",
		...firstAttempt.errors.map((error) => `- ${error}`),
		"",
		"Return corrected JSON only.",
	].join("\n");

	const retry = await requestProposal(input, retryPrompt);
	if (retry.valid) {
		return retry.proposal;
	}

	throw new Error(`Commit proposal generation failed: ${retry.errors.join("; ")}`);
}

export async function generateSplitPlanWithModel(input: GenerateSplitPlanInput): Promise<SplitCommitPlan> {
	const prompt = buildSplitPrompt(input);
	const response = await completeSimple(
		input.model,
		{
			systemPrompt: SYSTEM_SPLIT_PROMPT,
			messages: [
				{
					role: "user",
					content: prompt,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: input.apiKey,
			reasoning: "low",
			maxTokens: 1_800,
		},
	);

	const text = response.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	const parsed = parseJsonObject(text);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}

	const normalized = normalizeSplitPlan(parsed.value);
	if (!normalized.ok) {
		throw new Error(normalized.errors.join("; "));
	}

	return normalized.value;
}

function buildProposalPrompt(input: GenerateProposalInput): string {
	const diff = truncateAndRedact(input.diff, MAX_DIFF_CHARS);
	const numstatLines = input.numstat
		.slice(0, 200)
		.map((entry) => `${entry.additions}\t${entry.deletions}\t${entry.path}`)
		.join("\n");
	const stat = redactSensitiveText(input.stat || "(empty)");
	const recentCommits = redactSensitiveText(input.recentCommits.join("\n") || "(none)");

	const sections = [
		"Analyze these staged git changes and generate a conventional commit proposal.",
		"",
		"Diff stat:",
		stat || "(empty)",
		"",
		"Numstat:",
		numstatLines || "(empty)",
		"",
		"Recent commits (style reference):",
		recentCommits || "(none)",
		"",
		"Diff:",
		diff || "(empty)",
	];

	if (input.context?.trim()) {
		sections.push("", "Additional user context:", redactSensitiveText(input.context.trim()));
	}

	sections.push("", `Allowed types: ${COMMIT_TYPES.join(", ")}`);
	return sections.join("\n");
}

function buildSplitPrompt(input: GenerateSplitPlanInput): string {
	const diff = truncateAndRedact(input.diff, MAX_DIFF_CHARS);
	const stat = redactSensitiveText(input.stat || "(empty)");
	const recentCommits = redactSensitiveText(input.recentCommits.join("\n") || "(none)");

	const sections = [
		"Split these staged changes into atomic commits.",
		`Max commits: ${input.maxSplitCommits}`,
		"",
		"Changed files:",
		input.files.join("\n") || "(none)",
		"",
		"Diff stat:",
		stat || "(empty)",
		"",
		"Hunk outline (indices are 1-based):",
		summarizeHunksForPrompt(diff),
		"",
		"Recent commits (style reference):",
		recentCommits || "(none)",
		"",
		"Diff:",
		diff || "(empty)",
	];

	if (input.context?.trim()) {
		sections.push("", "Additional user context:", redactSensitiveText(input.context.trim()));
	}

	sections.push("", "Return JSON object with key 'commits'.");
	return sections.join("\n");
}

async function requestProposal(
	input: GenerateProposalInput,
	userPrompt: string,
): Promise<{
	valid: boolean;
	proposal: CommitProposal;
	errors: string[];
	raw: string;
}> {
	const response = await completeSimple(
		input.model,
		{
			systemPrompt: SYSTEM_PROPOSAL_PROMPT,
			messages: [
				{
					role: "user",
					content: userPrompt,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: input.apiKey,
			reasoning: "low",
			maxTokens: 1_200,
		},
	);

	const text = response.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	const parsed = parseJsonObject(text);
	if (!parsed.ok) {
		return {
			valid: false,
			proposal: emptyProposal(),
			errors: [parsed.error],
			raw: text,
		};
	}

	const normalized = normalizeProposal(parsed.value);
	if (!normalized.ok) {
		return {
			valid: false,
			proposal: emptyProposal(),
			errors: normalized.errors,
			raw: text,
		};
	}

	return {
		valid: true,
		proposal: normalized.value,
		errors: [],
		raw: text,
	};
}

function parseJsonObject(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { ok: false, error: "Model returned empty response" };
	}

	const direct = tryJsonParse(trimmed);
	if (direct.ok) {
		return direct;
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return tryJsonParse(trimmed.slice(firstBrace, lastBrace + 1));
	}

	return { ok: false, error: "Model response is not valid JSON" };
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: `Failed to parse JSON: ${formatError(error)}` };
	}
}

function normalizeProposal(value: unknown): { ok: true; value: CommitProposal } | { ok: false; errors: string[] } {
	if (!value || typeof value !== "object") {
		return { ok: false, errors: ["Proposal must be an object"] };
	}

	const data = value as Record<string, unknown>;
	const type = typeof data.type === "string" ? data.type : "";
	const scopeValue = data.scope;
	const summary = typeof data.summary === "string" ? data.summary : "";
	const details = Array.isArray(data.details)
		? data.details.filter((item) => typeof item === "string").map((item) => item.trim())
		: [];
	const issueRefs = Array.isArray(data.issue_refs)
		? data.issue_refs.filter((item) => typeof item === "string").map((item) => item.trim())
		: [];

	const errors: string[] = [];
	if (!COMMIT_TYPES.includes(type as (typeof COMMIT_TYPES)[number])) {
		errors.push(`Invalid commit type: ${type || "(missing)"}`);
	}
	if (!summary.trim()) {
		errors.push("Summary is missing");
	}
	if (!(scopeValue === null || typeof scopeValue === "string" || typeof scopeValue === "undefined")) {
		errors.push("Scope must be string or null");
	}
	if (!Array.isArray(data.details)) {
		errors.push("Details must be an array");
	}
	if (!Array.isArray(data.issue_refs)) {
		errors.push("issue_refs must be an array");
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			type: type as (typeof COMMIT_TYPES)[number],
			scope: typeof scopeValue === "string" ? scopeValue : null,
			summary,
			details,
			issueRefs,
			warnings: [],
		},
	};
}

function normalizeSplitPlan(value: unknown): { ok: true; value: SplitCommitPlan } | { ok: false; errors: string[] } {
	if (!value || typeof value !== "object") {
		return { ok: false, errors: ["Split plan must be an object"] };
	}

	const data = value as Record<string, unknown>;
	if (!Array.isArray(data.commits)) {
		return { ok: false, errors: ["Split plan must contain commits array"] };
	}

	const commits: SplitCommitItem[] = [];
	const errors: string[] = [];
	for (const [index, rawCommit] of data.commits.entries()) {
		const normalized = normalizeSplitCommit(rawCommit);
		if (!normalized.ok) {
			errors.push(...normalized.errors.map((error) => `Commit ${index + 1}: ${error}`));
			continue;
		}
		commits.push(normalized.value);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			commits,
			warnings: [],
		},
	};
}

function normalizeSplitCommit(value: unknown): { ok: true; value: SplitCommitItem } | { ok: false; errors: string[] } {
	if (!value || typeof value !== "object") {
		return { ok: false, errors: ["must be an object"] };
	}

	const data = value as Record<string, unknown>;
	const proposal = normalizeProposal({
		type: data.type,
		scope: data.scope,
		summary: data.summary,
		details: data.details,
		issue_refs: data.issue_refs,
	});
	if (!proposal.ok) {
		return { ok: false, errors: proposal.errors };
	}

	const changesInput = Array.isArray(data.changes)
		? data.changes
		: Array.isArray(data.files)
			? data.files.map((file) => ({ path: file, hunks: { type: "all" } }))
			: [];
	if (changesInput.length === 0) {
		return { ok: false, errors: ["must include non-empty changes"] };
	}

	const changes: FileSelection[] = [];
	for (const rawChange of changesInput) {
		const normalized = normalizeFileSelection(rawChange);
		if (!normalized.ok) {
			return { ok: false, errors: normalized.errors };
		}
		changes.push(normalized.value);
	}

	const dependencies = Array.isArray(data.dependencies)
		? data.dependencies.filter((value): value is number => typeof value === "number").map((value) => Math.floor(value))
		: [];

	return {
		ok: true,
		value: {
			proposal: proposal.value,
			changes,
			dependencies,
			rationale: typeof data.rationale === "string" ? data.rationale.trim() : undefined,
		},
	};
}

function normalizeFileSelection(value: unknown): { ok: true; value: FileSelection } | { ok: false; errors: string[] } {
	if (!value || typeof value !== "object") {
		return { ok: false, errors: ["change must be an object"] };
	}

	const data = value as Record<string, unknown>;
	const filePath = typeof data.path === "string" ? data.path.trim() : "";
	if (!filePath) {
		return { ok: false, errors: ["change.path is required"] };
	}

	const selector = parseHunkSelector(data.hunks);
	if (!selector.ok) {
		return { ok: false, errors: selector.errors };
	}

	return {
		ok: true,
		value: {
			path: filePath,
			hunks: selector.value,
		},
	};
}

function parseHunkSelector(
	value: unknown,
): { ok: true; value: FileSelection["hunks"] } | { ok: false; errors: string[] } {
	if (!value || typeof value !== "object") {
		return { ok: true, value: { type: "all" } };
	}

	const data = value as Record<string, unknown>;
	const type = typeof data.type === "string" ? data.type : "all";

	if (type === "all") {
		return { ok: true, value: { type: "all" } };
	}

	if (type === "indices") {
		if (!Array.isArray(data.indices)) {
			return { ok: false, errors: ["hunks.indices must be an array"] };
		}
		const indices = data.indices
			.filter((item): item is number => typeof item === "number")
			.map((item) => Math.floor(item))
			.filter((item) => item >= 1);
		if (indices.length === 0) {
			return { ok: false, errors: ["hunks.indices must contain positive integers"] };
		}
		return { ok: true, value: { type: "indices", indices } };
	}

	if (type === "lines") {
		const start = typeof data.start === "number" ? Math.floor(data.start) : 0;
		const end = typeof data.end === "number" ? Math.floor(data.end) : 0;
		if (start < 1 || end < start) {
			return { ok: false, errors: ["hunks.lines requires valid start/end"] };
		}
		return { ok: true, value: { type: "lines", start, end } };
	}

	return { ok: false, errors: [`unknown hunk selector type: ${type}`] };
}

function truncateAndRedact(text: string, maxChars: number): string {
	if (!text) {
		return "";
	}
	const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n...<truncated>` : text;
	return redactSensitiveText(clipped);
}

function redactSensitiveText(text: string): string {
	let output = text;
	for (const pattern of SECRET_BLOCK_PATTERNS) {
		output = output.replace(pattern, "[REDACTED_PRIVATE_KEY]");
	}
	for (const entry of SECRET_INLINE_PATTERNS) {
		output = output.replace(entry.pattern, entry.replacement);
	}
	return output;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function emptyProposal(): CommitProposal {
	return {
		type: "chore",
		scope: null,
		summary: "updated files",
		details: [],
		issueRefs: [],
		warnings: [],
	};
}
