# Design: split-settle-sounds-and-add-mute-toggle

## Context

Pi's settle event is payload-free and outcome-blind.
Verified against `@earendil-works/pi-coding-agent@0.85.1`:

- `AgentSettledEvent` is `{ type: "agent_settled" }` (`dist/core/extensions/types.d.ts:560`), and it is emitted from the `finally` of `AgentSession._runAgentPrompt` (`dist/core/agent-session.js:773-784` → `_emitAgentSettled` at `:347`).
  Success, Esc-abort, and exhausted-retry death all reach it identically.
- `AgentEndEvent` is the only lifecycle event carrying outcome data: `{ type: "agent_end", messages: AgentMessage[] }` (`types.d.ts:555`, forwarded to extensions at `agent-session.js:474`).
- `pi-agent-core@0.85.1` `dist/agent-loop.js:124-127` ends a run on a failed provider call by emitting `turn_end` with `toolResults: []` and then `agent_end` with the error-carrying assistant message included.
  So the terminal `stopReason` is always visible in the last `agent_end` before settle.
- Automatic retry re-enters the loop: `_handlePostAgentRun` (`agent-session.js:791-812`) calls `_prepareRetry` then `agent.continue()`, and `runAgentLoopContinue` emits a fresh `agent_start` (`agent-loop.js:67`).
  Per-attempt `agent_end` events therefore precede the final one.
- The `error` trigger's source cannot serve this case: extension `tool_result` events are emitted only from `agent.afterToolCall` (`agent-session.js:244-256`), and a failed assistant turn produces no tool results — so today a provider-killed run produces no error sound at all, only the celebration.
- `auto_retry_end` — the event whose `success: false` drives the TUI's "Retry failed after 3 attempts" line (`agent-session.js:796-804`) — is a session-bus event, not in the `ExtensionEvent` union (`types.d.ts:813`).
  It is unreachable from an extension.
- `StopReason` in `@earendil-works/pi-ai@0.85.1` (`dist/types.d.ts:287`) is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.
- `ExtensionAPI` exposes no settings-write method (`types.d.ts:906-1000` has no `setSetting`/`updateSettings`), so a durable mute would require the extension to rewrite the user's settings.json itself.

Current code: `src/index.ts` fires `agentSettled` unconditionally at `:106-109`; every playback path is gated by `active()` (`:67`), which reads `config.enabled && !noSounds`.
`src/config.ts` normalizes `sounds.events` over `EVENT_TRIGGER_NAMES` (`:64-73`) and already tests key presence with `if (name in events)` (`:174`).
Precedent for subcommand-style slash commands with completions: `pi-cc-ui`'s `/ccstyle` (`extensions/renderer/index.ts:139`).

## Goals / Non-Goals

**Goals:**

- The settle sound must agree with what actually happened: celebration on success, an error sound on provider death, nothing misleading on Esc.
- Correct classification under automatic retry and compaction continuation, where several `agent_end` events precede one settle.
- A runtime mute that works mid-session without editing files or relaunching, and that composes with `enabled` and `--no-sounds` without a precedence chain to explain.
- No configuration edits required for existing users to stop hearing celebrations over failures.

**Non-Goals:**

- Persisting the mute across process restarts (that is what `sounds.enabled` is for).
- Per-trigger mute switches, or a per-trigger enable/inherit sentinel model in settings.json.
- Classifying failure causes at settle time (quota vs auth vs overflow) — `quota` and `quotaExhausted` already do that at `message_end`.
- Treating `stopReason: "length"` (output truncated by the token limit) as a failure.
  Pi does not, and neither do we.
- Changing playback, backend detection, settings lookup order, or the `--no-sounds` flag.

## Decisions

### D1: Outcome comes from `agent_end`, not `message_end` or session state

The extension subscribes to `agent_end` and records the `stopReason` of the last assistant message in `event.messages`.

*Why:* `agent_end` is the loop's own terminal signal, it fires on the error and abort paths (`agent-loop.js:126`), its `messages` array is already scoped to that run, and reading the last assistant entry needs no scanning across event boundaries. `message_end` would work but fires for user and tool-result messages too, so the latch would need role filtering and would have to re-derive "which assistant message was last" from a stream.

*Alternatives considered:* `ctx.sessionManager` history inspection at settle time (heavier, and the read-only manager exposes entries rather than the run's own messages); Pi's `retryAttempt` (not on `ExtensionContext`); `auto_retry_end` (not delivered to extensions at all).

### D2: Four outcomes, `unknown` behaves like success

`failed` (last assistant `stopReason: "error"`), `aborted` (`"aborted"`), `settled` (any other terminal stop reason), `unknown` (no `agent_end` observed since the last reset).

`unknown` plays `agentSettled`.
It is the current behavior, and a future Pi reshuffle that drops or reorders `agent_end` degrades to today's semantics instead of silencing the sound users depend on.

*Alternatives:* treat `unknown` as failure (would start playing error sounds for clean runs that end through a path we did not anticipate); treat it as silent (regression risk for the primary success signal).

### D3: Latch lifecycle — reset on `agent_start`, consume and clear on `agent_settled`, clear on `session_start`

`agent_start` re-arms per retry attempt (D1 evidence: `runAgentLoopContinue` emits it), so the last attempt's verdict wins; a run that was throttled and then retried to success settles as `settled`.
Consuming at settle prevents a stale verdict leaking into the next run, and `session_start` clears across session boundaries.
The latch is a class in `src/triggers.ts` with the same injectable-seam style as `QuotaDetector` and `TurnErrorDedupe`, so the retry-ordering scenarios are unit-testable without a real session.

### D4: `agentFailed` reuses the `error` file list, never the `error` trigger

When the outcome is `failed`, the file list is `agentFailed` if non-empty, otherwise `error`.
Selection picks and plays directly; `TurnErrorDedupe.claim()` is not consulted, and nothing is added to it.

*Why:* routing through `fire("error")` would be swallowed in exactly the scenario that prompted this change — a run whose tool errored earlier in the turn has already consumed the once-per-turn slot, and the tool error and the run death are different events that happen to share a sound.
Reusing the list keeps one sound source in settings while leaving the two triggers' semantics and dedupe independent.

*Alternative:* make `agentFailed` a plain trigger with an empty default and no fallback.
Rejected: existing users would get silence on failure and would have to discover a new settings key to fix a sound they already own.

### D5: No presence sentinel; absent and empty both mean "inherit"

`agentFailed: []` is indistinguishable from omitting the key, so both inherit `error`.

*Why:* the config model tracks no key presence anywhere today (`resolveConfig` only filters per key to decide whether to normalize), and the "make it stop" need is served globally by the mute command.
Adding a boolean would introduce a new concept to `SoundConfig` for one trigger.

*Consequence, documented in the README:* you cannot silence run failures while keeping tool-error sounds.
Exits are `/sounds off` for the session, or pointing `agentFailed` at a file you are content to hear.

*Alternative considered and rejected:* a `configuredAgentFailed: boolean` derived from the existing `name in events` check, giving absent/empty-listed/explicit-empty three states.

### D6: `agentAborted` exists, defaults to silence

Aborted runs fire `agentAborted` only if configured; otherwise nothing plays.

*Why:* Esc is a user action, and the honest feedback is the absence of a sound; but a user who walks away and wants to know a run was cancelled needs a key to point at.
Defaulting it to the `error` list would make an intentional cancel indistinguishable from a provider death, which is why aborted gets no fallback.

*Alternative:* fold `aborted` into `failed`.
Rejected — it would mean the fallback fires the error sound on every cancel.
*Alternative:* no key at all, always silent.
Viable and smaller; kept only because it costs one name in an already-data-driven list.

### D7: The mute is a third independent input, not an override

`active()` becomes `config.enabled && !noSounds && !muted`.
`/sounds off` silences; `/sounds on` clears the mute and returns to whatever settings.json says.
The command can never make sound play against `enabled: false` or `--no-sounds`.

*Why:* one job per layer, no precedence chain, and the change to the existing gate is a single conjunct.
Because the elapsed-timer callback and the turn-milestone handler already call `active()` at fire time, muting mid-run retroactively silences a timer armed before the mute — no extra wiring.

*Alternative:* a tri-state override (`undefined | true | false`) that could force playback on top of `enabled: false`.
Rejected: it turns a mute button into a settings editor and makes `status` a lesson in precedence.

### D8: Mute lives in a module-scope variable, not the factory closure

Session replacement (`newSession`/`switchSession`/`fork` in `dist/core/agent-session-runtime.js:128-215`) always goes through `createRuntime` (`dist/main.js:570`), and the load path is `loadExtensionsCached` → `loadExtensionsInternal(..., useCache = true)` → `loadExtension()` (`dist/core/extensions/loader.js:524-560`), which fetches the factory from `extensionCache` and then calls `initializeExtension()` — which does `await factory(load.api)` on **every** load.
So the factory is re-invoked for each new session, and a `let muted` inside it is born `false` again on `/new` and `/resume`.

What survives is the module instance: `extensionCache` (`dist/core/extensions/loader.js:115-126`) holds the factory across calls, so `jiti.import` is not re-run and module-scope bindings are reused.
A module-scope `let muted = false` therefore keeps its value across session replacement, and a closure-scoped one does not.
Module scope is required, not merely defensive.

Two resets follow from the same mechanism and are stated in the spec rather than papered over: `clearExtensionCache()` empties `extensionCache` (reached by `AgentSession.reload()` → `ResourceLoader.reload()`, `dist/core/agent-session.js:2225`, `dist/core/resource-loader.js:264-266`), so `/reload` re-imports the module and unmutes; and `useExtensionCacheCwd()` clears the cache when the resolved cwd changes (`dist/core/extensions/loader.js:121-127`), so resuming a session belonging to a different project unmutes too.

There is no settings-write API (Context), so durability is out of scope by construction.

### D9: `/sounds` with an `/event-sounds` alias, `toggle` bare

`/sounds` → toggle; `/sounds on|off|status`; unknown argument prints usage; `getArgumentCompletions` offers `on|off|status`, following `/ccstyle`. `status` reports the effective state and which input is responsible (`muted by /sounds`, `disabled by --no-sounds`, `sounds.enabled is false`, or enabled).

*Why:* `/sounds` is what you type; `/event-sounds` matches the package name for palette discovery.
Both register the same handler via two `pi.registerCommand` calls.

*Alternative:* single name.
The alias costs one extra palette row — cut it if that reads as clutter.

### D10: Classification is on `stopReason` only

No text matching at settle time.
The TUI mutates `errorMessage` for aborted messages (`modes/interactive` message_end handler), and Pi prefixes retry summaries itself, so any text-based rule would depend on handler ordering we do not control.
`stopReason` is the same field Pi branches on.

## Risks / Trade-offs

- [Existing users hear error sounds on provider failures without opting in, because `agentFailed` inherits `error`] → Called out in README and CHANGELOG as the intended consequence of the fallback; `/sounds off` and an explicit `agentFailed` list are the exits.
- [Pi emits `agent_settled` without a preceding `agent_end`, or in a different order] → `unknown` maps to the success path, so the failure is a silent no-op rather than a wrong sound (D2).
- [A retried run is misclassified because an early attempt errored] → `agent_start` resets the latch per attempt (D3); covered by a retry-burst-then-success scenario.
- [`/reload` and cross-directory session replacement clear Pi's extension cache (`resource-loader.js:264-266`; `loader.js:121-127`), so the mute resets there while same-directory `/new`/`/resume`/`/fork` keep it] → Documented in the README command section and in the spec; a mute that survives the ordinary new-session case but resets when extensions are genuinely re-imported is the behavior the mechanism can actually promise.
- [Two triggers sharing one file list confuse users reading settings.json] → The README documents `agentFailed` as "defaults to your `error` list", not as a copy of the `error` trigger.
- [Silence on abort can read as "still running" to a user across the room] → `agentAborted` exists for exactly that case (D6).
- [Failure and quota sounds can overlap: 429 fires `quota` at `message_end`, then `agentFailed` at settle] → Accepted as two accurate statements about one event (throttled, then gave up).
  Not deduped: the quota window is 5s and shared with `quotaExhausted`, so folding settle into it would suppress legitimate later fires.
  Revisit only if it proves noisy in practice.
- [A behavioral playback assertion through `discoverAndLoadExtensions` is not attempted: the loader compiles extensions through jiti (`dist/core/extensions/loader.d.ts` header), so a `vi.mock("../src/player")` keyed on the test file's specifier is expected not to reach the module the extension imports.
  Not verified empirically here — the point is that loader coverage does not depend on it] → `test/loader.test.ts` stays registration-level, which is what repo policy asks of loader tests; the spawn path itself is covered in `test/player.test.ts` through `PlayerSeams`, settle routing in `test/extension.test.ts`, and the whole chain by hand in task 6.5.

## Migration Plan

Additive except for the `agentSettled` semantics change.
No settings.json migration: absent `agentFailed`/`agentAborted` keys normalize to empty lists under the existing defaults path, and every current configuration keeps playing exactly the sounds it names.
Rollback is reverting the source change; nothing is persisted, so no state outlives a revert.
Documented in README's trigger table, the claude-code mapping row for `Stop`, and a CHANGELOG entry noting that `agentSettled` is now success-only.

## Resolved During Planning

These were open when the proposal was first drafted; all three are now decided and committed by the spec deltas and tasks, listed here so the design does not read as undecided.

- **`/event-sounds` alias** — kept alongside `/sounds` (D9, committed by the "Sounds mute command" requirement).
  If two palette rows read as clutter, dropping the alias is a one-line cut during implementation.
- **`agentAborted`** — kept (D6, committed by "Outcome-specific settle sounds").
  Chosen over hard-silencing aborts because it is one entry in an already data-driven list and the only way to signal "a human stopped this" to someone away from the keyboard.
- **`status` verbosity** — reports the winning gate only, not which triggers are configured-but-empty.
  Inheriting a file list is not a gate, so surfacing it belongs in the README, not in a mute command.
