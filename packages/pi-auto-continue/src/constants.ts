import type { AutoContinueConfig } from "./types.ts";

export const DEFAULT_BASE_DELAY_MS = 5000; // 5 seconds
export const DEFAULT_MAX_DELAY_MS = 600000; // 10 minutes
export const DEFAULT_BACKOFF_MULTIPLIER = 2;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 60000; // 1 minute (60,000 ms)
export const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 600000; // 10 minutes (600,000 ms)
export const DEFAULT_RATE_LIMIT_MAX_RETRIES = "5h"; // 5 hours

export const DEFAULT_RATE_LIMIT_RETRY_PROMPT =
  "The previous request encountered a provider rate/quota limit, which has now resolved. Please resume your task directly from where you left off. Do not apologize or discuss the delay—proceed immediately with the next step.";

export const DEFAULT_TOKEN_LIMIT_CONTINUE_PROMPT =
  "Continue from where you left off without repeating any text or code already provided. Do not add conversational preamble, explanations, or filler—resume output immediately at the exact point of interruption.";

export const DEFAULT_INCOMPLETE_TOOL_CALL_CONTINUE_PROMPT =
  "Your previous response was cut off while emitting a tool call, leaving arguments incomplete. Please re-issue the complete tool call with all required arguments. Do not add conversational preamble, explanations, or apologies—proceed directly with executing the tool call, or provide your final response if finished.";

/**
 * Multiplier applied to a detected rolling quota window so the retry lands
 * just past the window boundary instead of exactly on it (default: 1.15).
 */
export const DEFAULT_WINDOW_RETRY_MARGIN = 1.15;

/**
 * Phrases that mean the account is out of credit rather than temporarily
 * throttled. Only consulted when `rateLimit.fatalFirst` is enabled, since
 * upstream classifies bare quota/usage-limit text as retryable by default.
 */
export const QUOTA_EXHAUSTION_PATTERNS: RegExp[] = [
  /insufficient.?quota/i,
  /\bquota_exhausted\b/i,
  /\bbilling_error\b/i,
  /out.?of.?budget/i,
  /no.?remaining.?(?:credits|balance)/i,
  /available.?balance/i,
];

/**
 * Signals that a quota error will clear on its own. When one of these is
 * present, the error is throttling rather than exhaustion and stays
 * retryable even when `rateLimit.fatalFirst` is enabled.
 */
export const RESET_SIGNAL_PATTERNS: RegExp[] = [
  /retry.?after/i,
  /try.?again/i,
  /reset/i,
  /wait/i,
  /\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i,
  /per.?(?:minute|hour|day)/i,
  /within\s+\d+/i,
  /\b(?:RPM|TPM|RPD|TPD)\b/i,
  /\/\s*\d+\s*(?:m|min|h|d)\b/i,
];

export const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: true,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
  maxRetries: DEFAULT_MAX_RETRIES,
  rateLimit: {
    enabled: true,
    baseDelayMs: DEFAULT_RATE_LIMIT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
    maxRetries: DEFAULT_RATE_LIMIT_MAX_RETRIES,
    jitter: true,
    fatalFirst: false,
    windowRetryMargin: DEFAULT_WINDOW_RETRY_MARGIN,
    retryPrompt: DEFAULT_RATE_LIMIT_RETRY_PROMPT,
  },
  tokenLimit: {
    enabled: true,
    continuePrompt: DEFAULT_TOKEN_LIMIT_CONTINUE_PROMPT,
  },
  incompleteToolCall: {
    enabled: true,
    continuePrompt: DEFAULT_INCOMPLETE_TOOL_CALL_CONTINUE_PROMPT,
  },
};

/**
 * Patterns that indicate provider rate limits, quota limits, or server capacity issues.
 * These are transient errors that can be retried automatically until quota resets.
 */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  // Generic & HTTP 429
  /rate.?limit/i,
  /too.?many.?requests/i,
  /please.?slow.?down/i,
  /retry.?after/i,
  /throttl/i,
  /requests?.?per.?(?:minute|second|day|hour)/i,
  /tokens?.?per.?(?:minute|second|day|hour)/i,
  /\b(?:RPM|TPM|RPD|TPD)\b/i,

  // Server capacity & overload (503 / 529 / 500 transient)
  /overloaded/i,
  /capacity/i,
  /service.?unavailable.*load/i,
  /temporarily.?unavailable/i,
  /server.?busy/i,
  /peak.?capacity/i,
  /high.?traffic/i,

  // Google Gemini / Vertex
  /resource.?exhausted/i,
  /quota.?exceeded/i,
  /quota.?metric/i,
  /rate.?limit.?exceeded/i,

  // Anthropic
  /overloaded_error/i,
  /rate_limit_error/i,

  // OpenAI / OpenCode / Azure
  /(?:you.?)?(?:have.?)?exceeded.?(?:the.?)?rate/i,
  /(?:you.?)?(?:have.?)?exceeded.?(?:your.?)?(?:current.?)?quota/i,
  /insufficient.?quota/i,
  /quota.?(?:exceeded|reached|exhausted|limit)/i,
  /usage.?limit/i,
  /plan.?limit/i,
  /request.?limit/i,
  /api.?limit/i,
  /chatgpt.?usage.?limit/i,
  /hit.?your.?(?:chatgpt.?)?usage.?limit/i,

  // GitHub Copilot & other providers
  /copilot.?quota/i,
  /copilot.?limit/i,
];

/**
 * Patterns indicating non-retryable billing / account / auth errors.
 * Retrying these will not succeed without user manual action.
 */
export const BILLING_HARD_LIMIT_PATTERNS: RegExp[] = [
  /insufficient.?funds/i,
  /payment.?required/i,
  /account.?deactivated/i,
  /account.?suspended/i,
  /credit.?card/i,
  /upgrade.?plan/i,
  /upgrade.?your.?plan/i,
  /out.?of.?credits/i,
  /billing.?hard.?limit/i,
  /no.?remaining.?credits/i,
  /invalid.?api.?key/i,
  /authentication.?failed/i,
  /unauthorized/i,
  /forbidden.*billing/i,
];

/**
 * Patterns for context window overflow.
 * Pi has built-in auto-compaction for this, so we should not retry blindly.
 */
export const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context.?length/i,
  /context.?window/i,
  /maximum.?context/i,
  /prompt.?(?:is.?)?too.?long/i,
  /request.?too.?large/i,
  /input.?too.?long/i,
  /exceeds?.?(?:the.?)?max(?:imum)?.?(?:context|tokens?)/i,
  /model.?context.?size/i,
];
