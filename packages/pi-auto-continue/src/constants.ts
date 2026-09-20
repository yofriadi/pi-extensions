import type { AutoContinueConfig } from "./types.ts";

export const DEFAULT_BASE_DELAY_MS = 5000; // 5 seconds
export const DEFAULT_MAX_DELAY_MS = 600000; // 10 minutes
export const DEFAULT_BACKOFF_MULTIPLIER = 2;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 60000; // 1 minute (60,000 ms)
export const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 600000; // 10 minutes (600,000 ms)
export const DEFAULT_RATE_LIMIT_MAX_RETRIES = "5h"; // 5 hours

export const DEFAULT_RATE_LIMIT_RETRY_PROMPT =
  "The previous request was interrupted by a transient provider error or rate/quota limit. Resume from the last completed step without repeating completed work. Check existing tool results before retrying any operation.";

export const DEFAULT_TOKEN_LIMIT_CONTINUE_PROMPT =
  "Continue from where you left off without repeating any text or code already provided. Do not add conversational preamble, explanations, or filler—resume output immediately at the exact point of interruption.";

export const DEFAULT_INCOMPLETE_TOOL_CALL_CONTINUE_PROMPT =
  "Your previous response was truncated while emitting a tool call. Check existing tool results first; do not repeat completed operations. If the call has not run, issue it with complete arguments, otherwise continue from its result.";

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
  /(?:requests?|tokens?|quota|limit).{0,40}per\s+(?:minute|hour|day)\b/i,
  /\b(?:RPM|TPM|RPD|TPD)\b/i,
];

export const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: true,
  subagent: false,
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
 * Env vars whose presence marks this pi process as a subagent launched by a
 * supervisor (pi-subagent-herdr and compatible launchers). When set (and the
 * `subagent` config opt-in is not true), the retry wiring is disabled.
 */
export const SUBAGENT_ENV_VARS = ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID"] as const;

/**
 * Tool names whose successful execution means the subagent has declared
 * completion. After one of these runs, this session must never send another
 * autonomous continuation/retry prompt.
 */
export const SUBAGENT_DONE_TOOL_NAMES = ["subagent_done"] as const;

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
 * Patterns for transient transport and gateway failures that surface as
 * `stopReason: "error"` turns: dropped connections, timed-out requests,
 * upstream relay errors, gateway maintenance, and routing capacity. The
 * request may have partially completed, so recovery prompts must check existing
 * tool results before repeating work. Consulted only for error turns.
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  // Timeouts: "Request timed out.", "The operation timed out.",
  // "504 Gateway Time-out" HTML pages
  /\btime(?:d)?.?out\b/i,
  // Stream / socket termination: undici's bare "terminated"
  /\bterminated\b/i,
  // Connection failures: "Connection error.",
  // "The socket connection was closed unexpectedly…"
  /(?:connection|socket).{0,30}(?:error|closed|reset|refused|dropped|failed|ended)/i,
  // Stream relay failures: "Stream ended without finish_reason",
  // "upstream stream failed", "stream ended before message_stop"
  /stream.{0,40}(?:ended|fail|error|without finish)/i,
  // Upstream relay failures: "upstream chain exhausted",
  // '502 "upstream error"', "upstream error: do request failed"
  /upstream.{0,30}(?:error|fail|exhaust)/i,
  // Provider relay status: "Provider is unavailable",
  // "Provider rejected the request", "Provider finish_reason: error".
  // Policy/safety rejections are handled by the permanent-error guard below.
  /provider.{0,30}(?:unavailable|rejected|finish_reason["'\s:=]+error\b)/i,
  // Gateway maintenance: 503 maintenance_mode
  /under.?maintenance/i,
  // Gateway routing capacity: "No healthy openai route for model …"
  /no.?healthy.{0,30}route/i,
  // Temporary gateway-side verification failures:
  // "unable to verify api key — try again shortly"
  /unable to verify.{0,30}(?:api.?key|balance)/i,
  // Daily inference caps that carry their own reset hint:
  // INFERENCE_CAP_ERROR "… Try again in 2h 36m"
  /inference.?cap.?error/i,
  // Bare HTTP errors, without matching numbers buried in unrelated messages.
  /^\s*["']?(?:(?:error:\s*)?(?:HTTP[\s/]*)?)?(?:408|429|500|502|503|504|52[0-6]|529|530)(?:[\s:"'<(]|$)/i,
  // Cloudflare HTML error pages: "502 Bad Gateway"
  /bad.?gateway/i,
  // Gateway concurrency caps: 429 "… Concurrency limit 1200 …"
  /concurrency.?limit/i,
  // Node/undici transport codes and terse wrapper errors:
  // "read ECONNRESET", "fetch failed", "socket hang up", "premature close"
  /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|PROTO)\b/i,
  /\bfetch.?failed\b/i,
  /\bsocket hang.?up\b/i,
  /\bpremature(?:ly)? close(?:d)?\b/i,
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
  // Account termination is not a terminated network stream.
  /\b(?:account|org(?:anization)?|access|subscription|api.?key)\b.{0,80}?\bterminat/i,
  /\bterminated\s+(?:your|the)\s+(?:account|organization|access|subscription|api.?key)\b/i,
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

/** User cancellation takes precedence over transport errors or cached status. */
export const USER_ABORT_PATTERNS: RegExp[] = [
  /\b(?:operation|request|stream)\s+(?:was\s+)?(?:aborted|cancelled|canceled)\b/i,
  /\b(?:abort(?:ed)?|cancel(?:led|ed)?|terminated)\s+by\s+(?:the\s+)?(?:user|client)\b/i,
  /\b(?:user|client)\s+(?:abort(?:ed)?|cancel(?:led|ed)?|closed)\b/i,
  /\bAbortError\b/i,
];

/** Provider refusals and invalid requests do not become transient on HTTP 5xx. */
export const PERMANENT_REQUEST_ERROR_PATTERNS: RegExp[] = [
  // Apply to every retry path, not just the provider-rejection transient pattern:
  // gateways may also wrap a refusal in upstream_error or a retryable HTTP status.
  /provider.{0,30}rejected.{0,60}(?:polic|safety|prohibit|illegal)/is,
  /content[_\s-]?(?:policy|filter)|safety[_\s-]?(?:system|filter|violation)|policy\s+violation/i,
  /finish_reason["'\s:=]+(?:safety|recitation|blocklist|prohibited_content|spii)\b/i,
  /invalid[_\s-]?(?:request|argument|schema|parameter)|unsupported[_\s-]?(?:model|parameter)/i,
  /model.{0,40}(?:not found|does not exist|disabled|not available for|not eligible)/i,
  /\binvalid_grant\b|refresh token.{0,40}(?:expired|not found|invalid)/i,
  /^\s*(?:error:\s*)?(?:HTTP[\s/]*)?(?:401|402|403|404|405|422|501|505)\b/i,
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
