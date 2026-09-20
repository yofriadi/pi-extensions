# Change: subagent-session-guards

## Why

A herdr-launched code-reviewer subagent kept receiving auto-continue
resume prompts after it called `subagent_done`, for ~78 minutes, until the
user manually aborted the pane. Root cause chain (forensic analysis of
`~/.pi/agent/sessions/--Users-ycm-Developer-oss-pi-extensions-packages-pi-auto-continue--/2026-09-14T22-22-16-449Z_*-ac2da100-d225d1c0-01ecdd.jsonl`):

1. pi-auto-continue runs inside subagent sessions with full retry wiring —
   herdr sets `PI_SUBAGENT_SESSION`/`PI_SUBAGENT_ID` env vars
   (`packages/pi-subagent-herdr/src/subagent-launch.ts:722-723`) but
   nothing in this extension notices them.
2. `subagent_done` calls `ctx.shutdown()`, which is *deferred*: pi sets a
   `shutdownRequested` flag and only exits when the session goes idle.
3. The in-flight tool-result→provider request timed out (16 min), the
   error turn was classified `RATE_LIMIT` (transient-transport patterns),
   and each retry prompt (`sendUserMessage(".", followUp)`) re-armed the
   agent, resetting the idle clock — a self-sustaining zombie loop.

## What Changes

- **Environment guard**: `SUBAGENT_ENV_VARS = ["PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ID"]` in `src/constants.ts`. When either is set, the new
  `isAutoActive()` predicate disables every automatic path
  (`message_end` handling, `before_agent_start` guidance injection,
  `agent_settled` recovery notices). `/auto-continue` stays usable
  manually. New `AutoContinueConfig.subagent: boolean` (default `false`)
  opts back in via settings (`autoContinue.subagent: true`).
- **Done-tool guard**: new `tool_execution_end` handler in
  `src/index.ts`; when a tool named in `SUBAGENT_DONE_TOOL_NAMES`
  (`["subagent_done"]`) executes, it sets a session-local `shuttingDown`
  flag and calls `resetTurnState()` (aborts any pending retry sleep).
  All automatic handlers early-out while the flag is set. Fresh
  `interactive`/`rpc` input clears the flag (human steering re-arms).
- **Status visibility**: `/auto-continue status` reports
  `Subagent session: yes/no (auto-continue inactive)` and
  `Shutdown pending (done-tool ran): yes/no`.
- **Tests**: new `subagent guards` suite in `tests/extension.test.ts`
  (8 tests), including the key regression: a `message_end` after a
  `subagent_done` tool execution must not schedule a retry, and a pending
  retry wait must be aborted when `subagent_done` executes mid-sleep.
- **Docs**: README fork-notes §4 + config table row; AGENTS.md component
  notes.

## Capability

### Added

- `subagent-session-guards`: the extension MUST NOT autonomously retry or
  continue inside supervised subagent sessions unless explicitly opted
  in, and MUST NOT resurrect a session after its done-tool executed.

## Risks

- Non-herdr supervisors that set neither env var nor use a tool named
  `subagent_done` are not covered; the done-tool name list is the
  extension point (`SUBAGENT_DONE_TOOL_NAMES`).
- Users who *want* auto-continue inside their own subagent workflows must
  set `autoContinue.subagent: true`; behavior change is documented in the
  README.
