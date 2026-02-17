import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyPatchToIndex,
	excludeSensitiveFiles,
	getCachedPatch,
	getStagedFiles,
	resetStaging,
	stageSelections,
} from "../src/git.js";

const execFileAsync = promisify(execFile);

describe("commit git helpers", () => {
	it("stages untracked file when selected with hunks: all", async () => {
		await withTempRepo(async (cwd, pi) => {
			await writeFile(path.join(cwd, "new-file.ts"), "export const value = 1;\n", "utf8");

			const result = await stageSelections(pi, cwd, [{ path: "new-file.ts", hunks: { type: "all" } }]);
			expect(result.ok).toBe(true);

			const staged = await getStagedFiles(pi, cwd);
			expect(staged).toContain("new-file.ts");
		});
	});

	it("rejects partial hunk selection for untracked files", async () => {
		await withTempRepo(async (cwd, pi) => {
			await writeFile(path.join(cwd, "new-file.ts"), "export const value = 1;\n", "utf8");

			const result = await stageSelections(pi, cwd, [
				{ path: "new-file.ts", hunks: { type: "indices", indices: [1] } },
			]);
			expect(result.ok).toBe(false);
			expect(result.message).toContain("Cannot select partial hunks for untracked file");
		});
	});

	it("restores staged index from cached patch", async () => {
		await withTempRepo(async (cwd, pi) => {
			await writeFile(path.join(cwd, "tracked.txt"), "line 1\n", "utf8");
			await runGit(cwd, ["add", "tracked.txt"]);
			await runGit(cwd, ["commit", "-m", "init"]);

			await writeFile(path.join(cwd, "tracked.txt"), "line 1\nline 2\n", "utf8");
			await runGit(cwd, ["add", "tracked.txt"]);

			const patch = await getCachedPatch(pi, cwd);
			expect(patch).toContain("diff --git");

			const resetResult = await resetStaging(pi, cwd);
			expect(resetResult.ok).toBe(true);
			expect(await getStagedFiles(pi, cwd)).toEqual([]);

			const restoreResult = await applyPatchToIndex(pi, cwd, patch);
			expect(restoreResult.ok).toBe(true);
			expect(await getStagedFiles(pi, cwd)).toContain("tracked.txt");
		});
	});

	it("filters sensitive file paths from analysis", () => {
		const result = excludeSensitiveFiles([
			"src/index.ts",
			".env",
			"secrets/prod.json",
			"config/id_rsa",
			"docs/readme.md",
		]);

		expect(result.filtered).toEqual(["src/index.ts", "docs/readme.md"]);
		expect(result.excluded).toEqual([".env", "secrets/prod.json", "config/id_rsa"]);
	});
});

async function withTempRepo(run: (cwd: string, pi: ExtensionAPI) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-commit-test-"));
	try {
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "test@example.com"]);
		await runGit(cwd, ["config", "user.name", "Test User"]);
		await run(cwd, createPiExec());
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

function createPiExec(): ExtensionAPI {
	return {
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			try {
				const { stdout, stderr } = await execFileAsync(command, args, {
					cwd: options?.cwd,
					timeout: options?.timeout,
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
		},
	} as unknown as ExtensionAPI;
}
