# Proposal: summarizer-fallback-model

## Why

Summarizer outage fallback today has two holes:

1. **No configurable fallback target.** On transient failure the summarizer retries once on the *session model* (`ctx.model`). When `summarizerModel: "default"` (the common case), primary IS the session model, `FallbackController.hasDistinctFallback` is false, and there is no fallback at all.
2. **Sticky entry on first error.** One transient blip flips the controller into fallback for up to a 10-minute cooldown, even when the primary recovers on the very next call. There is no tolerance for short blips.

## What Changes

- New config `contextPrune.summarizerFallbackModel` in `~/.pi/agent/settings.json`: a **middle fallback tier** between the primary and the session model. `"provider/model-id"` (resolved via `ctx.modelRegistry`, same syntax as `summarizerModel`) or `"default"` = no middle tier (today's behavior).
- Fallback chain becomes 3 tiers: `summarizerModel` → `summarizerFallbackModel` → session model (`ctx.model`). Identical tiers collapse (dedup). Per-call rescue walks the chain in order; first success wins, no batch lost.
- New config `contextPrune.summarizerFallbackThinking`: thinking level applied to all non-primary tiers, independent of `summarizerThinking` (fallback models may support a different reasoning level). Same enum as `summarizerThinking`.
- New retry policy: each non-final tier must fail transiently **3 consecutive times** before being marked down (skipped, re-probed per existing 10-min cooldown). The floor tier (last of the deduped chain) is never marked down. Below the threshold each failed call still walks the rescue chain, so no batch summary is lost to a blip.
- Per-call failure counting is strict per tier: a transient failure increments that tier's counter even when a lower tier rescues the call (counter measures tier health, not batch loss). Any success on a tier resets its counter.
- Threshold is an internal constant (3), not configurable — same precedent as `COOLDOWN_MS`.

## Capabilities

### New Capabilities
- `summarizer-fallback`: 3-tier fallback chain with configurable middle model, independent fallback thinking level, and per-tier 3-failure threshold for marking a tier down.

### Modified Capabilities
<!-- none - no existing openspec specs -->

## Impact

- `src/types.ts` — `ContextPruneConfig` + `DEFAULT_CONFIG` gain `summarizerFallbackModel`, `summarizerFallbackThinking`.
- `src/config.ts` — settings merge for both new keys.
- `src/summarizer.ts` — `resolveFallbackModel()`, tier-chain construction + dedup, per-call rescue walk across tiers, per-target thinking selection; **BREAKING (internal exported API)**: `summarizerThinkingOptions(config, model)` → `summarizerThinkingOptions(level, model)`.
- `src/summarizer-fallback.ts` — generalize from single boolean `inFallback` to per-tier state (consecutive-failure counter, down flag, probe cooldown), threshold constant, `reset()` zeroes all tier state.
- `src/commands.ts` — `/pruner` settings overlay exposes both new keys.
- Tests — `src/summarizer.test.ts` (signature call sites), `src/summarizer-fallback.test.ts`, `src/summarizer-wiring.test.ts` (threshold injection).
- Docs — `README.md`, `doc/configuration.md`, `PRUNING.md`, `doc/specs/2026-07-06-summarizer-outage-fallback.md` (threshold semantics change).
- No changes to emitted events, session entry types, or the `cost:external` payload.
