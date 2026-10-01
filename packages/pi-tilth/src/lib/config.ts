/**
 * Extension configuration loading.
 *
 * Config files live at:
 *  - Global:  <agentDir>/extensions/pi-tilth/config.json
 *  - Project: <cwd>/.pi/extensions/pi-tilth/config.json
 *
 * Project config takes precedence over global. A missing file is silent; a
 * malformed file warns once (per load) and falls back to defaults. Unknown
 * fields are dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "pi-tilth";

export interface TilthConfig {
	/**
	 * Budget for the MCP `initialize` handshake in milliseconds. The transport
	 * resolves it at connect time when omitted: 120,000 for `npx` (cold-cache
	 * package download) and 30,000 for a local `tilth` binary.
	 */
	connectTimeoutMs?: number;
	/**
	 * Per-call timeout in milliseconds (default 60_000). Enforced in-process
	 * by the MCP client (`timeoutMs` on `callTool`): the pending JSON-RPC
	 * request is cancelled — the persistent server process is NOT killed, so
	 * the connection stays usable after a timeout.
	 */
	callTimeoutMs: number;
	/** Master switch for hashline-edit anchor compatibility (default true). */
	hashlineCompat: boolean;
}

export function getGlobalConfigPath(agentDir: string): string {
	return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

/** Drop fields that don't match the expected shape. Garbage becomes absent. */
export function normalizeConfig(raw: unknown): Partial<TilthConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const config: Partial<TilthConfig> = {};
	if (
		typeof record.connectTimeoutMs === "number" &&
		Number.isFinite(record.connectTimeoutMs) &&
		record.connectTimeoutMs > 0
	) {
		config.connectTimeoutMs = record.connectTimeoutMs;
	}
	if (typeof record.callTimeoutMs === "number" && Number.isFinite(record.callTimeoutMs) && record.callTimeoutMs > 0) {
		config.callTimeoutMs = record.callTimeoutMs;
	}
	if (typeof record.hashlineCompat === "boolean") {
		config.hashlineCompat = record.hashlineCompat;
	}
	return config;
}

function loadSingleConfig(path: string): Partial<TilthConfig> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return normalizeConfig(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-tilth] Ignoring malformed config at ${path}: ${reason}`);
		return {};
	}
}

/** Load merged config: global provides defaults, project overrides. */
export function loadConfig(options: { globalConfigPath: string; projectConfigPath: string }): TilthConfig {
	const merged = {
		...loadSingleConfig(options.globalConfigPath),
		...loadSingleConfig(options.projectConfigPath),
	};
	return {
		// undefined is meaningful: the transport then derives the connect
		// budget from the resolved mode (120s npx / 30s binary).
		...(merged.connectTimeoutMs !== undefined ? { connectTimeoutMs: merged.connectTimeoutMs } : {}),
		callTimeoutMs: merged.callTimeoutMs ?? 60_000,
		hashlineCompat: merged.hashlineCompat ?? true,
	};
}
