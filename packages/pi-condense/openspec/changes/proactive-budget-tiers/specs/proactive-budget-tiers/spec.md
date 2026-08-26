## ADDED Requirements

### Requirement: Proactive budget tier configuration
The extension SHALL support `contextPrune.proactiveBudgetTiers` (an array of fractions in `(0, 1]`, default `[]` meaning disabled) and `contextPrune.proactiveBatchLimit` (an integer ≥ 1, default `4`) in `settings.json`. Fractional batch limits SHALL be floored. Invalid tier entries (non-numeric, non-finite, out of range) SHALL be dropped during normalization, the tier list SHALL be deduplicated and sorted ascending, and the dropped entries SHALL be returned to the caller out-of-band (NOT as a field on the persisted config object) and surfaced as one warning notification per session start. The `/pruner` settings overlay SHALL expose both keys, and `/pruner status` SHALL show the configured tiers and batch limit, plus a hint when tiers are configured while `autoBudgetThreshold` is null.

#### Scenario: Default is off
- **WHEN** `contextPrune` omits `proactiveBudgetTiers`
- **THEN** the effective tier list is empty and no proactive flush ever fires

#### Scenario: Invalid entries are dropped, not fatal
- **WHEN** `proactiveBudgetTiers` is `[0.5, "0.7", 1.5, 0.5]`
- **THEN** the effective tier list is `[0.5]`, one warning is shown at that session start, config loading succeeds, and a subsequent `saveConfig` writes only the normalized tier list

#### Scenario: Batch limit validation
- **WHEN** `proactiveBatchLimit` is `2.9`
- **THEN** the effective limit is `2`
- **WHEN** `proactiveBatchLimit` is `0`, negative, or non-numeric
- **THEN** the effective limit is the default `4`

### Requirement: Bounded oldest-first tier flushes at safe boundaries
When the tier list is non-empty, the extension SHALL evaluate tiers at the existing `turn_end` budget gate, comparing the usage fraction `tokens / min(contextWindow, MAX_BUDGET_WINDOW)` against each tier (the same normalized-fraction space as `usageFraction`; on windows above 300k a tier therefore addresses a smaller share of the advertised window). Evaluation inherits the gate's existing preconditions: a text-only turn without rearmed pending work, or a turn whose captured batch trims to empty without a rearm, performs no tier evaluation. When the fraction reaches a not-yet-fired tier, the extension SHALL summarize at most `proactiveBatchLimit` of the OLDEST eligible pending batches through the normal flush pipeline (dedup, trivial filter, summarizer pool, indexer, frontier advance, persistence), and the batches beyond the limit SHALL remain in the in-memory pending queue — a tier flush MUST NOT silently drop its untaken tail. Tier flushes SHALL skip the chain-compression phase, SHALL NOT mutate the active context beyond the existing next-request `context`-hook behavior, SHALL respect `isFlushing` and null-tokens guards exactly like the budget threshold, and SHALL remain independent of `pruneOn`. A tier flush SHALL NOT fire on a boundary where the budget/delta flush fires; the threshold flush wins and drains everything. A successful full drain (any trigger: threshold, delta, message-end, manual, rearmed) SHALL NOT blanket-reset the tier cursor to 0; it SHALL recompute the cursor from the current usage fraction so already-exceeded tiers stay fired until a genuine usage dip re-arms them.

#### Scenario: Tier fires with a bounded drain
- **WHEN** tiers are `[0.5]` with limit `3`, usage crosses 50% of the effective window, and 10 batches are pending
- **THEN** exactly the oldest 3 batches are summarized and persisted, the other 7 stay in the pending queue (visible to the next boundary's guard, the budget-flush notification count, and `agent_end`), and the flush-metrics entry records trigger `"proactive"` with `tier: 0.5`

#### Scenario: Final threshold still drains everything
- **WHEN** tiers fired earlier and `autoBudgetThreshold` is later crossed
- **THEN** all remaining pending batches are flushed, regardless of `proactiveBatchLimit`

#### Scenario: Null usage is a no-op
- **WHEN** `getContextUsage()` reports `tokens: null` (post-compaction)
- **THEN** no tier evaluation occurs and tier state is unchanged

#### Scenario: Tier fires while flush in progress
- **WHEN** a tier level is crossed while another flush is running
- **THEN** the tier flush is skipped for that boundary (no concurrent flush), the tier's cursor does NOT advance, and a retry floor is recorded at the current fraction + 0.05 so the tier re-attempts only once usage climbs at least 0.05 of the effective window above the fraction at which it was blocked

#### Scenario: Multiple tiers due on one boundary
- **WHEN** usage jumps from below tier `0.5` to above tier `0.85` in a single gate evaluation with tiers `[0.5, 0.7, 0.85]`
- **THEN** only tier `0.5` fires on that boundary (draining at most `proactiveBatchLimit`), and tiers `0.7` and `0.85` fire on subsequent gate evaluations while usage remains due

#### Scenario: Threshold co-firing wins
- **WHEN** a turn's usage crosses both a configured tier and `autoBudgetThreshold`
- **THEN** only the threshold flush runs, draining all pending batches, and the tier cursor is recomputed from the current fraction (already-exceeded tiers stay fired)

### Requirement: Tier state hysteresis
The extension SHALL track per-session tier state such that each tier fires at most once per monotonic usage climb. The tier cursor SHALL advance only when the tier flush completes with a persisting or provably-empty metrics outcome (`summarized`, `skipped-oversized`, `skipped-deduped`, `skipped-trivial`, `empty`); on failure, stale-context, or abort the cursor SHALL NOT advance and a retry floor SHALL be set at the attempt fraction + 0.05 of the effective window — and likewise when a due tier is blocked by the `isFlushing` guard (no flush call is made, but the floor is still recorded). The retry floor SHALL be cleared whenever a tier re-arms. A tier SHALL re-arm only after measured usage falls below `max(0, tier − 0.10)` of the effective window (hysteresis as an internal constant; tiers ≤ 0.10 consequently re-arm only near zero usage). Re-arming SHALL only ever move the cursor to a LOWER index, never skip un-fired tiers (`cursor = min(cursor, rearmCursor(fraction, tiers))`). Tier state SHALL reset on `session_start` and `session_tree` and re-derive from the next gate evaluation; because `session_tree` fires on every branch navigation, a navigation at high usage with genuinely pending work MAY fire one tier per navigation, while already-summarized branches SHALL perform no summarizer calls.

#### Scenario: No retrigger while hovering
- **WHEN** usage crosses tier `0.5`, the tier fires, and usage then oscillates between 49% and 51% without dropping below 40% of the effective window
- **THEN** the tier does not fire again

#### Scenario: Re-arm after a real drop
- **WHEN** tier `0.5` has fired and usage later falls below 40% of the effective window, then climbs past 50% again
- **THEN** the tier fires once more (re-arm having cleared any retry floor left by a prior failed attempt)

#### Scenario: Reload re-derivation is idempotent
- **WHEN** a session reloads with only TRIVIAL captured work present (raw chars below `minBatchChars`, so the rescan rears the gate but the flush makes no LLM call), while usage is above a configured tier
- **THEN** the tier evaluates and fires, zero summarizer calls are made, the flush reports the `skipped-trivial` outcome, and the cursor advances

#### Scenario: Tier list change invalidates cursor
- **WHEN** tiers `[0.5, 0.7, 0.85]` are active with cursor `2` (0.5 and 0.7 fired), and the user changes the config to `[0.4, 0.6, 0.8]` mid-session
- **THEN** tier state is reset (or re-keyed by tier value) so the new tiers `0.4`/`0.6` are not silently treated as already fired

### Requirement: Tier flush observability
Flush-metrics entries for tier flushes SHALL use trigger `"proactive"` and SHALL include the fired tier fraction as an optional `tier` field; the drained count SHALL be reported through the existing `processedBatches` field (no duplicate field). All other trigger values and entry fields SHALL remain unchanged. Tier flushes SHALL update the footer/status widget but SHALL NOT emit the per-flush info notification used by budget/delta flushes; failure notifications from the flush pipeline itself are unaffected.

#### Scenario: Metrics record the tier
- **WHEN** a tier flush completes after draining 3 of 10 pending batches at tier `0.5`
- **THEN** the emitted `context-prune-flush-metrics` entry has `trigger: "proactive"`, `tier: 0.5`, and `processedBatches: 3`, and no per-flush info notification is emitted

#### Scenario: Non-tier entries are unchanged
- **WHEN** a budget, delta, message-end, manual, or rearmed flush completes
- **THEN** its metrics entry has no `tier` field and its existing trigger, fields, and notification behavior are unchanged
