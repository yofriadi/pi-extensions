export const COMMIT_TYPES = [
	"feat",
	"fix",
	"refactor",
	"perf",
	"docs",
	"test",
	"build",
	"ci",
	"chore",
	"style",
	"revert",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export interface CommitProposal {
	type: CommitType;
	scope: string | null;
	summary: string;
	details: string[];
	issueRefs: string[];
	warnings: string[];
}

export type HunkSelector =
	| { type: "all" }
	| { type: "indices"; indices: number[] }
	| { type: "lines"; start: number; end: number };

export interface FileSelection {
	path: string;
	hunks: HunkSelector;
}

export interface SplitCommitItem {
	proposal: CommitProposal;
	changes: FileSelection[];
	dependencies: number[];
	rationale?: string;
}

export interface SplitCommitPlan {
	commits: SplitCommitItem[];
	warnings: string[];
}

export interface ParsedCommitCommandArgs {
	push: boolean;
	dryRun: boolean;
	noChangelog: boolean;
	legacy: boolean;
	split: boolean;
	noSplit: boolean;
	allowMixedIndex: boolean;
	maxSplitCommits?: number;
	context?: string;
	model?: string;
	help: boolean;
}

export interface NumstatEntry {
	path: string;
	additions: number;
	deletions: number;
}

export interface DiffHunk {
	index: number;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

export interface FileDiff {
	filename: string;
	content: string;
	additions: number;
	deletions: number;
	isBinary: boolean;
}

export interface FileHunks {
	filename: string;
	isBinary: boolean;
	hunks: DiffHunk[];
}
