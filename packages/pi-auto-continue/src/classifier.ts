import {
  BILLING_HARD_LIMIT_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  DEFAULT_WINDOW_RETRY_MARGIN,
  QUOTA_EXHAUSTION_PATTERNS,
  RATE_LIMIT_PATTERNS,
  RESET_SIGNAL_PATTERNS,
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
  // 1. Check HTTP response headers
  if (headers) {
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    // Standard Retry-After header (seconds or HTTP date)
    const retryAfter = normalizedHeaders["retry-after"];
    if (retryAfter) {
      const parsedSeconds = parseFloat(retryAfter);
      if (!isNaN(parsedSeconds) && parsedSeconds >= 0) {
        const delayMs = Math.round(parsedSeconds * 1000);
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: true,
        };
      }
      const parsedDate = Date.parse(retryAfter);
      if (!isNaN(parsedDate)) {
        const diffMs = parsedDate - now;
        return {
          delayMs: diffMs > 0 ? diffMs : 0,
          expectedResetTime: parsedDate,
          hasHeader: true,
        };
      }
    }

    // Direct ms header used by some gateways
    const retryAfterMs = normalizedHeaders["retry-after-ms"];
    if (retryAfterMs) {
      const parsedMs = parseFloat(retryAfterMs);
      if (!isNaN(parsedMs) && parsedMs >= 0) {
        const delayMs = Math.round(parsedMs);
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: true,
        };
      }
    }

    // UNIX timestamp reset header (e.g. OpenAI / Cloudflare)
    const resetTime =
      normalizedHeaders["x-ratelimit-reset"] ||
      normalizedHeaders["x-ratelimit-reset-requests"] ||
      normalizedHeaders["x-ratelimit-reset-tokens"];
    if (resetTime) {
      const parsed = parseFloat(resetTime);
      if (!isNaN(parsed) && parsed > 0) {
        // Could be epoch seconds (> 1e9) or delta seconds
        if (parsed > 1e9) {
          const expectedResetTime = Math.round(parsed * 1000);
          const diffMs = expectedResetTime - now;
          return {
            delayMs: diffMs > 0 ? diffMs : 0,
            expectedResetTime,
            hasHeader: true,
          };
        } else {
          const delayMs = Math.round(parsed * 1000);
          return {
            delayMs,
            expectedResetTime: now + delayMs,
            hasHeader: true,
          };
        }
      }
    }
  }

  // 2. Check error message text for inline retry hints
  if (errorMessage) {
    // "retry after 30s", "try again in 12.5 seconds", "wait 45 seconds", "try again in ~42 min."
    const secMatch = errorMessage.match(
      /(?:retry.?after|try.?again.?(?:in|after)|wait|slow.?down.?for|resets?.?(?:in|after))\s*(?:~|approx(?:\.|imately)?|about|around)?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?\b/i
    );
    if (secMatch && secMatch[1]) {
      const num = parseFloat(secMatch[1]);
      const rawUnit =
        secMatch[2] ||
        secMatch[0].match(
          /(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|ms)$/i
        )?.[1] ||
        "s";
      const unit = rawUnit.toLowerCase();
      if (!isNaN(num) && num > 0) {
        let delayMs: number;
        if (unit.startsWith("m") && !unit.startsWith("ms")) {
          delayMs = Math.round(num * 60 * 1000);
        } else if (unit.startsWith("h")) {
          delayMs = Math.round(num * 3600 * 1000);
        } else if (unit === "ms") {
          delayMs = Math.round(num);
        } else {
          delayMs = Math.round(num * 1000);
        }
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: false,
        };
      }
    }

    // ISO timestamp in error: "resets at 2026-09-01T14:30:00Z"
    const dateMatch = errorMessage.match(
      /(?:resets?.?at|retry.?at)\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/i
    );
    if (dateMatch && dateMatch[1]) {
      const parsed = Date.parse(dateMatch[1]);
      if (!isNaN(parsed)) {
        const diffMs = parsed - now;
        return {
          delayMs: diffMs > 0 ? diffMs : 0,
          expectedResetTime: parsed,
          hasHeader: false,
        };
      }
    }

    // Target clock time in error: "try again at 3:45 PM", "resets at 14:30"
    const clockMatch = errorMessage.match(
      /(?:resets?.?at|retry.?at|try.?again.?at)\s*([01]?\d|2[0-3]:[0-5]\d(?::[0-5]\d)?\s*(?:am|pm)?)\b/i
    );
    if (clockMatch && clockMatch[1]) {
      const parsed = parseTargetTime(clockMatch[1], new Date(now));
      if (parsed) {
        const diffMs = parsed.targetTimeMs - now;
        return {
          delayMs: diffMs > 0 ? diffMs : 0,
          expectedResetTime: parsed.targetTimeMs,
          hasHeader: false,
        };
      }
    }

    // Rolling quota window: "Maximum 8 requests within 1 minutes",
    // "5 requests per 30 seconds", "limit of 10 req/1min". Unlike the hints
    // above this states the window WIDTH, not a reset point, so the start is
    // unknown. Best case it has just opened; worst case the rejected request
    // landed at its very end and it closes after the full width, so we assume
    // the full width and retry just past the boundary.
    const windowMatch = errorMessage.match(
      /(?:within|per|every|limit\s+of|max(?:imum)?\s+of)\s*(?:~|approx(?:\.|imately)?|about|around)?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/i
    );
    if (windowMatch && windowMatch[1]) {
      const widthMs = toMillis(
        parseFloat(windowMatch[1]),
        (windowMatch[2] || "s").toLowerCase()
      );
      if (widthMs !== null && widthMs > 0) {
        const delayMs = Math.round(widthMs * windowRetryMargin);
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: false,
          isWindowEstimate: true,
        };
      }
    }
  }

  return {
    delayMs: null,
    expectedResetTime: null,
    hasHeader: false,
  };
}

/**
 * Converts a magnitude plus a unit token to milliseconds, or null if unrecognised.
 */
function toMillis(num: number, unit: string): number | null {
  if (isNaN(num) || num <= 0) return null;
  if (unit === "ms") return Math.round(num);
  if (unit.startsWith("s")) return Math.round(num * 1000);
  if (unit.startsWith("m")) return Math.round(num * 60 * 1000);
  if (unit.startsWith("h")) return Math.round(num * 3600 * 1000);
  if (unit.startsWith("d")) return Math.round(num * 86400 * 1000);
  return null;
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
  content?: any[];
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
  const currentTime = now ?? input.now ?? Date.now();
  const retryInfo = extractRetryAfterInfo(
    httpHeaders,
    errorMessage,
    currentTime,
    input.windowRetryMargin ?? DEFAULT_WINDOW_RETRY_MARGIN
  );

  // 0. Opt-in (`rateLimit.fatalFirst`): let terminal signals outrank a
  //    retryable HTTP status code. A quota-exhausted or billing-blocked request
  //    routinely arrives as HTTP 429, and waiting out the retry budget on an
  //    account with no credit stalls the run for hours.
  //
  //    Off by default so behaviour matches upstream: every quota/usage-limit
  //    message is retried. When on, a message carrying a self-evident reset
  //    signal ("try again in 20s", "within 1 minutes", "resets at 14:30") is
  //    still retried, so only terminal-looking text stops the loop.
  //
  //    These checks read the status code only for 401/403, which pi reports for
  //    the same request as the error text, so no cached-response staleness
  //    applies here beyond what upstream already relies on.
  const errorTextPre = errorMessage || "";
  if (input.fatalFirst) {
    // 401/403 are terminal whatever the body claims: the request was never
    //    authorized, so no amount of waiting changes the outcome.
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        type: "BILLING_HARD_LIMIT",
        reason: `HTTP ${httpStatus} authentication or permission failure`,
        errorMessage: errorTextPre || `HTTP ${httpStatus}`,
        rawStopReason: stopReason,
      };
    }
    const hasResetSignal = RESET_SIGNAL_PATTERNS.some((p) => p.test(errorTextPre));
    if (!hasResetSignal && QUOTA_EXHAUSTION_PATTERNS.some((p) => p.test(errorTextPre))) {
      return {
        type: "BILLING_HARD_LIMIT",
        reason: "Quota exhaustion or billing failure without a reset signal",
        errorMessage: errorTextPre,
        rawStopReason: stopReason,
      };
    }
    // Context overflow is resolved by Pi's auto-compaction, never by waiting,
    // so it must not be masked by a retryable status code.
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorTextPre))) {
      return {
        type: "CONTEXT_OVERFLOW",
        reason: "Context window overflow",
        errorMessage: errorTextPre,
        rawStopReason: stopReason,
      };
    }
  }

  // 1. Direct HTTP 429 / 503 / 529 Rate Limit or Overload
  if (httpStatus === 429) {
    return {
      type: "RATE_LIMIT",
      reason: "HTTP 429 Too Many Requests (Rate Limited)",
      errorMessage: errorMessage || "HTTP 429 Too Many Requests",
      retryAfterMs: retryInfo.delayMs ?? undefined,
      retryAfterHeaderReceived: retryInfo.hasHeader,
      expectedResetTime: retryInfo.expectedResetTime ?? undefined,
      isWindowEstimate: retryInfo.isWindowEstimate,
      rawStopReason: stopReason,
    };
  }

  if (httpStatus === 503 || httpStatus === 529) {
    return {
      type: "RATE_LIMIT",
      reason: `HTTP ${httpStatus} Provider Overloaded`,
      errorMessage: errorMessage || `HTTP ${httpStatus} Service Unavailable / Overloaded`,
      retryAfterMs: retryInfo.delayMs ?? undefined,
      retryAfterHeaderReceived: retryInfo.hasHeader,
      expectedResetTime: retryInfo.expectedResetTime ?? undefined,
      isWindowEstimate: retryInfo.isWindowEstimate,
      rawStopReason: stopReason,
    };
  }

  // 2. Provider Error Messages
  if (stopReason === "error" || (errorMessage && errorMessage.trim().length > 0)) {
    const errorText = errorMessage || "";

    // Check Context Overflow first (should defer to auto-compaction, not retry in a loop)
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "CONTEXT_OVERFLOW",
        reason: "Context window overflow",
        errorMessage: errorText,
        rawStopReason: stopReason,
      };
    }

    // Check non-retryable fatal billing / account limits
    if (BILLING_HARD_LIMIT_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "BILLING_HARD_LIMIT",
        reason: "Billing hard limit or authentication failure (non-retryable)",
        errorMessage: errorText,
        rawStopReason: stopReason,
      };
    }

    // Check transient rate limits and quota resets
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "RATE_LIMIT",
        reason: "Provider rate limit or quota exceeded",
        errorMessage: errorText,
        retryAfterMs: retryInfo.delayMs ?? undefined,
        retryAfterHeaderReceived: retryInfo.hasHeader,
        expectedResetTime: retryInfo.expectedResetTime ?? undefined,
        isWindowEstimate: retryInfo.isWindowEstimate,
        rawStopReason: stopReason,
      };
    }
  }

  // 3. Incomplete Tool Call Check
  // Check if output ended mid-tool-call (e.g. truncated arguments or empty JSON object)
  if (Array.isArray(content) && content.length > 0) {
    const lastContent = content[content.length - 1];
    if (lastContent?.type === "toolCall") {
      const args = lastContent.arguments;
      const isEmptyArgs =
        args === undefined ||
        args === null ||
        (typeof args === "object" && Object.keys(args).length === 0);
      if (isEmptyArgs && stopReason !== "stop") {
        return {
          type: "INCOMPLETE_TOOL_CALL",
          reason: "Tool call cut off with missing or incomplete arguments",
          errorMessage,
          rawStopReason: stopReason,
        };
      }
    }
  }

  // 4. Token Limit Truncation (stopReason === "length")
  if (stopReason === "length") {
    return {
      type: "TOKEN_LIMIT",
      reason: "Response reached maximum output tokens (max_tokens)",
      errorMessage,
      rawStopReason: stopReason,
    };
  }

  return {
    type: "NONE",
    reason: "Normal message completion",
    errorMessage,
    rawStopReason: stopReason,
  };
}
