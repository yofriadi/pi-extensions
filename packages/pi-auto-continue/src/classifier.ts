import {
  BILLING_HARD_LIMIT_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  DEFAULT_WINDOW_RETRY_MARGIN,
  PERMANENT_REQUEST_ERROR_PATTERNS,
  QUOTA_EXHAUSTION_PATTERNS,
  RATE_LIMIT_PATTERNS,
  RESET_SIGNAL_PATTERNS,
  TRANSIENT_ERROR_PATTERNS,
  USER_ABORT_PATTERNS,
} from "./constants.ts";
import { parseTargetTime } from "./config.ts";
import type { ClassificationResult } from "./types.ts";

export interface RetryAfterInfo {
  delayMs: number | null;
  expectedResetTime: number | null;
  hasHeader: boolean;
  /**
   * True when the delay was inferred from a rolling quota WINDOW
   * ("Maximum 8 requests within 1 minutes") rather than an absolute reset
   * point. The window start is unknown, so the value is a worst-case estimate
   * of the remaining width, and it is used directly instead of being added on
   * top of the configured base delay.
   */
  isWindowEstimate?: boolean;
}

/**
 * Extracts retry delay and expected reset time from HTTP response headers or error message text.
 */
export function extractRetryAfterInfo(
  headers?: Record<string, string>,
  errorMessage?: string,
  now = Date.now(),
  windowRetryMargin = DEFAULT_WINDOW_RETRY_MARGIN
): RetryAfterInfo {
  let info: RetryAfterInfo = { delayMs: null, expectedResetTime: null, hasHeader: false };
  const considerDelay = (delayMs: number | null, hasHeader: boolean, expectedResetTime?: number) => {
    if (delayMs !== null && delayMs >= 0 && Number.isSafeInteger(now + delayMs) &&
        (info.delayMs === null || delayMs > info.delayMs)) {
      info = { delayMs, expectedResetTime: expectedResetTime ?? now + delayMs, hasHeader };
    }
  };

  if (headers) {
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    // Prefer the explicit millisecond header when a gateway supplies both.
    const retryAfterMs = normalizedHeaders["retry-after-ms"];
    if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs.trim())) {
      considerDelay(Math.round(Number(retryAfterMs)), true);
    }

    // Standard Retry-After is seconds or an HTTP date, never a numeric prefix.
    const retryAfter = normalizedHeaders["retry-after"];
    if (info.delayMs === null && retryAfter) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const duration = parseRetryDuration(retryAfter);
      const parsedDate = /[a-z]/i.test(retryAfter) ? Date.parse(retryAfter) : NaN;
      const delayMs = Number.isFinite(seconds)
        ? Math.round(seconds * 1000)
        : duration ?? (Number.isFinite(parsedDate) ? Math.max(0, parsedDate - now) : NaN);
      considerDelay(delayMs, true);
    }

    // Request and token limits can reset independently. Conservatively wait for
    // the latest reset rather than choosing whichever header happened to be first.
    for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
      const resetTime = normalizedHeaders[name];
      if (!resetTime) continue;
      const parsed = /^\d+(?:\.\d+)?$/.test(resetTime.trim()) ? Number(resetTime) : NaN;
      const delayMs = Number.isFinite(parsed)
        ? parsed > 1e12 ? Math.max(0, Math.round(parsed) - now)
          : parsed > 1e9 ? Math.max(0, Math.round(parsed * 1000) - now)
          : Math.round(parsed * 1000)
        : parseRetryDuration(resetTime);
      considerDelay(delayMs, true);
    }
  }

  if (errorMessage) {
    // Read every complete duration, including adjacent components ("6m0s").
    const durationMatches = errorMessage.matchAll(
      /(?:retry.?after|try.?again.?(?:in|after)|wait|slow.?down.?for|resets?.?(?:in|after))\s*(?:~|approx(?:\.|imately)?|about|around)?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])[\s,]*)+(?!\w)|\d+(?:\.\d+)?(?![\w:.\d-]))/gi
    );
    for (const match of durationMatches) {
      const raw = match[1].trim().replace(/,$/, "");
      const delayMs = parseRetryDuration(raw) ?? (/^\d+(?:\.\d+)?$/.test(raw) ? Math.round(Number(raw) * 1000) : null);
      considerDelay(delayMs, false);
    }

    // ISO timestamp in error: "resets at 2026-09-01T14:30:00Z"
    const dateMatches = errorMessage.matchAll(
      /(?:resets?.?at|retry.?(?:at|after)|try.?again.?at)\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/gi
    );
    for (const match of dateMatches) {
      const parsed = Date.parse(match[1]);
      considerDelay(Math.max(0, parsed - now), false, parsed);
    }

    // Target clock time in error: "try again at 3:45 PM", "resets at 14:30"
    const clockMatches = errorMessage.matchAll(
      /(?:resets?.?at|retry.?at|try.?again.?at)\s*((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\s*(?:am|pm)?)\b/gi
    );
    for (const match of clockMatches) {
      const parsed = parseTargetTime(match[1], new Date(now));
      if (parsed) considerDelay(Math.max(0, parsed.targetTimeMs - now), false, parsed.targetTimeMs);
    }

    // Only infer a rolling window when there is no explicit reset hint, and
    // only from request/token quotas, not latency or pricing.
    if (info.delayMs === null) {
      const windowMatch = errorMessage.match(
        /\b(?:requests?|tokens?|req)\s+(?:within|per|every|\/)\s*(\d+(?:\.\d+)?)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i
      );
      if (windowMatch?.[1]) {
        const widthMs = toMillis(Number(windowMatch[1]), windowMatch[2].toLowerCase());
        const margin = Number.isFinite(windowRetryMargin) && windowRetryMargin >= 1 ? windowRetryMargin : DEFAULT_WINDOW_RETRY_MARGIN;
        const delayMs = widthMs === null ? NaN : Math.round(widthMs * margin);
        if (Number.isSafeInteger(now + delayMs)) {
          return { delayMs, expectedResetTime: now + delayMs, hasHeader: false, isWindowEstimate: true };
        }
      }
    }
  }

  return info;
}

/** Parses complete, possibly compound durations such as "6m0s" or "2h 36m". */
function parseRetryDuration(value: string): number | null {
  const parts = value.trim().matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi);
  let delayMs = 0;
  let end = 0;
  for (const part of parts) {
    if (!/^[\s,]*$/.test(value.trim().slice(end, part.index))) return null;
    const ms = toMillis(Number(part[1]), part[2].toLowerCase());
    if (ms === null) return null;
    delayMs += ms;
    end = part.index + part[0].length;
  }
  return end > 0 && value.trim().slice(end).trim() === "" && Number.isSafeInteger(delayMs) ? delayMs : null;
}

function toMillis(num: number, unit: string): number | null {
  if (!Number.isFinite(num) || num < 0) return null;
  const multiplier = unit === "ms" || unit.startsWith("millisecond") ? 1
    : unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60000
    : unit.startsWith("h") ? 3600000 : unit.startsWith("d") ? 86400000 : NaN;
  const result = Math.round(num * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}

/**
 * Extracts a retry delay in milliseconds from HTTP response headers or error message text.
 * Returns null if no explicit retry delay is specified.
 */
export function extractRetryAfterDelay(
  headers?: Record<string, string>,
  errorMessage?: string,
  now = Date.now(),
  windowRetryMargin = DEFAULT_WINDOW_RETRY_MARGIN
): number | null {
  return extractRetryAfterInfo(headers, errorMessage, now, windowRetryMargin).delayMs;
}

export interface ClassifyInput {
  stopReason?: string;
  errorMessage?: string;
  content?: readonly unknown[];
  httpStatus?: number;
  httpHeaders?: Record<string, string>;
  now?: number;
  /** See RateLimitConfig.fatalFirst. Defaults to false (upstream behavior). */
  fatalFirst?: boolean;
  /** See RateLimitConfig.windowRetryMargin. */
  windowRetryMargin?: number;
}

/**
 * Classifies an agent message, turn, or provider response to identify interruption type.
 */
export function classifyInterruption(
  input: ClassifyInput,
  now?: number
): ClassificationResult {
  const { stopReason, errorMessage, content, httpStatus, httpHeaders } = input;
  const none: ClassificationResult = { type: "NONE", reason: "No recoverable interruption", errorMessage, rawStopReason: stopReason };

  // A successful or cancelled message can never be resurrected by cached HTTP
  // metadata, an error string, or a perfectly valid zero-argument tool call.
  if (stopReason !== undefined && stopReason !== "error" && stopReason !== "length") return none;
  if (stopReason === "length") {
    const lastContent = content?.[content.length - 1];
    const endsInTool = typeof lastContent === "object" && lastContent !== null && "type" in lastContent && lastContent.type === "toolCall";
    return {
      type: endsInTool ? "INCOMPLETE_TOOL_CALL" : "TOKEN_LIMIT",
      reason: endsInTool ? "Response truncated while emitting a tool call" : "Response reached maximum output tokens (max_tokens)",
      errorMessage,
      rawStopReason: stopReason,
    };
  }

  const errorText = errorMessage || "";
  if (USER_ABORT_PATTERNS.some((pattern) => pattern.test(errorText))) return none;

  // These are never fixed by waiting, regardless of a gateway's HTTP status.
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorText))) {
    return { type: "CONTEXT_OVERFLOW", reason: "Context window overflow", errorMessage, rawStopReason: stopReason };
  }
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403 || BILLING_HARD_LIMIT_PATTERNS.some((pattern) => pattern.test(errorText))) {
    return { type: "BILLING_HARD_LIMIT", reason: "Billing, authentication or permission failure (non-retryable)", errorMessage: errorMessage || `HTTP ${httpStatus}`, rawStopReason: stopReason };
  }
  if (httpStatus !== undefined && [404, 405, 422, 501, 505].includes(httpStatus)) return none;
  if (PERMANENT_REQUEST_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) return none;

  const retryInfo = extractRetryAfterInfo(httpHeaders, errorMessage, now ?? input.now ?? Date.now(), input.windowRetryMargin);
  // Preserve the opt-in policy for ambiguous quota exhaustion, but a bare
  // "retry after topping up" is not evidence of a timed reset.
  const hasResetSignal = retryInfo.delayMs !== null || RESET_SIGNAL_PATTERNS.some((pattern) => pattern.test(errorText));
  if (input.fatalFirst && !hasResetSignal && QUOTA_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(errorText))) {
    return { type: "BILLING_HARD_LIMIT", reason: "Quota exhaustion or billing failure without a reset signal", errorMessage, rawStopReason: stopReason };
  }

  let reason: string | undefined;
  if (httpStatus === 429) reason = "HTTP 429 Too Many Requests (Rate Limited)";
  else if (httpStatus !== undefined && [408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529, 530].includes(httpStatus)) {
    reason = `HTTP ${httpStatus} transient provider failure`;
  } else if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorText))) {
    reason = "Provider rate limit or quota exceeded";
  } else if (stopReason === "error" && TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
    reason = "Transient transport or gateway failure";
  }
  if (!reason) return none;
  return {
    type: "RATE_LIMIT",
    reason,
    errorMessage: errorMessage || (httpStatus ? `HTTP ${httpStatus}` : undefined),
    retryAfterMs: retryInfo.delayMs ?? undefined,
    retryAfterHeaderReceived: retryInfo.hasHeader,
    expectedResetTime: retryInfo.expectedResetTime ?? undefined,
    isWindowEstimate: retryInfo.isWindowEstimate,
    rawStopReason: stopReason,
  };
}
