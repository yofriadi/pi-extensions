## Context

pi-condense's `turn_end` gate evaluates three context-pressure triggers, OR-ed together in `index.ts`: `autoBudgetThreshold` (a single level, `min(300k, threshold × contextWindow)`, see `MAX_BUDGET_WINDOW` in `src/budget.ts`), `budgetTurnDelta` (per-turn jump), and the opt-in absolute `frontierGapThresholdTokens` upstream added in v2.10.0. The notification reason prefers budget, then delta, then gap.

**Base note (rebased onto upstream v2.11.2).** This change was written against the v2.9.0 base, which had only `autoBudgetThreshold`. Proactive tiers are still distinct from the frontier-gap trigger — tiers are fractional levels of the capped window with hysteresis and a bounded oldest-first drain, while `frontierGapThresholdTokens` is one opt-in absolute measure of the un-pruned tail — but the tier block is now a *fourth* trigger, and its ordering against a frontier-gap flush that is due on the same turn must be stated explicitly (see Decision 3 and task 2.4) instead of inherited from a two-trigger world. With `pruneOn: "on-demand"` nothing summarizes until that level fires, so the flush drains the entire session backlog in one fan-out — the documented 34-simultaneous-calls incident that motivated `summarizerConcurrency` (archived `summarizer-flush-pacing` change). Even bounded to 4 workers, a large backlog makes the budget flush slow at the worst moment, and `/pruner now` is worse: it passes `onProgress` and therefore processes batches strictly sequentially (`index.ts:410-432`) to drive the widget rows.

The pipeline already has the right shape for spreading work: flushing summarizes + indexes + persists, while active-context stubbing happens later in the `context` hook. So "summarize early, apply later" is the existing behavior — proactive tiers only move the *summarization* earlier, in bounded slices, without changing how or when context is rewritten.

Constraints:
- No new runtime dependencies; worker pool and rate-limit gate already exist (`src/summarizer.ts`, `src/summarizer-pacing.ts`).
- Summarization must only happen at safe boundaries (completed turns), never from the `context` hook (recursion risk: the summarizer is itself an LLM call).
- Effective-window semantics (`min(contextWindow, MAX_BUDGET_WINDOW)`) must be shared with the existing threshold/delta triggers, not duplicated.
- Session state must survive reloads: `session_start`/`session_tree` already rescan the branch and set `rearmedPending`.

## Goals / Non-Goals

**Goals:**
- Spread summarization across configurable usage tiers so the final auto-flush (or manual flush) only handles a small tail.
- Bound the work each tier performs (oldest-first, `proactiveBatchLimit` batches), so a tier flush is a small, fast fan-out.
- Hysteresis so hovering at a level cannot retrigger a tier in a loop.
- Make `/pruner now` use the `summarizerConcurrency` pool while keeping the multi-row progress widget live.
- Full observability: flush-metrics record tier flushes with trigger `"proactive"` plus tier level and drained count; `/pruner status` shows tier config and last-fired tier.

**Non-Goals:**
- No early active-context mutation: tiers never force the `context` hook's hand; stub application stays on the next-request path exactly as today.
- No change to `MAX_BUDGET_WINDOW` (300k) semantics or to `budgetTurnDelta`.
- No mid-turn or `context`-hook summarization (preflight/prune-before-send is a separate, riskier feature).
- No summarizer model/fallback changes (owned by the active `summarizer-fallback-model` change).
- Not making proactive tiers the default; the feature is off unless configured.

## Decisions

### Decision 1: Tiers are fractions of the CAPPED window, evaluated at the existing turn_end gate

Tier firing uses the same normalized-fraction space as `usageFraction()` and `budgetTurnDelta`:

```
fraction = tokens / min(contextWindow, MAX_BUDGET_WINDOW)
fire tier t when fraction >= t
```

Deliberately NOT the `shouldBudgetFlush` level shape (`min(300k, t × window)`): for an absolute level the cap bounds the level, but tiers are *positions on a climb* and must stay ordered and evenly spaced, which only the capped-denominator fraction gives. Consequence, documented for users: on windows above 300k the tiers address a smaller share of the advertised window — on a 1M model, tier `0.5` is 150k tokens, i.e. 15% of the advertised window. This matches the existing delta trigger's semantics and keeps one fraction-space helper for both.

Evaluation lives inside the existing `turn_end` budget block (after `ctx.getContextUsage()`), sharing the null-tokens and `isFlushing` guards — and inheriting that gate's preconditions: a text-only turn with `rearmedPending == false`, or a turn whose captured batch trims to empty without a rearm, never evaluates tiers. The contract is "at safe turn boundaries where the gate runs", not "every turn"; the specs say so explicitly. Alternatives considered: a separate event handler (duplicates the guards and ordering rules); evaluation in `message_end` (never fires in `on-demand` mode and is too late in the turn lifecycle for tool-result capture).

### Decision 2: Tier flushes drain the OLDEST N batches, not all pending

To keep this bounded without restructuring `flushPending`, the flush gains a `batchLimit` option. Placement matters: `flushPending` captures into a local `batches` array, then DRAINS the shared queue with `pendingBatches.length = 0` (`index.ts:311`) after the empty and abort early-returns. So the truncation/restoration must happen **after that drain line**, not "immediately after capture": truncate the local `batches` to the oldest N, then `restoreBatches(tail)` (which unshifts) so the tail is re-queued onto the now-empty `pendingBatches`. Restoring before the drain would be wiped by the drain; restoring before the abort early-return would duplicate the tail (the queue still holds the originals there). `capturedBatches` is recorded at `index.ts:295` BEFORE the limit, so it stays the full rescan+trim count (matching its doc "batches after rescan+trim, before processing") — only the processed slice is bounded. Ordering with the later failure-restore is chronological (`restoreBatches` unshifts, so `[failed head…, tail…]`). The final `autoBudgetThreshold` path and `/pruner now` pass no limit and keep full-drain semantics. Failed batches are restored as today; restored batches are eligible at the next tier.

Bounded means bounded at the *summarization* layer. A tier flush skips the chain-compression tail (`compressEligible` / range fusion): compression runs on message-end, budget, delta, and manual flushes, not on tiers — otherwise up to three tier flushes per climb would triple compression frequency and per-tier cost would be unbounded in chain count. The tier option carries this as `skipChainCompression: true` internally.

`batchingMode: "agent-message"` caveat (applies to all tier flushes): grouping merges a whole user→final-assistant span into one batch, so `batchLimit: 4` can still cover a large span-heavy backlog. Tiers bound the NUMBER of summarizer calls, not their individual size — documented as a known interaction; no special-casing in v1.

### Decision 3: Tier state with hysteresis, session-scoped, reconstructed on reload

State: `tierCursor` (index of the next not-yet-fired tier). A tier fires when `usageFraction(usage)` reaches it and it is at or past the cursor. **Fire-one-per-boundary**: when several tiers are due at once (a big jump, or reload above multiple tiers), only the *lowest* due tier fires; the cursor advances by one, and higher due tiers fire on subsequent boundaries. This keeps one tier per metrics entry, bounds per-turn work to one `batchLimit` slice, and avoids a 3×-limit triple drain on a single jump.

The cursor advances **only on a flush whose outcome persists something or proves nothing pending** (`summarized`, `skipped-*`, `empty`). On `summarizer-failed`/`stale-context`/`aborted`/`already-flushing` the cursor does NOT advance — the tier stays eligible, but the attempt records a retry floor at `currentFraction + 0.05` (half the hysteresis margin): a genuine usage climb re-triggers the tier, a flat line does not retry a failing fan-out on every tool turn.

Re-arm: a tier re-arms when usage drops below `max(0, tier − HYSTERESIS)` with `HYSTERESIS = 0.10` in fraction space (30k tokens at the 300k cap, proportionally less below it — an internal constant like `MAX_BUDGET_WINDOW`). Tiers ≤ 0.10 re-arm only near zero — acceptable: they exist for early-start draining, and the spec notes it. Tiers spaced closer than 0.10 have overlapping re-arm windows — documented, not rejected.

Ordering vs the other `turn_end` triggers: the tier block runs **only when the budget, delta, and frontier-gap flushes did not fire this turn** (else-if, in that precedence). The final threshold always wins and drains everything; a tier configured at/above `autoBudgetThreshold` degenerates to plain threshold behavior with no double flush. On a successful full drain the tier cursor is NOT blanket-reset to 0 (that would let `message_end` full-drains at high usage re-fire low tiers every cycle); instead the cursor is recomputed via `rearmCursor(currentFraction, tiers)` so already-exceeded tiers stay fired until a genuine usage dip re-arms them.

On `session_start`/`session_tree` the cursor resets and re-derives from the next gate evaluation. Idempotency comes from the indexer/frontier (already-summarized calls trim out), but tree navigation at high usage with genuinely pending work CAN fire one tier per navigation — accepted (a fresh branch may need draining) and spec'd explicitly, not framed as a no-op.

Hysteresis is a fraction constant, not config: one more knob is not worth the settings surface; 10 points mirrors the cadence between default tiers. Alternatives considered: cooldown turns (time-based, misfires in long turns); one-shot per session (a session that dips and regrows loses protection).

### Decision 4: Config shape — explicit fraction list + bounded limit, both defaulting to safe values

```jsonc
{ "contextPrune": { "proactiveBudgetTiers": [0.5, 0.7, 0.85], "proactiveBatchLimit": 4 } }
```

`proactiveBudgetTiers` default `[]` (off — no behavior change on upgrade). Validation: each entry must be a finite number in `(0, 1]`; invalid entries are dropped; the list is deduplicated and sorted ascending at normalize time. `proactiveBatchLimit` is a finite integer ≥ 1, floored, default 4 (matching `summarizerConcurrency`'s default cadence); `0` is rejected to default because a zero limit is indistinguishable from off. Tiers above or equal to `autoBudgetThreshold` are harmless but pointless — documented, not rejected (the threshold is itself nullable, so cross-validation would be order-dependent).

Overlay: presets for common tier sets (`off`, `0.5`, `0.5/0.7/0.85`, `0.4/0.6/0.8`) plus a limit cycler (`1`, `2`, `4`, `8`). Alternative considered: a single string like `"0.5,0.7"` — rejected; JSON arrays are native in settings.json and normalize cleanly.

### Decision 5: `/pruner now` goes through the worker pool — keeping the start/done callback

The manual path drops its special sequential loop and calls the same `summarizeBatches` pool used by automatic flushes. Crucially, `onProgress` is NOT removed: it stays as the start/done row-transition signal. But note `summarizeBatches` / `SummarizeBatchesOptions` currently accept ONLY `onBatchTextProgress` (`src/types.ts:919-921`) — there is no `onProgress` on the pool today. So this change REQUIRES adding an optional `onProgress?: ProgressCallback` to the pool and invoking it from the worker around each `summarizeBatch` (and the single-batch delegate): trivial/deduped as immediate `skipped`, real batches as `start` then `done`/`skipped`. The pool only ever sees the NON-TRIVIAL subset (`nonTrivialBatches`), so its callback indices are subset-relative while widget rows are keyed by the full list — `onProgress` must be remapped through the same `nonTrivialIndices` table the existing `onBatchTextProgress` remap uses (`index.ts:444-447`), or rows get marked on the wrong batches whenever any batch is trivial/deduped. What changes for callers is only that providing `onProgress` no longer forces sequential execution. Retries re-emit `onTextProgress(0)` per attempt; the widget's `updateRow` currently assigns `receivedChars` unconditionally (`commands.ts:464`), so it must clamp to the max seen — a retry never visibly regresses a row's char count. Ordered persistence is unaffected: results stay index-aligned and the existing result loop is unchanged. Alternative considered — drop `onProgress` and infer done-ness from the final result array: rejected; rows would sit in `running` until the whole flush settled.

### Decision 6: Metrics, status, and notifications surface tier activity

`FlushTrigger` gains `"proactive"`. `FlushMetricsEntry` gains ONE optional field, `tier?: number` (the fired tier fraction) — the drained count is the existing `processedBatches`; no duplicate field. `FlushOptions` gains `tier?: number` alongside `batchLimit` so `flushPending` (which owns the metrics emit in its `finally`) can record it. Outcome naming: `flushPending`'s RESULT reason for a summarized flush is `"flushed"`, while the metrics OUTCOME string is `"summarized"` — the tier cursor advances on the metrics-outcome set, so the reason→outcome mapping must be explicit wherever the cursor logic reads the result.

Tier flushes use the quiet path by default: footer/status widget only, without the per-flush `safeNotify` used by budget/delta flushes (those are justified as significant-and-infrequent; tiers fire up to once per tier per climb and would be noise). A tier flush ending in `summarizer-failed` still surfaces the existing failure notification from `flushPending`. `/pruner status` shows configured tiers, batch limit, last-fired tier when known, and a hint when tiers are configured while `autoBudgetThreshold` is null (no guaranteed full drain).

Config normalization warns out-of-band: `loadConfig` returns the normalized config plus a side-channel list of dropped tier entries (NOT a field on `ContextPruneConfig`, so `saveConfig` never persists diagnostics); the session_start handler notifies once per session start when the list is non-empty.

## Risks / Trade-offs

- [Tier flush fires while the agent loop continues, adding summarizer latency between turns] → Bounded by `proactiveBatchLimit` × `summarizerConcurrency` summarizer calls (chain compression excluded from tier flushes — Decision 2); tiers are off by default; the same trade-off is already accepted for the budget flush.
- [Early summarization slightly reduces summary quality for chains that close later, since a turn-level summary can't see the closing assistant message] → Same limitation already exists for budget/delta flushes; chain compression's range fusion (which runs on the non-tier flushes) repairs multi-batch coherence after closure.
- [Hysteresis constant (10 points) is arbitrary] → Internal constant with documented rationale (fraction space, `max(0, tier − 0.10)` floor), mirroring the `MAX_BUDGET_WINDOW` precedent; can become config later if users ask.
- [Tier cursor state is in-memory; a reload or tree navigation loses "already fired" knowledge] → Cursor re-derives from usage; indexer/frontier make re-summarization idempotent. A session_tree hop at high usage WITH pending work fires one tier per navigation — accepted and spec'd (Decision 3).
- [Tiers configured without `autoBudgetThreshold` never get a guaranteed full drain] → Spec'd: each climb drains at most `tiers.length × batchLimit`; with `pruneOn: "on-demand"` a monotonic climb can still grow the backlog. `/pruner status` hints when this combination is detected (Decision 6).
- [Parallel `/pruner now` shows several running rows; retries could regress a row's char count] → `onProgress` retained for start/done (Decision 5); row rendering clamps to max-seen chars.
- [Config list normalized by dropping invalid entries could silently ignore a typo like `0,7`] → Dropped entries come back out-of-band from `loadConfig` and surface as one warning per session start; they are never a config field, so `saveConfig` cannot persist them (Decision 6).

## Migration Plan

Purely additive. Upgrade: feature off (`proactiveBudgetTiers: []`), `/pruner now` gets faster via the pool with no user action. Rollback: remove the two keys; flush-metrics entries with `trigger: "proactive"` remain valid historical data (consumers read `trigger` as a string). No session-entry, entry-type, or spec migrations.

## Open Questions

- Is 4 the right default `proactiveBatchLimit`, or should it scale with backlog size (e.g. `ceil(pending/3)`)? Starting fixed; adaptive sizing can follow metrics from real sessions.
- Should a future version let tiers fire in `context`-hook preflight for sessions that stop producing tool results? Out of scope here (recursion risk), but the tier state machine is designed to be reusable if a safe preflight seam ever lands in Pi.
