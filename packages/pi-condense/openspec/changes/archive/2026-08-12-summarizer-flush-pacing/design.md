# Design: summarizer-flush-pacing

## Context

`summarizeBatches` (src/summarizer.ts:401) fans a flush out with `Promise.all(batches.map(...))` — one LLM call per non-trivial batch, all started in the same tick. `/pruner now` avoids this because `flushPending` takes a sequential branch when `onProgress` is set (index.ts:295-317); every other flush path, including the budget auto-flush (`shouldBudgetFlush` → `flushPending(ctx, { delivery: "session" })`), takes the parallel branch.

With `pruneOn: "on-demand"` the pending queue is not drained until the budget threshold fires, so the fan-out width equals the whole session backlog. Observed: 34 concurrent calls in one flush, answered by `Cloud Code Assist API error (429): Resource has been exhausted`. The Antigravity provider retries a 429 internally (up to 4 attempts, server-requested delay up to 60s) while emitting no stream events, so pi-condense's own idle timer (`summarizerIdleTimeoutMs`, armed in `runOnce`) aborts some calls as `stalled (no output for Ns)` mid-backoff. Both shapes reach `runSummarization` as `transient`, which immediately retries on the session model and flips `FallbackController` sticky for `COOLDOWN_MS` (10 min).

Constraint: pi-ai surfaces no structured status code on the throw — `runOnce` only sees an error message or `stopReason: "error"` plus `errorMessage`. Classification must be string-shaped and provider-agnostic.

## Goals / Non-Goals

**Goals:**
- Bound the number of in-flight summarizer calls per fan-out, configurable, with a safe default.
- Absorb a quota burst on the configured summarizer model instead of failing over to the session model.
- Keep pacing invisible: no new notifications, no change to fallback wording or tier logic.
- Keep the retry seam out of `runSummarization` so the sibling `summarizer-fallback-model` change stays independent.

**Non-Goals:**
- Retrying idle/ceiling timeouts in place. A stall is not evidence that waiting helps, and retrying it would multiply `summarizerMaxTimeoutMs`; the user already tunes that knob directly.
- Cross-flush or session-global pacing state (the fallback controller's cooldown already covers repeated outages).
- Capping how many batches a single flush may process (all queued batches still get summarized, just in waves).
- Changing the sequential `/pruner now` path, the fallback chain, notify texts, or cost accounting.
- Provider-specific quota knowledge (RPM tables, account rotation) inside pi-condense.

## Decisions

### D1: Fixed-size worker pool replaces `Promise.all`

`summarizeBatches` starts `min(concurrency, batches.length)` workers over a shared cursor; each worker pulls the next index, awaits `summarizeBatch`, and writes into a pre-sized `results` array. Index alignment with the input array is preserved by construction, so `flushPending`'s `nonTrivialIndices` zip is untouched, and `onBatchTextProgress(index, total, ...)` keeps reporting the batch's index within the array it was given.

`summarizerConcurrency: 0` means unbounded — one worker per batch, i.e. today's behavior. The existing short-circuits stay: `[]` for no batches, direct `summarizeBatch` delegation for exactly one.

Alternatives rejected: chunked waves (`for` over slices of N) — a slow batch stalls its whole wave, so throughput is worse for the same width; an external `p-limit` dependency — pi-condense ships no runtime dependencies; a semaphore inside `runOnce` — would also throttle the sequential `/pruner now` path and range summarization, which are already single-call.

### D2: Abort behavior of the pool

`runSummarization` re-throws on abort so `flushPending` can restore batches. The pool captures the first thrown error, stops handing out new indices, awaits the in-flight workers, then re-throws it. This differs from `Promise.all` (which rejects on the first rejection while siblings keep running): the rejection now surfaces once in-flight calls settle. That is bounded — those calls share the aborted signal and end promptly — and it removes the current window where a rejected fan-out leaves orphan streams running.

### D3: Rate-limit retry lives inside the model-call layer

`runOnce` is split:

- `runAttempt(...)` — today's body verbatim: one stream call with its own idle + ceiling timers, returning `RunOutcome`.
- `runOnce(...)` — a retry loop around `runAttempt` that re-attempts the **same model** while the outcome is rate-limit-shaped, then returns the final outcome.

`runSummarization`, `FallbackController`, and every notify string stay as they are: they see a `transient` only after in-place retries are exhausted. This placement is deliberate — the sibling `summarizer-fallback-model` change rewrites `runSummarization` and the controller, so keeping pacing below that seam limits the overlap to `runAttempt`'s parameter list.

Bounds (internal constants, `COOLDOWN_MS` precedent): `RATE_LIMIT_RETRIES = 2` extra attempts, `RATE_LIMIT_BASE_DELAY_MS = 2000` doubling per attempt, `RATE_LIMIT_MAX_WAIT_MS = 30000` per wait. No jitter — D5's gate coordinates a shared backoff window across the pool (workers can wake together, but not during a penalty window), and deterministic delays are testable. When `summarizerMaxTimeoutMs > 0`, the loop stops retrying once elapsed-plus-planned-wait would exceed it, so a rate-limit chain stays roughly inside the user's ceiling. Waits happen **outside** `runAttempt`, so each attempt arms fresh idle/ceiling timers and a wait is never mistaken for a stall.

Constants are exported and overridable through an optional internal `pacing` field on `SummarizeBatchOptions` (`{ retries, baseDelayMs, maxWaitMs, sleep, now }`), the same test-seam pattern as `FallbackController`'s injected `now` — otherwise a unit test would have to sit through real 2s backoffs.

### D4: Rate-limit classification and delay extraction

A failed attempt is rate-limit-shaped when its message matches any provider-agnostic marker: `429`, `resource has been exhausted` / `RESOURCE_EXHAUSTED`, `rate limit`, `too many requests`, `quota`, `overloaded`, or a `Server requested Ns retry delay` / `retry in Ns` / `quota will reset after ...` phrase. Matching is case-insensitive on both the thrown error message and `stopReason: "error"`'s `errorMessage`.

A parsed server delay wins over the exponential backoff when it fits under `RATE_LIMIT_MAX_WAIT_MS`. When it exceeds the cap the outcome is returned as `transient` immediately without waiting: a multi-minute quota reset is a real outage, and the existing fallback path is the right handler. Unclassified failures behave exactly as today (single attempt → `transient`), so a provider wording this design does not recognize degrades to current behavior rather than hanging.

`auth` and `unusable` outcomes are never retried in place — unchanged semantics.

### D5: Per-fan-out rate-limit gate

`summarizeBatches` creates one `RateLimitGate` and passes it to every `summarizeBatch` in that fan-out. `runOnce` awaits the gate before each attempt and, on a rate-limit-shaped failure, stamps it with the computed delay. So the first worker to hit the quota wall closes the gate for that window and every worker waits it out before its next attempt — they don't all spend their retry budget against the same wall during the penalty window (workers can wake together when the window opens, but the gate coordinates, not serializes, the retry admission).

The gate is intentionally minimal — a single `until` timestamp with an abort-aware `wait()` and a `penalize(ms)` that only ever extends it. It is per fan-out, not session-global: a later, unrelated flush should not inherit an old penalty, and repeated outages are already the fallback controller's job. The single-batch delegation path also gets a gate (one code path, no behavioral difference at width 1); the sequential `/pruner now` loop and `summarizeRange` pass none and rely on in-place retry alone.

### D6: Config surface and default

```jsonc
// ~/.pi/agent/settings.json
{ "contextPrune": { "summarizerConcurrency": 4 } }   // 0 = unbounded
```

Default `4`. A 34-batch flush then costs ~9 waves instead of one 34-wide burst: slower in wall-clock, but it keeps the configured summarizer model, which is the point of configuring one. `/pruner` overlay presets: `1`, `2`, `4 (default)`, `8`, `0 (unbounded)`, matching the string-cycling pattern of `SUMMARIZER_IDLE_TIMEOUT_PRESETS`. `src/config.ts` accepts a finite integer `>= 0` and falls back to the default otherwise, mirroring the timeout keys.

## Risks / Trade-offs

- [Large flushes take longer in wall-clock] → default keeps 4-way parallelism, and `0` restores unbounded fan-out for high-quota providers.
- [String-matched classification misses a provider's rate-limit wording] → that failure degrades to today's behavior (transient → fallback), never to a hang; markers are unit-tested and provider-agnostic.
- [In-place retry delays the fallback during a genuine outage] → capped at 2 extra attempts, each wait ≤ 30s, whole chain bounded by `summarizerMaxTimeoutMs`, and an over-cap server delay short-circuits immediately.
- [Gate parks healthy calls behind one quota hit] → bounded by the same per-wait cap; the alternative (independent per-call backoff) keeps N workers hammering the wall that just rejected them.
- [Retry hides a flapping provider from the fallback controller] → only rate-limit shapes are absorbed, and only up to the cap; anything beyond reaches the controller exactly as today.
- [Shared edits with `summarizer-fallback-model`] → overlap is confined to `runAttempt`/`runOnce` parameters; whichever change lands second reconciles those call sites.

## Migration Plan

Config-only addition. The single behavioral default change (fan-out width `N` → `4`) is announced in `CHANGELOG.md`; rollback is `"summarizerConcurrency": 0`. No session-state, entry-type, or spec migration.

## Open Questions

- None.
