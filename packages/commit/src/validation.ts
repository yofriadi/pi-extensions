import path from "node:path";
import { fallbackVerb, inferTypeFromFiles } from "./heuristics.js";
import { COMMIT_TYPES, type CommitProposal, type NumstatEntry } from "./types.js";

const SUMMARY_MAX_CHARS = 72;
const MAX_DETAIL_ITEMS = 6;

const FILLER_WORDS = ["comprehensive", "various", "several", "improved", "enhanced", "better"];
const META_PHRASES = ["this commit", "this change", "updated code", "modified files"];
const PAST_TENSE_VERBS = new Set([
	"added",
	"adjusted",
	"aligned",
	"changed",
	"cleaned",
	"clarified",
	"consolidated",
	"converted",
	"corrected",
	"created",
	"deprecated",
	"disabled",
	"documented",
	"dropped",
	"enabled",
	"expanded",
	"extracted",
	"fixed",
	"hardened",
	"implemented",
	"improved",
	"integrated",
	"introduced",
	"migrated",
	"moved",
	"optimized",
	"patched",
	"prevented",
	"reduced",
	"refactored",
	"removed",
	"renamed",
	"reorganized",
	"replaced",
	"resolved",
	"restored",
	"restructured",
	"reworked",
	"simplified",
	"stabilized",
	"standardized",
	"streamlined",
	"tightened",
	"updated",
	"upgraded",
	"validated",
]);

export function validateProposal(proposal: CommitProposal): {
	valid: boolean;
	errors: string[];
	warnings: string[];
	proposal: CommitProposal;
} {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!COMMIT_TYPES.includes(proposal.type)) {
		errors.push(`Invalid commit type: ${proposal.type}`);
	}

	const normalizedScope = normalizeScope(proposal.scope);
	const scopeValidation = validateScope(normalizedScope);
	errors.push(...scopeValidation.errors);

	const normalizedSummary = normalizeSummary(proposal.summary);
	const summaryValidation = validateSummary(normalizedSummary);
	errors.push(...summaryValidation.errors);
	warnings.push(...summaryValidation.warnings);

	const normalizedDetails = proposal.details
		.map((detail) => detail.trim())
		.filter(Boolean)
		.slice(0, MAX_DETAIL_ITEMS)
		.map((detail) => (detail.endsWith(".") ? detail : `${detail}.`));

	for (const detail of normalizedDetails) {
		if (detail.length > 120) {
			errors.push(`Detail exceeds 120 characters: ${detail}`);
		}
	}

	const normalizedIssueRefs = proposal.issueRefs
		.map((ref) => ref.trim())
		.filter(Boolean)
		.map((ref) => (ref.startsWith("#") ? ref : `#${ref}`));

	const normalized: CommitProposal = {
		...proposal,
		scope: normalizedScope,
		summary: normalizedSummary,
		details: normalizedDetails,
		issueRefs: normalizedIssueRefs,
		warnings: [...proposal.warnings, ...warnings],
	};

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		proposal: normalized,
	};
}

export function validateScope(scope: string | null): { errors: string[] } {
	if (!scope) {
		return { errors: [] };
	}

	const errors: string[] = [];
	const segments = scope.split("/");

	if (segments.length > 2) {
		errors.push("Scope may contain at most two segments");
	}

	for (const segment of segments) {
		if (!segment) {
			errors.push("Scope segments cannot be empty");
			continue;
		}
		if (segment !== segment.toLowerCase()) {
			errors.push("Scope must be lowercase");
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/.test(segment)) {
			errors.push(`Scope segment has invalid characters: ${segment}`);
		}
	}

	return { errors };
}

export function normalizeSummary(summary: string): string {
	return summary.replace(/\s+/g, " ").trim();
}

export function validateSummary(summary: string): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!summary) {
		errors.push("Summary is empty");
		return { errors, warnings };
	}
	if (summary.length > SUMMARY_MAX_CHARS) {
		errors.push(`Summary exceeds ${SUMMARY_MAX_CHARS} characters`);
	}
	if (summary.includes("\n")) {
		errors.push("Summary must be a single line");
	}
	if (summary.endsWith(".")) {
		errors.push("Summary must not end with a period");
	}

	const firstWord = summary
		.split(/\s+/)[0]
		?.toLowerCase()
		.replace(/[^a-z]/g, "");
	if (!firstWord || !isPastTense(firstWord)) {
		errors.push("Summary must start with a past-tense verb");
	}

	const lowerSummary = summary.toLowerCase();
	for (const word of FILLER_WORDS) {
		if (lowerSummary.includes(word)) {
			warnings.push(`Avoid filler word: ${word}`);
		}
	}
	for (const phrase of META_PHRASES) {
		if (lowerSummary.includes(phrase)) {
			warnings.push(`Avoid meta phrase: ${phrase}`);
		}
	}

	return { errors, warnings };
}

function isPastTense(word: string): boolean {
	if (PAST_TENSE_VERBS.has(word)) {
		return true;
	}
	if (word.endsWith("ed") && word.length > 3) {
		return true;
	}
	return false;
}

function normalizeScope(scope: string | null): string | null {
	if (!scope) {
		return null;
	}
	const trimmed = scope.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function formatCommitMessage(proposal: CommitProposal): { subject: string; body: string } {
	const subject = `${proposal.type}${proposal.scope ? `(${proposal.scope})` : ""}: ${proposal.summary}`;
	const lines: string[] = [];

	if (proposal.details.length > 0) {
		for (const detail of proposal.details) {
			lines.push(`- ${detail}`);
		}
	}

	if (proposal.issueRefs.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(`Refs: ${proposal.issueRefs.join(", ")}`);
	}

	return {
		subject,
		body: lines.join("\n"),
	};
}

export function generateFallbackProposal(numstat: NumstatEntry[]): CommitProposal {
	const type = inferTypeFromFiles(numstat);
	const primary = path.basename(numstat[0]?.path ?? "files");
	const summary =
		numstat.length <= 1
			? `${fallbackVerb(type)} ${primary}`
			: `${fallbackVerb(type)} ${primary} and ${numstat.length - 1} other${numstat.length === 2 ? "" : "s"}`;
	const details = numstat.slice(0, 3).map((entry) => `Updated ${path.basename(entry.path)}.`);

	return {
		type,
		scope: null,
		summary,
		details,
		issueRefs: [],
		warnings: ["Used fallback commit proposal after model generation failed"],
	};
}
