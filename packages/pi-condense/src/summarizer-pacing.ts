/**
 * Rate-limit pacing primitives for the summarizer fan-out.
 *
 * pi-ai surfaces no structured status code on a failed stream call - only an
 * error message (thrown, or `errorMessage` on a `stopReason: "error"` result)
 * - so rate-limit detection is string-shaped and provider-agnostic by design.
 * A detected rate limit is retried in place on the same model by `runOnce`
 * (src/summarizer.ts); a per-fan-out RateLimitGate parks the whole worker pool
 * for the backoff window so N workers don't retry into the same quota wall.
 *
 * The constants are internal (COOLDOWN_MS precedent) and overridable only
 * through the `pacing` test seam on SummarizeBatchOptions.
 */

/** Extra attempts after the first rate-limit-shaped failure. */
export const RATE_LIMIT_RETRIES = 2;
/** Base of the exponential backoff in ms (doubles per attempt). */
export const RATE_LIMIT_BASE_DELAY_MS = 2000;
/** Per-wait cap in ms. A parsed server delay above this is not waited out. */
export const RATE_LIMIT_MAX_WAIT_MS = 30000;

/**
 * Abort-aware sleep: resolves after `ms`, rejects early when `signal` aborts.
 * Rejection is intentional - callers treat it like any abort propagation.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const RATE_LIMIT_MARKERS = [
  "resource has been exhausted",
  "resource exhausted", // also covers gRPC RESOURCE_EXHAUSTED after separator normalization
  "rate limit",
  "too many requests",
  "quota",
  "overloaded",
];

/**
 * True when a failure message looks like provider rate limiting: the HTTP
 * status as a standalone token, one of the provider-agnostic markers, or a
 * parseable server retry-delay phrase. Matching is case-insensitive and treats
 * `_` / `-` as separators (so `RESOURCE_EXHAUSTED` and `rate-limit` match);
 * idle/ceiling timeout wording ("stalled", "exceeded ... ceiling")
 * intentionally matches nothing.
 */
export function isRateLimited(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[_-]+/g, " ");
  if (/\b429\b/.test(normalized)) return true;
  return RATE_LIMIT_MARKERS.some((marker) => normalized.includes(marker)) || parseRetryDelayMs(message) !== undefined;
}

/**
 * Extracts a server-requested retry delay in ms from common phrasings, or
 * undefined when none is parseable:
 *   - "Server requested 30s retry delay"
 *   - "retry in 500ms" / "retry in 5s"
 *   - `"retryDelay": "30s"` (Google API JSON details)
 *   - "quota will reset after 1h 2m 3s" (any h/m/s subset)
 */
export function parseRetryDelayMs(message: string): number | undefined {
  let match = /server requested\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?\s+retry delay/i.exec(message);
  if (match) return Number(match[1]) * 1000;

  match = /retry in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message);
  if (match) return match[2].toLowerCase() === "ms" ? Number(match[1]) : Number(match[1]) * 1000;

  match = /retryDelay["']?\s*:\s*["'](\d+(?:\.\d+)?)\s*s["']/i.exec(message);
  if (match) return Number(match[1]) * 1000;

  match = /quota will reset after\s+((?:\d+\s*h)?\s*(?:\d+\s*m)?\s*(?:\d+\s*s)?)/i.exec(message);
  if (match) {
    const span = match[1].toLowerCase();
    const hours = /(\d+)\s*h/.exec(span);
    const minutes = /(\d+)\s*m(?!s)/.exec(span);
    const seconds = /(\d+)\s*s/.exec(span);
    const total =
      (hours ? Number(hours[1]) * 3600_000 : 0) +
      (minutes ? Number(minutes[1]) * 60_000 : 0) +
      (seconds ? Number(seconds[1]) * 1000 : 0);
    if (total > 0) return total;
  }
  return undefined;
}

/**
 * Minimal per-fan-out rate-limit gate: a single `until` timestamp. `wait()`
 * resolves immediately when open and ends early on abort; `penalize()` only
 * ever extends the closed window. One gate per `summarizeBatches` call - not
 * session-global, so a later flush starts open (repeated outages are the
 * fallback controller's job).
 */
export class RateLimitGate {
  private until = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Resolves immediately when the gate is open; otherwise waits out the penalty. Rejects on abort. */
  async wait(signal?: AbortSignal): Promise<void> {
    // Loop: a penalize() landing while we sleep extends `until`, so the
    // remaining time must be recomputed after every wake.
    for (;;) {
      const remaining = this.until - this.now();
      if (remaining <= 0) return;
      await sleep(remaining, signal);
    }
  }

  /** Closes the gate for `ms` from now. Only ever extends, never shortens. */
  penalize(ms: number): void {
    this.until = Math.max(this.until, this.now() + ms);
  }
}
