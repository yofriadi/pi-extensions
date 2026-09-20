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

/**
 * Loads configuration from Pi's settings.json.
 */
export function loadConfig(customSettingsPath?: string): AutoContinueConfig {
  const settingsPath =
    customSettingsPath ||
    path.join(
      process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "settings.json"
    );

  let rawConfig: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      const settings: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      rawConfig = asRecord(asRecord(settings).autoContinue);
    }
  } catch {
    // Continue through normalization to return independent nested defaults.
  }

  const rateLimitRaw = asRecord(rawConfig.rateLimit);
  const tokenLimitRaw = asRecord(rawConfig.tokenLimit);
  const incompleteToolCallRaw = asRecord(rawConfig.incompleteToolCall);

  const baseDelayMs = parseDuration(rawConfig.baseDelayMs, DEFAULT_CONFIG.baseDelayMs);
  const maxDelayMs = parseDuration(rawConfig.maxDelayMs, DEFAULT_CONFIG.maxDelayMs);
  const backoffMultiplier =
    typeof rawConfig.backoffMultiplier === "number" && Number.isFinite(rawConfig.backoffMultiplier) && rawConfig.backoffMultiplier >= 1
      ? rawConfig.backoffMultiplier
      : DEFAULT_CONFIG.backoffMultiplier;

  let maxRetries: number | string = DEFAULT_CONFIG.maxRetries;
  if (rawConfig.maxRetries !== undefined) {
    if (typeof rawConfig.maxRetries === "number" && Number.isSafeInteger(Math.round(rawConfig.maxRetries)) && rawConfig.maxRetries >= 0) {
      maxRetries = Math.round(rawConfig.maxRetries);
    } else if (typeof rawConfig.maxRetries === "string") {
      maxRetries = rawConfig.maxRetries.trim();
    }
  }

  const rateLimitBaseDelayMs = parseDuration(
    rateLimitRaw.baseDelayMs,
    DEFAULT_RATE_LIMIT_BASE_DELAY_MS
  );

  const rateLimitMaxDelayMs = parseDuration(
    rateLimitRaw.maxDelayMs,
    DEFAULT_RATE_LIMIT_MAX_DELAY_MS
  );

  let rateLimitMaxRetries: number | string = DEFAULT_RATE_LIMIT_MAX_RETRIES;
  if (rateLimitRaw.maxRetries !== undefined) {
    if (typeof rateLimitRaw.maxRetries === "number" && Number.isSafeInteger(Math.round(rateLimitRaw.maxRetries)) && rateLimitRaw.maxRetries >= 0) {
      rateLimitMaxRetries = Math.round(rateLimitRaw.maxRetries);
    } else if (typeof rateLimitRaw.maxRetries === "string") {
      rateLimitMaxRetries = rateLimitRaw.maxRetries.trim();
    }
  }

  return {
    enabled: rawConfig.enabled !== false,
    subagent: rawConfig.subagent === true,
    baseDelayMs,
    maxDelayMs,
    backoffMultiplier,
    maxRetries,
    rateLimit: {
      enabled: rateLimitRaw.enabled !== false,
      baseDelayMs: rateLimitBaseDelayMs,
      maxDelayMs: rateLimitMaxDelayMs,
      maxRetries: rateLimitMaxRetries,
      jitter: rateLimitRaw.jitter !== false,
      fatalFirst: rateLimitRaw.fatalFirst === true,
      windowRetryMargin:
        typeof rateLimitRaw.windowRetryMargin === "number" &&
        Number.isFinite(rateLimitRaw.windowRetryMargin) &&
        rateLimitRaw.windowRetryMargin >= 1
          ? rateLimitRaw.windowRetryMargin
          : DEFAULT_WINDOW_RETRY_MARGIN,
      retryPrompt:
        typeof rateLimitRaw.retryPrompt === "string" && rateLimitRaw.retryPrompt.trim().length > 0
          ? rateLimitRaw.retryPrompt.trim()
          : DEFAULT_CONFIG.rateLimit.retryPrompt,
    },
    tokenLimit: {
      enabled: tokenLimitRaw.enabled !== false,
      continuePrompt:
        typeof tokenLimitRaw.continuePrompt === "string" && tokenLimitRaw.continuePrompt.trim().length > 0
          ? tokenLimitRaw.continuePrompt.trim()
          : DEFAULT_CONFIG.tokenLimit.continuePrompt,
    },
    incompleteToolCall: {
      enabled: incompleteToolCallRaw.enabled !== false,
      continuePrompt:
        typeof incompleteToolCallRaw.continuePrompt === "string" && incompleteToolCallRaw.continuePrompt.trim().length > 0
          ? incompleteToolCallRaw.continuePrompt.trim()
          : DEFAULT_CONFIG.incompleteToolCall.continuePrompt,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
