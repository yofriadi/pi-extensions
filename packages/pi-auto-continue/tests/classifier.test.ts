import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyInterruption,
  extractRetryAfterDelay,
  extractRetryAfterInfo,
} from "../src/classifier.ts";

describe("classifier", () => {
  describe("extractRetryAfterInfo", () => {
    it("extracts delay, expectedResetTime, and header flag from Retry-After", () => {
      const now = 1000000;
      const info = extractRetryAfterInfo({ "retry-after": "30" }, undefined, now);
      assert.equal(info.delayMs, 30000);
      assert.equal(info.expectedResetTime, now + 30000);
      assert.equal(info.hasHeader, true);
    });

    it("extracts timestamp from HTTP date Retry-After header", () => {
      const futureDate = "Wed, 21 Oct 2026 07:28:00 GMT";
      const epoch = Date.parse(futureDate);
      const now = epoch - 20000;
      const info = extractRetryAfterInfo({ "retry-after": futureDate }, undefined, now);
      assert.equal(info.delayMs, 20000);
      assert.equal(info.expectedResetTime, epoch);
      assert.equal(info.hasHeader, true);
    });

    it("extracts from x-ratelimit-reset epoch timestamp", () => {
      const epochSeconds = 1758440000;
      const now = epochSeconds * 1000 - 15000;
      const info = extractRetryAfterInfo({ "x-ratelimit-reset": String(epochSeconds) }, undefined, now);
      assert.equal(info.delayMs, 15000);
      assert.equal(info.expectedResetTime, epochSeconds * 1000);
      assert.equal(info.hasHeader, true);
    });

    it("marks hasHeader false when delay is extracted from error message text", () => {
      const now = 1000000;
      const info = extractRetryAfterInfo(undefined, "Please retry after 45 seconds.", now);
      assert.equal(info.delayMs, 45000);
      assert.equal(info.expectedResetTime, now + 45000);
      assert.equal(info.hasHeader, false);
    });

    it("extracts delay and expectedResetTime from ChatGPT usage limit error message with tilde (~42 min)", () => {
      const now = 1000000;
      const error = '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.';
      const info = extractRetryAfterInfo(undefined, error, now);
      assert.equal(info.delayMs, 42 * 60 * 1000);
      assert.equal(info.expectedResetTime, now + 42 * 60 * 1000);
      assert.equal(info.hasHeader, false);
    });
  });

  describe("extractRetryAfterDelay", () => {
    it("extracts integer seconds from Retry-After header", () => {
      const delay = extractRetryAfterDelay({ "retry-after": "30" });
      assert.equal(delay, 30000);
    });

    it("extracts decimal seconds from Retry-After header", () => {
      const delay = extractRetryAfterDelay({ "retry-after": "12.5" });
      assert.equal(delay, 12500);
    });

    it("extracts ms from retry-after-ms header", () => {
      const delay = extractRetryAfterDelay({ "retry-after-ms": "4500" });
      assert.equal(delay, 4500);
    });

    it("extracts seconds from x-ratelimit-reset delta", () => {
      const delay = extractRetryAfterDelay({ "x-ratelimit-reset": "25" });
      assert.equal(delay, 25000);
    });

    it("extracts delay from error message text with seconds", () => {
      const delay = extractRetryAfterDelay(undefined, "Rate limit reached. Please try again in 15 seconds.");
      assert.equal(delay, 15000);
    });

    it("extracts delay from error message text with minutes", () => {
      const delay = extractRetryAfterDelay(undefined, "Quota exceeded. Please retry after 2 minutes.");
      assert.equal(delay, 120000);
    });

    it("extracts delay from ChatGPT usage limit error message with tilde (~42 min)", () => {
      const error = '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.';
      const delay = extractRetryAfterDelay(undefined, error);
      assert.equal(delay, 42 * 60 * 1000);
    });

    it("returns null when no retry delay is indicated", () => {
      const delay = extractRetryAfterDelay(undefined, "Something unexpected happened.");
      assert.equal(delay, null);
    });
  });

  describe("classifyInterruption", () => {
    it("identifies HTTP 429 status code as RATE_LIMIT", () => {
      const result = classifyInterruption({
        httpStatus: 429,
        httpHeaders: { "retry-after": "10" },
      });
      assert.equal(result.type, "RATE_LIMIT");
      assert.equal(result.retryAfterMs, 10000);
      assert.equal(result.retryAfterHeaderReceived, true);
      assert.ok(typeof result.expectedResetTime === "number");
    });

    it("identifies HTTP 503 / 529 as RATE_LIMIT / overloaded", () => {
      const result = classifyInterruption({ httpStatus: 503 });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("identifies Anthropic overloaded and rate limit errors", () => {
      const result1 = classifyInterruption({
        stopReason: "error",
        errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      });
      assert.equal(result1.type, "RATE_LIMIT");

      const result2 = classifyInterruption({
        stopReason: "error",
        errorMessage: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      });
      assert.equal(result2.type, "RATE_LIMIT");
    });

    it("identifies Google Gemini RESOURCE_EXHAUSTED errors", () => {
      const result = classifyInterruption({
        stopReason: "error",
        errorMessage: "GoogleGenerativeAIError: [429 Too Many Requests] RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API Requests'",
      });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("identifies OpenAI rate limit and quota exceeded messages", () => {
      const result1 = classifyInterruption({
        stopReason: "error",
        errorMessage: "Rate limit reached for model gpt-4o in organization org-123 on requests per min (RPM): Limit 500, Used 500, Requested 1. Please try again in 20s.",
      });
      assert.equal(result1.type, "RATE_LIMIT");
      assert.equal(result1.retryAfterMs, 20000);

      const result2 = classifyInterruption({
        stopReason: "error",
        errorMessage: "You exceeded your current quota, please check your plan and billing details.",
      });
      assert.equal(result2.type, "RATE_LIMIT");
    });

    it("identifies ChatGPT usage limit error and extracts estimated token reset time", () => {
      const now = 1750000000000;
      const error = '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.';
      const result = classifyInterruption(
        {
          stopReason: "error",
          errorMessage: error,
        },
        now
      );
      assert.equal(result.type, "RATE_LIMIT");
      assert.equal(result.retryAfterMs, 42 * 60 * 1000);
      assert.equal(result.expectedResetTime, now + 42 * 60 * 1000);
      assert.equal(result.retryAfterHeaderReceived, false);
      assert.equal(result.errorMessage, error);
    });

    it("correctly parses ChatGPT usage limit variations (quotes, closing quotes, no quotes, min/minutes)", () => {
      const now = 2000000000000;
      const variations = [
        '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
        '"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."',
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min",
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 minutes.",
      ];
      for (const err of variations) {
        const result = classifyInterruption({ errorMessage: err }, now);
        assert.equal(result.type, "RATE_LIMIT", `Failed type on: ${err}`);
        assert.equal(
          result.retryAfterMs,
          42 * 60 * 1000,
          `Failed delay on: ${err}`
        );
        assert.equal(
          result.expectedResetTime,
          now + 42 * 60 * 1000,
          `Failed expectedResetTime on: ${err}`
        );
      }
    });

    it("identifies CONTEXT_OVERFLOW errors", () => {
      const result = classifyInterruption({
        stopReason: "error",
        errorMessage: "Invalid request: prompt is too long. The model's maximum context length is 128000 tokens.",
      });
      assert.equal(result.type, "CONTEXT_OVERFLOW");
    });

    it("identifies BILLING_HARD_LIMIT errors", () => {
      const result = classifyInterruption({
        stopReason: "error",
        errorMessage: "Account deactivated due to payment required. Please update your credit card.",
      });
      assert.equal(result.type, "BILLING_HARD_LIMIT");
    });

    it("identifies TOKEN_LIMIT when stopReason is length", () => {
      const result = classifyInterruption({
        stopReason: "length",
        content: [{ type: "text", text: "Here is the code so far..." }],
      });
      assert.equal(result.type, "TOKEN_LIMIT");
    });

    it("identifies INCOMPLETE_TOOL_CALL when tool call has empty/truncated args", () => {
      const result = classifyInterruption({
        stopReason: "length",
        content: [
          { type: "text", text: "I will edit the file now." },
          { type: "toolCall", id: "call_1", name: "edit_file", arguments: {} },
        ],
      });
      assert.equal(result.type, "INCOMPLETE_TOOL_CALL");
    });

    it("returns NONE for regular completed assistant messages", () => {
      const result = classifyInterruption({
        stopReason: "stop",
        content: [{ type: "text", text: "Task completed successfully." }],
      });
      assert.equal(result.type, "NONE");
    });
  });
});

describe("fork additions", () => {
  describe("rolling quota window parsing", () => {
    it("derives a wait from 'Maximum 8 requests within 1 minutes'", () => {
      const now = 1000000;
      const err =
        'Error: 429: {"code":"","message":"You have reached the request limit[z-ai/glm-5.3-free]: Maximum 8 requests within 1 minutes. (request id: 20260913173637238708907fSiZbdHq)","type":"api_error"}';
      const info = extractRetryAfterInfo(undefined, err, now);
      assert.equal(info.delayMs, 69000);
      assert.equal(info.isWindowEstimate, true);
      // The window's start is unknown, so no reset instant may be published: the
      // wait is capped by maxDelayMs while `now + delayMs` would claim a reset
      // 69s out (or 27.6h out for a daily window) that nobody observed.
      assert.equal(info.expectedResetTime, null);
    });

    it("honours a configured windowRetryMargin", () => {
      const info = extractRetryAfterInfo(
        undefined,
        "Rate limited: 5 requests per 30 seconds",
        1000000,
        2
      );
      assert.equal(info.delayMs, 60000);
      assert.equal(info.isWindowEstimate, true);
    });

    it("classifies a bare 503 cache-admission rejection as retryable", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 503,
        errorMessage:
          'Error: 503: {"message":"cache-only admission rejected a cold, unavailable, or overloaded request","type":"Service Unavailable","param":"","code":"cache_only_cold"}',
      });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("does not invent a window from unrelated text", () => {
      const info = extractRetryAfterInfo(undefined, "fetch failed", 1000000);
      assert.equal(info.delayMs, null);
      assert.equal(info.isWindowEstimate, undefined);
    });
  });

  describe("fatalFirst", () => {
    const exhausted =
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}';

    it("is off by default: quota-exhausted 429 stays retryable (upstream behavior)", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 429,
        errorMessage: exhausted,
      });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("stops a quota-exhausted 429 when enabled", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 429,
        errorMessage: exhausted,
        now: Date.now(),
        fatalFirst: true,
      });
      assert.equal(result.type, "BILLING_HARD_LIMIT");
    });

    it("keeps a window-bounded limit retryable even when enabled", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 429,
        errorMessage:
          "You have reached the request limit[z-ai/glm-5.3-free]: Maximum 8 requests within 1 minutes.",
        now: Date.now(),
        fatalFirst: true,
      });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("treats 401/403 as terminal on generic bodies", () => {
      for (const status of [401, 403]) {
        const result = classifyInterruption({
          stopReason: "error",
          httpStatus: status,
          errorMessage: "unauthorized",
          now: Date.now(),
          fatalFirst: true,
        });
        assert.equal(result.type, "BILLING_HARD_LIMIT", `status ${status}`);
      }
    });

    it("defers context overflow to auto-compaction ahead of a 429", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 429,
        errorMessage: "This model's maximum context length is 128000 tokens.",
        now: Date.now(),
        fatalFirst: true,
      });
      assert.equal(result.type, "CONTEXT_OVERFLOW");
    });
  });

  describe("transient transport & gateway failures", () => {
    it("classifies 'upstream chain exhausted' as RATE_LIMIT", () => {
      const result = classifyInterruption({
        stopReason: "error",
        errorMessage: "upstream chain exhausted",
      });
      assert.equal(result.type, "RATE_LIMIT");
      assert.equal(result.reason, "Transient transport or gateway failure");
      assert.equal(result.rawStopReason, "error");
    });

    it("classifies timeouts, terminations, and connection failures", () => {
      for (const errorMessage of [
        "Request timed out.",
        "The operation timed out.",
        "terminated",
        "read ECONNRESET",
        "fetch failed",
        "socket hang up",
        "premature close",
        "Connection error.",
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` to increase logging verbosity.",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
      }
    });

    it("classifies stream and upstream relay failures", () => {
      for (const errorMessage of [
        "Stream ended without finish_reason",
        "upstream stream failed",
        "upstream stream interrupted",
        "Upstream network",
        '502 "upstream error"',
        '524 "upstream error"',
        '500: {"message":"upstream error: do request failed (request id: 20260913173637238708907fSiZbdHq)"}',
        // Relays reuse 413 for upstream failures; it is not a payload verdict.
        '413: {"message":"Upstream request failed","type":"api_error","code":"upstream_error"}',
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
        assert.equal(result.reason, "Transient transport or gateway failure", `Failed on: ${errorMessage}`);
      }
    });

    it("classifies component-named interruptions and provider-side internal errors", () => {
      for (const errorMessage of [
        "The response was interrupted mid-stream",
        "connection interrupted by remote peer",
        "Internal server error",
        "An internal error occurred. Please try again later.",
        '500: {"message":"Internal server error","type":"api_error"}',
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
        assert.equal(result.reason, "Transient transport or gateway failure", `Failed on: ${errorMessage}`);
      }
      // The component list IS the rule, so every entry is pinned: dropping one
      // must fail here rather than silently narrow recovery.
      for (const component of [
        "stream",
        "response",
        "connection",
        "socket",
        "transfer",
        "relay",
        "upstream",
        "generation",
      ]) {
        const result = classifyInterruption({
          stopReason: "error",
          errorMessage: `${component} interrupted while streaming`,
        });
        assert.equal(result.type, "RATE_LIMIT", `component not honoured: ${component}`);
      }
    });

    it("keeps cancellation-flavoured interruption wording unclassified", () => {
      for (const errorMessage of [
        "interrupted",
        "request interrupted",
        "The operation was interrupted",
        "Operation interrupted",
        "stream interrupted by user",
        "The request was interrupted by the client",
        "This request was interrupted because the client disconnected",
        "user interrupted the request",
        "interrupted at user request",
        "Ctrl+C interrupted the stream",
        // Cancellation wording that co-occurs with a transient marker. These
        // are what make the cancellation patterns load-bearing: without them a
        // transient pattern fires and the turn is retried.
        "The operation was interrupted. fetch failed",
        "operation interrupted: server is overloaded",
        "interrupted at user request: fetch failed",
        "user interrupted the request; upstream error",
        "client interrupted: socket hang up",
        "Aborted after 1 retry attempt",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "NONE", `Failed on: ${errorMessage}`);
      }
    });

    it("does not let interruption or internal-error wording resurrect terminal failures", () => {
      const cases = [
        ["Your authentication session was interrupted. Sign in again.", "NONE"],
        ["Subscription upgrade interrupted", "NONE"],
        ["upstream closed the connection because your API key is invalid", "NONE"],
        ["This endpoint is not available in your region. Please try again later.", "NONE"],
        ["This model is deprecated. Please try again later with a different model.", "NONE"],
        ["internal error: model requires a paid plan", "BILLING_HARD_LIMIT"],
        ["Internal error: forbidden", "BILLING_HARD_LIMIT"],
        ["Internal error: permission denied for this workspace", "BILLING_HARD_LIMIT"],
        ["Internal error: request is not authorized for this workspace", "BILLING_HARD_LIMIT"],
        // Bare authorization wording is deliberately NOT terminal: it appears in
        // throttled text ("Access Denied - Too Many Requests") and this list
        // outranks every HTTP status branch. Only the internal-error wrapper
        // makes it terminal, which is what the four rows below pin.
        ["upstream reset: model requires an entitlement you do not have", "NONE"],
        ["Access denied. Try again later.", "NONE"],
        ["Internal error: unauthenticated", "BILLING_HARD_LIMIT"],
        ["internal error: entitlement expired", "BILLING_HARD_LIMIT"],
        ["InternalError: request entity too large", "CONTEXT_OVERFLOW"],
        // A payload-size complaint that also carries throttling wording
        // (`"code":"free_rate_limited"`): re-sending the same prompt cannot
        // succeed, so this defers to compaction instead of retrying.
        [
          '400: {"message":"This prompt is longer than the free tier allows for a single request. Shorten it, or add credits","type":"invalid_request_error","code":"free_rate_limited"}',
          "CONTEXT_OVERFLOW",
        ],
        [
          '400: {"message":"<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.","type":"data_inspection_failed"}',
          "NONE",
        ],
      ];
      for (const [errorMessage, expected] of cases) {
        assert.equal(classifyInterruption({ stopReason: "error", errorMessage }).type, expected, errorMessage);
      }
    });

    it("does not let ambiguous interruption or permission wording veto a retryable status", () => {
      // USER_ABORT and BILLING_HARD_LIMIT outrank every status branch, so an
      // over-broad match there silently discards a confirmed rate limit.
      for (const httpStatus of [429, 502, 503]) {
        for (const errorMessage of ["request interrupted", "upstream request interrupted", "Forbidden"]) {
          assert.equal(
            classifyInterruption({ stopReason: "error", httpStatus, errorMessage }).type,
            "RATE_LIMIT",
            `${httpStatus}: ${errorMessage}`
          );
        }
      }
      const retryable: Array<{ httpStatus?: number; errorMessage: string }> = [
        { httpStatus: 429, errorMessage: "Rate limit exceeded. The request was interrupted. Retry after 60s" },
        { httpStatus: 504, errorMessage: "entitlement check failed: upstream timed out" },
        { errorMessage: "operation interrupted: ECONNRESET" },
        { errorMessage: "The operation was interrupted by a socket hang up" },
        // Each row pins one alternative in the lookahead's exclusion list;
        // they must start with "operation" or the cancellation pattern never
        // fires and the row proves nothing.
        { errorMessage: "operation interrupted: the connection was reset by peer" },
        { errorMessage: "operation interrupted: upstream error" },
        { errorMessage: "operation interrupted: request timed out" },
        { errorMessage: "request interrupted: connection reset by peer" },
        { errorMessage: "Request interrupted due to a network timeout" },
        { errorMessage: "unable to verify api key — forbidden" },
        { errorMessage: "entitlement service temporarily unavailable" },
        { errorMessage: "upstream error: 403 Forbidden" },
      ];
      for (const input of retryable) {
        assert.equal(classifyInterruption({ stopReason: "error", ...input }).type, "RATE_LIMIT", JSON.stringify(input));
      }
    });

    it("bounds the component-interrupt match to one sentence and a 40-character gap", () => {
      // Pins both constraints. Widening the gap bound or letting "." through
      // resurrects cross-sentence false positives such as "Stream finished
      // successfully. The user then interrupted."
      const gap = (n: number) => `stream ${"x".repeat(n)} interrupted`;
      assert.equal(classifyInterruption({ stopReason: "error", errorMessage: gap(38) }).type, "RATE_LIMIT");
      assert.equal(classifyInterruption({ stopReason: "error", errorMessage: gap(39) }).type, "NONE");
      for (const errorMessage of [
        "relay handed off. something something interrupted",
        "generation started ok. the operator then interrupted",
        "Stream finished successfully. The user then interrupted.",
      ]) {
        assert.equal(classifyInterruption({ stopReason: "error", errorMessage }).type, "NONE", errorMessage);
      }
    });

    it("classifies provider relay statuses, maintenance, and routing failures", () => {
      for (const errorMessage of [
        "Provider is unavailable",
        "Provider rejected the request",
        "Provider finish_reason: error",
        '503: {"message":"Shiteru AI is currently under maintenance.","type":"api_error","code":"maintenance_mode"}',
        "No healthy openai route for model gpt-5.6-sol:free",
        "No healthy anthropic route for model claude-opus-5:free",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
      }
    });

    it("classifies bare status-code texts without bodies", () => {
      for (const errorMessage of ['"HTTP 429"', "520 status code (no body)", "522 status code (no body)"]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
      }
    });

    it("extracts the reset hint from an INFERENCE_CAP_ERROR daily cap", () => {
      const now = 1750000000000;
      const result = classifyInterruption(
        {
          stopReason: "error",
          errorMessage:
            '429: {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 2h 36m"}',
        },
        now
      );
      assert.equal(result.type, "RATE_LIMIT");
      assert.equal(result.retryAfterMs, (2 * 60 + 36) * 60000);
      assert.equal(result.expectedResetTime, now + (2 * 60 + 36) * 60000);
    });

    it("classifies temporary gateway verification and concurrency failures", () => {
      for (const errorMessage of [
        '503: {"message":"unable to verify api key — try again shortly","type":"auth_unavailable"}',
        '503: {"message":"unable to verify balance — try again shortly","type":"billing_unavailable"}',
        "The request rate exceeds the current model Concurrency limit 1200. Please reduce the request frequency or contact Tencent Cloud support.",
        "502 <html><head><title>502 Bad Gateway</title></head></html>",
        "504 <html><head><title>504 Gateway Time-out</title></head></html>",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "RATE_LIMIT", `Failed on: ${errorMessage}`);
      }
    });

    it("stays retryable when fatalFirst is enabled", () => {
      const result = classifyInterruption({
        stopReason: "error",
        httpStatus: 400,
        errorMessage: '400: {"message":"Provider rejected the request","type":"api_error","code":"upstream_error"}',
        fatalFirst: true,
      });
      assert.equal(result.type, "RATE_LIMIT");
    });

    it("never matches abort or cancel texts", () => {
      for (const input of [
        { stopReason: "aborted", errorMessage: "Operation aborted" },
        { stopReason: "aborted", errorMessage: "Aborted after 1 retry attempt" },
        { stopReason: "aborted", errorMessage: "Request timed out." },
        { stopReason: "error", errorMessage: "This operation was aborted" },
      ]) {
        const result = classifyInterruption(input);
        assert.equal(result.type, "NONE", `Failed on: ${JSON.stringify(input)}`);
      }
    });

    it("stops on account-terminated text despite the terminated transport pattern", () => {
      for (const errorMessage of [
        "Your account has been terminated for violating usage policies.",
        "Your account was found in violation and has been terminated",
        "Your API access has been terminated due to policy violations",
        "Your subscription has been terminated for abuse",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "BILLING_HARD_LIMIT", `Failed on: ${errorMessage}`);
      }
    });

    it("does not retry provider rejections that cite policy or safety", () => {
      for (const errorMessage of [
        "Provider rejected the request: content policy violation",
        "Provider rejected the request because the safety system flagged it",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "NONE", `Failed on: ${errorMessage}`);
      }
    });

    it("keeps policy/safety rejections terminal across gateway wrappers and retryable statuses", () => {
      for (const rejection of [
        "Provider rejected the request for safety reasons",
        "Provider rejected the request due to provider policy",
        "Provider rejected the request because it is prohibited",
        "Provider rejected the request because it is illegal",
        "PROVIDER rejected the request:\nSafety reasons",
      ]) {
        for (const errorMessage of [
          rejection,
          `${rejection}; upstream_error`,
          `upstream_error: ${rejection}`,
          `502: ${JSON.stringify({ message: rejection, code: "upstream_error" })}`,
          `${rejection}; Request timed out.`,
          `${rejection}; rate limit exceeded; retry after 10s`,
        ]) {
          for (const httpStatus of [undefined, 408, 429, 500, 502, 503, 504, 529]) {
            for (const fatalFirst of [false, true]) {
              const input = {
                stopReason: "error",
                errorMessage,
                httpStatus,
                httpHeaders: { "retry-after": "10" },
                fatalFirst,
              };
              assert.equal(classifyInterruption(input).type, "NONE", JSON.stringify(input));
            }
          }
        }
      }
    });

    it("keeps generic rejections and unavailable safety/policy services retryable", () => {
      for (const errorMessage of [
        "Provider rejected the request; upstream_error",
        "Provider rejected the request due to temporary capacity; retry after 10s",
        "Provider unavailable: safety service timed out",
        "Provider policy service temporarily unavailable",
        "content moderation service temporarily unavailable",
      ]) {
        for (const httpStatus of [undefined, 429, 503]) {
          const result = classifyInterruption({ stopReason: "error", errorMessage, httpStatus });
          assert.equal(result.type, "RATE_LIMIT", `${httpStatus}: ${errorMessage}`);
        }
      }
    });

    it("keeps permanent entitlement and configuration errors unclassified", () => {
      for (const errorMessage of [
        "403: Your current subscription is not eligible for model claude-opus-5. Please choose another model.",
        '403: {"message":"no channel is currently available","type":"access_terminated_error"}',
        "403: model disabled in your preferences: cbcn/glm-5.3",
        "402: balance too low for this request — deposit USDC to continue",
        'OAuth refresh failed for anthropic: {"error":"invalid_grant","error_description":"Refresh token not found or expired"}',
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage });
        assert.equal(result.type, "NONE", `Failed on: ${errorMessage}`);
      }
    });
  });
});

describe("recovery safety regressions", () => {
  it("never classifies completed, tool-use, or aborted messages from stale HTTP metadata", () => {
    for (const stopReason of ["stop", "toolUse", "aborted"]) {
      for (const argumentsValue of [{}, undefined, { path: "valid" }]) {
        assert.equal(classifyInterruption({
          stopReason,
          httpStatus: 429,
          errorMessage: "fetch failed; retry after 30s",
          content: [{ type: "toolCall", name: "status", arguments: argumentsValue }],
        }).type, "NONE");
      }
    }
  });

  it("only calls a tool incomplete when the response was actually truncated", () => {
    const content = [{ type: "toolCall", name: "edit", arguments: { path: "incomplete.ts" } }];
    assert.equal(classifyInterruption({ stopReason: "length", content }).type, "INCOMPLETE_TOOL_CALL");
    assert.equal(classifyInterruption({ stopReason: "error", content }).type, "NONE");
    assert.equal(classifyInterruption({ stopReason: "toolUse", content }).type, "NONE");
    assert.equal(classifyInterruption({ stopReason: "length", httpStatus: 429, content: [{ type: "text", text: "partial" }] }).type, "TOKEN_LIMIT");
  });

  it("retries a relay interruption that died mid-tool-call as RATE_LIMIT", () => {
    const content = [
      { type: "thinking", thinking: "Now tasks.md edits." },
      { type: "toolCall", id: "call_ef04a80ab1e64f418d3f6e14", name: "edit", arguments: {} },
    ];
    // The reported stall: a 200 response whose stream broke while emitting a
    // tool call. The relay failure outranks the truncated-tool-call reading —
    // the turn never reached max_tokens, so the rate-limit path and its
    // deadline apply.
    const result = classifyInterruption({
      stopReason: "error",
      errorMessage: "upstream stream interrupted",
      content,
      httpStatus: 200,
    });
    assert.equal(result.type, "RATE_LIMIT");
    assert.equal(result.reason, "Transient transport or gateway failure");
  });

  it("gives cancellation, context, billing, and invalid requests priority over retryable statuses", () => {
    const cases = [
      ["Request was cancelled by the user; fetch failed", "NONE"],
      ["AbortError: connection reset", "NONE"],
      ["maximum context length exceeded", "CONTEXT_OVERFLOW"],
      ["invalid API key", "BILLING_HARD_LIMIT"],
      ["payment required", "BILLING_HARD_LIMIT"],
      ["content_policy_violation", "NONE"],
      ["invalid_request: unsupported parameter", "NONE"],
      ["OAuth refresh failed: invalid_grant", "NONE"],
    ];
    for (const httpStatus of [429, 500, 503]) {
      for (const [errorMessage, expected] of cases) {
        assert.equal(classifyInterruption({ stopReason: "error", httpStatus, errorMessage }).type, expected, `${httpStatus}: ${errorMessage}`);
      }
    }
    for (const httpStatus of [401, 402, 403]) {
      assert.equal(classifyInterruption({ stopReason: "error", httpStatus, errorMessage: "overloaded" }).type, "BILLING_HARD_LIMIT");
    }
  });

  it("retries a rate limit the gateway wrapped as an invalid request", () => {
    const wrapped = '429: {"message":"Rate limited","type":"invalid_request_error","code":"rate_limit_exceeded"}';
    for (const httpStatus of [undefined, 429]) {
      const result = classifyInterruption({ stopReason: "error", errorMessage: wrapped, httpStatus, fatalFirst: true });
      assert.equal(result.type, "RATE_LIMIT", `httpStatus ${String(httpStatus)}`);
    }
    // The override reaches the request-shape guard only. Refusals, credential
    // errors, unknown models and an anchored permanent status stay terminal even
    // when the same body mentions a rate limit.
    for (const errorMessage of [
      "Provider rejected the request for safety reasons; rate limit exceeded",
      "invalid_grant: rate limit exceeded",
      "model not found: rate limit exceeded",
      '404: {"message":"Rate limited","type":"invalid_request_error"}',
      "invalid_request: unsupported parameter",
    ]) {
      assert.equal(classifyInterruption({ stopReason: "error", errorMessage, fatalFirst: true }).type, "NONE", errorMessage);
    }
  });

  it("keeps quota exhaustion wrapped as an invalid request terminal", () => {
    // Bare "quota" is not an explicit throttling signal. If it were, these
    // out-of-credit bodies would retry for the whole deadline at the default
    // fatalFirst: false. That they stay NONE (rather than reporting a billing
    // failure) is the documented open gap: the request-shape guard is consulted
    // before the ambiguous-quota branch.
    for (const errorMessage of [
      '400: {"message":"Insufficient quota. Please add credits to continue.","type":"invalid_request_error","code":"insufficient_quota"}',
      '{"message":"Quota exhausted for this account","type":"invalid_request_error","code":"quota_exhausted"}',
    ]) {
      for (const fatalFirst of [false, true]) {
        assert.equal(
          classifyInterruption({ stopReason: "error", errorMessage, fatalFirst }).type,
          "NONE",
          `fatalFirst=${String(fatalFirst)}: ${errorMessage}`
        );
      }
    }
    // The throttling wrapper that motivated the override is unaffected.
    assert.equal(
      classifyInterruption({
        stopReason: "error",
        errorMessage: '429: {"message":"Rate limited","type":"invalid_request_error","code":"rate_limit_exceeded"}',
      }).type,
      "RATE_LIMIT"
    );
  });

  it("treats prompt and input size as context overflow, never request duration", () => {
    for (const errorMessage of [
      "This prompt is longer than the free tier allows for a single request.",
      "input is longer than 128000 tokens",
      "prompt is longer than the model context window",
    ]) {
      assert.equal(classifyInterruption({ stopReason: "error", errorMessage }).type, "CONTEXT_OVERFLOW", errorMessage);
    }
    // Context overflow is consulted before every HTTP status branch, so latency
    // wording must not be able to veto a confirmed 429/504 or send a timeout to
    // compaction that has nothing to compact.
    for (const httpStatus of [undefined, 429, 504]) {
      for (const errorMessage of [
        "The request is longer than the gateway timeout",
        "request is longer than 30000ms",
        "This request is longer than 5 minutes old",
      ]) {
        const result = classifyInterruption({ stopReason: "error", errorMessage, httpStatus });
        assert.notEqual(result.type, "CONTEXT_OVERFLOW", `${String(httpStatus)}: ${errorMessage}`);
      }
    }
    assert.equal(
      classifyInterruption({ stopReason: "error", errorMessage: "The request is longer than the gateway timeout", httpStatus: 504 }).type,
      "RATE_LIMIT"
    );
  });

  it("does not retry permanent numeric statuses even when the body sounds transient", () => {
    for (const httpStatus of [404, 405, 422, 501, 505]) {
      for (const errorMessage of ["Provider rejected the request", "fetch failed", "retry after 10s"]) {
        assert.equal(classifyInterruption({ stopReason: "error", httpStatus, errorMessage }).type, "NONE", `${httpStatus}: ${errorMessage}`);
      }
    }
  });

  it("only treats an error finish_reason as transient, never terminal safety reasons", () => {
    assert.equal(classifyInterruption({ stopReason: "error", errorMessage: "Provider finish_reason: error" }).type, "RATE_LIMIT");
    for (const reason of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "content_filter"]) {
      for (const httpStatus of [undefined, 429, 503]) {
        assert.equal(classifyInterruption({ stopReason: "error", httpStatus, errorMessage: `Provider finish_reason: ${reason}` }).type, "NONE", `${httpStatus}: ${reason}`);
      }
    }
    assert.equal(classifyInterruption({ stopReason: "error", errorMessage: "Provider finish_reason: stop" }).type, "NONE");
  });

  it("covers explicit transient statuses without matching arbitrary numbers in permanent errors", () => {
    for (const httpStatus of [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529, 530]) {
      assert.equal(classifyInterruption({ stopReason: "error", httpStatus }).type, "RATE_LIMIT", String(httpStatus));
    }
    for (const errorMessage of ["Invalid argument at line 503", "The model identifier is 529", "Unknown error (request id: 429-123)"]) {
      assert.equal(classifyInterruption({ stopReason: "error", errorMessage }).type, "NONE", errorMessage);
    }
  });

  it("does not mistake instructions to top up for a timed quota reset", () => {
    assert.equal(classifyInterruption({
      stopReason: "error", httpStatus: 429, fatalFirst: true,
      errorMessage: "insufficient_quota: retry after topping up your balance",
    }).type, "BILLING_HARD_LIMIT");
    assert.equal(classifyInterruption({
      stopReason: "error", httpStatus: 429, fatalFirst: true,
      errorMessage: "insufficient_quota: try again in 2h 36m",
    }).type, "RATE_LIMIT");
  });

  it("parses compound durations, duration-form reset headers, and epoch milliseconds", () => {
    const now = 1750000000000;
    const cases: Array<[Record<string, string> | undefined, string | undefined, number]> = [
      [undefined, "Try again in 2h 36m", 9360000],
      [undefined, "Please retry after 1.5 minutes", 90000],
      [undefined, "Wait 500ms", 500],
      [undefined, "Retry after 6m0s", 360000],
      [undefined, "Try again in 1h2m3.5s", 3723500],
      [{ "Retry-After": "1m 30s" }, undefined, 90000],
      [{ "x-ratelimit-reset-requests": "6m0s" }, undefined, 360000],
      [{ "x-ratelimit-reset-tokens": "500ms" }, undefined, 500],
      [{ "x-ratelimit-reset": String(now + 15000) }, undefined, 15000],
      [{ "retry-after": "20", "retry-after-ms": "500" }, undefined, 500],
    ];
    for (const [headers, text, expected] of cases) {
      const info = extractRetryAfterInfo(headers, text, now);
      assert.equal(info.delayMs, expected, JSON.stringify({ headers, text }));
      assert.equal(info.expectedResetTime, now + expected);
    }
  });

  it("waits for the latest request/token reset or inline hint, independent of header order", () => {
    const now = 1750000000000;
    for (const headers of [
      { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" },
      { "x-ratelimit-reset-tokens": "6m0s", "x-ratelimit-reset-requests": "1s" },
    ]) {
      assert.deepEqual(extractRetryAfterInfo(headers, "TPM limit exceeded", now), {
        delayMs: 360000, expectedResetTime: now + 360000, hasHeader: true,
      });
      assert.deepEqual(extractRetryAfterInfo(headers, "TPM limit exceeded. Try again in 7m30s", now), {
        delayMs: 450000, expectedResetTime: now + 450000, hasHeader: false,
      });
    }
    const info = extractRetryAfterInfo({ "retry-after": "2" }, "Retry after 3s; tokens reset in 5s", now);
    assert.equal(info.delayMs, 5000);
    assert.equal(info.hasHeader, false);
    assert.equal(extractRetryAfterDelay({ "retry-after-ms": "500", "x-ratelimit-reset-tokens": "6m0s" }), 360000);
  });

  it("does not replace an explicit reset with a full rolling-window estimate", () => {
    const info = extractRetryAfterInfo({ "retry-after": "2" }, "8 requests within 1 minute", 1000);
    assert.equal(info.delayMs, 2000);
    assert.equal(info.isWindowEstimate, undefined);
  });

  it("rejects malformed or overflowing headers rather than parsing a numeric prefix", () => {
    for (const value of ["-1", "10garbage", "Infinity", "1e100", "9".repeat(400)]) {
      assert.equal(extractRetryAfterDelay({ "retry-after": value }), null, value);
      assert.equal(extractRetryAfterDelay({ "retry-after-ms": value }), null, value);
      assert.equal(extractRetryAfterDelay({ "x-ratelimit-reset": value }), null, value);
    }
  });

  it("does not read the year of an ISO retry timestamp as seconds", () => {
    const target = Date.parse("2026-09-01T14:30:00Z");
    const info = extractRetryAfterInfo(undefined, "Retry after 2026-09-01T14:30:00Z", target - 60000);
    assert.equal(info.delayMs, 60000);
    assert.equal(info.expectedResetTime, target);
  });

  it("only infers rolling windows tied to requests or tokens", () => {
    for (const text of ["fetch failed within 30 seconds", "processing latency limit of 20 seconds", "cost is $5 per 1 day"]) {
      assert.equal(extractRetryAfterDelay(undefined, text), null, text);
    }
    const info = extractRetryAfterInfo(undefined, "20 tokens every 2 seconds", 1000, Infinity);
    assert.equal(info.delayMs, 2300);
    assert.equal(info.isWindowEstimate, true);
  });
});
