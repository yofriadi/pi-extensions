import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLiveAntigravityCredentials } from "../src/stored-credentials.ts";

const originalAgentDirectory = process.env.PI_AGENT_DIR;
const directories: string[] = [];

async function writeCredentials(directoryPrefix: string, files: Record<string, unknown>): Promise<string> {
	const directory = join(tmpdir(), `${directoryPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	directories.push(directory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const [filename, value] of Object.entries(files)) {
		const filePath = join(directory, filename);
		await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
		await chmod(filePath, 0o600);
	}
	return directory;
}

async function writeAuth(providerCredentials: Record<string, unknown>): Promise<string> {
	return writeCredentials("antigravity-script-auth", {
		"auth.json": { "google-antigravity": providerCredentials },
	});
}

async function writeAccounts(providerState: Record<string, unknown>): Promise<string> {
	return writeCredentials("antigravity-script-accounts", {
		"pi-accounts.json": { version: 1, providers: { "google-antigravity": providerState } },
	});
}

afterEach(async () => {
	if (originalAgentDirectory === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = originalAgentDirectory;
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Antigravity script credentials", () => {
	it("uses a non-empty unexpired access token", async () => {
		process.env.PI_AGENT_DIR = await writeAuth({
			access: "access-token",
			expires: Date.now() + 60_000,
			projectId: "p",
		});
		await expect(loadLiveAntigravityCredentials()).resolves.toEqual({
			accessToken: "access-token",
			projectId: "p",
		});
	});

	it("does not send an empty access token even when its expiry is in the future", async () => {
		process.env.PI_AGENT_DIR = await writeAuth({ access: "", expires: Date.now() + 60_000, projectId: "p" });
		await expect(loadLiveAntigravityCredentials()).rejects.toThrow(/cannot be refreshed/);
	});

	it("falls back read-only to the active google-antigravity account in pi-accounts.json", async () => {
		process.env.PI_AGENT_DIR = await writeAccounts({
			active: "work",
			accounts: {
				work: {
					access: "accounts-access-token",
					expires: Date.now() + 60_000,
					projectId: "accounts-project",
					refresh: "accounts-refresh",
				},
			},
		});
		await expect(loadLiveAntigravityCredentials()).resolves.toEqual({
			accessToken: "accounts-access-token",
			projectId: "accounts-project",
		});
	});

	it("uses the active named account when auth.json contains only another provider", async () => {
		process.env.PI_AGENT_DIR = await writeCredentials("antigravity-script-precedence", {
			"auth.json": { anthropic: { access: "unrelated" } },
			"pi-accounts.json": {
				version: 1,
				providers: {
					"google-antigravity": {
						active: "work",
						accounts: {
							work: {
								access: "accounts-access-token",
								expires: Date.now() + 60_000,
								projectId: "accounts-project",
								refresh: "accounts-refresh",
							},
						},
					},
				},
			},
		});
		await expect(loadLiveAntigravityCredentials()).resolves.toEqual({
			accessToken: "accounts-access-token",
			projectId: "accounts-project",
		});
	});
});
