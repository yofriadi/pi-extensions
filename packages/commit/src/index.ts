import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCommitHelpText, parseCommitCommandArgs } from "./args.js";
import { applyChangelogForCommit } from "./changelog.js";
import {
	applyPatchToIndex,
	commit,
	excludeLockFiles,
	excludeSensitiveFiles,
	getCachedDiff,
	getCachedNumstat,
	getCachedPatch,
	getCachedStat,
	getMixedIndexFiles,
	getRecentCommits,
	getStagedFiles,
	isGitRepo,
	push,
	resetStaging,
	stageAll,
	stageSelections,
} from "./git.js";
import { generateProposalWithModel, generateSplitPlanWithModel } from "./llm.js";
import { buildHeuristicSplitPlan, shouldAttemptAutoSplit, validateSplitPlan } from "./split.js";
import type { CommitProposal, SplitCommitPlan } from "./types.js";
import { formatCommitMessage, generateFallbackProposal, validateProposal } from "./validation.js";

const DEFAULT_SPLIT_COMMIT_CAP = 6;

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "AI-powered conventional commit generation for staged changes",
		handler: async (args, ctx) => {
			const parsed = parseCommitCommandArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(`Commit command error: ${parsed.error}`, "warning");
				ctx.ui.notify(getCommitHelpText(), "info");
				return;
			}

			const options = parsed.value;
			if (options.help) {
				ctx.ui.notify(getCommitHelpText(), "info");
				return;
			}

			if (!(await isGitRepo(pi, ctx.cwd))) {
				ctx.ui.notify("/commit requires a git repository.", "error");
				return;
			}

			if (options.legacy) {
				ctx.ui.notify("--legacy is accepted for compatibility and follows the same pipeline.", "info");
			}

			ctx.ui.setStatus("commit", "commit: collecting git changes...");
			try {
				let stagedFiles = await getStagedFiles(pi, ctx.cwd);
				if (stagedFiles.length === 0) {
					ctx.ui.notify("No staged files detected, staging all changes...", "info");
					const stageResult = await stageAll(pi, ctx.cwd);
					if (!stageResult.ok) {
						ctx.ui.notify(`Failed to stage changes: ${stageResult.message}`, "error");
						return;
					}
					stagedFiles = await getStagedFiles(pi, ctx.cwd);
				}

				if (stagedFiles.length === 0) {
					ctx.ui.notify("No changes to commit.", "warning");
					return;
				}

				const numstat = await getCachedNumstat(pi, ctx.cwd);
				const { filtered: noLockfileFiles, excluded: excludedLockfiles } = excludeLockFiles(stagedFiles);
				const { filtered: analysisFiles, excluded: excludedSensitiveFiles } = excludeSensitiveFiles(noLockfileFiles);
				const stat = analysisFiles.length > 0 ? await getCachedStat(pi, ctx.cwd, analysisFiles) : "";
				const analysisNumstat = analysisFiles.length > 0 ? await getCachedNumstat(pi, ctx.cwd, analysisFiles) : [];
				const diff = analysisFiles.length > 0 ? await getCachedDiff(pi, ctx.cwd, analysisFiles) : "";
				const recentCommits = await getRecentCommits(pi, ctx.cwd, 8);

				if (analysisFiles.length === 0) {
					ctx.ui.notify(
						"All staged files were excluded from AI analysis (lockfiles/sensitive files). Using fallback commit text.",
						"warning",
					);
				}

				const modelResolution = await resolveModelAndApiKey(options.model, ctx.model, ctx.modelRegistry.getAll(), ctx);
				if (!modelResolution) {
					return;
				}
				const { model, apiKey } = modelResolution;

				let shouldSplit =
					options.split || (!options.noSplit && shouldAttemptAutoSplit(stagedFiles) && stagedFiles.length > 1);
				if (shouldSplit && !options.allowMixedIndex && !options.dryRun) {
					const mixedIndexFiles = await getMixedIndexFiles(pi, ctx.cwd, stagedFiles);
					if (mixedIndexFiles.length > 0) {
						const preview = mixedIndexFiles.slice(0, 8).join(", ");
						const suffix = mixedIndexFiles.length > 8 ? ` (+${mixedIndexFiles.length - 8} more)` : "";
						const warning =
							`Split mode safety guard: detected files with both staged and unstaged edits: ${preview}${suffix}. ` +
							"Clean the index first, or rerun with --allow-mixed-index.";

						if (options.split) {
							ctx.ui.notify(warning, "error");
							return;
						}

						ctx.ui.notify(`${warning} Falling back to single-commit mode.`, "warning");
						shouldSplit = false;
					}
				}

				if (shouldSplit) {
					ctx.ui.setStatus("commit", "commit: planning split commits...");
					const splitPlanResult = await buildSplitPlan({
						model,
						apiKey,
						diff,
						stat,
						stagedFiles,
						numstat,
						recentCommits,
						context: options.context,
						maxSplitCommits: options.maxSplitCommits ?? DEFAULT_SPLIT_COMMIT_CAP,
						enforceSplit: options.split,
						ctx,
					});

					if (splitPlanResult) {
						const execution = await executeSplitPlan({
							pi,
							cwd: ctx.cwd,
							plan: splitPlanResult,
							dryRun: options.dryRun,
							noChangelog: options.noChangelog,
							ctx,
							modelLabel: `${model.provider}/${model.id}`,
							excludedLockfiles,
							excludedSensitiveFiles,
						});

						if (!execution.ok) {
							ctx.ui.notify(`Split commit failed: ${execution.error}`, "error");
							return;
						}

						if (options.push && !options.dryRun) {
							ctx.ui.setStatus("commit", "commit: pushing...");
							const pushResult = await push(pi, ctx.cwd);
							ctx.ui.notify(
								pushResult.ok ? "Pushed to remote." : `Push failed: ${pushResult.message}`,
								pushResult.ok ? "info" : "error",
							);
						}
						return;
					}
				}

				ctx.ui.setStatus("commit", "commit: generating proposal...");
				let proposal: CommitProposal;
				try {
					proposal = await generateProposalWithModel({
						model,
						apiKey,
						diff,
						stat,
						numstat: analysisNumstat,
						recentCommits,
						context: options.context,
					});
				} catch (error) {
					ctx.ui.notify(`Model proposal failed, using fallback: ${formatError(error)}`, "warning");
					proposal = generateFallbackProposal(numstat);
				}

				const validated = validateProposal(proposal);
				if (!validated.valid) {
					ctx.ui.notify(`Commit proposal invalid, using fallback: ${validated.errors.join("; ")}`, "warning");
					proposal = generateFallbackProposal(numstat);
				} else {
					proposal = validated.proposal;
				}

				const message = formatCommitMessage(proposal);
				const exclusionNotes: string[] = [];
				if (excludedLockfiles.length > 0) {
					exclusionNotes.push(`${excludedLockfiles.length} lockfile(s) excluded from analysis`);
				}
				if (excludedSensitiveFiles.length > 0) {
					exclusionNotes.push(`${excludedSensitiveFiles.length} sensitive file(s) excluded from analysis`);
				}

				const preview = [
					`Model: ${model.provider}/${model.id}`,
					`Files: ${stagedFiles.length} staged${exclusionNotes.length > 0 ? ` (${exclusionNotes.join(", ")})` : ""}`,
					"",
					"Generated commit message:",
					message.subject,
					...(message.body ? ["", message.body] : []),
					...(proposal.warnings.length > 0 ? ["", `Warnings: ${proposal.warnings.join(" | ")}`] : []),
				].join("\n");

				if (options.dryRun) {
					ctx.ui.notify(preview, "info");
					return;
				}

				if (!options.noChangelog) {
					const changelog = await applyChangelogForCommit({
						pi,
						cwd: ctx.cwd,
						proposal,
						files: stagedFiles,
						dryRun: options.dryRun,
					});
					if (changelog.updated.length > 0) {
						ctx.ui.notify(
							`Updated changelog: ${changelog.updated.map((value) => value.replace(`${ctx.cwd}/`, "")).join(", ")}`,
							"info",
						);
					}
					if (changelog.warnings.length > 0) {
						ctx.ui.notify(`Changelog warnings: ${changelog.warnings.join(" | ")}`, "warning");
					}
				}

				ctx.ui.setStatus("commit", "commit: creating git commit...");
				const commitResult = await commit(pi, ctx.cwd, message.subject, message.body);
				if (!commitResult.ok) {
					ctx.ui.notify(`Commit failed: ${commitResult.message}`, "error");
					return;
				}

				ctx.ui.notify(`Commit created.\n${preview}`, "info");
				if (options.push) {
					ctx.ui.setStatus("commit", "commit: pushing...");
					const pushResult = await push(pi, ctx.cwd);
					ctx.ui.notify(
						pushResult.ok ? "Pushed to remote." : `Push failed: ${pushResult.message}`,
						pushResult.ok ? "info" : "error",
					);
				}
			} finally {
				ctx.ui.setStatus("commit", undefined);
			}
		},
	});
}

async function buildSplitPlan(input: {
	model: Model<Api>;
	apiKey: string;
	diff: string;
	stat: string;
	stagedFiles: string[];
	numstat: ReturnType<typeof getCachedNumstat> extends Promise<infer T> ? T : never;
	recentCommits: string[];
	context?: string;
	maxSplitCommits: number;
	enforceSplit: boolean;
	ctx: { ui: { notify: (message: string, level?: "info" | "warning" | "error") => void } };
}): Promise<SplitCommitPlan | undefined> {
	try {
		const llmPlan = await generateSplitPlanWithModel({
			model: input.model,
			apiKey: input.apiKey,
			diff: input.diff,
			stat: input.stat,
			files: input.stagedFiles,
			recentCommits: input.recentCommits,
			maxSplitCommits: input.maxSplitCommits,
			context: input.context,
		});
		const validated = validateSplitPlan(llmPlan, input.stagedFiles);
		if (validated.valid && validated.plan.commits.length >= 2) {
			return validated.plan;
		}
		if (validated.errors.length > 0) {
			input.ctx.ui.notify(`Split plan validation failed: ${validated.errors.join("; ")}`, "warning");
		}
	} catch (error) {
		input.ctx.ui.notify(`Split planning failed: ${formatError(error)}`, "warning");
	}

	const fallback = buildHeuristicSplitPlan(input.stagedFiles, input.numstat);
	if (!fallback) {
		if (input.enforceSplit) {
			input.ctx.ui.notify("Unable to build a valid split plan. Falling back to single commit.", "warning");
		}
		return undefined;
	}
	const validatedFallback = validateSplitPlan(fallback, input.stagedFiles);
	if (!validatedFallback.valid) {
		return undefined;
	}
	return validatedFallback.plan;
}

async function executeSplitPlan(input: {
	pi: ExtensionAPI;
	cwd: string;
	plan: SplitCommitPlan;
	dryRun: boolean;
	noChangelog: boolean;
	ctx: {
		hasUI: boolean;
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => void;
			confirm: (title: string, message: string) => Promise<boolean>;
			setStatus: (key: string, value: string | undefined) => void;
		};
	};
	modelLabel: string;
	excludedLockfiles: string[];
	excludedSensitiveFiles: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const validated = validateSplitPlan(input.plan, await getStagedFiles(input.pi, input.cwd));
	if (!validated.valid) {
		return { ok: false, error: validated.errors.join("; ") };
	}

	const plan = validated.plan;
	const order = validated.order;
	const preview = formatSplitPlanPreview(
		plan,
		order,
		input.modelLabel,
		input.excludedLockfiles,
		input.excludedSensitiveFiles,
	);
	if (input.dryRun) {
		input.ctx.ui.notify(preview, "info");
		return { ok: true };
	}

	if (input.ctx.hasUI) {
		const confirmed = await input.ctx.ui.confirm(
			"Split commit confirmation",
			`Create ${plan.commits.length} commits in dependency order?`,
		);
		if (!confirmed) {
			return { ok: false, error: "Split commit cancelled" };
		}
	}

	const originalIndexPatch = await getCachedPatch(input.pi, input.cwd);
	const resetResult = await resetStaging(input.pi, input.cwd);
	if (!resetResult.ok) {
		return { ok: false, error: resetResult.message ?? "Failed to reset staging" };
	}

	const completedSubjects: string[] = [];
	let completedCount = 0;

	const fail = async (reason: string): Promise<{ ok: false; error: string }> => {
		const resetAfterFailure = await resetStaging(input.pi, input.cwd);
		if (!resetAfterFailure.ok) {
			return {
				ok: false,
				error: `${reason} (also failed to reset index: ${resetAfterFailure.message ?? "unknown error"})`,
			};
		}

		if (completedCount === 0) {
			const restore = await applyPatchToIndex(input.pi, input.cwd, originalIndexPatch);
			if (!restore.ok) {
				return {
					ok: false,
					error: `${reason} (failed to restore original staged state: ${restore.message ?? "unknown error"})`,
				};
			}
			return { ok: false, error: `${reason} (original staged state restored)` };
		}

		return {
			ok: false,
			error: `${reason} (${completedCount} split commit(s) already created; index reset, original staging cannot be fully restored)`,
		};
	};

	for (const commitIndex of order) {
		const entry = plan.commits[commitIndex];
		if (!entry) {
			return fail(`Invalid split plan index ${commitIndex}`);
		}

		input.ctx.ui.setStatus("commit", `commit: staging split commit ${commitIndex + 1}/${plan.commits.length}...`);
		const stageResult = await stageSelections(input.pi, input.cwd, entry.changes);
		if (!stageResult.ok) {
			return fail(`Failed staging commit ${commitIndex + 1} (${entry.proposal.summary}): ${stageResult.message}`);
		}

		const stagedNow = await getStagedFiles(input.pi, input.cwd);
		if (stagedNow.length === 0) {
			return fail(`No staged changes for split commit ${commitIndex + 1}`);
		}

		if (!input.noChangelog) {
			const changelog = await applyChangelogForCommit({
				pi: input.pi,
				cwd: input.cwd,
				proposal: entry.proposal,
				files: entry.changes.map((change) => change.path),
				dryRun: false,
			});
			if (changelog.warnings.length > 0) {
				input.ctx.ui.notify(
					`Split commit ${commitIndex + 1} changelog warnings: ${changelog.warnings.join(" | ")}`,
					"warning",
				);
			}
		}

		const message = formatCommitMessage(entry.proposal);
		input.ctx.ui.setStatus("commit", `commit: creating split commit ${commitIndex + 1}/${plan.commits.length}...`);
		const commitResult = await commit(input.pi, input.cwd, message.subject, message.body);
		if (!commitResult.ok) {
			return fail(`git commit failed for split commit ${commitIndex + 1}: ${commitResult.message}`);
		}

		completedSubjects.push(message.subject);
		completedCount += 1;
	}

	input.ctx.ui.notify(
		[
			`Created ${completedSubjects.length} split commit(s):`,
			...completedSubjects.map((subject, index) => `${index + 1}. ${subject}`),
		].join("\n"),
		"info",
	);

	return { ok: true };
}

async function resolveModelAndApiKey(
	override: string | undefined,
	current: Model<Api> | undefined,
	allModels: Model<Api>[],
	ctx: {
		modelRegistry: { getApiKey: (model: Model<Api>) => Promise<string | undefined>; getAvailable: () => Model<Api>[] };
		ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	},
): Promise<{ model: Model<Api>; apiKey: string } | undefined> {
	let model = resolveModel(override, current, allModels);
	let apiKey = model ? await ctx.modelRegistry.getApiKey(model) : undefined;
	if (!apiKey) {
		const availableFallback = ctx.modelRegistry.getAvailable()[0];
		if (availableFallback) {
			model = availableFallback;
			apiKey = await ctx.modelRegistry.getApiKey(model);
		}
	}

	if (!model || !apiKey) {
		ctx.ui.notify("No model with valid API key is available for commit generation.", "error");
		return undefined;
	}

	return { model, apiKey };
}

function resolveModel(
	override: string | undefined,
	current: Model<Api> | undefined,
	allModels: Model<Api>[],
): Model<Api> | undefined {
	if (!override) {
		return current ?? allModels[0];
	}

	const target = override.trim();
	if (!target) {
		return current ?? allModels[0];
	}

	const exact = allModels.find((model) => model.id === target || `${model.provider}/${model.id}` === target);
	if (exact) {
		return exact;
	}

	const [provider, modelId] = splitProviderModel(target);
	if (provider && modelId) {
		return allModels.find((model) => model.provider === provider && model.id === modelId);
	}

	return undefined;
}

function splitProviderModel(value: string): [string | undefined, string | undefined] {
	const slash = value.indexOf("/");
	if (slash > 0 && slash < value.length - 1) {
		return [value.slice(0, slash), value.slice(slash + 1)];
	}
	const colon = value.indexOf(":");
	if (colon > 0 && colon < value.length - 1) {
		return [value.slice(0, colon), value.slice(colon + 1)];
	}
	return [undefined, undefined];
}

function formatSplitPlanPreview(
	plan: SplitCommitPlan,
	order: number[],
	modelLabel: string,
	excludedLockfiles: string[],
	excludedSensitiveFiles: string[],
): string {
	const lines = [
		`Model: ${modelLabel}`,
		`Split plan: ${plan.commits.length} commit(s)`,
		`Execution order: ${order.map((index) => index + 1).join(" -> ")}`,
	];
	if (excludedLockfiles.length > 0) {
		lines.push(`Excluded lockfiles from analysis: ${excludedLockfiles.join(", ")}`);
	}
	if (excludedSensitiveFiles.length > 0) {
		lines.push(`Excluded sensitive files from analysis: ${excludedSensitiveFiles.join(", ")}`);
	}

	for (const [index, item] of plan.commits.entries()) {
		const message = formatCommitMessage(item.proposal);
		lines.push("", `${index + 1}. ${message.subject}`);
		if (item.dependencies.length > 0) {
			lines.push(`   depends on: ${item.dependencies.map((value) => value + 1).join(", ")}`);
		}
		if (item.rationale) {
			lines.push(`   rationale: ${item.rationale}`);
		}
		for (const change of item.changes) {
			lines.push(`   - ${formatFileSelection(change.path, change.hunks.type === "all" ? "all" : change.hunks)}`);
		}
	}

	if (plan.warnings.length > 0) {
		lines.push("", `Warnings: ${plan.warnings.join(" | ")}`);
	}

	return lines.join("\n");
}

function formatFileSelection(
	path: string,
	selector: "all" | { type: "indices"; indices: number[] } | { type: "lines"; start: number; end: number },
): string {
	if (selector === "all") {
		return `${path} (all hunks)`;
	}
	if (selector.type === "indices") {
		return `${path} (hunks ${selector.indices.join(", ")})`;
	}
	return `${path} (lines ${selector.start}-${selector.end})`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
