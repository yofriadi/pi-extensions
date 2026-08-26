import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshAntigravityAccessToken } from "./google-antigravity-oauth.ts";

const ACCOUNTS_FILE = "pi-accounts.json";
const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStoredCredentials(value: unknown): StoredAntigravityCredentials | undefined {
	return isRecord(value) ? (value as StoredAntigravityCredentials) : undefined;
}

type JsonFileReadResult =
	| { status: "missing" }
	| { status: "invalid"; error: string }
	| { status: "ok"; value: unknown };

// Discovery scripts must never follow a credential-file symlink. Unlike AccountStore,
// this reader is deliberately read-only, so it rejects weak files rather than repairing
// their permissions as a side effect.
async function readPrivateJsonFile(filePath: string): Promise<JsonFileReadResult> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const pathInfo = await lstat(filePath);
		if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
			return { status: "invalid", error: "credential path is not a regular file" };
		}
		handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const fileInfo = await handle.stat();
		if (!fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) {
			return { status: "invalid", error: "credential file is not private" };
		}
		try {
			return { status: "ok", value: JSON.parse(await handle.readFile({ encoding: "utf8" })) };
		} catch {
			return { status: "invalid", error: "credential file contains invalid JSON" };
		}
	} catch (error) {
		if (isNotFoundError(error)) return { status: "missing" };
		return { status: "invalid", error: "credential file could not be read" };
	} finally {
		await handle?.close();
	}
}

function credentialsFromAuthFile(value: unknown): StoredAntigravityCredentials | undefined {
	return isRecord(value) && Object.hasOwn(value, ANTIGRAVITY_PROVIDER_ID)
		? asStoredCredentials(value[ANTIGRAVITY_PROVIDER_ID])
		: undefined;
}

// This is intentionally a narrow, read-only compatibility boundary. The provider
// package does not write pi-accounts.json and pi-accounts never imports this package.
function credentialsFromAccountsFile(value: unknown): StoredAntigravityCredentials | undefined {
	if (!isRecord(value) || !isRecord(value.providers)) return undefined;
	if (!Object.hasOwn(value.providers, ANTIGRAVITY_PROVIDER_ID)) return undefined;
	const provider = value.providers[ANTIGRAVITY_PROVIDER_ID];
	if (!isRecord(provider) || typeof provider.active !== "string" || provider.active.length === 0) return undefined;
	if (!isRecord(provider.accounts) || !Object.hasOwn(provider.accounts, provider.active)) return undefined;
	return asStoredCredentials(provider.accounts[provider.active]);
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
	const authFile = await readPrivateJsonFile(join(agentDirectory, "auth.json"));
	const accountsFile = await readPrivateJsonFile(join(agentDirectory, ACCOUNTS_FILE));
	// auth.json remains authoritative when it has an Antigravity credential. Named
	// accounts are a compatibility fallback even if auth.json contains other providers.
	const credentials =
		(authFile.status === "ok" ? credentialsFromAuthFile(authFile.value) : undefined) ??
		(accountsFile.status === "ok" ? credentialsFromAccountsFile(accountsFile.value) : undefined);
	if (!credentials) {
		const invalidFile = [authFile, accountsFile].find((file) => file.status === "invalid");
		if (invalidFile?.status === "invalid") {
			throw new Error(`Stored Pi credentials are unavailable: ${invalidFile.error}`);
		}
		throw new Error("Antigravity credentials are unavailable; authenticate with Pi first");
	}
	const projectId = nonEmptyString(credentials.projectId);
	if (!projectId) {
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

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
