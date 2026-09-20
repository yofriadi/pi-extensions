/**
 * Extension configuration loading.
 *
 * Config files live at:
 *  - Global:  <agentDir>/extensions/pi-colgrep/config.json
 *  - Project: <cwd>/.pi/extensions/pi-colgrep/config.json
 *
 * Project config takes precedence over global. A missing file is silent; a
 * malformed file warns to stderr and falls back to defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "pi-colgrep";

export interface ColGrepConfig {
  /** Whether to build the semantic index in the background on session start. */
  indexOnStartup: boolean;
}

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

/** Drop fields that don't match the expected shape. Garbage becomes absent. */
export function normalizeConfig(raw: unknown): Partial<ColGrepConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const config: Partial<ColGrepConfig> = {};
  if (typeof record.indexOnStartup === "boolean") {
    config.indexOnStartup = record.indexOnStartup;
  }
  return config;
}

function loadSingleConfig(path: string): Partial<ColGrepConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeConfig(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pi-colgrep] Ignoring malformed config at ${path}: ${reason}`,
    );
    return {};
  }
}

/** Load merged config: global provides defaults, project overrides. */
export function loadConfig(options: {
  globalConfigPath: string;
  projectConfigPath: string;
}): ColGrepConfig {
  const merged = {
    ...loadSingleConfig(options.globalConfigPath),
    ...loadSingleConfig(options.projectConfigPath),
  };
  return { indexOnStartup: merged.indexOnStartup ?? true };
}
