import path from "node:path";
import { fallbackVerb, inferScopeFromFiles, inferTypeFromFiles, isDocPath, isTestPath } from "./heuristics.js";
import type { CommitProposal, FileSelection, NumstatEntry, SplitCommitItem, SplitCommitPlan } from "./types.js";
import { validateProposal } from "./validation.js";

export function validateSplitPlan(
	plan: SplitCommitPlan,
	stagedFiles: string[],
): { valid: boolean; errors: string[]; warnings: string[]; plan: SplitCommitPlan; order: number[] } {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (plan.commits.length < 2) {
		errors.push("Split plan requires at least 2 commits");
	}

	const normalizedCommits: SplitCommitItem[] = plan.commits.map((commit, commitIndex) => {
		const validated = validateProposal(commit.proposal);
		if (!validated.valid) {
			errors.push(...validated.errors.map((error) => `Commit ${commitIndex + 1}: ${error}`));
		}

		const changes = commit.changes
			.map((change) => normalizeSelection(change))
			.filter((change): change is FileSelection => !!change);
		if (changes.length === 0) {
			errors.push(`Commit ${commitIndex + 1}: no valid file changes`);
		}

		const dependencies = Array.from(
			new Set(
				commit.dependencies
					.map((value) => Math.floor(value))
					.filter(
						(value) => Number.isFinite(value) && value >= 0 && value < plan.commits.length && value !== commitIndex,
					),
			),
		);
		if (dependencies.length !== commit.dependencies.length) {
			warnings.push(`Commit ${commitIndex + 1}: normalized dependencies`);
		}

		for (const dependency of dependencies) {
			if (dependency === commitIndex) {
				errors.push(`Commit ${commitIndex + 1}: cannot depend on itself`);
			}
		}

		return {
			proposal: validated.proposal,
			changes,
			dependencies,
			rationale: commit.rationale?.trim() || undefined,
		};
	});

	const stagedSet = new Set(stagedFiles);
	const coverage = new Set<string>();
	const allFileSelections = new Map<string, number>();
	for (const [commitIndex, commit] of normalizedCommits.entries()) {
		for (const change of commit.changes) {
			if (!stagedSet.has(change.path)) {
				errors.push(`Commit ${commitIndex + 1}: file not staged: ${change.path}`);
			}
			coverage.add(change.path);
			if (change.hunks.type === "all") {
				allFileSelections.set(change.path, (allFileSelections.get(change.path) ?? 0) + 1);
			}
		}
	}

	for (const file of stagedFiles) {
		if (!coverage.has(file)) {
			errors.push(`Split plan does not cover staged file: ${file}`);
		}
	}

	for (const [file, count] of allFileSelections.entries()) {
		if (count > 1) {
			errors.push(`File selected as 'all' in multiple commits: ${file}`);
		}
	}

	const orderResult = computeDependencyOrder(normalizedCommits);
	if (!orderResult.ok) {
		errors.push(orderResult.error);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		plan: {
			commits: normalizedCommits,
			warnings: [...plan.warnings, ...warnings],
		},
		order: orderResult.ok ? orderResult.order : normalizedCommits.map((_commit, index) => index),
	};
}

function normalizeSelection(selection: FileSelection | null | undefined): FileSelection | undefined {
	if (!selection) {
		return undefined;
	}
	const filePath = selection.path.trim();
	if (!filePath) {
		return undefined;
	}

	const hunks = selection.hunks;
	if (hunks.type === "indices") {
		const indices = hunks.indices
			.map((value) => Math.floor(value))
			.filter((value) => Number.isFinite(value) && value >= 1);
		if (indices.length === 0) {
			return undefined;
		}
		return { path: filePath, hunks: { type: "indices", indices: Array.from(new Set(indices)) } };
	}

	if (hunks.type === "lines") {
		const start = Math.floor(hunks.start);
		const end = Math.floor(hunks.end);
		if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
			return undefined;
		}
		return { path: filePath, hunks: { type: "lines", start, end } };
	}

	return { path: filePath, hunks: { type: "all" } };
}

export function computeDependencyOrder(
	commits: Pick<SplitCommitItem, "dependencies">[],
): { ok: true; order: number[] } | { ok: false; error: string } {
	const indegree = new Array<number>(commits.length).fill(0);
	const graph = new Map<number, number[]>();
	for (let index = 0; index < commits.length; index += 1) {
		graph.set(index, []);
	}

	for (const [index, commit] of commits.entries()) {
		for (const dependency of commit.dependencies) {
			if (dependency < 0 || dependency >= commits.length) {
				return { ok: false, error: `Invalid dependency index: ${dependency}` };
			}
			graph.get(dependency)?.push(index);
			indegree[index] = (indegree[index] ?? 0) + 1;
		}
	}

	const queue: number[] = [];
	for (let index = 0; index < indegree.length; index += 1) {
		if ((indegree[index] ?? 0) === 0) {
			queue.push(index);
		}
	}

	const order: number[] = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		order.push(current);
		for (const next of graph.get(current) ?? []) {
			indegree[next] = (indegree[next] ?? 1) - 1;
			if ((indegree[next] ?? 0) === 0) {
				queue.push(next);
			}
		}
	}

	if (order.length !== commits.length) {
		return { ok: false, error: "Circular dependency detected in split commit plan" };
	}

	return { ok: true, order };
}

export function shouldAttemptAutoSplit(stagedFiles: string[]): boolean {
	if (stagedFiles.length < 3) {
		return false;
	}
	const groups = groupFilesForHeuristic(stagedFiles);
	return groups.size >= 2;
}

export function buildHeuristicSplitPlan(stagedFiles: string[], numstat: NumstatEntry[]): SplitCommitPlan | undefined {
	const groups = groupFilesForHeuristic(stagedFiles);
	if (groups.size < 2) {
		return undefined;
	}

	const commits: SplitCommitItem[] = [];
	for (const files of groups.values()) {
		const stats = numstat.filter((entry) => files.includes(entry.path));
		if (stats.length === 0) {
			continue;
		}

		const proposal = fallbackProposalForGroup(stats);
		commits.push({
			proposal,
			changes: files.map((filePath) => ({ path: filePath, hunks: { type: "all" } })),
			dependencies: [],
			rationale: "Heuristic grouping fallback",
		});
	}

	if (commits.length < 2) {
		return undefined;
	}

	return {
		commits,
		warnings: ["Used heuristic split grouping fallback"],
	};
}

function fallbackProposalForGroup(stats: NumstatEntry[]): CommitProposal {
	const type = inferTypeFromFiles(stats);
	const primary = path.basename(stats[0]?.path ?? "files");
	const summary =
		stats.length <= 1
			? `${fallbackVerb(type)} ${primary}`
			: `${fallbackVerb(type)} ${primary} and ${stats.length - 1} other${stats.length === 2 ? "" : "s"}`;

	return {
		type,
		scope: inferScopeFromFiles(stats),
		summary,
		details: stats.slice(0, 4).map((entry) => `Updated ${path.basename(entry.path)}.`),
		issueRefs: [],
		warnings: ["Generated split commit text from heuristic fallback"],
	};
}

function groupFilesForHeuristic(files: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const file of files) {
		const key = fileGroupKey(file);
		const bucket = groups.get(key) ?? [];
		bucket.push(file);
		groups.set(key, bucket);
	}
	return groups;
}

function fileGroupKey(filePath: string): string {
	const lowerPath = filePath.toLowerCase();
	if (isTestPath(lowerPath)) {
		return "tests";
	}

	if (isDocPath(lowerPath)) {
		return "docs";
	}

	const root = lowerPath.split("/")[0] ?? "root";
	return root || "root";
}
