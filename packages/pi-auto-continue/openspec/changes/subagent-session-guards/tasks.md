# Tasks

## 1. Environment guard

- [x] `SUBAGENT_ENV_VARS = ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID"]` and
  `SUBAGENT_DONE_TOOL_NAMES = ["subagent_done"]` constants in
  `src/constants.ts`.
- [x] `AutoContinueConfig.subagent: boolean` (default `false`) in
  `src/types.ts`; parsed in `src/config.ts` (`subagent: rawConfig.subagent
  === true`); `DEFAULT_CONFIG.subagent = false`.
- [x] `isSubagentSession()` + `isAutoActive()` predicates in
  `src/index.ts`; `message_end`, `before_agent_start` guidance, and
  `agent_settled` early-out when `!isAutoActive()`.

## 2. Done-tool guard

- [x] `tool_execution_end` handler: on a done-tool name with `isError ===
  false`, set `shuttingDown = true` and `resetTurnState()` (aborts pending
  retry sleeps via `activeAbortController.abort()`). Failed done-tool
  executions (sidecar write error before `ctx.shutdown()`) do NOT engage
  the guard.
- [x] All automatic handlers early-out while `shuttingDown`.
- [x] `session_start` clears the flag; `input` from `interactive`/`rpc`
  sources clears the flag (re-arm on human steering). The re-arm runs
  before the `config.enabled` early-out so it works while the extension
  is disabled.

## 3. Observability

- [x] `/auto-continue status` prints `Subagent session: yes/no
  (auto-continue inactive)` and `Shutdown pending (done-tool ran): yes/no`.

## 4. Tests

- [x] `subagent guards` suite (10 tests): env guard (both vars), opt-in,
  done-tool blocks retry + token continuation + guidance, mid-sleep
  abort, interactive re-arm, status output, failed done-tool does not
  engage guard, re-arm while disabled. Baseline suites snapshot/clear/
  restore `PI_SUBAGENT_SESSION`/`PI_SUBAGENT_ID` so tests pass when run
  inside a herdr child process.

## 5. Docs

- [x] README fork-notes §4 "Subagent session guards", config table row,
  example JSON key.
- [x] AGENTS.md component notes.

## 6. Verification

- [x] `npm test` — 128/128 pass (including under
  `PI_SUBAGENT_ID=… PI_SUBAGENT_SESSION=…`).
- [x] `npm run typecheck` — clean.
- [x] Root `pnpm run check` — clean.
