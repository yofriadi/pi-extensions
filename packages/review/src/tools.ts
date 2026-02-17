import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { reviewStateStore, upsertFinding } from "./state.js";
import type { FindingPriority, ReviewFinding, ReviewSubmission } from "./types.js";
import { PRIORITIES, suggestVerdict, summarizePriorities } from "./verdict.js";

const VERDICTS = ["approve", "request_changes", "comment"] as const;

const TITLE_MAX_LENGTH = 80;
const MAX_LINE_SPAN = 10;

export const TOOL_REPORT_FINDING = "report_finding";
export const TOOL_SUBMIT_REVIEW = "submit_review";

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

function normalizeTitle(title: string, priority: FindingPriority): string {
	let normalized = title.trim().replace(/\s+/g, " ");
	if (!normalized.startsWith(`[${priority}]`)) {
		normalized = `[${priority}] ${normalized}`;
	}
	if (normalized.length > TITLE_MAX_LENGTH) {
		normalized = `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…`;
	}
	return normalized;
}

export function sanitizeFindingPath(cwd: string, inputPath: string): string | undefined {
	const trimmed = inputPath.trim();
	if (!trimmed || trimmed.includes("\0")) {
		return undefined;
	}

	const resolved = path.resolve(cwd, trimmed);
	const relative = path.relative(cwd, resolved);
	if (!relative || relative === ".") {
		return undefined;
	}

	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return undefined;
	}

	return toPosixPath(relative);
}

function normalizeFinding(cwd: string, finding: ReviewFinding): ReviewFinding | undefined {
	const filePath = sanitizeFindingPath(cwd, finding.file_path);
	if (!filePath) {
		return undefined;
	}

	const normalizedTitle = normalizeTitle(finding.title, finding.priority);
	const lineStart = Math.max(1, Math.floor(finding.line_start));
	const rawLineEnd = Math.max(lineStart, Math.floor(finding.line_end));
	const lineEnd = Math.min(lineStart + (MAX_LINE_SPAN - 1), rawLineEnd);

	return {
		...finding,
		title: normalizedTitle,
		body: finding.body.trim(),
		line_start: lineStart,
		line_end: lineEnd,
		confidence: clampConfidence(finding.confidence),
		file_path: filePath,
	};
}

export function registerReviewTools(pi: ExtensionAPI): void {
	const ReportFindingParams = Type.Object({
		title: Type.String({ description: "Short finding title (prefer format: [P1] ...)." }),
		body: Type.String({ description: "One concise paragraph with impact and trigger." }),
		priority: Type.Union(
			PRIORITIES.map((value) => Type.Literal(value)),
			{
				description: "P0-P3 severity, from critical to nit.",
			},
		),
		confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence score 0-1." }),
		file_path: Type.String({ description: "Path to affected file (workspace-relative preferred)." }),
		line_start: Type.Number({ minimum: 1 }),
		line_end: Type.Number({ minimum: 1 }),
	});

	const SubmitReviewParams = Type.Object({
		verdict: Type.Union(
			VERDICTS.map((value) => Type.Literal(value)),
			{
				description: "Final review verdict.",
			},
		),
		summary: Type.String({ description: "Concise overall summary." }),
		confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence score 0-1." }),
	});

	pi.registerTool({
		name: TOOL_REPORT_FINDING,
		label: "Report Finding",
		description: "Record one code review finding with severity and precise location.",
		parameters: ReportFindingParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const finding = normalizeFinding(ctx.cwd, {
				title: params.title,
				body: params.body,
				priority: params.priority as FindingPriority,
				confidence: params.confidence,
				file_path: params.file_path,
				line_start: params.line_start,
				line_end: params.line_end,
			});

			if (!finding) {
				return {
					content: [
						{
							type: "text",
							text: "Rejected finding: file_path must be inside workspace and relative (no absolute or ..-escape paths).",
						},
					],
					details: { accepted: false },
				};
			}

			const sessionId = getSessionKey(ctx);
			const state = reviewStateStore.get(sessionId);
			const replaced = upsertFinding(state.findings, finding);
			state.submission = undefined;
			state.updatedAt = Date.now();

			const location = `${finding.file_path}:${finding.line_start}${
				finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""
			}`;

			return {
				content: [
					{
						type: "text",
						text: `${replaced ? "Updated" : "Recorded"} ${finding.priority} finding: ${finding.title}\nLocation: ${location}\nFindings in session: ${state.findings.length}`,
					},
				],
				details: finding,
			};
		},
	});

	pi.registerTool({
		name: TOOL_SUBMIT_REVIEW,
		label: "Submit Review",
		description: "Submit final review verdict after all findings are reported.",
		parameters: SubmitReviewParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const sessionId = getSessionKey(ctx);
			const state = reviewStateStore.get(sessionId);
			const submission: ReviewSubmission = {
				verdict: params.verdict,
				summary: params.summary.trim(),
				confidence: clampConfidence(params.confidence),
			};
			state.submission = submission;
			state.updatedAt = Date.now();

			const counts = summarizePriorities(state.findings);
			const findingsSummary = PRIORITIES.map((priority) => `${priority}:${counts[priority] ?? 0}`).join(" ");
			const suggestedVerdict = suggestVerdict(state.findings);
			const mismatchNote =
				suggestedVerdict !== submission.verdict
					? `\nNote: verdict differs from finding-based suggestion (${suggestedVerdict}).`
					: "";

			return {
				content: [
					{
						type: "text",
						text: `Review submitted: ${submission.verdict}\nFindings: ${state.findings.length} (${findingsSummary})\nSummary: ${submission.summary}${mismatchNote}`,
					},
				],
				details: {
					...submission,
					findings_count: state.findings.length,
					priorities: counts,
					suggested_verdict: suggestedVerdict,
				},
			};
		},
	});
}
