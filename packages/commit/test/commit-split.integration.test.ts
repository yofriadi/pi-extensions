import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import commitExtension from "../src/index.js";
import { generateSplitPlanWithModel } from "../src/llm.js";

vi.mock("../src/llm.js", () => ({
	generateSplitPlanWithModel: vi.fn(),
	generateProposalWithModel: vi.fn(),
}));

const execFileAsync = promisify(execFile);

describe("commit split integration", () => {
	it("resets index and reports partial progress when split commit fails mid-flight", async () => {
		const splitPlanMock = vi.mocked(generateSplitPlanWithModel);
		splitPlanMock.mockResolvedValue({
			commits: [
				{
					proposal: {
						type: "refactor",
						scope: null,
						summary: "updated alpha module",
						details: ["Updated alpha implementation."],
						issueRefs: [],
						warnings: [],
					},
					changes: [{ path: "alpha.ts", hunks: { type: "all" } }],
					dependencies: [],
				},
				{
					proposal: {
						type: "refactor",
						scope: null,
						summary: "updated beta module",
						details: ["Updated beta implementation."],
						issueRefs: [],
						warnings: [],
					},
					changes: [{ path: "beta.ts", hunks: { type: "all" } }],
					dependencies: [0],
				},
			],
			warnings: [],
		});

		await withTempRepo(async (cwd) => {
			await writeFile(path.join(cwd, "alpha.ts"), "export const alpha = 1;\n", "utf8");
			await writeFile(path.join(cwd, "beta.ts"), "export const beta = 1;\n", "utf8");
			await runGit(cwd, ["add", "alpha.ts", "beta.ts"]);
			await runGit(cwd, ["commit", "-m", "initial"]);

			await writeFile(path.join(cwd, "alpha.ts"), "export const alpha = 2;\n", "utf8");
			await writeFile(path.join(cwd, "beta.ts"), "export const beta = 2;\n", "utf8");
			await runGit(cwd, ["add", "alpha.ts", "beta.ts"]);

			const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
			let commitCallCount = 0;
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

			const pi = {
				registerCommand: (
					_name: string,
					options: {
						handler: (args: string, ctx: unknown) => Promise<void>;
					},
				) => {
					handler = options.handler;
				},
				exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
					if (command === "git" && args[0] === "commit") {
						commitCallCount += 1;
						if (commitCallCount === 2) {
							return { code: 1, stdout: "", stderr: "simulated commit failure" };
						}
					}
					return runExec(command, args, options?.cwd, options?.timeout);
				},
			} as unknown as ExtensionAPI;

			commitExtension(pi);
			expect(handler).toBeDefined();

			const model = { provider: "test", id: "mock" } as unknown as Model<Api>;
			const ctx = {
				cwd,
				hasUI: false,
				model,
				modelRegistry: {
					getAll: () => [model],
					getAvailable: () => [model],
					getApiKey: async () => "test-key",
				},
				ui: {
					notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
					confirm: async () => true,
					setStatus: () => undefined,
				},
			};

			if (!handler) {
				throw new Error("commit handler was not registered");
			}
			await handler("--split --no-changelog", ctx);

			expect(splitPlanMock).toHaveBeenCalledTimes(1);
			expect(commitCallCount).toBe(2);

			const totalCommits = (await readGit(cwd, ["rev-list", "--count", "HEAD"])).trim();
			expect(totalCommits).toBe("2");

			const stagedAfterFailure = (await readGit(cwd, ["diff", "--cached", "--name-only", "--"])).trim();
			expect(stagedAfterFailure).toBe("");

			const unstagedAfterFailure = (await readGit(cwd, ["diff", "--name-only", "--"]))
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(unstagedAfterFailure).toContain("beta.ts");

			const combinedNotifications = notifications.map((item) => item.message).join("\n");
			expect(combinedNotifications).toContain("Split commit failed:");
			expect(combinedNotifications).toContain(
				"1 split commit(s) already created; index reset, original staging cannot be fully restored",
			);
		});
	});
});

async function withTempRepo(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-commit-split-test-"));
	try {
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "test@example.com"]);
		await runGit(cwd, ["config", "user.name", "Test User"]);
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
}

async function readGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	return stdout ?? "";
}

async function runExec(command: string, args: string[], cwd?: string, timeout?: number) {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			timeout,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			env: process.env,
		});
		return {
			code: 0,
			stdout: stdout ?? "",
			stderr: stderr ?? "",
		};
	} catch (error) {
		const typed = error as {
			code?: string | number;
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		return {
			code: typeof typed.code === "number" ? typed.code : 1,
			stdout: typed.stdout ?? "",
			stderr: typed.stderr ?? typed.message ?? "",
		};
	}
}
