# Design: summarizer-fallback-model

## Context

`runSummarization` (src/summarizer.ts) implements outage fallback via `FallbackController` (src/summarizer-fallback.ts): a transient failure of the configured summarizer model is retried once on the session model, and the controller goes sticky until a per-10-minute probe of the primary succeeds. The fallback chain today is 2 tiers: `summarizerModel` → `ctx.model`. When `summarizerModel: "default"` both tiers are the same model and no fallback exists. Sticky entry happens on the first transient failure. Thinking level comes from `summarizerThinking` for whichever model runs.

## Goals / Non-Goals

**Goals:**
- 3-tier fallback chain: `summarizerModel` → `summarizerFallbackModel` (new middle tier) → session model (`ctx.model`).
- Independent thinking level for non-primary tiers (`summarizerFallbackThinking`).
- A tier is marked down (skipped, sticky) only after 3 consecutive transient failures.

**Non-Goals:**
- Configurable threshold or cooldown (constants, `COOLDOWN_MS` precedent).
- More than 3 tiers (one configurable middle tier; the last tier of the deduped chain is the fixed floor).
- Fallback for `auth` or `unusable` outcomes (unchanged: auth notifies and never trips the controller; unusable returns null).
- Persisting controller state across sessions (in-memory, `reset()` on `session_start`).
- Marking the chain's last tier (the floor) down — it is the last resort; its failures only notify.

## Decisions

### D1: Tier chain with dedup

Per call, `runSummarization` builds the chain:

```
chain = dedup([ resolveModel(config, ctx),          // primary
                resolveFallbackModel(config, ctx),  // middle, undefined when "default" or miss
                ctx.model ])                        // floor
```

Dedup by `key = ${provider}/${id}`, keeping first occurrence. `summarizerFallbackModel: "default"` contributes no tier. Chain of 1 (`summarizerModel: "default"`, no fallback configured) = today's no-controller single-attempt path. Chain of 2 = today's behavior. Chain of 3 = new. The **floor** is always `chain[chain.length - 1]` — whatever model lands there after dedup.

### D2: Per-call rescue walk skips down tiers

A call targets the first non-down tier (from `chooseTarget`). On a transient failure it walks the chain downward from the next index, **skipping tiers marked down**, retrying the same call on each until one succeeds or the floor fails. First success wins; the failure notify for any failed tier is suppressed when a lower tier rescues. When every tier fails, the user is notified once with the **last attempted (floor) tier's** failure message. Auth failure on any tier notifies and aborts the walk for that call without affecting tier state. Unusable returns null without affecting tier state.

### D3: Per-tier health state keyed by model key

`FallbackController` generalizes from one `inFallback` boolean to a `Map<string, TierState>` keyed by `${provider}/${id}` (survives settings-edit index shifts; avoids stale-recover for a model that never failed):

```ts
type TierState = { fails: number; down: boolean; lastProbeAt: number; owedWarning: boolean }
```

Public read surface: `isDown(key, isFloor)`, `isOwed(key)`. The floor index is **always eligible**: `chooseTarget` and `isDown` ignore any stale `down` flag when `isFloor` is true (a model marked down while non-floor can become the floor after a settings change; reads must not let that stick). `isDown` takes `isFloor` because the keyed map alone cannot know the caller's current chain position. Transition API (replaces `onPrimaryFailFallbackOk`/`onBothDown`/`onFallbackSuccess`/`onPrimarySuccess`/`onFallbackOnlyFail`), all taking the model key + `isFloor` flag:

```ts
chooseTarget(chain: ModelLike[]): { key: string; index: number; wasProbe: boolean }
onFailure(key: string, isFloor: boolean): { markedDown: boolean }
onSuccess(key: string, wasProbe: boolean, isFloor: boolean): { recovered: boolean }
drainOwed(chain: ModelLike[], succeededIndex: number): string[]   // owed keys of tiers with lower index than succeededIndex
```

Convention: **higher priority = lower index**. Prose uses "higher-priority"/"lower-priority", never bare above/below.

Transitions:

- Transient failure on tier *k* (`onFailure`): `fails[k]++`; when `fails[k] >= threshold` AND `!isFloor` AND `!down[k]` (mark-down effects fire only on the `!down → down` edge — concurrent batches in one `Promise.all` flush may each fail on an already-down tier; re-arming `owedWarning` would repeat the enter warning and re-stamping `lastProbeAt` would starve the probe) → set `down[k] = true` AND `lastProbeAt[k] = now()` (cooldown starts at the mark), enter warning deferred via `owedWarning[k]`. Floor transient failures never set `down`.
- Success on tier *k* (`onSuccess(key, wasProbe, isFloor)`): `fails[k] = 0`; `owedWarning[k]` cleared (own-tier success discards the deferred enter warning). A **probe** success on a down tier additionally sets `down[k] = false` and emits recover. A non-probe success clears `fails` only — it does NOT clear `down`, **unless `isFloor`**: a model with stale `down` promoted to floor serves via non-probe success, and that success clears `down[k]` silently (no recover notify — the user was never told it was down as floor) so a later demotion does not resurrect a stale recover/enter cycle.
- Deferred enter warning (`drainOwed`): called by the caller after the walk with the full chain and the index of the tier that succeeded; fires `owedWarning` for every key at a lower index than `succeededIndex` (the higher-priority tiers that failed), returns them for notify, and clears them. A success on tier *k* itself discards `owedWarning[k]` without emitting (handled by `onSuccess`).
- `reset()` clears the map.

Strict counting (failure counts even when rescued) applies per tier — counter measures tier health, not batch loss. Alternative (count only full-chain failures) rejected: rescue would hide a flapping tier indefinitely.

### D4: Target selection across down tiers

`chooseTarget(chain: ModelLike[])` returns the key/index of the first non-down tier (floor always counts as non-down). Separately, if a down tier's probe cooldown has elapsed, the call probes that tier instead — single synchronous claim, first of N concurrent callers wins (existing pattern). Probe eligibility at selection time is restricted to down tiers with a **lower index** (higher priority) than the first non-down tier — probing a lower-priority down tier would emit "recovered" for a non-serving tier and route the next call to a worse model. Within eligibility, probe the highest-priority (lowest index) one. Independently, **the rescue walk probes a down tier when it reaches one whose cooldown has elapsed**: a down middle tier unreachable at selection time (a higher-priority healthy tier ranks above it) is re-tested exactly when it would serve — a higher-priority tier has failed and the walk lands on it. This keeps every down non-floor tier recoverable. This retires `CallTarget`/`TargetDecision`'s `"primary" | "fallback"` shape in favor of a tier index + `wasProbe`.

### D5: Thinking resolution per tier

`summarizerThinkingOptions(config, model)` becomes `summarizerThinkingOptions(level, model)` taking a resolved `SummarizerThinking` (exported symbol, directly unit-tested in src/summarizer.test.ts — call sites update). `runOnce` accepts the level as an argument. Tier 0 (primary) gets `config.summarizerThinking`; tiers 1+ get `config.summarizerFallbackThinking`. The function already no-ops on `off`/`default`/non-reasoning models, so a reasoning-less tier needs no special-casing.

### D6: Notify text per tier

Enter warning names the failing tier and the tier now serving: `pi-condense: summarizer model <X> failing, using <Y> until it recovers`. Recover: `pi-condense: summarizer model <X> recovered`. No hardcoded "session model" wording. Source docstrings describing the fallback target as the session model (src/summarizer-fallback.ts header, src/summarizer.ts `runSummarization` doc) update in the same change; `hasDistinctFallback` is superseded by `chain.length > 1` and removed.

### D7: Config surface

```jsonc
// ~/.pi/agent/settings.json
{ "contextPrune": {
    "summarizerModel": "openai/gpt-5-mini",                  // tier 0
    "summarizerFallbackModel": "anthropic/claude-haiku-4-5",  // tier 1; "default" = none
    "summarizerFallbackThinking": "low"                      // tiers 1+; same enum as summarizerThinking
} }
```

Defaults (`summarizerFallbackModel: "default"`, `summarizerFallbackThinking: "default"`) preserve today's 2-tier behavior exactly, except sticky entry moves 1 → 3 strikes per tier.

## Risks / Trade-offs

- [Middle tier shares the primary's outage (same provider/account)] → accepted; user picks the chain. Chain walk handles any subset being down.
- [Threshold delays marking a tier down during a real outage] → bounded: a flush of N batches costs up to N walks through the failing tier before it is marked down (sticky within one flush when N >= threshold, else within 3 flushes). Rescue walk means no batch loss.
- [Mid-session settings change] → chain rebuilds per call; provider/id-keyed state means a model keeps its health across index shifts. A model newly absent from the chain keeps stale state harmlessly until `reset()`; a model newly present starts healthy. No stale-recover for models that never failed.
- [`summarizerFallbackThinking` set while a lower tier has no reasoning support] → silent ignore via `summarizerThinkingOptions`, consistent with primary behavior.

## Migration Plan

Config-only addition with backward-compatible defaults; no migration. Existing sessions unaffected until settings are edited.

## Open Questions

- None.
