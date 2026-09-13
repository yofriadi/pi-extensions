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
	/** mcporter server entry to prefer (default "tilth"). */
	serverName: string;
	/** Per-call mcporter timeout in milliseconds (default 60_000). */
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
	if (typeof record.serverName === "string" && record.serverName.length > 0) {
		config.serverName = record.serverName;
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
		serverName: merged.serverName ?? "tilth",
		callTimeoutMs: merged.callTimeoutMs ?? 60_000,
		hashlineCompat: merged.hashlineCompat ?? true,
	};
}
