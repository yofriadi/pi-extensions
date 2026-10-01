# Proposal: split-settle-sounds-and-add-mute-toggle

## Why

`agent_settled` is Pi's "run is over" signal, but it carries no payload (`AgentSettledEvent { type: "agent_settled" }`) and is emitted from the `finally` block of `AgentSession._runAgentPrompt` — so it fires identically whether the run answered the prompt, was killed by Esc, or died after exhausting provider retries.
A run that ends `Retry failed after 3 attempts: 429: …` therefore plays the configured celebration sound, which is worse than silence: it tells the user the opposite of the truth.
Separately, the only ways to go quiet are editing `sounds.enabled` in settings.json or relaunching with `--no-sounds`; neither is usable mid-session when the user just needs the noise off right now.

## What Changes

- Add an assistant-message outcome latch fed by `agent_end` (the only lifecycle event carrying messages), reset per run on `agent_start`, so the terminal outcome of a settled run is known: `failed` (last assistant `stopReason: "error"`), `aborted` (`"aborted"`), `settled` (any other terminal stop reason), or `unknown` (no `agent_end` observed since the last reset).
- **BREAKING** `agentSettled` becomes success-only: it fires when the outcome is `settled` or `unknown`, and MUST NOT fire when the run ended `failed` or `aborted`.
- Add event trigger `agentFailed`, fired instead of `agentSettled` when the run ended `failed`.
  When `agentFailed` is not configured it falls back to the `error` file list, so an existing configuration announces run failures without edits.
  The fallback is a file-list reuse only: it does NOT touch the `error` trigger's per-turn dedupe state (a run that tool-errored before dying must still be audible).
- Add a `sounds` slash command (`/sounds`, with `/event-sounds` as an alias) providing `toggle` (also the bare form), `on`, `off`, and `status`, implementing an in-process mute (surviving `/new`, `/resume`, and `/fork`, cleared by restart or `/reload`) that is independent of settings.json and of `--no-sounds`.
- Add an event trigger `agentAborted` so Esc-terminated runs are not forced to share the failure sound; when it is not configured, an aborted run is silent.
- Update README trigger reference, settings example, claude-code hook mapping, and CLI section for the new triggers and command.

## Capabilities

### New Capabilities

(none — both new behaviors extend existing capabilities)

### Modified Capabilities

- `event-sound-triggers`: the "Lifecycle event triggers" requirement changes (`agentSettled` becomes outcome-conditional); new requirements for the outcome latch, the `agentFailed` fallback, and `agentAborted`.
- `sound-configuration`: new requirements for the runtime mute layer and the `/sounds` command surface; the `sounds.events` key set gains `agentFailed` and `agentAborted`.

## Impact

- **Source**: `src/triggers.ts` (outcome latch, alongside the existing `QuotaDetector` / `TurnErrorDedupe` / `ElapsedTimer` classes), `src/index.ts` (new `agent_end` handler, settle-time routing, `active()` gains the mute input, command registration), `src/config.ts` (two new `EventTriggerName`s, mute-independent).
- **Tests**: `test/loader.test.ts` asserts the exact sorted list of subscribed events and must gain `agent_end`; `test/extension.test.ts`, `test/triggers.test.ts`, `test/config.test.ts` gain coverage for the latch, fallback, and command.
- **Peer dependency**: unchanged at `>=0.85.1`. `agent_end` (`AgentEndEvent { messages: AgentMessage[] }`) predates the floor, so no version bump.
- **Behavior risk**: users who configured only `error` (no `agentFailed`) start hearing error sounds on provider failures without changing settings — that reuse is the point of the fallback, and `/sounds off` plus `agentAborted` are the stated exits.
- **No changes** to `src/player.ts`, backend detection, or the `sounds` lookup order.
