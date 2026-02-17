import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseDiff } from "./diff.js";
import { buildReviewRequest, getGitBranches, getRecentCommits, isGitRepo, isValidRefArg } from "./git.js";
import { buildReviewPrompt } from "./prompt.js";
import { reviewStateStore } from "./state.js";
import { registerReviewTools, TOOL_REPORT_FINDING, TOOL_SUBMIT_REVIEW } from "./tools.js";
import type { ReviewExecutionMode, ReviewMode, ReviewSessionState } from "./types.js";
import { PRIORITIES, suggestVerdict, summarizePriorities } from "./verdict.js";

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export default function reviewExtension(pi: ExtensionAPI): void {
	registerReviewTools(pi);

	pi.registerCommand("review", {
		description: "Interactive code review launcher (branch, uncommitted, commit, custom)",
		getArgumentCompletions: (prefix) => {
			const options = ["uncommitted", "branch ", "commit ", "custom "];
			const matches = options.filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!(await isGitRepo(pi, ctx.cwd))) {
				ctx.ui.notify("/review requires a git repository.", "error");
				return;
			}

			const mode = await resolveReviewMode(args, ctx, pi);
			if (!mode) {
				return;
			}

			const request = await buildReviewRequest(mode, {
				pi,
				cwd: ctx.cwd,
				notify: (message, level) => ctx.ui.notify(message, level),
			});
			if (!request) {
				return;
			}

			const stats = parseDiff(request.rawDiff);
			if (stats.files.length === 0 && mode.kind !== "custom") {
				ctx.ui.notify("No reviewable files found (changes may be filtered as noise).", "warning");
				return;
			}

			const executionMode = getExecutionMode(pi);
			reviewStateStore.reset(getSessionKey(ctx), request.modeLabel);
			const prompt = buildReviewPrompt({
				mode: request.modeLabel,
				stats,
				rawDiff: request.rawDiff,
				additionalInstructions: request.additionalInstructions,
				executionMode,
			});

			sendPrompt(pi, ctx, prompt);
			ctx.ui.notify(
				`Queued review request: ${request.modeLabel}. Mode=${executionMode}. Tools: ${TOOL_REPORT_FINDING}, ${TOOL_SUBMIT_REVIEW}.`,
				"info",
			);
		},
	});

	pi.registerCommand("review-status", {
		description: "Show collected review findings and latest verdict",
		handler: async (_args, ctx) => {
			const state = reviewStateStore.get(getSessionKey(ctx));
			ctx.ui.notify(formatState(state), "info");
		},
	});

	pi.registerCommand("review-reset", {
		description: "Clear in-memory review findings/verdict for this session",
		handler: async (_args, ctx) => {
			reviewStateStore.reset(getSessionKey(ctx));
			ctx.ui.notify("Review state reset.", "info");
		},
	});
}

function getExecutionMode(pi: ExtensionAPI): ReviewExecutionMode {
	const allTools = pi.getAllTools().map((tool) => tool.name);
	return allTools.includes("task") ? "task" : "direct";
}

function formatState(state: ReviewSessionState): string {
	const counts = summarizePriorities(state.findings);
	const byPriority = PRIORITIES.map((priority) => `${priority}:${counts[priority] ?? 0}`).join(" ");
	const suggested = suggestVerdict(state.findings);
	const verdict = state.submission
		? `${state.submission.verdict} (${Math.round(state.submission.confidence * 100)}%)`
		: "not submitted";

	return [
		`Review mode: ${state.mode ?? "(unknown)"}`,
		`Findings: ${state.findings.length} (${byPriority})`,
		`Suggested verdict: ${suggested}`,
		`Submitted verdict: ${verdict}`,
	].join("\n");
}

function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
		return;
	}
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

async function resolveReviewMode(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<ReviewMode | undefined> {
	const parsed = parseModeArgs(args);
	if (parsed) {
		return parsed;
	}

	if (args.trim().length > 0) {
		ctx.ui.notify(
			"Invalid /review arguments. Use: uncommitted | branch <name> | commit <hash> | custom <text>",
			"warning",
		);
		return undefined;
	}

	if (!ctx.hasUI) {
		return { kind: "uncommitted" };
	}

	const selection = await ctx.ui.select("Review Mode", [
		"1. Review against a base branch (PR style)",
		"2. Review uncommitted changes",
		"3. Review a specific commit",
		"4. Custom review instructions",
	]);

	if (!selection) {
		return undefined;
	}

	const modeNum = Number.parseInt(selection[0] ?? "", 10);
	if (modeNum === 1) {
		const branches = await getGitBranches(pi, ctx.cwd);
		if (branches.length === 0) {
			ctx.ui.notify("No git branches found.", "error");
			return undefined;
		}
		const baseBranch = await ctx.ui.select("Select base branch", branches);
		if (!baseBranch) {
			return undefined;
		}
		return { kind: "branch", baseBranch };
	}
	if (modeNum === 2) {
		return { kind: "uncommitted" };
	}
	if (modeNum === 3) {
		const commits = await getRecentCommits(pi, ctx.cwd, 25);
		if (commits.length === 0) {
			ctx.ui.notify("No commits found.", "error");
			return undefined;
		}
		const selectedCommit = await ctx.ui.select("Select commit", commits);
		if (!selectedCommit) {
			return undefined;
		}
		const hash = selectedCommit.split(" ")[0];
		return { kind: "commit", hash };
	}
	if (modeNum === 4) {
		const instructions = await ctx.ui.editor("Custom review instructions", "Review the following:\n\n");
		if (!instructions?.trim()) {
			return undefined;
		}
		return { kind: "custom", instructions };
	}

	return undefined;
}

function parseModeArgs(args: string): ReviewMode | undefined {
	const trimmed = args.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed === "uncommitted") {
		return { kind: "uncommitted" };
	}

	if (trimmed.startsWith("branch ")) {
		const baseBranch = trimmed.slice("branch ".length).trim();
		if (!baseBranch || !isValidRefArg(baseBranch)) {
			return undefined;
		}
		return { kind: "branch", baseBranch };
	}

	if (trimmed.startsWith("commit ")) {
		const hash = trimmed.slice("commit ".length).trim();
		if (!hash || !isValidRefArg(hash)) {
			return undefined;
		}
		return { kind: "commit", hash };
	}

	if (trimmed.startsWith("custom ")) {
		const instructions = trimmed.slice("custom ".length).trim();
		return instructions ? { kind: "custom", instructions } : undefined;
	}

	return undefined;
}
