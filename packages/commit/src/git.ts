import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractFileHeader, parseFileDiffs, selectHunks } from "./diff.js";
import type { FileSelection, NumstatEntry } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const LOCKFILE_PATTERNS = [
	/^Cargo\.lock$/,
	/^package-lock\.json$/,
	/^yarn\.lock$/,
	/^pnpm-lock\.ya?ml$/,
	/^bun\.lockb?$/,
	/^go\.sum$/,
	/^poetry\.lock$/,
	/^Pipfile\.lock$/,
	/^uv\.lock$/,
	/^composer\.lock$/,
	/^Gemfile\.lock$/,
	/^flake\.lock$/,
	/^pubspec\.lock$/,
	/^Podfile\.lock$/,
	/^mix\.lock$/,
	/^gradle\.lockfile$/,
	/\.lock\.ya?ml$/,
	/-lock\.ya?ml$/,
];

const SENSITIVE_FILE_PATTERNS = [
	/(^|\/)\.env(\.|$)/i,
	/\.(pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/(^|\/)secrets?(\/|\.|$)/i,
	/(^|\/)(credentials?|tokens?)(\/|\.|$)/i,
];

export async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 10_000);
	return result.code === 0 && result.stdout.trim() === "true";
}

export async function getStagedFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await runGit(pi, cwd, ["diff", "--cached", "--name-only", "--"], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return [];
	}
	return splitLines(result.stdout);
}

export async function getMixedIndexFiles(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<string[]> {
	const result = await runGit(
		pi,
		cwd,
		["status", "--porcelain", "--untracked-files=no", "--", ...(files ?? [])],
		DEFAULT_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		return [];
	}

	const mixed = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		const raw = line.trimEnd();
		if (raw.length < 3) {
			continue;
		}

		const indexStatus = raw[0] ?? " ";
		const worktreeStatus = raw[1] ?? " ";
		if (!isTrackedStatus(indexStatus) || !isTrackedStatus(worktreeStatus)) {
			continue;
		}

		const pathPart = raw.slice(3).trim();
		const normalizedPath = normalizeStatusPath(pathPart);
		if (normalizedPath) {
			mixed.add(normalizedPath);
		}
	}

	return Array.from(mixed).sort();
}

export async function getUntrackedFiles(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<string[]> {
	const result = await runGit(
		pi,
		cwd,
		["ls-files", "--others", "--exclude-standard", "--", ...(files ?? [])],
		DEFAULT_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		return [];
	}
	return splitLines(result.stdout);
}

export async function stageAll(pi: ExtensionAPI, cwd: string): Promise<{ ok: boolean; message?: string }> {
	const result = await runGit(pi, cwd, ["add", "-A"], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr || result.stdout || "git add failed" };
	}
	return { ok: true };
}

export async function stageFiles(
	pi: ExtensionAPI,
	cwd: string,
	files: string[],
): Promise<{ ok: boolean; message?: string }> {
	if (files.length === 0) {
		return { ok: true };
	}
	const result = await runGit(pi, cwd, ["add", "--", ...files], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr || result.stdout || "git add failed" };
	}
	return { ok: true };
}

export async function resetStaging(pi: ExtensionAPI, cwd: string): Promise<{ ok: boolean; message?: string }> {
	const result = await runGit(pi, cwd, ["reset", "--"], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr || result.stdout || "git reset failed" };
	}
	return { ok: true };
}

export async function getCachedDiff(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<string> {
	const args = ["diff", "--cached", "--", ...(files ?? [])];
	const result = await runGit(pi, cwd, args, 45_000);
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getWorkingDiff(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<string> {
	const args = ["diff", "--", ...(files ?? [])];
	const result = await runGit(pi, cwd, args, 45_000);
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getCachedPatch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await runGit(pi, cwd, ["diff", "--cached", "--binary", "--full-index", "--"], 45_000);
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function applyPatchToIndex(
	pi: ExtensionAPI,
	cwd: string,
	patch: string,
): Promise<{ ok: boolean; message?: string }> {
	if (!patch.trim()) {
		return { ok: true };
	}

	const patchPath = path.join(os.tmpdir(), `pi-commit-index-${randomUUID()}.patch`);
	try {
		await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600 });
		const applyResult = await runGit(
			pi,
			cwd,
			["apply", "--cached", "--recount", "--whitespace=nowarn", patchPath],
			DEFAULT_TIMEOUT_MS,
		);
		if (applyResult.code !== 0) {
			return {
				ok: false,
				message: applyResult.stderr || applyResult.stdout || "git apply --cached failed",
			};
		}
		return { ok: true };
	} finally {
		await rm(patchPath, { force: true });
	}
}

export async function getCachedStat(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<string> {
	const result = await runGit(pi, cwd, ["diff", "--cached", "--stat", "--", ...(files ?? [])], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getCachedNumstat(pi: ExtensionAPI, cwd: string, files?: string[]): Promise<NumstatEntry[]> {
	const result = await runGit(pi, cwd, ["diff", "--cached", "--numstat", "--", ...(files ?? [])], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return [];
	}

	const entries: NumstatEntry[] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const [addsRaw, delsRaw, pathRaw] = trimmed.split("\t");
		if (!pathRaw) {
			continue;
		}
		const additions = addsRaw === "-" ? 0 : Number.parseInt(addsRaw ?? "0", 10);
		const deletions = delsRaw === "-" ? 0 : Number.parseInt(delsRaw ?? "0", 10);
		entries.push({
			path: normalizeRenamePath(pathRaw),
			additions: Number.isFinite(additions) ? additions : 0,
			deletions: Number.isFinite(deletions) ? deletions : 0,
		});
	}

	return entries;
}

export async function getRecentCommits(pi: ExtensionAPI, cwd: string, count: number): Promise<string[]> {
	const result = await runGit(pi, cwd, ["log", `-${count}`, "--oneline", "--no-decorate"], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return [];
	}
	return splitLines(result.stdout);
}

export async function stageSelections(
	pi: ExtensionAPI,
	cwd: string,
	selections: FileSelection[],
): Promise<{ ok: boolean; message?: string }> {
	if (selections.length === 0) {
		return { ok: false, message: "No file selections provided" };
	}

	const uniquePaths = Array.from(new Set(selections.map((selection) => selection.path)));
	const diff = await getWorkingDiff(pi, cwd, uniquePaths);
	const fileDiffs = parseFileDiffs(diff);
	const fileDiffMap = new Map(fileDiffs.map((entry) => [entry.filename, entry]));
	const untracked = new Set(await getUntrackedFiles(pi, cwd, uniquePaths));

	const patchParts: string[] = [];
	const directStagePaths: string[] = [];

	for (const selection of selections) {
		const fileDiff = fileDiffMap.get(selection.path);
		if (!fileDiff) {
			if (untracked.has(selection.path) && selection.hunks.type === "all") {
				directStagePaths.push(selection.path);
				continue;
			}
			if (untracked.has(selection.path)) {
				return { ok: false, message: `Cannot select partial hunks for untracked file ${selection.path}` };
			}
			return { ok: false, message: `No unstaged diff found for ${selection.path}` };
		}

		if (selection.hunks.type === "all") {
			if (fileDiff.isBinary) {
				directStagePaths.push(selection.path);
			} else {
				patchParts.push(fileDiff.content);
			}
			continue;
		}

		if (fileDiff.isBinary) {
			return { ok: false, message: `Cannot select partial hunks for binary file ${selection.path}` };
		}

		const selectedHunks = selectHunks(fileDiff, selection.hunks);
		if (selectedHunks.length === 0) {
			return { ok: false, message: `No hunks matched selector for ${selection.path}` };
		}

		const header = extractFileHeader(fileDiff.content);
		patchParts.push([header, ...selectedHunks.map((hunk) => hunk.content)].join("\n"));
	}

	if (patchParts.length > 0) {
		const patch = joinPatch(patchParts);
		const applyResult = await applyPatchToIndex(pi, cwd, patch);
		if (!applyResult.ok) {
			return applyResult;
		}
	}

	if (directStagePaths.length > 0) {
		const stageFilesResult = await stageFiles(pi, cwd, Array.from(new Set(directStagePaths)));
		if (!stageFilesResult.ok) {
			return stageFilesResult;
		}
	}

	return { ok: true };
}

export async function commit(
	pi: ExtensionAPI,
	cwd: string,
	subject: string,
	body: string,
): Promise<{ ok: boolean; message: string }> {
	const args = body.trim().length > 0 ? ["commit", "-m", subject, "-m", body] : ["commit", "-m", subject];
	const result = await runGit(pi, cwd, args, DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr || result.stdout || "git commit failed" };
	}
	return { ok: true, message: result.stdout || "Commit created." };
}

export async function push(pi: ExtensionAPI, cwd: string): Promise<{ ok: boolean; message: string }> {
	const result = await runGit(pi, cwd, ["push"], DEFAULT_TIMEOUT_MS);
	if (result.code !== 0) {
		return { ok: false, message: result.stderr || result.stdout || "git push failed" };
	}
	return { ok: true, message: result.stdout || "Pushed to remote." };
}

export function excludeLockFiles(files: string[]): { filtered: string[]; excluded: string[] } {
	const filtered: string[] = [];
	const excluded: string[] = [];

	for (const file of files) {
		const name = file.split("/").pop() ?? file;
		if (LOCKFILE_PATTERNS.some((pattern) => pattern.test(name))) {
			excluded.push(file);
		} else {
			filtered.push(file);
		}
	}

	return { filtered, excluded };
}

export function excludeSensitiveFiles(files: string[]): { filtered: string[]; excluded: string[] } {
	const filtered: string[] = [];
	const excluded: string[] = [];

	for (const file of files) {
		if (isSensitiveFilePath(file)) {
			excluded.push(file);
		} else {
			filtered.push(file);
		}
	}

	return { filtered, excluded };
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout: number) {
	return pi.exec("git", args, { cwd, timeout });
}

function normalizeRenamePath(filePath: string): string {
	if (!filePath.includes("=>")) {
		return filePath;
	}

	const match = filePath.match(/\{[^}]+=>\s*([^}]+)\}/);
	if (!match) {
		return filePath;
	}

	const after = (match[1] ?? "").trim();
	return filePath.replace(/\{[^}]+=>\s*[^}]+\}/, after);
}

function isSensitiveFilePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isTrackedStatus(status: string): boolean {
	return status !== " " && status !== "?";
}

function normalizeStatusPath(statusPath: string): string {
	const arrowIndex = statusPath.indexOf(" -> ");
	if (arrowIndex >= 0) {
		return statusPath.slice(arrowIndex + 4).trim();
	}
	return statusPath.trim();
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
}

function joinPatch(parts: string[]): string {
	return parts
		.map((part) => (part.endsWith("\n") ? part : `${part}\n`))
		.join("\n")
		.trimEnd()
		.concat("\n");
}
