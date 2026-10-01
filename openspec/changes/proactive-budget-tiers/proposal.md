## Why

The current token-budget auto-flush is a single high-water mark: by the time `autoBudgetThreshold` fires, the session may have accumulated a large backlog of unsummarized tool calls, so the flush spends a long time in the summarizer fan-out exactly when the user is already under context pressure. `/pruner now` has the same backlog problem and additionally serializes LLM calls to drive its progress overlay, making a manual rescue flush slower than the parallel automatic path. Both problems come from deferring all summarization work to one late, unbounded-in-backlog flush.

## What Changes

- Add proactive budget tiers: ordered usage fractions in `(0, 1]` of the CAPPED effective window `min(contextWindow, 300k)` (e.g. `[0.5, 0.7, 0.85]`) that each summarize a bounded number of the oldest eligible pending batches at safe turn boundaries, so the final `autoBudgetThreshold` flush only handles a small tail.
- Tier flushes summarize, index, and persist exactly like existing flushes — no early active-context mutation; the existing `context` hook applies stubs on the next request as it does today.
- Track tier state per session with hysteresis (re-arm a tier only after usage drops materially below it) so hovering near a level cannot retrigger it.
- Add `contextPrune.proactiveBudgetTiers` (fraction list in `(0, 1]`, empty = off, default off) and `contextPrune.proactiveBatchLimit` (integer ≥ 1, default 4) to config, the settings overlay, and `/pruner status` output.
- Parallelize the `/pruner now` manual flush through the existing `summarizerConcurrency` worker pool while keeping per-row widget progress, instead of the current strictly sequential loop.
- Record tier flushes in flush-metrics with a distinct trigger (e.g. `proactive`) plus the tier and drained count, keeping observability consistent with existing triggers.

## Capabilities

### New Capabilities
- `proactive-budget-tiers`: Staged, bounded summarization of pending tool-result batches at configurable context-usage tiers below the final auto-flush threshold, including tier state/hysteresis, configuration surface, and flush-metrics observability.
- `manual-flush-parallelism`: Worker-pool execution of the `/pruner now` manual flush honoring `summarizerConcurrency`, while preserving per-row progress reporting and existing skip/dedup/frontier semantics.

     Use existing spec names from openspec/specs/. Leave empty if no requirement changes. -->
- `summarizer-pacing`: the "Shared rate-limit gate per fan-out" requirement states the sequential `/pruner now` loop works without a gate; this change deletes that loop, so the requirement is MODIFIED to reflect that `/pruner now` now runs inside a fan-out with a gate (only range summarization remains gate-less).

## Impact

- `src/types.ts` — new config keys (`proactiveBudgetTiers`, `proactiveBatchLimit`), presets, defaults, and a new `FlushTrigger` value.
- `src/config.ts` — normalization/validation for the new keys (tier fractions in `(0,1]`; batch limit an integer ≥ 1, with `0`/invalid falling back to the default).
- `index.ts` — tier evaluation at the existing turn_end budget gate, tier state tracking, bounded oldest-first flush path, and a parallelizable manual flush path.
- `src/commands.ts` — settings overlay rows, `/pruner status` lines, and the `/pruner now` parallel progress wiring.
- `src/budget.ts` — shared effective-window helpers reused for tier levels (no change to `MAX_BUDGET_WINDOW` semantics).
- Tests — new config tests, tier/hysteresis lifecycle tests extending the reload-rearm harness style, and summarizer fan-out progress tests reusing the pacing harness.
- Docs — `README.md`, `doc/configuration.md`, `PRUNING.md` sections for proactive tiers and parallel manual flush.
- No changes to emitted session entry types other than flush-metrics payload fields; no new dependencies; no breaking changes (feature is off by default).
