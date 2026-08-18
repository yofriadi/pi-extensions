# Tasks: summarizer-fallback-model

## 1. Config surface

- [ ] 1.1 Add `summarizerFallbackModel: string` and `summarizerFallbackThinking: SummarizerThinking` to `ContextPruneConfig` and `DEFAULT_CONFIG` (`"default"` / `"default"`) in src/types.ts
- [ ] 1.2 Merge both keys in src/config.ts (reuse `isSummarizerThinking` guard for the thinking key)
- [ ] 1.3 Expose both in the `/pruner` settings overlay in src/commands.ts

## 2. Tier chain in summarizer

- [ ] 2.1 Add `resolveFallbackModel(config, ctx)` in src/summarizer.ts mirroring `resolveModel` (`"default"` → no middle tier; `provider/model-id` → registry find with warning + absent on miss)
- [ ] 2.2 Build the per-call chain in `runSummarization`: `dedup([primary, fallback, ctx.model])` by `provider/id`, keeping first occurrence; chain length 1 keeps today's single-attempt path; floor = last element; remove `hasDistinctFallback` (superseded by `chain.length > 1`); remove `CallTarget`/`TargetDecision` `"primary"|"fallback"` shape in favor of tier index + `wasProbe`
- [ ] 2.3 Change `summarizerThinkingOptions(config, model)` to `summarizerThinkingOptions(level, model)` (takes resolved `SummarizerThinking`), change `runOnce` to accept the level as an argument, and update `summarizerThinkingOptions` call sites in src/summarizer.test.ts
- [ ] 2.4 Rescue walk: `const { key, index, wasProbe } = controller.chooseTarget(chain)`; attempt tier at `index`; transient failure on tier *k* → `controller.onFailure(key, isFloor)` then retry same call on tier *k+1*, skipping tiers marked down — except a down tier with elapsed cooldown is probed when the walk reaches it (single claim) — through the floor; on success on tier *j* → `controller.onSuccess(key, wasProbe, isFloor)`, then `controller.drainOwed(chain, j)` and notify each returned key's enter warning; first success suppresses failure notify; all-fail notifies once with the floor's (last attempted) failure message; auth notifies and aborts the walk; unusable returns null without touching controller state; pass `summarizerThinking` for tier 0 and `summarizerFallbackThinking` for tiers 1+
- [ ] 2.5 Notify text names the failing tier and the serving tier ("pi-condense: summarizer model <X> failing, using <Y> until it recovers" / "pi-condense: summarizer model <X> recovered"); unify `notifyFailure`'s error prefix from `pruner:` to `pi-condense:` (src/summarizer.ts non-timeout branch) so all user-facing summarizer notices share one prefix; update source docstrings naming the session model as fallback target (src/summarizer-fallback.ts header, src/summarizer.ts `runSummarization` doc)

## 3. Per-tier state in controller

- [ ] 3.1 Generalize `FallbackController` from `inFallback` boolean to `Map<string, TierState>` keyed by `${provider}/${id}` with `TierState = { fails, down, lastProbeAt, owedWarning }`; replace old transition methods with `chooseTarget(chain) / onFailure(key, isFloor) / onSuccess(key, wasProbe, isFloor) / drainOwed(chain, succeededIndex)`; add public `isDown(key, isFloor = false)`, `isOwed(key)` accessors; add exported `FAILOVER_THRESHOLD = 3` and constructor `constructor(now = Date.now, options: { threshold?: number } = {})`; `reset()` clears the map; reads at the floor index ignore stale `down` (a model marked down while non-floor can become floor after a settings change)
- [ ] 3.2 `chooseTarget(chain: ModelLike[])`: first non-down tier (floor always counts as non-down); if a down tier's probe cooldown elapsed, probe the highest-priority (lowest-index) such tier **with lower index than the first non-down tier** (never probe a lower-priority down tier at selection time); single synchronous claim, existing pattern; floor never marked down
- [ ] 3.3 Transitions: transient fail on tier *k* increments `fails[k]`; when `fails[k] >= threshold` AND `!isFloor` AND `!down[k]` (mark-down effects only on the up→down edge — no re-arming `owedWarning`, no re-stamping `lastProbeAt`) → set `down[k] = true` AND `lastProbeAt[k] = now()` AND defer enter warning via `owedWarning[k]`; success on tier *k* resets `fails[k]` AND clears `owedWarning[k]`; a probe success on a down tier additionally clears `down[k]` and emits recover; a non-probe floor success clears stale `down[k]` silently (no recover notify); first success on a lower-priority tier emits `owedWarning[k]` and clears it (via `drainOwed(chain, succeededIndex)`)

## 4. Tests

- [ ] 4.1 Rewrite src/summarizer-fallback.test.ts against the new keyed API (`chooseTarget`/`onFailure`/`onSuccess`/`drainOwed`/`isDown`) — every block (`chooseTarget`, enter fallback, recover, probe transient, both-down owes, recover clears owed, unusable probe, probe schedule, reset) currently calls the retired `onPrimaryFailFallbackOk`/`onBothDown`/`onFallbackSuccess`/`onPrimarySuccess`/`onFallbackOnlyFail` shape and must port; delete the `describe("hasDistinctFallback")` block (src/summarizer-fallback.test.ts:11-28); inject `{ threshold: 1 }` at all `new FallbackController()` sites in src/summarizer-fallback.test.ts AND src/summarizer-wiring.test.ts; replace `controller.inFallback` assertions (src/summarizer-wiring.test.ts:183,198,234,297) with `controller.isDown(key)`
- [ ] 4.2 New controller tests: sub-threshold blips do not mark a tier down; third consecutive failure marks it down AND stamps `lastProbeAt`; repeated failures on an already-down tier leave `lastProbeAt` and `owedWarning` untouched (idempotent mark-down); non-probe success resets counter but not down state (non-floor); floor tier never down; stale down ignored when a model becomes the floor; non-probe floor success clears stale `down` silently so demotion does not resurrect a stale recover cycle; selection-time probe never targets a lower-priority down tier; walk probes a down tier it reaches with elapsed cooldown; probe recovery; owed-warning emitted by first lower-priority-tier success (`drainOwed(chain, succeededIndex)`), discarded by own-tier success; enter warning emitted at most once while a tier remains down
- [ ] 4.3 New chain tests in summarizer: dedup of identical tiers; `"default"` fallback adds no tier; registry miss warning degrades to 2 tiers; `summarizerModel: "default"` + distinct fallback yields 2-tier chain with fallback as floor
- [ ] 4.4 New rescue-walk tests: middle rescues primary; floor rescues when primary+middle fail; walk skips down tiers; walk probes a down middle tier it reaches with elapsed cooldown and recovers on success; all-down notifies once with floor's failure message and returns null; auth on a mid-chain tier aborts the walk and leaves tier state untouched; unusable returns null without touching tier state; enter/recover notifications use the exact strings from spec ("pi-condense: summarizer model <X> failing, using <Y> until it recovers" / "pi-condense: summarizer model <X> recovered")
- [ ] 4.5 New thinking test: tier 0 call receives `summarizerThinking`, tier 1+ call receives `summarizerFallbackThinking`; non-reasoning tier sends no reasoning option

## 5. Docs

- [ ] 5.1 Config reference: both new keys with defaults and 3-tier chain explanation in README.md AND doc/configuration.md (settings table + "retried once on the session model" passage)
- [ ] 5.2 Update doc/specs/2026-07-06-summarizer-outage-fallback.md and PRUNING.md (outage-fallback mention) with tier-chain + threshold semantics

## 6. Verify

- [ ] 6.1 `bun test src/` green
- [ ] 6.2 Typecheck: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
- [ ] 6.3 Smoke: `pi -e ./index.ts --no-extensions -p "..."` with an explicit `summarizerFallbackModel`, verify tier walk + warning/notify behavior on forced failure
