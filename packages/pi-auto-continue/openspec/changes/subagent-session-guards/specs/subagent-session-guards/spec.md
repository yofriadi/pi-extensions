# ADDED Capability: `subagent-session-guards`

## ADDED Requirements

### Requirement: Auto-continue is inactive inside supervised subagent sessions

The extension SHALL detect supervised subagent sessions via the
`PI_SUBAGENT_SESSION` or `PI_SUBAGENT_ID` environment variables and
disable all automatic retry/continuation behavior in them (no automatic
retry prompts, no system-prompt guidance injection, no recovery
notifications), unless `autoContinue.subagent` is explicitly `true`.
Manual use of the `/auto-continue` command SHALL remain available.

#### Scenario: Subagent session detected via env

- **WHEN** the extension is initialized in a process where
  `PI_SUBAGENT_SESSION` or `PI_SUBAGENT_ID` is set and
  `autoContinue.subagent` is not `true`
- **THEN** a `message_end` with a retryable error does not schedule a
  retry, and `before_agent_start` does not inject the Auto-Continue
  guidance into the system prompt

#### Scenario: Explicit opt-in

- **WHEN** a subagent session is detected but `autoContinue.subagent` is
  `true`
- **THEN** automatic retries behave exactly as in a normal session

### Requirement: Done-tool terminates all autonomous continuation

After a tool named `subagent_done` (or any name listed in
`SUBAGENT_DONE_TOOL_NAMES`) finishes executing, the extension SHALL treat
the session as shutting down: abort any pending retry wait, reset retry
state, and skip all automatic interruption handling — for every
interruption class, not only rate limits — regardless of environment
variables.

#### Scenario: No retry after subagent_done

- **WHEN** `subagent_done` has executed and a later assistant `message_end`
  carries a retryable error (rate limit, token limit, incomplete tool
  call)
- **THEN** no retry or continuation prompt is sent and no system-prompt
  guidance is injected

#### Scenario: Pending retry aborted mid-sleep

- **WHEN** a retry delay is pending (sleep in flight) and `subagent_done`
  executes
- **THEN** the pending wait is aborted and the retry prompt is never sent

#### Scenario: Fresh interactive input re-arms

- **WHEN** the session is in the shutting-down state and the user sends a
  new interactive or RPC message
- **THEN** automatic retry behavior is re-armed for the new user turn

### Requirement: Guard state is observable

The `/auto-continue status` output SHALL report whether the current
process is a detected subagent session (and whether auto-continue is
therefore inactive) and whether a done-tool has executed in the current
session.

#### Scenario: Status reflects guards

- **WHEN** `/auto-continue status` runs in a detected subagent session or
  after `subagent_done` executed
- **THEN** the output includes `Subagent session: yes (auto-continue
  inactive)` and/or `Shutdown pending (done-tool ran): yes`
