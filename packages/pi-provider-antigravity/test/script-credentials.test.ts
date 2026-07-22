import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLiveAntigravityCredentials } from "../src/stored-credentials.ts";

const originalAgentDirectory = process.env.PI_AGENT_DIR;
const directories: string[] = [];

async function writeAuth(providerCredentials: Record<string, unknown>): Promise<string> {
	const directory = join(tmpdir(), `antigravity-script-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	directories.push(directory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "auth.json"), JSON.stringify({ "google-antigravity": providerCredentials }));
	return directory;
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
});
