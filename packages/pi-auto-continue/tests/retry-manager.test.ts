import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { RetryManager } from "../src/retry-manager.ts";

describe("RetryManager", () => {
  it("starts in an idle state", () => {
    const manager = new RetryManager();
    const state = manager.getState();
    assert.equal(state.isRetrying, false);
    assert.equal(state.startTime, null);
    assert.equal(state.attempt, 0);
  });

  it("calculates initial retry and advances attempts using global retry parameters", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 2000,
      backoffMultiplier: 2,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 2000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    const res1 = manager.evaluateRetry(config, "Rate limited", null, startTime);

    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);
    assert.equal(res1.delayMs, 2000);
    assert.equal(res1.elapsedMs, 0);
    assert.equal(res1.deadlineExceeded, false);

    // Second attempt 5 seconds later
    const res2 = manager.evaluateRetry(config, "Rate limited again", null, startTime + 5000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);
    assert.equal(res2.delayMs, 4000); // 2000 * 2^1 = 4000
    assert.equal(res2.elapsedMs, 5000);
  });

  it("respects explicit Retry-After delay on first attempt with baseDelay + reset time, and uses exponential backoff subsequently", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 5000,
      backoffMultiplier: 2,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 5000,
        jitter: false,
      },
    };

    // Attempt 1: baseDelay (5000) + expected reset time (15000) = 20000
    const res1 = manager.evaluateRetry(config, "Rate limited", 15000, 1000000);
    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);
    assert.equal(res1.delayMs, 20000);

    // Attempt 2: baseDelay * backoff = 5000 * 2 = 10000 (even if error hint repeats)
    const res2 = manager.evaluateRetry(config, "Rate limited again", 15000, 1020000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);
    assert.equal(res2.delayMs, 10000);

    // Attempt 3: baseDelay * backoff^2 = 5000 * 4 = 20000
    const res3 = manager.evaluateRetry(config, "Rate limited again", 15000, 1030000);
    assert.equal(res3.canRetry, true);
    assert.equal(res3.attempt, 3);
    assert.equal(res3.delayMs, 20000);
  });

  it("first attempt delay respects expected reset time even when greater than maxDelayMs", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 5000,
      maxDelayMs: 10000, // 10 seconds max delay for backoff
      backoffMultiplier: 2,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 5000,
        maxDelayMs: 10000,
        jitter: false,
      },
    };

    // Quota resets in 60s (> maxDelayMs of 10s)
    // Attempt 1: 5000 + 60000 = 65000 (respects quota reset time, not capped to 10000)
    const res1 = manager.evaluateRetry(config, "Rate limited", 60000, 1000000);
    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);
    assert.equal(res1.delayMs, 65000);

    // Attempt 2: baseDelay * backoff = 5000 * 2 = 10000
    const res2 = manager.evaluateRetry(config, "Rate limited again", null, 1065000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);
    assert.equal(res2.delayMs, 10000);

    // Attempt 3: 5000 * 4 = 20000, capped at maxDelayMs of 10000
    const res3 = manager.evaluateRetry(config, "Rate limited again", null, 1075000);
    assert.equal(res3.canRetry, true);
    assert.equal(res3.attempt, 3);
    assert.equal(res3.delayMs, 10000);
  });

  it("caps single delay to maxDelayMs", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 5000,
      maxDelayMs: 10000,
      maxRetries: 10,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 5000,
        maxDelayMs: 10000,
        maxRetries: 10,
        jitter: false,
      },
    };

    // Attempt 1 -> 5000
    manager.evaluateRetry(config, "Rate limited", null, 1000000);
    // Attempt 2 -> 10000
    manager.evaluateRetry(config, "Rate limited", null, 1005000);
    // Attempt 3 -> 20000 capped at 10000
    const res3 = manager.evaluateRetry(config, "Rate limited", null, 1015000);
    assert.equal(res3.delayMs, 10000);

    // Explicit delay above max is also capped
    const resExplicit = manager.evaluateRetry(config, "Rate limited", 999999, 1025000);
    assert.equal(resExplicit.delayMs, 10000);
  });

  it("enforces attempt-based retry limit (numeric maxRetries)", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      maxRetries: 2, // Allow 2 retries
      baseDelayMs: 1000,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetries: 2,
        baseDelayMs: 1000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Attempt 1
    const res1 = manager.evaluateRetry(config, "Rate limited", null, startTime);
    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);

    // Attempt 2
    const res2 = manager.evaluateRetry(config, "Rate limited", null, startTime + 2000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);

    // Attempt 3: limit of 2 attempts exceeded
    const res3 = manager.evaluateRetry(config, "Rate limited", null, startTime + 4000);
    assert.equal(res3.canRetry, false);
    assert.equal(res3.deadlineExceeded, true);
    assert.ok(res3.reason?.includes("Maximum retries limit of 2 attempt(s) exceeded"));
  });

  it("enforces duration-based deadline (string maxRetries e.g. 1m)", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      maxRetries: "1m", // 60,000 ms
      baseDelayMs: 5000,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetries: "1m",
        baseDelayMs: 5000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Attempt 1 at t=0s
    const res1 = manager.evaluateRetry(config, "Rate limited", null, startTime);
    assert.equal(res1.canRetry, true);

    // Attempt 2 at t=30s (within 60s deadline)
    const res2 = manager.evaluateRetry(config, "Rate limited", null, startTime + 30000);
    assert.equal(res2.canRetry, true);

    // Attempt 3 at t=60s (deadline expired)
    const res3 = manager.evaluateRetry(config, "Rate limited", null, startTime + 60000);
    assert.equal(res3.canRetry, false);
    assert.equal(res3.deadlineExceeded, true);
    assert.ok(res3.reason?.includes("Maximum retry duration of 1m exceeded"));

    // Attempt 4 at t=75s (past deadline)
    const res4 = manager.evaluateRetry(config, "Rate limited", null, startTime + 75000);
    assert.equal(res4.canRetry, false);
    assert.equal(res4.deadlineExceeded, true);
  });

  it("clamps delay so it does not exceed remaining retry duration when using duration limit", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      maxRetries: "30s", // 30s max
      baseDelayMs: 10000,
      backoffMultiplier: 2,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetries: "30s",
        baseDelayMs: 10000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Start at t=0
    manager.evaluateRetry(config, "Rate limit", null, startTime);

    // At t=25s, remaining time is 5s. Calculated delay would be 20s, but must clamp to 5s.
    const res = manager.evaluateRetry(config, "Rate limit", null, startTime + 25000);
    assert.equal(res.canRetry, true);
    assert.equal(res.remainingMs, 5000);
    assert.equal(res.delayMs, 5000);
  });

  it("allows rateLimit.maxRetries override while others use global maxRetries", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      maxRetries: 1, // global: 1 attempt
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetries: 3, // rate limit overridden to 3 attempts
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Rate limit attempt 1 -> allowed
    const r1 = manager.evaluateRetry(config, "429", null, startTime);
    assert.equal(r1.canRetry, true);
    assert.equal(r1.attempt, 1);

    // Rate limit attempt 2 -> allowed (under rateLimit limit of 3)
    const r2 = manager.evaluateRetry(config, "429", null, startTime + 2000);
    assert.equal(r2.canRetry, true);
    assert.equal(r2.attempt, 2);

    // Rate limit attempt 3 -> allowed
    const r3 = manager.evaluateRetry(config, "429", null, startTime + 4000);
    assert.equal(r3.canRetry, true);
    assert.equal(r3.attempt, 3);

    // Rate limit attempt 4 -> exceeded (3 attempts reached)
    const r4 = manager.evaluateRetry(config, "429", null, startTime + 6000);
    assert.equal(r4.canRetry, false);
    assert.equal(r4.deadlineExceeded, true);

    // Test token continuation on fresh manager uses global maxRetries: 1
    const tokenManager = new RetryManager();
    const t1 = tokenManager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated", startTime);
    assert.equal(t1.canRetry, true);
    assert.equal(t1.attempt, 1);

    // Second continuation exceeds global limit of 1
    const t2 = tokenManager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated 2", startTime + 2000);
    assert.equal(t2.canRetry, false);
    assert.equal(t2.deadlineExceeded, true);
  });

  it("defaults rateLimit.baseDelayMs to 1 minute (without falling back to global baseDelayMs)", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 3000, // global: 3s
      backoffMultiplier: 2,
      maxRetries: 5,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        jitter: false,
      },
    };

    // 1. Check getBaseDelay helper directly:
    // Rate limit defaults to 60,000 ms (1 minute), completely independent of global baseDelayMs (3000)
    assert.equal(manager.getBaseDelay(config, "RATE_LIMIT"), 60000);
    // Other interruption types (e.g. token limits) use global baseDelayMs (3000)
    assert.equal(manager.getBaseDelay(config, "TOKEN_LIMIT"), 3000);
    assert.equal(manager.getBaseDelay(config, "INCOMPLETE_TOOL_CALL"), 3000);

    // 2. Custom override via rateLimit.baseDelayMs
    const customConfig = {
      ...config,
      rateLimit: { ...config.rateLimit, baseDelayMs: 10000 },
    };
    assert.equal(manager.getBaseDelay(customConfig, "RATE_LIMIT"), 10000);

    // Also supports string format in rateLimit.baseDelayMs (e.g. "25s")
    const configWithStr = {
      ...config,
      rateLimit: { ...config.rateLimit, baseDelayMs: "25s" },
    };
    assert.equal(manager.getBaseDelay(configWithStr, "RATE_LIMIT"), 25000);

    // 3. Evaluate rate limit retry with default 1-minute base delay
    const now = 1000000;
    // Attempt 1 with expected reset time: delayMs = rateLimit.baseDelayMs (60000) + resetDelayMs (15000)
    const r1 = manager.evaluateRetry(config, "429 Rate limited", 15000, now);
    assert.equal(r1.canRetry, true);
    assert.equal(r1.delayMs, 60000 + 15000); // 75000

    // Attempt 2: exponential backoff = 60000 * 2^(2-1) = 120000
    const r2 = manager.evaluateRetry(config, "429 Rate limited", null, now + 75000);
    assert.equal(r2.canRetry, true);
    assert.equal(r2.delayMs, 120000);

    // 4. Token continuation uses global baseDelayMs (3000), not the 1m rate limit default
    const tokenManager = new RetryManager();
    const t1 = tokenManager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated", now);
    assert.equal(t1.canRetry, true);
    assert.equal(t1.delayMs, 3000);
  });

  it("defaults rateLimit.maxDelayMs to 10 minutes and rateLimit.maxRetries to 5h independently", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      maxDelayMs: 5000, // global: 5s
      maxRetries: 2, // global: 2 attempts
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        jitter: false,
      },
    };

    // 1. Checks helpers default independently without falling back to global settings
    assert.equal(manager.getMaxDelay(config, "RATE_LIMIT"), 600000); // 10m
    assert.equal(manager.getMaxDelay(config, "TOKEN_LIMIT"), 5000); // global
    assert.deepEqual(manager.getActiveLimit(config, "RATE_LIMIT"), { type: "duration", durationMs: 18000000 }); // 5h = 18,000,000 ms
    assert.deepEqual(manager.getActiveLimit(config, "TOKEN_LIMIT"), { type: "attempts", count: 2 }); // global

    // 2. Custom overrides
    const customConfig = {
      ...config,
      rateLimit: {
        ...config.rateLimit,
        maxDelayMs: "2m",
        maxRetries: "30m",
      },
    };
    assert.equal(manager.getMaxDelay(customConfig, "RATE_LIMIT"), 120000);
    assert.deepEqual(manager.getActiveLimit(customConfig, "RATE_LIMIT"), { type: "duration", durationMs: 1800000 });
  });

  it("resets state properly", () => {
    const manager = new RetryManager();
    manager.evaluateRetry(DEFAULT_CONFIG, "Error", null, 1000000);
    assert.equal(manager.getState().isRetrying, true);

    manager.reset();
    const state = manager.getState();
    assert.equal(state.isRetrying, false);
    assert.equal(state.startTime, null);
    assert.equal(state.attempt, 0);
  });

  it("returns human-readable status summary for attempt limit and duration limit", () => {
    const manager = new RetryManager();
    assert.equal(manager.getStatusSummary(DEFAULT_CONFIG), "Idle (no active retry loop)");

    // Attempt-based status summary
    const attemptConfig = {
      ...DEFAULT_CONFIG,
      rateLimit: { ...DEFAULT_CONFIG.rateLimit, maxRetries: 5 },
    };
    manager.evaluateRetry(attemptConfig, "HTTP 429 Quota Exceeded", null, 1000000);
    const summary = manager.getStatusSummary(attemptConfig, 1010000);
    assert.ok(summary.includes("Active Retry Loop:"));
    assert.ok(summary.includes("Attempt: 1 / Max: 5"));
    assert.ok(summary.includes("Remaining attempts: 4"));
    assert.ok(summary.includes("HTTP 429 Quota Exceeded"));
    assert.equal(summary.includes("Expected token reset time:"), false);

    // Duration-based status summary
    const durationConfig = {
      ...DEFAULT_CONFIG,
      rateLimit: { ...DEFAULT_CONFIG.rateLimit, maxRetries: "1h" },
    };
    const durManager = new RetryManager();
    durManager.evaluateRetry(durationConfig, "HTTP 429", 30000, 1000000, 1030000, true);
    const durSummary = durManager.getStatusSummary(durationConfig, 1010000);
    assert.ok(durSummary.includes("Attempt: 1"));
    assert.ok(durSummary.includes("Max: 1h"));
    assert.ok(durSummary.includes("Expected token reset time:"));

    // DEFAULT_CONFIG status summary defaults to 5h
    const defaultManager = new RetryManager();
    defaultManager.evaluateRetry(DEFAULT_CONFIG, "HTTP 429", null, 1000000);
    const defaultSummary = defaultManager.getStatusSummary(DEFAULT_CONFIG, 1010000);
    assert.ok(defaultSummary.includes("Max: 5h"));
  });

  it("evaluates continuation and advances attempts on shared retryState", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 3000,
      backoffMultiplier: 2,
      maxRetries: 5,
    };

    const startTime = 1000000;
    const res1 = manager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated", startTime);
    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);
    assert.equal(res1.delayMs, 3000);
    assert.equal(manager.getState().attempt, 1);
    assert.equal(manager.getState().lastInterruptionType, "TOKEN_LIMIT");

    // Second continuation
    const res2 = manager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated again", startTime + 4000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);
    assert.equal(res2.delayMs, 6000); // 3000 * 2^1
    assert.equal(manager.getState().attempt, 2);
  });

  it("consolidates rate limit retry and token continuation under the same attempt counter", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      baseDelayMs: 2000,
      backoffMultiplier: 2,
      maxRetries: 5,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Attempt 1: Token truncation
    const res1 = manager.evaluateContinuation(config, "TOKEN_LIMIT", "Length cutoff", startTime);
    assert.equal(res1.attempt, 1);
    assert.equal(manager.getState().attempt, 1);

    // Attempt 2: Provider hits rate limit during continuation
    const res2 = manager.evaluateRetry(config, "HTTP 429", null, startTime + 2000);
    assert.equal(res2.attempt, 2);
    assert.equal(manager.getState().attempt, 2);
    assert.equal(manager.getState().lastInterruptionType, "RATE_LIMIT");

    // Attempt 3: Another token truncation after recovering from rate limit
    const res3 = manager.evaluateContinuation(config, "TOKEN_LIMIT", "Length cutoff 2", startTime + 8000);
    assert.equal(res3.attempt, 3);
    assert.equal(manager.getState().attempt, 3);
    assert.equal(manager.getState().lastInterruptionType, "TOKEN_LIMIT");
  });

  it("decrements attempt count and resets retrying state when reaching 0", () => {
    const manager = new RetryManager();
    const config = { ...DEFAULT_CONFIG };

    manager.evaluateContinuation(config, "TOKEN_LIMIT", "Truncated", 1000000);
    assert.equal(manager.getState().attempt, 1);
    assert.equal(manager.getState().isRetrying, true);

    manager.decrementAttempt();
    assert.equal(manager.getState().attempt, 0);
    assert.equal(manager.getState().isRetrying, false);
    assert.equal(manager.getState().startTime, null);
  });

  describe("scheduleRetry", () => {
    it("schedules retry at specific target timestamp without capping to maxDelayMs", () => {
      const manager = new RetryManager();
      const config = {
        ...DEFAULT_CONFIG,
        maxDelayMs: 60000, // 1 min max standard delay
        maxRetries: "5h", // 5 hours max duration
      };

      const now = 1000000;
      const targetTimeMs = now + 7200000; // 2 hours in future

      const res = manager.scheduleRetry(config, targetTimeMs, now);

      assert.equal(res.canRetry, true);
      assert.equal(res.attempt, 1);
      assert.equal(res.delayMs, 7200000); // Preserves 2 hours, not capped at 60s
      assert.equal(res.deadlineExceeded, false);

      const state = manager.getState();
      assert.equal(state.isRetrying, true);
      assert.equal(state.attempt, 1);
      assert.equal(state.lastDelayMs, 7200000);
      assert.equal(state.expectedTokenResetTime, targetTimeMs);
      assert.equal(state.nextRetryTime, targetTimeMs);
      assert.equal(state.retryAfterHeaderReceived, true);
    });

    it("enforces duration deadline when target time exceeds max duration", () => {
      const manager = new RetryManager();
      const config = {
        ...DEFAULT_CONFIG,
        rateLimit: {
          ...DEFAULT_CONFIG.rateLimit,
          maxRetries: "1h", // 1 hour max duration
        },
      };

      const now = 1000000;
      const targetTimeMs = now + 7200000; // 2 hours in future (> 1h max)

      const res = manager.scheduleRetry(config, targetTimeMs, now);

      assert.equal(res.canRetry, false);
      assert.equal(res.deadlineExceeded, true);
      assert.ok(res.reason?.includes("exceeds maximum retry duration"));
    });

    it("increments attempt count if retry loop was already active", () => {
      const manager = new RetryManager();
      const config = { ...DEFAULT_CONFIG, maxRetries: 5 };

      const now = 1000000;
      // Attempt 1 from error
      manager.evaluateRetry(config, "HTTP 429", null, now);
      assert.equal(manager.getState().attempt, 1);

      // User schedules attempt 2 for later
      const targetTimeMs = now + 300000; // 5m later
      const res = manager.scheduleRetry(config, targetTimeMs, now + 1000);

      assert.equal(res.canRetry, true);
      assert.equal(res.attempt, 2);
      assert.equal(manager.getState().attempt, 2);
      assert.equal(res.delayMs, 299000);
    });
  });
});
