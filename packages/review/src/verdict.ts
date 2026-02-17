import type { FindingPriority, ReviewFinding, ReviewVerdict } from "./types.js";

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export function summarizePriorities(findings: ReviewFinding[]): Partial<Record<FindingPriority, number>> {
	const counts: Partial<Record<FindingPriority, number>> = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}
	return counts;
}

export function suggestVerdict(findings: ReviewFinding[]): ReviewVerdict {
	if (findings.some((finding) => finding.priority === "P0" || finding.priority === "P1")) {
		return "request_changes";
	}
	if (findings.length > 0) {
		return "comment";
	}
	return "approve";
}
