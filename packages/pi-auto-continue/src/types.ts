/**
 * Configuration and state type definitions for pi-auto-continue extension.
 */

export type RetryLimit =
  | { type: "attempts"; count: number }
  | { type: "duration"; durationMs: number };

export interface RateLimitConfig {
  /** Whether to automatically retry on rate/quota limit errors (default: true) */
  enabled: boolean;
  /** Whether to add random jitter (±15%) to retry delays (default: true) */
  jitter: boolean;
  /**
   * Let terminal signals outrank a retryable HTTP status code:
   *   - HTTP 401/403 and quota-exhaustion / billing text stop the retry loop
   *     instead of being retried for the whole rateLimit budget.
   *   - Context-window overflow defers to Pi's auto-compaction as it always should.
   * Messages that state their own reset window ("try again in 20s",
   * "within 1 minutes") stay retryable. Default false = upstream behavior.
   */
  fatalFirst?: boolean;
  /**
   * Multiplier applied to a detected rolling quota window so the retry lands
   * just past the boundary rather than exactly on it (default 1.15).
   */
  windowRetryMargin?: number;
  /**
   * Base delay in ms for rate limits (duration number or string like "1m" or "10s").
   * Defaults to 1 minute (60,000 ms), independent of global baseDelayMs.
   */
  baseDelayMs?: number | string;
  /**
   * Maximum single delay cap in ms for rate limits (duration number or string like "10m").
   * Defaults to 10 minutes (600,000 ms), independent of global maxDelayMs.
   */
  maxDelayMs?: number | string;
  /**
   * Maximum retries or duration deadline for rate limits (attempts number or duration string like "5h").
   * Defaults to "5h" (5 hours), independent of global maxRetries.
   */
  maxRetries?: number | string;
  /** Prompt sent when retrying after a provider rate or quota limit error */
  retryPrompt?: string;
}

export interface TokenLimitConfig {
  /** Whether to automatically continue truncated responses (default: true) */
  enabled: boolean;
  /** Prompt sent when response is truncated due to max output tokens */
  continuePrompt: string;
}

export interface IncompleteToolCallConfig {
  /** Whether to auto-continue when an output cuts off mid-tool-call (default: true) */
  enabled: boolean;
  /** Prompt sent when response is cut off mid tool call */
  continuePrompt: string;
}

export interface AutoContinueConfig {
  /** Master switch to enable/disable auto-continue (default: true) */
  enabled: boolean;
  /** Base delay in ms for exponential backoff (default: 5,000 ms = 5 seconds) */
  baseDelayMs: number;
  /** Maximum single delay in ms (default: 600,000 ms = 10 minutes) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number;
  /**
   * Maximum retries: either a number of attempts (e.g. 3) or a duration string (e.g. "15m", "5h").
   * Defaults to 3 attempts.
   */
  maxRetries: number | string;
  /** Rate limit and quota exhaustion retry settings */
  rateLimit: RateLimitConfig;
  /** Token limit truncation handling settings */
  tokenLimit: TokenLimitConfig;
  /** Incomplete tool call handling settings */
  incompleteToolCall: IncompleteToolCallConfig;
}

/**
 * Categorization of an assistant message interruption or failure.
 */
export type InterruptionType =
  | "RATE_LIMIT" // 429, quota exhaustion, overloaded, rate limits (retryable)
  | "TOKEN_LIMIT" // stopReason === "length" (continuation prompt)
  | "INCOMPLETE_TOOL_CALL" // cut off mid-tool-call arguments (continuation prompt)
  | "CONTEXT_OVERFLOW" // context window full (defer to Pi auto-compaction)
  | "BILLING_HARD_LIMIT" // permanent payment required / account exhaustion
  | "NONE"; // normal completion or non-interrupted

export interface ClassificationResult {
  type: InterruptionType;
  reason: string;
  errorMessage?: string;
  /** Explicit delay in ms extracted from Retry-After headers or error text */
  retryAfterMs?: number;
  /** Whether an explicit HTTP retry-after / reset header was received */
  retryAfterHeaderReceived?: boolean;
  /** Expected epoch timestamp (ms) when quota or tokens reset */
  expectedResetTime?: number;
  /** True when the delay came from a rolling window width, not a reset point */
  isWindowEstimate?: boolean;
  rawStopReason?: string;
}

export interface RetryState {
  isRetrying: boolean;
  startTime: number | null;
  attempt: number;
  lastDelayMs: number;
  lastErrorMessage?: string;
  lastInterruptionType?: InterruptionType;
  nextRetryTime?: number;
  /** Whether the active or last retry was triggered by a Retry-After header */
  retryAfterHeaderReceived?: boolean;
  /** Expected epoch timestamp (ms) when tokens/quota reset from Retry-After header */
  expectedTokenResetTime?: number;
  /** Optional timestamp of last processed message */
  lastMessageTimestamp?: number;
  /** Number of rate limit attempts in the current retry cycle */
  rateLimitAttempts?: number;
}

/**
 * Consolidated into RetryState.
 * Retained as an alias for backward compatibility.
 */
export type ContinuationState = RetryState;
