import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshAntigravityAccessToken } from "./google-antigravity-oauth.ts";

interface StoredAntigravityCredentials {
	access?: unknown;
	expires?: unknown;
	projectId?: unknown;
	refresh?: unknown;
}

export interface LiveAntigravityCredentials {
	accessToken: string;
	projectId: string;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function defaultAgentDirectory(): string {
	return process.env.PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Load the persisted Pi credential for model discovery and standalone
 * validation scripts. Error messages intentionally exclude token and project
 * values.
 */
export async function loadLiveAntigravityCredentials(
	agentDirectory = defaultAgentDirectory(),
): Promise<LiveAntigravityCredentials> {
	let authFile: unknown;
	try {
		authFile = JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"));
	} catch {
		throw new Error("Antigravity credentials are unavailable; authenticate with Pi first");
	}
	if (!authFile || typeof authFile !== "object" || Array.isArray(authFile)) {
		throw new Error("Pi auth.json does not contain a provider map");
	}
	const credentials = (authFile as Record<string, unknown>)["google-antigravity"] as
		| StoredAntigravityCredentials
		| undefined;
	const projectId = nonEmptyString(credentials?.projectId);
	if (!credentials || !projectId) {
		throw new Error("Authenticate the google-antigravity provider with Pi before running this command");
	}

	const accessToken = nonEmptyString(credentials.access);
	if (accessToken && typeof credentials.expires === "number" && credentials.expires > Date.now()) {
		return { accessToken, projectId };
	}

	const refreshToken = nonEmptyString(credentials.refresh);
	if (!refreshToken) {
		throw new Error("Stored google-antigravity credentials cannot be refreshed");
	}
	try {
		const refreshed = await refreshAntigravityAccessToken(refreshToken, projectId);
		const refreshedAccessToken = nonEmptyString(refreshed.access);
		if (!refreshedAccessToken) throw new Error("empty access token");
		return { accessToken: refreshedAccessToken, projectId };
	} catch {
		throw new Error("Stored google-antigravity credentials could not be refreshed; authenticate again");
	}
}
