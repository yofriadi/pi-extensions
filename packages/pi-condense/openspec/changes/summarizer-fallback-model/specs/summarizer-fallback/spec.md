# Spec: summarizer-fallback

## ADDED Requirements

### Requirement: Three-tier fallback chain

The summarizer SHALL resolve an ordered fallback chain per call: `summarizerModel` (primary), then `summarizerFallbackModel` (middle tier), then the session model (`ctx.model`, floor). Tiers identical by `provider/id` SHALL be collapsed, keeping the highest-priority occurrence. `summarizerFallbackModel: "default"` SHALL contribute no tier. A `summarizerFallbackModel` of `"provider/model-id"` SHALL resolve via `ctx.modelRegistry.find(provider, modelId)`; on lookup failure or malformed value the extension SHALL notify a warning and treat the middle tier as absent. The last tier of the deduped chain is the floor; the floor is the only tier that is never marked down, regardless of which model occupies it. Tier health state is keyed by `provider/id`, so a model previously marked down while non-floor may retain stale `down` state after a settings change makes it the floor; reads at the floor index SHALL ignore any such stale `down` flag so the floor is always eligible.

#### Scenario: Full 3-tier chain

- **WHEN** `summarizerModel` is `"openai/gpt-5-mini"`, `summarizerFallbackModel` is `"anthropic/claude-haiku-4-5"`, and the session model is a third distinct model
- **THEN** the chain is `[gpt-5-mini, claude-haiku-4-5, session model]` and only the session-model tier is never-down

#### Scenario: Identical tiers collapse

- **WHEN** `summarizerModel` is `"default"` and `summarizerFallbackModel` names the session model
- **THEN** the chain contains the session model once, as the floor, and there is no downable tier

#### Scenario: Default fallback adds no tier

- **WHEN** `summarizerFallbackModel` is `"default"` or absent
- **THEN** the chain is `[primary, session model]`, matching previous behavior, with the session model as floor

#### Scenario: Unknown fallback model degrades to 2 tiers

- **WHEN** `summarizerFallbackModel` names a model not present in the registry
- **THEN** the extension notifies a warning and the chain is `[primary, session model]`

#### Scenario: Middle tier closes the default-primary hole

- **WHEN** `summarizerModel` is `"default"` (primary equals session model) and `summarizerFallbackModel` names a distinct model
- **THEN** the chain is `[session model, fallback model]`, the fallback model is the floor (never-down), and the session-model primary is downable

#### Scenario: Stale down state ignored when a model becomes the floor

- **WHEN** a model was marked down as a middle tier, then a settings change makes that model the floor
- **THEN** the floor reads as never-down, `chooseTarget` always returns a tier, and the rescue walk attempts it

### Requirement: Per-call rescue walk

A call SHALL target the first non-down tier, except that when a probe-eligible down tier exists the call SHALL probe that tier instead (see per-tier threshold). On a transient failure of any non-floor tier the extension SHALL immediately retry the same call on the next tier, skipping tiers already marked down, continuing until a tier succeeds or the floor fails. A successful rescue SHALL suppress the failure notification for the failed tiers. When every tier fails the extension SHALL notify once, using the floor's (last attempted) failure message, and return null. Auth failures SHALL notify and abort the walk for that call without affecting tier state. Unusable summaries SHALL return null without affecting tier state.

#### Scenario: Middle tier rescues primary failure

- **WHEN** the primary fails transiently and the middle tier succeeds
- **THEN** the call returns the middle tier's summary with no error notification

#### Scenario: Floor rescues when primary and middle fail

- **WHEN** primary and middle tiers both fail transiently and the floor succeeds
- **THEN** the call returns the floor's summary with no error notification

#### Scenario: Walk skips a tier already marked down

- **WHEN** the primary is marked down and the call's probe fails transiently
- **THEN** the walk does not retry the primary and proceeds to the middle tier

#### Scenario: All tiers fail

- **WHEN** every tier in the chain fails transiently
- **THEN** the call returns null and the user is notified once with the floor's failure message

### Requirement: Per-tier 3-failure threshold

Each non-floor tier SHALL track consecutive transient failures keyed by `provider/id` and SHALL be marked down — skipped by subsequent calls and re-probed at most once per cooldown — only when its counter reaches 3, at which point the tier's probe cooldown SHALL begin. Mark-down effects (`down`, cooldown stamp, deferred warning) SHALL apply only on the transition from up to down; further failures on an already-down tier SHALL NOT re-arm the warning or re-stamp the cooldown. A down tier SHALL be probe-eligible when its cooldown has elapsed AND either it has higher priority (lower index) than the first non-down tier — selected directly — or the rescue walk reaches it because every higher-priority tier failed. The floor tier SHALL never be marked down. Any success on a tier SHALL reset its consecutive-failure counter. A probe success on a down tier SHALL additionally clear its down state and notify recovery. A non-probe success on a down tier SHALL leave its down state unchanged — except at the floor, where reads ignore stale `down` and any success SHALL clear it silently (no recovery notification, since the floor was never announced as down). The threshold SHALL be an internal constant, not configurable.

#### Scenario: Blips do not mark a tier down

- **WHEN** the primary fails transiently once and the rescue succeeds
- **THEN** the next call still targets the primary and no warning is shown

#### Scenario: Third consecutive failure marks tier down

- **WHEN** the primary fails transiently on 3 consecutive calls (each rescued by a lower tier)
- **THEN** the primary is marked down, its probe cooldown begins, subsequent calls start at the middle tier, and the user is warned once

#### Scenario: Success resets a non-floor tier's counter but not its down state

- **WHEN** the primary fails transiently twice, then a non-probe primary call succeeds
- **THEN** the primary's counter resets to 0 and its down state is unchanged (down on a non-floor tier only clears via probe success)

#### Scenario: Floor success clears stale down state

- **WHEN** a model marked down as a middle tier becomes the floor, and its non-probe call succeeds
- **THEN** its counter resets and its `down` state is cleared, so a later settings change demoting it back to non-floor does not resurrect a stale recovery cycle

#### Scenario: Probe never targets a lower-priority tier than the serving tier

- **WHEN** the middle tier is healthy and serving, and a lower-priority down tier exists
- **THEN** that down tier is not probed at selection time; only a higher-priority down tier may be probed

#### Scenario: Down middle tier recovers when the walk reaches it

- **WHEN** the primary is healthy, the middle tier is down with elapsed cooldown, and the primary fails transiently
- **THEN** the walk reaches the middle tier, probes it, and on success the tier recovers and serves the call

#### Scenario: Floor tier never marked down

- **WHEN** the floor tier fails transiently any number of consecutive times
- **THEN** calls continue to attempt the floor tier and it is never skipped

#### Scenario: Down tier recovers via probe

- **WHEN** a non-floor tier is marked down and its probe cooldown has elapsed
- **THEN** one call probes it, and on success the tier serves subsequent calls and the user is notified of recovery
#### Scenario: Repeated failures on an already-down tier leave state untouched

- **WHEN** a tier is marked down and further calls (e.g. concurrent batches in one flush) fail transiently on it
- **THEN** its cooldown stamp and deferred warning are unchanged and no additional warning is emitted

### Requirement: Independent fallback thinking level

The extension SHALL support a `contextPrune.summarizerFallbackThinking` setting with the same enum as `summarizerThinking`. Calls to the primary tier SHALL apply `summarizerThinking`; calls to all lower tiers SHALL apply `summarizerFallbackThinking`. When a tier's model does not support reasoning, the level SHALL be silently ignored.

#### Scenario: Lower tier uses fallback thinking level

- **WHEN** `summarizerThinking` is `"high"`, `summarizerFallbackThinking` is `"low"`, and a call is routed to the middle or floor tier
- **THEN** the call requests reasoning level `"low"`

#### Scenario: Non-reasoning tier ignores level

- **WHEN** `summarizerFallbackThinking` is `"high"` and the serving tier's model has `reasoning: false`
- **THEN** the call sends no reasoning option

### Requirement: Tier-transition notifications

When a non-floor tier is marked down the extension SHALL emit one enter warning naming the failing tier and the tier now serving, formatted `pi-condense: summarizer model <X> failing, using <Y> until it recovers`. When a down tier recovers via probe the extension SHALL emit `pi-condense: summarizer model <X> recovered`. A deferred enter warning SHALL fire on the first success of any tier below the failing tier; if the failing tier itself succeeds before any lower tier does, the deferred warning SHALL be discarded without emitting. Enter warnings SHALL not repeat while a tier remains down.

#### Scenario: Enter warning fires on first lower-tier success

- **WHEN** the primary is marked down and the middle tier's call succeeds
- **THEN** the user is warned once that the primary is failing and the middle tier is serving

#### Scenario: Deferred warning discarded on own-tier recovery

- **WHEN** the primary is marked down, then a probe of the primary succeeds before any lower tier has served
- **THEN** no enter warning is emitted and the user is notified only of recovery

#### Scenario: No repeated enter warning while down

- **WHEN** the primary is marked down and the middle tier serves several calls
- **THEN** the enter warning is emitted at most once until the primary recovers
