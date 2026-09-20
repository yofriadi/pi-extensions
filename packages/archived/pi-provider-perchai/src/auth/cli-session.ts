import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PerchCredentials } from "./perch-oauth.ts";

const execFileAsync = promisify(execFile);

/** Keychain entry names from the perchai-cli bundle (`O3e`/`F3e`). */
const KEYCHAIN_SERVICE = "app.perchai.cli-auth";
const KEYCHAIN_ACCOUNT = "default";
/** CLI session file shape (verified from the bundle's `L3e`/`gvn`). */
const CLI_SESSION_VERSION = 1;

export interface CliSessionFile {
	version: number;
	appUrl: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	userId: string;
	email?: string;
	updatedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseCliSession(value: unknown): CliSessionFile | null {
	if (!isRecord(value)) {
		return null;
	}
	if (value.version !== CLI_SESSION_VERSION) {
		return null;
	}
	const required = ["appUrl", "accessToken", "refreshToken", "expiresAt", "userId"] as const;
	for (const field of required) {
		if (typeof value[field] !== "string" && typeof value[field] !== "number") {
			return null;
		}
	}
	if (
		typeof value.appUrl !== "string" ||
		typeof value.accessToken !== "string" ||
		typeof value.refreshToken !== "string" ||
		typeof value.expiresAt !== "number" ||
		typeof value.userId !== "string"
	) {
		return null;
	}
	if (value.appUrl.length === 0 || value.accessToken.length === 0 || value.refreshToken.length === 0) {
		return null;
	}
	const email = typeof value.email === "string" ? value.email : undefined;
	return {
		version: CLI_SESSION_VERSION,
		appUrl: value.appUrl,
		accessToken: value.accessToken,
		refreshToken: value.refreshToken,
		expiresAt: value.expiresAt,
		userId: value.userId,
		email,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
	};
}

interface PrivateJsonResult {
	value: unknown | null;
	rejection: string | null;
}

/** Reads a JSON file with private-file hardening: no symlink, mode 0600. */
async function readPrivateJsonFile(path: string): Promise<PrivateJsonResult> {
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		const pathInfo = await lstat(path);
		if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
			return { value: null, rejection: `refusing non-regular or symlinked session file ${path}` };
		}
		handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const fileInfo = await handle.stat();
		if (!fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) {
			return { value: null, rejection: `refusing session file ${path}: permissions must be 0600` };
		}
		try {
			return { value: JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown, rejection: null };
		} catch {
			return { value: null, rejection: `refusing session file ${path}: invalid JSON` };
		}
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
		return code === "ENOENT"
			? { value: null, rejection: null }
			: { value: null, rejection: `unable to read session file ${path}` };
	} finally {
		await handle?.close();
	}
}

/** macOS Keychain password for the perchai CLI session, or null. */
async function readKeychainSession(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-w",
		]);
		const value = stdout.trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

export interface CliSessionProbe {
	credentials: PerchCredentials;
	/** Where the session was found ("keychain" | "file"). */
	source: "keychain" | "file";
}

export interface CliSessionProbeResult {
	session: CliSessionProbe | null;
	warnings: string[];
}

/** Probes a local `perch login` session and preserves rejection diagnostics. */
export async function probeCliSession(): Promise<CliSessionProbeResult> {
	const warnings: string[] = [];

	// 1. macOS Keychain.
	const keychain = await readKeychainSession();
	if (keychain !== null) {
		try {
			const parsed = parseCliSession(JSON.parse(keychain));
			if (parsed !== null) {
				return { session: { credentials: toCredentials(parsed), source: "keychain" }, warnings };
			}
			warnings.push("stored perch Keychain session has an unsupported version or malformed fields");
		} catch {
			warnings.push("stored perch Keychain session is not valid JSON");
		}
	}

	// 2. Session file.
	const dir = process.env.PERCH_CLI_AUTH_DIR ?? join(homedir(), ".perch");
	const path = join(dir, "cli-auth-session.json");
	const file = await readPrivateJsonFile(path);
	if (file.rejection !== null) {
		warnings.push(file.rejection);
	}
	if (file.value === null) {
		return { session: null, warnings };
	}
	const parsed = parseCliSession(file.value);
	if (parsed === null) {
		warnings.push(`refusing session file ${path}: unsupported version or malformed fields`);
		return { session: null, warnings };
	}
	return { session: { credentials: toCredentials(parsed), source: "file" }, warnings };
}

function toCredentials(session: CliSessionFile): PerchCredentials {
	return {
		access: session.accessToken,
		refresh: session.refreshToken,
		expires: session.expiresAt,
		email: session.email,
		userId: session.userId,
		appUrl: session.appUrl,
	};
}
