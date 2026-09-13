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
      assert.equal(info.expectedResetTime, now + 69000);
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
});
