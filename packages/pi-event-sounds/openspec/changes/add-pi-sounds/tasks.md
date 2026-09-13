# Tasks: add-pi-sounds

## 1. Package scaffolding

- [x] 1.1 Create `packages/pi-event-sounds/package.json` with `pi.extensions` entry `./src/index.ts`, peer dep `"@earendil-works/pi-coding-agent": ">=0.85.1"` (floor for `ui_prompt_start`), matching dev dep `^0.85.1` for tests, vitest dev dep, and repo-standard scripts; create a `tsconfig.json` whose `include` covers `src/` and `test/` (pi-hashline-edit's tsconfig is a starting point but its `include` lists a root `index.ts` this package does not have — adjust)
- [x] 1.2 Wire the package into repo orchestration: workspace glob `packages/*` and root `test` (`pnpm -r --if-present test`) auto-discover it; add `tsc --noEmit -p packages/pi-event-sounds/tsconfig.json` to the root `check` script alongside the existing per-package tsc entries; run `pnpm install`

## 2. Configuration (`src/config.ts`)

- [x] 2.1 Implement settings file lookup over exactly two sources — project `<cwd>/.pi/settings.json`, then `<getAgentDir()>/settings.json` (import `getAgentDir` from `@earendil-works/pi-coding-agent`; it resolves `$PI_CODING_AGENT_DIR` or `~/.pi/agent`) — using the FIRST file that defines a `sounds` key (a project file without the key falls through to global), skipping missing/unreadable files
- [x] 2.2 Implement `resolveConfig`: defaults (`enabled: true`, `volume: 0.4`, `quotaPatterns` per spec, empty event lists), bare-string → array normalization, `~` expansion, per-source relative-path resolution (project root for project settings, agentDir for global), malformed-value tolerance (including invalid-regex `quotaPatterns` entries)
- [x] 2.3 Unit tests for lookup precedence, normalization, defaults, and malformed input — verified passing (test/config.test.ts, 18 tests)

## 3. Player (`src/player.ts`)

- [x] 3.1 Implement memoized backend detection (`darwin`/`linux`/`windows`/`terminal`) via executable PATH probing
- [x] 3.2 Implement `playSound(file, volume, backend)`: existence check, fire-and-forget `execFile` (`afplay -v <0..1>` / `paplay --volume=<v*65536>` / `aplay` / PowerShell `SoundPlayer` / stderr bell gated on `stderr.isTTY`), all errors swallowed
- [x] 3.3 Unit tests with injected spawn/exports seams: backend selection, volume clamping, missing-file no-op, error swallowing — verified passing (test/player.test.ts, 20 tests)

## 4. Triggers (`src/triggers.ts`)

- [x] 4.1 Implement random file picker with injectable RNG (`pick(files, rng)`)
- [x] 4.2 Implement turn-milestone check (`turnIndex > 0 && turnIndex % every === 0`)
- [x] 4.3 Implement quota error-text matcher: on assistant `message_end` with `stopReason: "error"`, case-insensitively match `errorMessage` against `quotaPatterns` (defaults grounded in `@earendil-works/pi-ai`'s `utils/retry.js` classifier); invalid regex entries ignored; 5-second dedupe window (injectable clock)
- [x] 4.4 Implement per-turn error dedupe state (reset on `turn_start`/`session_start`)
- [x] 4.5 Implement elapsed-time timer manager: arm on `agent_start`, one-shot vs `repeat`, `unref()`, clear on `agent_settled`/`session_shutdown` (injectable timer functions for tests)
- [x] 4.6 Unit tests for 4.1–4.5 covering every scenario in `specs/event-sound-triggers/spec.md` — verified passing (test/triggers.test.ts, 31 tests)

## 5. Extension entry (`src/index.ts`)

- [x] 5.1 Implement the default export factory: register `--no-sounds` flag (value captured once at factory time and re-captured at the head of the `session_start` dispatch — the first event of each session on the live `pi`, since CLI flag values are applied after factories run; all other handlers and timer callbacks use only the captured boolean), wire all event subscriptions (`session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_start`, `tool_result`, `message_end`, `turn_start`, `session_shutdown`) to triggers and player with best-effort wrappers; within the `session_start` dispatch, refresh the cached config BEFORE evaluating the `sessionStart` trigger; every other handler reads the cached config at fire time
- [x] 5.2 Loader-level integration test through `discoverAndLoadExtensions` asserting the extension is discovered and the flag is registered — verified passing (test/loader.test.ts, 2 tests)
- [x] 5.3 Unit tests with a mocked `pi` API object: each event fires the expected trigger, `--no-sounds` and `enabled: false` silence everything, handlers never throw — verified passing (test/extension.test.ts, 22 tests; one redundant elapsed-timer test removed during the verification pass, subsumed by the real-timer clear test and the never-throws suite)

## 6. Docs and verification

- [x] 6.1 Write `packages/pi-event-sounds/README.md`: purpose, install, settings.json reference (full annotated example), platform/sound-format support table, claude-code hook mapping example
- [x] 6.2 Run `pnpm run check` and fix all errors/warnings/infos
- [x] 6.3 Run `pnpm test` from repo root and iterate until green — pi-event-sounds is green (93/93; every other package verified green except pi-condense (19 failures), pi-session-recap (39 failures), and pi-accounts (hangs), all pre-existing from in-flight edits on the un-modified tree, with zero references to or from pi-event-sounds)
