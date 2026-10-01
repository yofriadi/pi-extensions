/**
 * Sound configuration: reads a `sounds` object from the first settings file
 * that defines one, normalizes it, and merges it over defaults.
 *
 * Lookup order (exactly two sources):
 *   1. `<cwd>/.pi/settings.json`   (project)
 *   2. `<agentDir>/settings.json`   (global; agentDir via getAgentDir(),
 *                                    i.e. $PI_CODING_AGENT_DIR or ~/.pi/agent)
 * The first file that DEFINES a `sounds` key wins — a project file without
 * the key falls through to the global file. Missing/unreadable files are
 * skipped silently; malformed `sounds` values fall back to defaults
 * per-part without ever throwing.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Trigger names a user can configure under `sounds.events`. */
export type EventTriggerName =
	| "sessionStart"
	| "promptSubmit"
	| "agentStart"
	| "agentSettled"
	| "agentFailed"
	| "agentAborted"
	| "question"
	| "error"
	| "quota"
	| "quotaExhausted";

/**
 * One turn-milestone trigger block: a periodic interval (`every`), a
 * one-shot milestone list (`at`), or both, plus its own files. A block
 * fires when either condition matches; blocks fire independently, so
 * each milestone can carry its own sound.
 */
export interface TurnTriggerSpec {
	/** Periodic: fire when turnIndex > 0 and turnIndex % every === 0. */
	every?: number;
	/** One-shot: fire exactly when turnIndex equals one of these values. */
	at?: number | number[];
	files: string[];
}

/** One elapsed-time trigger block: second-mark(s), optional repeat, and its own files. */
export interface ElapsedTriggerSpec {
	/** Fire after this many seconds — or after each listed value. */
	seconds: number | number[];
	/** Repeat each listed value on its own interval while the agent runs. */
	repeat: boolean;
	files: string[];
}

/** Normalized sound configuration. */
export interface SoundConfig {
	enabled: boolean;
	volume: number;
	events: Record<EventTriggerName, string[]>;
	turns: TurnTriggerSpec[];
	elapsed: ElapsedTriggerSpec[];
	quotaPatterns: string[];
	exhaustedPatterns: string[];
}

export const DEFAULT_QUOTA_PATTERNS: string[] = [
	"429",
	"rate.?limit",
	"too many requests",
	"overloaded",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
];

/** Default exhausted-quota patterns (grounded in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN). */
export const DEFAULT_EXHAUSTED_PATTERNS: string[] = [
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
];

const EVENT_TRIGGER_NAMES: EventTriggerName[] = [
	"sessionStart",
	"promptSubmit",
	"agentStart",
	"agentSettled",
	"agentFailed",
	"agentAborted",
	"question",
	"error",
	"quota",
	"quotaExhausted",
];

/** Default volume hint (0..1) — only applied by backends that support volume. */
export const DEFAULT_VOLUME = 0.4;

/** Default configuration: enabled, silent everywhere, default quota patterns. */
export function defaultConfig(): SoundConfig {
	const events = {} as Record<EventTriggerName, string[]>;
	for (const name of EVENT_TRIGGER_NAMES) events[name] = [];
	return {
		enabled: true,
		volume: DEFAULT_VOLUME,
		events,
		turns: [],
		elapsed: [],
		quotaPatterns: [...DEFAULT_QUOTA_PATTERNS],
		exhaustedPatterns: [...DEFAULT_EXHAUSTED_PATTERNS],
	};
}

/** A parsed settings source: raw `sounds` value plus the root for relative paths. */
interface SoundSource {
	sounds: unknown;
	/** Relative sound paths resolve against this (project root or agentDir). */
	baseDir: string;
}

/** Read JSON settings from one path; missing/unreadable/unparseable → undefined. */
function readSettingsFile(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Find the first source defining a `sounds` key. A settings file that exists
 * but has no `sounds` key does NOT short-circuit: the next source is consulted.
 */
function findSoundSource(projectRoot: string, agentDir: string): SoundSource | undefined {
	const projectPath = join(projectRoot, ".pi", "settings.json");
	const projectSettings = readSettingsFile(projectPath);
	if (projectSettings && "sounds" in projectSettings) {
		return { sounds: projectSettings.sounds, baseDir: projectRoot };
	}
	const globalPath = join(agentDir, "settings.json");
	const globalSettings = readSettingsFile(globalPath);
	if (globalSettings && "sounds" in globalSettings) {
		return { sounds: globalSettings.sounds, baseDir: agentDir };
	}
	return undefined;
}

/**
 * Normalize a configured file value to an array of absolute paths.
 * - bare string → one-element array
 * - `~/` prefix → expanded to the home directory
 * - relative → resolved against the source's baseDir
 * - anything else (wrong types, empty strings) → dropped
 */
function normalizeFiles(value: unknown, baseDir: string): string[] {
	const raw: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0) continue;
		const withHome = entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
		out.push(isAbsolute(withHome) ? withHome : resolve(baseDir, withHome));
	}
	return out;
}

/**
 * Normalize a `turns.at` / `elapsed.seconds` value: a single positive
 * finite number passes through as a scalar, an array is filtered to positive
 * finite numbers then deduped and sorted ascending, and anything with no
 * surviving entries (including non-numbers) is undefined.
 */
function normalizeValues(value: unknown): number | number[] | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	if (!Array.isArray(value)) return undefined;
	const out = new Set<number>();
	for (const entry of value) {
		if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out.add(entry);
	}
	if (out.size === 0) return undefined;
	return [...out].sort((a, b) => a - b);
}

/**
 * Parse the `turns` setting: one block or an array of blocks. Each block
 * carries its own files and either a periodic `every`, a one-shot `at`
 * (scalar or list), or both; blocks with no files or no valid condition
 * are dropped. Invalid entries never throw.
 */
function parseTurnSpecs(value: unknown, baseDir: string): TurnTriggerSpec[] {
	const entries = Array.isArray(value) ? value : [value];
	const specs: TurnTriggerSpec[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry as Record<string, unknown>;
		const files = normalizeFiles(raw.files, baseDir);
		if (files.length === 0) continue;
		const every =
			typeof raw.every === "number" && Number.isFinite(raw.every) && raw.every > 0 ? raw.every : undefined;
		const at = normalizeValues(raw.at);
		if (every === undefined && at === undefined) continue;
		const spec: TurnTriggerSpec = { files };
		if (every !== undefined) spec.every = every;
		if (at !== undefined) spec.at = at;
		specs.push(spec);
	}
	return specs;
}

/**
 * Parse the `elapsed` setting: one block or an array of blocks, each with
 * its own files, `seconds` (scalar or list), and an optional `repeat`.
 * Blocks with no files or no valid `seconds` are dropped; invalid entries
 * never throw.
 */
function parseElapsedSpecs(value: unknown, baseDir: string): ElapsedTriggerSpec[] {
	const entries = Array.isArray(value) ? value : [value];
	const specs: ElapsedTriggerSpec[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry as Record<string, unknown>;
		const files = normalizeFiles(raw.files, baseDir);
		const seconds = normalizeValues(raw.seconds);
		if (files.length === 0 || seconds === undefined) continue;
		specs.push({ seconds, repeat: raw.repeat === true, files });
	}
	return specs;
}

/**
 * Resolve the effective configuration: defaults merged with the first
 * `sounds` object found in project then global settings. Invalid parts of a
 * `sounds` object fall back to defaults; this function never throws.
 */
export function resolveConfig(projectRoot: string, agentDir: string): SoundConfig {
	const source = findSoundSource(projectRoot, agentDir);
	if (!source || typeof source.sounds !== "object" || source.sounds === null) {
		return defaultConfig();
	}
	const raw = source.sounds as Record<string, unknown>;
	const config = defaultConfig();

	if (typeof raw.enabled === "boolean") {
		config.enabled = raw.enabled;
	}

	if (typeof raw.volume === "number" && Number.isFinite(raw.volume)) {
		// Clamp into 0..1 — player backends accept no other range.
		config.volume = Math.min(1, Math.max(0, raw.volume));
	}

	if (typeof raw.events === "object" && raw.events !== null) {
		const events = raw.events as Record<string, unknown>;
		for (const name of EVENT_TRIGGER_NAMES) {
			if (name in events) {
				config.events[name] = normalizeFiles(events[name], source.baseDir);
			}
		}
	}

	// Turn and elapsed triggers accept one block or a list of blocks, each
	// with its own files; invalid blocks are dropped without affecting siblings.
	config.turns = parseTurnSpecs(raw.turns, source.baseDir);
	config.elapsed = parseElapsedSpecs(raw.elapsed, source.baseDir);

	// quotaPatterns must be an array of strings; non-array values keep the defaults.
	if (Array.isArray(raw.quotaPatterns)) {
		const patterns = raw.quotaPatterns.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (patterns.length > 0) {
			config.quotaPatterns = patterns;
		}
	}

	// exhaustedPatterns must be an array of strings; non-array values keep the defaults.
	if (Array.isArray(raw.exhaustedPatterns)) {
		const patterns = raw.exhaustedPatterns.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (patterns.length > 0) {
			config.exhaustedPatterns = patterns;
		}
	}

	return config;
}
