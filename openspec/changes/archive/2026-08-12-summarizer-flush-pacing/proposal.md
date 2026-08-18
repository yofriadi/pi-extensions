# Proposal: summarizer-flush-pacing

## Why

A budget auto-flush drains the whole backlog in one burst. With `pruneOn: "on-demand"` + `autoBudgetThreshold`, nothing summarizes until the window fills, and then `summarizeBatches` fires **every** queued batch at once through an unbounded `Promise.all` (src/summarizer.ts:422). An observed flush wrote 34 batch summaries inside the same minute, and a quota-limited summarizer (Antigravity / Cloud Code Assist) answered `Cloud Code Assist API error (429): Resource has been exhausted`; the provider's own 429 backoff sleeps emit no stream events, so `summarizerIdleTimeoutMs` also aborts calls as `stalled (no output for Ns)`. Both land in the same transient bucket, so one self-inflicted burst flips the configured summarizer into sticky fallback for the whole cooldown and the rest of the flush is summarized by the session model — exactly the model a separate `summarizerModel` exists to spare.

Fixing this by switching to `pruneOn: "agent-message"` is not acceptable: that flushes every turn even when the context window is nearly empty. A large, infrequent flush is the intended shape, so the flush has to be paced instead of stampeding.

## What Changes

- New config `contextPrune.summarizerConcurrency`: max summarizer LLM calls in flight for one `summarizeBatches` fan-out. Default `4`; `0` = unbounded (today's behavior). **BREAKING (behavioral default)**: a parallel flush of N non-trivial batches previously issued N simultaneous calls.
- `summarizeBatches` runs a fixed-size worker pool instead of `Promise.all`. Results stay index-aligned with the input array, per-batch progress callbacks keep their current `(index, total)` semantics, and an abort still rejects the fan-out — with unstarted batches never started.
- Rate-limit-shaped failures (HTTP 429, `resource has been exhausted`, quota/rate-limit/overloaded wording, `Server requested Ns retry delay`) are retried **in place on the same model** with bounded backoff before being classified transient, so a quota burst no longer trips the outage fallback at all. Attempt count, backoff base, and the maximum wait are internal constants (same precedent as `COOLDOWN_MS`).
- A per-fan-out rate-limit gate: the first call that gets rate-limited parks the whole pool for its backoff window, instead of every worker independently retrying into the same quota wall.
- Pacing is silent — no new notifications. A server-requested delay longer than the internal wait ceiling is not waited out; it is reported as transient immediately so the existing fallback path can take over.
- The retry sequence stays inside the summarizer-model call path (`runOnce`), so the fallback controller, its notify texts, and tier logic are untouched.

## Capabilities

### New Capabilities
- `summarizer-pacing`: bounded summarizer fan-out per flush, in-place rate-limit retry with a shared backoff gate, and the concurrency config surface.

### Modified Capabilities
<!-- none — no existing openspec specs; the sibling `summarizer-fallback` change is deliberately not touched -->

## Impact

- `src/types.ts` — `ContextPruneConfig` + `DEFAULT_CONFIG` gain `summarizerConcurrency`; new `SUMMARIZER_CONCURRENCY_PRESETS`; `SummarizeBatchOptions` gains an optional rate-limit gate.
- `src/config.ts` — settings merge/validation for the new key.
- `src/summarizer.ts` — worker-pool fan-out in `summarizeBatches`; `runOnce` split into a single-attempt function plus a rate-limit retry loop; rate-limit classification + delay parsing; `RateLimitGate`.
- `src/commands.ts` — `/pruner` settings overlay row + description for `summarizerConcurrency`.
- Tests — new pacing tests (pool bound, index alignment, abort, retry/gate behavior) reusing the fake-provider harness in `src/summarizer-wiring.test.ts`.
- Docs — `README.md`, `doc/configuration.md`, `PRUNING.md` (flush pacing + new key).
- No change to emitted events, session entry types, `cost:external` payload, fallback controller behavior, or notify wording.
- Overlap: the in-flight `summarizer-fallback-model` change also edits `runOnce`'s parameter list (thinking level) and `runSummarization`; the two are independent in intent, so whichever lands second reconciles the shared call sites.
