import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewMode, ReviewRequest } from "./types.js";

type NotifyLevel = "info" | "warning" | "error";

export interface ReviewGitContext {
	pi: ExtensionAPI;
	cwd: string;
	notify: (message: string, level: NotifyLevel) => void;
}

function isSafeRefInput(ref: string): boolean {
	if (!ref || ref.length > 200) {
		return false;
	}
	if (ref.startsWith("-") || /\s|\0/.test(ref)) {
		return false;
	}
	return true;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000) {
	return pi.exec("git", args, { cwd, timeout });
}

async function resolveCommitRef(pi: ExtensionAPI, cwd: string, ref: string): Promise<string | undefined> {
	if (!isSafeRefInput(ref)) {
		return undefined;
	}

	const result = await runGit(pi, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 15_000);
	if (result.code !== 0) {
		return undefined;
	}

	const hash = result.stdout.trim().split("\n")[0];
	return hash || undefined;
}

export async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 10_000);
	return result.code === 0 && result.stdout.trim() === "true";
}

export async function gitDiff(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await runGit(pi, cwd, ["diff", ...args], 30_000);
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getGitBranches(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await runGit(pi, cwd, ["branch", "-a", "--format=%(refname:short)"]);
	if (result.code !== 0) {
		return [];
	}
	return result.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter((value) => value.length > 0 && !value.includes("->"));
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await runGit(pi, cwd, ["branch", "--show-current"]);
	if (result.code !== 0) {
		return "HEAD";
	}
	return result.stdout.trim() || "HEAD";
}

export async function getRecentCommits(pi: ExtensionAPI, cwd: string, count: number): Promise<string[]> {
	const result = await runGit(pi, cwd, ["log", `-${count}`, "--oneline", "--no-decorate"]);
	if (result.code !== 0) {
		return [];
	}
	return result.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
}

export async function buildReviewRequest(mode: ReviewMode, ctx: ReviewGitContext): Promise<ReviewRequest | undefined> {
	const { pi, cwd, notify } = ctx;

	if (mode.kind === "branch") {
		const baseHash = await resolveCommitRef(pi, cwd, mode.baseBranch);
		if (!baseHash) {
			notify(`Invalid base branch or ref: ${mode.baseBranch}`, "error");
			return undefined;
		}

		const currentBranch = await getCurrentBranch(pi, cwd);
		const currentHash = await resolveCommitRef(pi, cwd, currentBranch || "HEAD");
		if (!currentHash) {
			notify("Could not resolve current HEAD commit.", "error");
			return undefined;
		}

		const diff = await gitDiff(pi, cwd, [`${baseHash}...${currentHash}`]);
		if (!diff.trim()) {
			notify(`No changes between ${mode.baseBranch} and ${currentBranch}.`, "warning");
			return undefined;
		}
		return {
			modeLabel: `Reviewing changes between \`${mode.baseBranch}\` and \`${currentBranch}\` (PR-style)`,
			rawDiff: diff,
		};
	}

	if (mode.kind === "uncommitted") {
		const status = await runGit(pi, cwd, ["status", "--porcelain"], 15_000);
		if (!status.stdout.trim()) {
			notify("No uncommitted changes found.", "warning");
			return undefined;
		}

		const [unstaged, staged] = await Promise.all([gitDiff(pi, cwd, []), gitDiff(pi, cwd, ["--cached"])]);
		const combinedDiff = [unstaged, staged].filter(Boolean).join("\n");
		if (!combinedDiff.trim()) {
			notify("No diff content found for uncommitted changes.", "warning");
			return undefined;
		}

		return {
			modeLabel: "Reviewing uncommitted changes (staged + unstaged)",
			rawDiff: combinedDiff,
		};
	}

	if (mode.kind === "commit") {
		const resolvedCommit = await resolveCommitRef(pi, cwd, mode.hash);
		if (!resolvedCommit) {
			notify(`Invalid commit reference: ${mode.hash}`, "error");
			return undefined;
		}

		const show = await runGit(pi, cwd, ["show", "--format=", resolvedCommit], 30_000);
		if (show.code !== 0) {
			notify(`Failed to read commit ${mode.hash}: ${show.stderr || "unknown error"}`, "error");
			return undefined;
		}
		if (!show.stdout.trim()) {
			notify(`Commit ${mode.hash} has no diff content.`, "warning");
			return undefined;
		}
		return {
			modeLabel: `Reviewing commit \`${mode.hash}\``,
			rawDiff: show.stdout,
		};
	}

	const customDiff = await gitDiff(pi, cwd, ["HEAD"]);
	const modeLabel = `Custom review: ${mode.instructions.split("\n")[0].slice(0, 80)}`;
	if (!customDiff.trim()) {
		return {
			modeLabel,
			rawDiff: "",
			additionalInstructions: mode.instructions,
		};
	}

	return {
		modeLabel,
		rawDiff: customDiff,
		additionalInstructions: mode.instructions,
	};
}

export function isValidRefArg(value: string): boolean {
	return isSafeRefInput(value.trim());
}
