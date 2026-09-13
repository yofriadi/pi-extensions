# Proposal: add-pi-sounds

## Why

Users running long Pi sessions want audible feedback on agent activity, like claude-code's hook sounds (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop` playing distinct `.wav` files).
The existing third-party `pi-notify` package only covers completion/error/question, uses one hardcoded system sound, and has no support for custom files, per-event sounds, or richer triggers.
Users also want sounds for derived conditions Pi has no dedicated events for: provider quota/rate-limit responses, turn-count milestones (e.g. turn 100), and elapsed time (e.g. every 5 minutes).

## What Changes

- Create a new package `packages/pi-event-sounds` (empty placeholder directory already exists) that plays user-configured sound files on Pi lifecycle and derived events.
- Support per-event sound configuration with one or more file paths per event; when multiple files are listed, pick one at random on each fire.
- Lifecycle triggers: session start (`session_start`), prompt submit (`input`), agent start (`agent_start`), agent settled (`agent_settled`), extension question (`ui_prompt_start` — requires `@earendil-works/pi-coding-agent` ≥ 0.85.1, which adds the typed `UIPromptStartEvent`; absent in ≤ 0.84.x; covers extension UI prompts only, not built-in permission dialogs), tool/turn error (`tool_result` with `isError`, deduped per turn).
- Quota trigger: fire when an assistant message ends with `stopReason: "error"` whose `errorMessage` matches configurable quota/rate-limit patterns (defaults grounded in `@earendil-works/pi-ai`'s retry classifier; `after_provider_response` was verified to carry only success statuses and is not emitted at all on Google providers), deduped within a short window so a retry burst plays once.
- Turn-count trigger: fire when `turn_start` reaches a configured `turnIndex` milestone or interval (e.g. every 50 turns).
- Elapsed-time trigger: fire after a configured duration since agent run start, one-shot or repeating (e.g. every 5 minutes while the agent is working), using timers that are cleared when the run settles or the session shuts down.
- Cross-platform playback: `afplay` (macOS), `paplay`/`aplay` (Linux), PowerShell `SoundPlayer`/beep fallback (Windows), terminal bell (stderr, interactive TTY only) last resort.
  Playback is best-effort and must never break the agent loop.
- Configuration via a `sounds` object in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global), with sensible defaults (disabled triggers stay silent when unconfigured). `--no-sounds` CLI flag disables everything for a run.

## Capabilities

### New Capabilities

- `sound-playback`: cross-platform, best-effort sound-file player with random selection among multiple files per trigger.
- `event-sound-triggers`: mapping of Pi lifecycle events, provider quota responses, turn-count milestones, and elapsed-time timers to sound triggers.
- `sound-configuration`: settings.json schema, defaults, per-trigger enablement, and the `--no-sounds` flag.

### Modified Capabilities

(none — no existing specs in `openspec/specs/`)

## Impact

- **New package**: `packages/pi-event-sounds/` — `package.json` (entry `./src/index.ts` per repo convention), `src/index.ts`, `src/player.ts`, `src/config.ts`, `src/triggers.ts`, tests under `test/`.
- **Dependencies**: none beyond Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`) and the peer `@earendil-works/pi-coding-agent` extension API, pinned `>=0.85.1` (the version that introduces `ui_prompt_start`/`ui_prompt_end`).
- **Repo wiring**: the workspace glob `packages/*` and root `test` script (`pnpm -r --if-present test`) pick the package up automatically; add `tsc --noEmit -p packages/pi-event-sounds/tsconfig.json` to the root `check` script (biome already covers all files). `pnpm run check` and `pnpm test` must pass.
- **No breaking changes** to existing packages.
