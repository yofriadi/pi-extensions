import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_RETRIES,
  DEFAULT_WINDOW_RETRY_MARGIN,
  DEFAULT_RATE_LIMIT_BASE_DELAY_MS,
  DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
  DEFAULT_RATE_LIMIT_MAX_RETRIES,
  DEFAULT_RATE_LIMIT_RETRY_PROMPT,
  DEFAULT_TOKEN_LIMIT_CONTINUE_PROMPT,
  DEFAULT_INCOMPLETE_TOOL_CALL_CONTINUE_PROMPT,
} from "./constants.ts";
import type { AutoContinueConfig, RetryLimit } from "./types.ts";

/**
 * Parses duration strings like "5h", "30m", "45s", "500ms" or numeric values in milliseconds.
 */
export function parseDuration(val: unknown, fallback: number): number {
  if (typeof val === "number") {
    return Number.isSafeInteger(Math.round(val)) && val >= 0 ? Math.round(val) : fallback;
  }
  if (typeof val !== "string") return fallback;
  const match = val.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|minutes?|h|hours?|d|days?)?$/);
  if (!match) return fallback;
  const unit = match[2] ?? "ms";
  const multiplier = unit === "ms" ? 1 : unit.startsWith("s") ? 1000
    : unit.startsWith("m") ? 60000 : unit.startsWith("h") ? 3600000 : 86400000;
  const durationMs = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(durationMs) ? durationMs : fallback;
}

/**
 * Parses maxRetries config value into either an attempt count limit or a duration deadline limit.
 * - Number or digit string (e.g. 5, "5") -> { type: "attempts", count: 5 }
 * - Duration string (e.g. "15m", "5h", "30s") -> { type: "duration", durationMs: ... }
 */
export function parseMaxRetries(
  val: unknown,
  fallback: RetryLimit = { type: "attempts", count: DEFAULT_MAX_RETRIES }
): RetryLimit {
  if (val === undefined || val === null) {
    return fallback;
  }
  if (typeof val === "number") {
    if (!Number.isSafeInteger(Math.round(val)) || val < 0) return fallback;
    return { type: "attempts", count: Math.round(val) };
  }
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (/^\d+$/.test(trimmed)) {
      const count = parseInt(trimmed, 10);
      return Number.isSafeInteger(count) ? { type: "attempts", count } : fallback;
    }
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|minutes?|h|hours?|d|days?)$/);
    if (match) {
      const durationMs = parseDuration(trimmed, -1);
      if (durationMs >= 0) {
        return { type: "duration", durationMs };
      }
    }
  }
  if (typeof val === "object" && val !== null && "type" in val) {
    if (val.type === "attempts" && "count" in val && typeof val.count === "number" && Number.isSafeInteger(val.count) && val.count >= 0) {
      return { type: "attempts", count: val.count };
    }
    if (val.type === "duration" && "durationMs" in val && typeof val.durationMs === "number" && Number.isSafeInteger(val.durationMs) && val.durationMs >= 0) {
      return { type: "duration", durationMs: val.durationMs };
    }
  }
  return fallback;
}

/**
 * Parses time strings like "14:30", "9:15", "14:30:00", "2:30pm" to target epoch timestamp (ms).
 * If the target time has already passed today, it targets the next occurrence tomorrow.
 * Returns null if format is invalid.
 */
export function parseTargetTime(
  val: unknown,
  now: Date | number = new Date()
): { targetTimeMs: number; hours: number; minutes: number; seconds: number } | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim().toLowerCase();
  const match = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const ampm = match[4];

  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === "pm" && hours < 12) {
      hours += 12;
    } else if (ampm === "am" && hours === 12) {
      hours = 0;
    }
  }

  const nowDate = typeof now === "number" ? new Date(now) : now;
  const target = new Date(nowDate.getTime());
  target.setHours(hours, minutes, seconds, 0);

  if (target.getTime() <= nowDate.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return {
    targetTimeMs: target.getTime(),
    hours,
    minutes,
    seconds,
  };
}

/** Sentinel that `parseMaxRetries` cannot produce, used to detect rejection. */
const INVALID_RETRY_LIMIT: RetryLimit = { type: "attempts", count: -1 };

/** Settings sections and the keys each one accepts, so a typo can be reported. */
const CONFIG_SECTIONS: ReadonlyArray<[string, readonly string[]]> = [
  ["autoContinue", ["enabled", "subagent", "baseDelayMs", "maxDelayMs", "backoffMultiplier", "maxRetries", "rateLimit", "tokenLimit", "incompleteToolCall"]],
  ["autoContinue.rateLimit", ["enabled", "baseDelayMs", "maxDelayMs", "maxRetries", "jitter", "fatalFirst", "windowRetryMargin", "retryPrompt"]],
  ["autoContinue.tokenLimit", ["enabled", "continuePrompt"]],
  ["autoContinue.incompleteToolCall", ["enabled", "continuePrompt"]],
];

/**
 * Loads configuration from Pi's settings.json.
 *
 * Every value that cannot be used is reported through `onWarning` instead of
 * being replaced silently: a setting that quietly means something other than
 * what was written is indistinguishable from a bug in the extension.
 */
export function loadConfig(
  customSettingsPath?: string,
  onWarning?: (message: string) => void
): AutoContinueConfig {
  const settingsPath =
    customSettingsPath ||
    path.join(
      process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "settings.json"
    );

  const warn = (message: string): void => {
    onWarning?.(`autoContinue: ${message}`);
  };
  const show = (value: unknown): string => {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  };

  let rawConfig: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      const settings: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const root = asRecord(settings);
      if (!isRecord(settings)) {
        warn(`settings file ${settingsPath} must contain a JSON object, got ${show(settings)}; using defaults`);
      }
      if ("autoContinue" in root && !isRecord(root.autoContinue)) {
        warn(`autoContinue must be an object, got ${show(root.autoContinue)}; using defaults`);
      }
      rawConfig = asRecord(root.autoContinue);
    }
  } catch (error) {
    // Still normalize so callers get independent nested defaults.
    warn(`could not load ${settingsPath} (${error instanceof Error ? error.message : String(error)}); using defaults`);
  }

  const rateLimitRaw = asRecord(rawConfig.rateLimit);
  const tokenLimitRaw = asRecord(rawConfig.tokenLimit);
  const incompleteToolCallRaw = asRecord(rawConfig.incompleteToolCall);

  for (const [label, value] of [
    ["rateLimit", rawConfig.rateLimit],
    ["tokenLimit", rawConfig.tokenLimit],
    ["incompleteToolCall", rawConfig.incompleteToolCall],
  ] as Array<[string, unknown]>) {
    if (value !== undefined && !isRecord(value)) {
      warn(`autoContinue.${label} must be an object, got ${show(value)}; using defaults for that section`);
    }
  }

  for (const section of [
    ["autoContinue", rawConfig],
    ["autoContinue.rateLimit", rateLimitRaw],
    ["autoContinue.tokenLimit", tokenLimitRaw],
    ["autoContinue.incompleteToolCall", incompleteToolCallRaw],
  ] as Array<[string, Record<string, unknown>]>) {
    const known = CONFIG_SECTIONS.find(([label]) => label === section[0])?.[1] ?? [];
    for (const key of Object.keys(section[1])) {
      if (!known.includes(key)) warn(`unknown ${section[0]} setting "${key}"; ignored`);
    }
  }

  const readBoolean = (label: string, value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    warn(`${label} must be true or false, got ${show(value)}; using ${fallback}`);
    return fallback;
  };

  const readDuration = (label: string, value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    const parsed = parseDuration(value, Number.NaN);
    if (!Number.isFinite(parsed)) {
      warn(`${label} must be a non-negative duration ("30s", "5m", "500ms") or a millisecond number, got ${show(value)}; using ${fallback}ms`);
      return fallback;
    }
    return parsed;
  };

  const readMinimum = (label: string, value: unknown, fallback: number, minimum: number): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= minimum) return value;
    warn(`${label} must be a number >= ${minimum}, got ${show(value)}; using ${fallback}`);
    return fallback;
  };

  const readMaxRetries = (label: string, value: unknown, fallback: number | string): number | string => {
    const reject = (): number | string => {
      warn(`${label} must be a non-negative integer or a duration ("15m", "5h"), got ${show(value)}; using ${show(fallback)}`);
      return fallback;
    };
    if (value === undefined) return fallback;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(Math.round(value)) || value < 0) return reject();
      const rounded = Math.round(value);
      if (!Number.isInteger(value)) warn(`${label} must be an integer, got ${show(value)}; using ${rounded}`);
      return rounded;
    }
    // parseMaxRetries is the oracle. Accepting anything it would later discard
    // (e.g. "5.5" or "0.0", which have no unit) stores a value whose effective
    // limit is a different default entirely — "0.0" silently became a 5h
    // deadline — so the two must agree.
    if (typeof value === "string" && parseMaxRetries(value.trim(), INVALID_RETRY_LIMIT) !== INVALID_RETRY_LIMIT) {
      return value.trim();
    }
    return reject();
  };

  const readPrompt = (label: string, value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    warn(`${label} must be a non-empty string, got ${show(value)}; using the built-in default prompt`);
    return fallback;
  };

  const baseDelayMs = readDuration("baseDelayMs", rawConfig.baseDelayMs, DEFAULT_CONFIG.baseDelayMs);
  const maxDelayMs = readDuration("maxDelayMs", rawConfig.maxDelayMs, DEFAULT_CONFIG.maxDelayMs);
  const backoffMultiplier = readMinimum("backoffMultiplier", rawConfig.backoffMultiplier, DEFAULT_CONFIG.backoffMultiplier, 1);
  const maxRetries = readMaxRetries("maxRetries", rawConfig.maxRetries, DEFAULT_CONFIG.maxRetries);
  const rateLimitBaseDelayMs = readDuration("rateLimit.baseDelayMs", rateLimitRaw.baseDelayMs, DEFAULT_RATE_LIMIT_BASE_DELAY_MS);
  const rateLimitMaxDelayMs = readDuration("rateLimit.maxDelayMs", rateLimitRaw.maxDelayMs, DEFAULT_RATE_LIMIT_MAX_DELAY_MS);
  const rateLimitMaxRetries = readMaxRetries("rateLimit.maxRetries", rateLimitRaw.maxRetries, DEFAULT_RATE_LIMIT_MAX_RETRIES);
  const windowRetryMargin = readMinimum("rateLimit.windowRetryMargin", rateLimitRaw.windowRetryMargin, DEFAULT_WINDOW_RETRY_MARGIN, 1);

  if (baseDelayMs > maxDelayMs) {
    warn(`baseDelayMs (${baseDelayMs}ms) exceeds maxDelayMs (${maxDelayMs}ms); every delay is clamped to ${maxDelayMs}ms`);
  }
  if (rateLimitBaseDelayMs > rateLimitMaxDelayMs) {
    warn(`rateLimit.baseDelayMs (${rateLimitBaseDelayMs}ms) exceeds rateLimit.maxDelayMs (${rateLimitMaxDelayMs}ms); every rate-limit delay is clamped to ${rateLimitMaxDelayMs}ms`);
  }

  return {
    enabled: readBoolean("enabled", rawConfig.enabled, true),
    subagent: readBoolean("subagent", rawConfig.subagent, false),
    baseDelayMs,
    maxDelayMs,
    backoffMultiplier,
    maxRetries,
    rateLimit: {
      enabled: readBoolean("rateLimit.enabled", rateLimitRaw.enabled, true),
      baseDelayMs: rateLimitBaseDelayMs,
      maxDelayMs: rateLimitMaxDelayMs,
      maxRetries: rateLimitMaxRetries,
      jitter: readBoolean("rateLimit.jitter", rateLimitRaw.jitter, true),
      fatalFirst: readBoolean("rateLimit.fatalFirst", rateLimitRaw.fatalFirst, false),
      windowRetryMargin,
      retryPrompt: readPrompt("rateLimit.retryPrompt", rateLimitRaw.retryPrompt, DEFAULT_RATE_LIMIT_RETRY_PROMPT),
    },
    tokenLimit: {
      enabled: readBoolean("tokenLimit.enabled", tokenLimitRaw.enabled, true),
      continuePrompt: readPrompt("tokenLimit.continuePrompt", tokenLimitRaw.continuePrompt, DEFAULT_TOKEN_LIMIT_CONTINUE_PROMPT),
    },
    incompleteToolCall: {
      enabled: readBoolean("incompleteToolCall.enabled", incompleteToolCallRaw.enabled, true),
      continuePrompt: readPrompt(
        "incompleteToolCall.continuePrompt",
        incompleteToolCallRaw.continuePrompt,
        DEFAULT_INCOMPLETE_TOOL_CALL_CONTINUE_PROMPT
      ),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
