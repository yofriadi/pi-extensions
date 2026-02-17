export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewSubmission {
	verdict: ReviewVerdict;
	summary: string;
	confidence: number;
}

export interface ReviewSessionState {
	findings: ReviewFinding[];
	submission?: ReviewSubmission;
	mode?: string;
	updatedAt: number;
}

export interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	preview: string;
}

export interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: Array<{ path: string; reason: string; linesAdded: number; linesRemoved: number }>;
}

export type ReviewExecutionMode = "direct" | "task";

export type ReviewMode =
	| { kind: "branch"; baseBranch: string }
	| { kind: "uncommitted" }
	| { kind: "commit"; hash: string }
	| { kind: "custom"; instructions: string };

export interface ReviewRequest {
	modeLabel: string;
	rawDiff: string;
	additionalInstructions?: string;
}

export interface ReviewPromptInput {
	mode: string;
	stats: DiffStats;
	rawDiff: string;
	additionalInstructions?: string;
	executionMode: ReviewExecutionMode;
}
