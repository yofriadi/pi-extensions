# Tasks: split-settle-sounds-and-add-mute-toggle

## 1. Configuration (`src/config.ts`)

- [x] 1.1 Add `"agentFailed"` and `"agentAborted"` to the `EventTriggerName` union (src/config.ts:20-28) and to `EVENT_TRIGGER_NAMES` (src/config.ts:64-73) so both default to an empty file list through the existing `defaultConfig()` loop and are accepted by the `resolveConfig` events branch (src/config.ts:171-178) — no other config change, no presence tracking (D5)
- [x] 1.2 Extend `test/config.test.ts`: both keys resolve to `[]` when absent; a configured relative path is resolved against the source base dir; an unknown `sounds.events` key is still ignored without throwing — run `pnpm --filter @yofriadi/pi-event-sounds test` until green

## 2. Outcome latch (`src/triggers.ts`)

- [x] 2.1 Add a structural message shim alongside the existing `QuotaMessage` (src/triggers.ts:46-50) — e.g. `interface OutcomeMessage { role: string; stopReason?: string }` — and an exported `RunOutcome` union: `"settled" | "failed" | "aborted" | "unknown"` (strip-only TS: no enum)
- [x] 2.2 Implement class `SettleOutcome` with `reset()` (sets `unknown`), `noteAgentEnd(messages: OutcomeMessage[])` (scan from the end for the last `role === "assistant"` entry, classify `stopReason === "error"` → `failed`, `"aborted"` → `aborted", any other value → `settled`, no assistant message → leave `unknown`), and `take(): RunOutcome` (return the current outcome and reset it to `unknown`); classify on `stopReason` only, never on `errorMessage` text (D10)
- [x] 2.3 Implement pure `settleFiles(config: SoundConfig, outcome: RunOutcome): string[]` returning the file list to play for an outcome: `failed` → `events.agentFailed` when non-empty else `events.error` (D4); `aborted` → `events.agentAborted` (no fallback, D6); `settled` and `unknown` → `events.agentSettled`
- [x] 2.4 Unit tests in `test/triggers.test.ts` for every scenario in the delta spec's "Settle-run outcome latch" and "Outcome-specific settle sounds" requirements: error → failed, aborted → aborted (not failed), `length` → settled, last-assistant-wins when earlier messages errored, `take()` clears to `unknown`, `agentFailed` inheritance from `error`, `aborted` silence when `agentAborted` is empty, `unknown` → success list

## 3. Settle routing (`src/index.ts`)

- [x] 3.1 Subscribe to `agent_end` and feed `event.messages` to the latch; reset the latch at the head of the `agent_start` handler (so each retry attempt re-arms, D3) and in the `session_start` handler
- [x] 3.2 Change the `agent_settled` handler (src/index:106-109) to keep `elapsedTimer.clear()` unconditional, then read `const outcome = settleOutcome.take()` and play `pick(settleFiles(config, outcome))` through the existing `active()` gate — `agentSettled` must no longer fire unconditionally, and the failure path must not call `turnError.claim()` or otherwise touch `TurnErrorDedupe`
- [x] 3.3 Confirm no other trigger regressed: tool `error` dedupe, `quota`/`quotaExhausted` at `message_end`, turn milestones, and elapsed timers keep their current behavior

## 4. Runtime mute and command (`src/index.ts`)

- [x] 4.1 Add `let muted = false` at **module** scope, above the factory: Pi re-invokes the factory on every `loadExtension` (`initializeExtension` → `await factory(load.api)`) while `extensionCache` reuses the module instance, so a factory-closure variable would silently reset on `/new` and `/resume` (design D8).
      Extend `active()` (src/index.ts:67) to `config.enabled && !noSounds && !muted`; the mute must not force playback on when `enabled` is false or `--no-sounds` is set (D7)
- [x] 4.2 Register one shared command options object under both names via `pi.registerCommand("sounds", opts)` and `pi.registerCommand("event-sounds", opts)`, with `getArgumentCompletions` offering `on`/`off`/`status` (pattern: `packages/pi-cc-ui/extensions/renderer/index.ts:139`), and a `(args, ctx)` handler: empty or `toggle` flips, `on` clears, `off` sets, `status` reports state plus the responsible input (`muted via /sounds` / `--no-sounds` / `sounds.enabled: false` / enabled), unknown argument prints a usage line — always through `ctx.ui.notify(msg, "info" | "warning")`, guarded so a missing `notify` cannot throw
- [x] 4.3 Keep the best-effort contract: wrap nothing in `await` that can reject unhandled, and make sure no handler or command path can throw out of the extension

## 5. Tests

- [x] 5.1 Update `test/loader.test.ts`: the sorted-handler assertion (test/loader.test.ts:48-58) gains `"agent_end"`, and assert the loaded extension registers both `sounds` and `event-sounds` in `extension.commands` (type: `Map<string, RegisteredCommand>`).
      Loader coverage stays registration-level by design — observing playback through the jiti-loaded extension would need a PATH-stub harness, the spawn path is already covered in `test/player.test.ts` via `PlayerSeams`, and settle routing in 5.2 (see design Risks)
- [x] 5.2 Extend `test/extension.test.ts` with the event-level cases: `agent_end(error)` + `agent_settled` plays the `agentFailed` file and not `agentSettled`; same with `agentFailed` unset plays the `error` file; `agent_end(aborted)` + `agent_settled` plays nothing; `agent_start` → error `agent_end` → `agent_start` → stop `agent_end` → `agent_settled` plays the success file (retry recovers); tool error earlier in the turn does not suppress the failure sound; and an armed elapsed timer that meets `agent_end(error)` + `agent_settled` never fires (delta scenario "Elapsed timer is cleared regardless of outcome")
- [x] 5.3 Add mute cases to `test/extension.test.ts`: mute off via the command silences every trigger including a timer armed earlier; un-muting restores playback; `enabled: false` or `--no-sounds` keeps silence after un-muting; the mute stays on across a `session_start` dispatch (this pins that the handler does not reset the mute — it cannot distinguish module scope from closure scope, since dispatching an event neither re-runs the factory nor re-imports the module; D8 rests on Pi's extension-cache behavior instead, and task 6.5 checks `/new` by hand); `status` and unknown-argument paths notify and do not throw

## 6. Docs and verification

- [x] 6.1 Update `README.md`: add `agentFailed` and `agentAborted` rows to the trigger table (README.md:82-95) stating the `agentFailed` → `error` inheritance and that `agentAborted` has no fallback; annotate the `agentSettled` row and the claude-code `Stop` mapping row (README.md:127) that it is now success-only; extend the annotated settings example (README.md:40-60) with both keys; add a command section documenting `/sounds` (`/event-sounds`) with `toggle`/`on`/`off`/`status` and the three-input gate (`enabled`, `--no-sounds`, mute)
- [x] 6.2 Add a `CHANGELOG.md` entry calling out the **BREAKING** `agentSettled` semantics change and the fallback's side effect for users who configured only `error`
- [x] 6.3 Run `pnpm run check` from the repo root with full output and fix every error, warning, and info
- [x] 6.4 Run `pnpm test` from the repo root and iterate until the pi-event-sounds suite is green
- [ ] 6.5 Verify by hand against the reported failure: with the real `~/.pi/agent/settings.json`, trigger a provider error that exhausts retries and confirm the celebration sound does not play and the error list does; then `/sounds off` and confirm the session goes quiet across `/new`
