# Tasks: summarizer-flush-pacing

## 1. Config surface

- [x] 1.1 Add `summarizerConcurrency: number` to `ContextPruneConfig` (doc comment: max in-flight summarizer calls per fan-out, `0` = unbounded) and `DEFAULT_CONFIG` (`4`) in src/types.ts
- [x] 1.2 Add `SUMMARIZER_CONCURRENCY_PRESETS` (`"1"`, `"2"`, `"4"` labelled default, `"8"`, `"0"` labelled unbounded) in src/types.ts next to `SUMMARIZER_IDLE_TIMEOUT_PRESETS`
- [x] 1.3 Merge + validate the key in src/config.ts (finite integer `>= 0`, `Math.floor`, else `DEFAULT_CONFIG.summarizerConcurrency`), mirroring the `summarizerIdleTimeoutMs` branch
- [x] 1.4 Expose the row in the `/pruner` settings overlay in src/commands.ts: preset-cycling item + description helper (unbounded wording when the value is 0) + apply branch, following the `summarizerIdleTimeoutMs` item at src/commands.ts:584-592 and its apply branch at src/commands.ts:751-755

## 2. Rate-limit pacing primitives

- [x] 2.1 Add exported constants `RATE_LIMIT_RETRIES = 2`, `RATE_LIMIT_BASE_DELAY_MS = 2000`, `RATE_LIMIT_MAX_WAIT_MS = 30000` and an abort-aware `sleep(ms, signal)` helper in a new src/summarizer-pacing.ts
- [x] 2.2 Add `isRateLimited(message: string): boolean` in src/summarizer-pacing.ts — case-insensitive markers: `429`, `resource has been exhausted` / `RESOURCE_EXHAUSTED`, `rate limit`, `too many requests`, `quota`, `overloaded`
- [x] 2.3 Add `parseRetryDelayMs(message: string): number | undefined` in src/summarizer-pacing.ts — `Server requested Ns retry delay`, `retry in N[ms|s]`, `retryDelay": "N s"`, `quota will reset after <Nh Nm Ns>`
- [x] 2.4 Add `RateLimitGate` in src/summarizer-pacing.ts: single `until` timestamp, `wait(signal)` that resolves immediately when open and ends early on abort, `penalize(ms)` that only ever extends `until`; injectable `now`
- [x] 2.5 Add an internal `pacing` test seam to `SummarizeBatchOptions` in src/types.ts (`{ retries?, baseDelayMs?, maxWaitMs?, sleep?, now?, gate? }`, documented as a test/wiring seam like `FallbackController`'s injected `now`) and thread it through `SummarizeBatchesOptions`

## 3. Retry loop in the model-call layer

- [x] 3.1 Rename the current `runOnce` body to `runAttempt` in src/summarizer.ts (unchanged behavior: one stream call, own idle + ceiling timers, returns `RunOutcome`)
- [x] 3.2 Add a new `runOnce` wrapper: awaits `options.pacing?.gate?.wait(signal)` before each attempt, calls `runAttempt`, and on a rate-limit-shaped `transient` (via `isRateLimited`) computes the delay (`parseRetryDelayMs` when `<= maxWaitMs`, else exponential `baseDelayMs * 2 ** attempt` capped at `maxWaitMs`), penalizes the gate, sleeps outside the attempt timers, and retries the same model up to `retries` extra attempts
- [x] 3.3 Short-circuit rules in `runOnce`: a parsed server delay greater than `maxWaitMs` returns the `transient` without waiting; when `config.summarizerMaxTimeoutMs > 0` no retry starts whose planned wait would push elapsed time past the ceiling; `auth`, `unusable`, `ok`, and non-rate-limit `transient` outcomes return immediately; aborts propagate as today (no swallow, no retry)
- [x] 3.4 Confirm no notification is emitted from the retry path (all notify stays in `runSummarization`) and that `timedOut` transients are never treated as rate-limited

## 4. Bounded fan-out

- [x] 4.1 Replace `Promise.all(batches.map(...))` in `summarizeBatches` (src/summarizer.ts:422) with a worker pool: shared cursor, `min(width, batches.length)` workers (`width = config.summarizerConcurrency || batches.length`), pre-sized index-aligned `results` array, unchanged `onBatchTextProgress(index, batches.length, ...)` semantics
- [x] 4.2 Pool abort handling: capture the first thrown error, stop handing out indices, await in-flight workers, then re-throw the captured error
- [x] 4.3 Create one `RateLimitGate` per `summarizeBatches` call and pass it via the `pacing` seam to every `summarizeBatch` in that fan-out, including the single-batch delegation path; leave `summarizeRange` and the sequential `/pruner now` loop without a gate
- [x] 4.4 Update the `summarizeBatches` docstring (parallel-per-batch rationale) to state the bounded width and the shared gate

## 5. Tests

- [x] 5.1 New src/summarizer-pacing.test.ts unit tests: `isRateLimited` markers + negatives (idle-timeout and ceiling messages must not match), `parseRetryDelayMs` for each supported phrase and for absent/garbled input, `RateLimitGate` extend-only + open-immediately + abort-releases behavior
- [x] 5.2 New fan-out tests (fake provider harness copied from src/summarizer-wiring.test.ts `makeCtx`/`okStream`): peak in-flight count never exceeds the width for 10 batches at width 4; all batches summarized; index alignment under out-of-order completion; width 0 starts everything at once; width greater than batch count starts one call per batch
- [x] 5.3 New fan-out abort test: abort mid-fan-out stops queued batches, rejects with the abort error, and no queued batch is reported as a summarizer failure
- [x] 5.4 New retry tests with injected `pacing` (`sleep` stub, small delays): 429 on the first attempt then success returns the summary with no notify and no fallback call; all attempts rate-limited returns null with today's single error notify; server delay above the cap returns immediately without sleeping; `summarizerMaxTimeoutMs` budget stops a further retry; idle-timeout and unrecognized errors get exactly one attempt; `auth` and `unusable` are not retried
- [x] 5.5 New gate test: one rate-limited call in a fan-out defers the other calls' next attempt until the gate opens; a fresh `summarizeBatches` call starts with an open gate
- [x] 5.6 New config tests in src/config.test.ts: default, negative, non-numeric, non-finite, and fractional values for `summarizerConcurrency`

## 6. Docs

- [x] 6.1 Document `summarizerConcurrency` (default, `0` sentinel, why it exists) in README.md and doc/configuration.md settings tables
- [x] 6.2 Add a flush-pacing note to PRUNING.md: budget auto-flush width, in-place rate-limit retry, and how it interacts with outage fallback
- [x] 6.3 CHANGELOG.md entry flagging the behavioral default change (fan-out width `N` → `4`) and the `0` rollback value

## 7. Verify

- [x] 7.1 `bun test src/` green
- [x] 7.2 Typecheck: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
- [ ] 7.3 Smoke against the reported case: `summarizerModel: "google-antigravity/gemini-3.6-flash"`, `pruneOn: "on-demand"`, `autoBudgetThreshold: 0.9`, a backlog of 20+ batches — the flush completes on the configured model with no `failing, using session model` warning
