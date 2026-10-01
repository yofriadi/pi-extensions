# Delta: event-sound-triggers

## MODIFIED Requirements

### Requirement: Lifecycle event triggers

The system SHALL fire the configured trigger for each of these Pi events: `sessionStart` on `session_start`, `promptSubmit` on `input`, `agentStart` on `agent_start`, and `question` on `ui_prompt_start` (requires `@earendil-works/pi-coding-agent` ≥ 0.85.1, the declared peer floor).
The system SHALL fire `agentSettled` on `agent_settled` only when the settled run's recorded outcome is `settled` or `unknown`; the outcome rules in "Settled-run outcome latch" and "Outcome-specific settle sounds" govern that trigger, and `agentSettled` MUST NOT fire when the outcome is `failed` or `aborted`.
A trigger whose configured file list is empty or absent MUST NOT fire, except where that trigger's own requirement defines a fallback list.
On `session_start` dispatch, the configuration cache MUST be refreshed before the `sessionStart` trigger is evaluated, so a settings edit taking effect with the new session also governs the session-start sound.

#### Scenario: Prompt submit triggers configured sound

- **WHEN** an `input` event is received and `promptSubmit` lists one file
- **THEN** playback of that file is scheduled (asynchronously, fire-and-forget) at the time the input is received, before agent processing begins

#### Scenario: All input sources trigger

- **WHEN** an `input` event arrives with `source` of `"interactive"`, `"rpc"`, or `"extension"` and `promptSubmit` is configured
- **THEN** the trigger fires for every source value

#### Scenario: Unconfigured event stays silent

- **WHEN** `agent_settled` fires with a recorded outcome of `settled`, `agentSettled` lists no files, and `agentFailed` lists no files
- **THEN** no playback occurs

#### Scenario: Config refresh precedes session-start sound

- **WHEN** a `session_start` event fires and the settings file was edited since the previous session
- **THEN** the refreshed configuration governs whether and which `sessionStart` sound plays

## ADDED Requirements

### Requirement: Settle-run outcome latch

The system SHALL record the outcome of a run from the `agent_end` event by reading the `stopReason` of the last assistant message in `event.messages`, classifying it as `failed` on `"error"`, `aborted` on `"aborted"`, and `settled` on any other value, and MUST classify outcome from `stopReason` alone without inspecting `errorMessage` text.
The latch MUST be reset to `unknown` on every `agent_start` (including the `agent_start` Pi emits when it re-enters the loop for an automatic retry or a compaction continuation), on every `agent_settled` after the outcome has been consumed, and on `session_start`.
When `agent_settled` fires with no `agent_end` observed since the last reset, the outcome MUST be `unknown` and MUST be treated as `settled` for sound selection.

#### Scenario: Provider error ends the run

- **WHEN** `agent_end` carries messages whose last assistant message has `stopReason: "error"`, followed by `agent_settled`
- **THEN** the recorded outcome is `failed`

#### Scenario: Retry storm then success

- **WHEN** a run emits `agent_end` with a last assistant `stopReason` of `"error"`, then `agent_start` again for an automatic retry, then `agent_end` with a last assistant `stopReason` of `"stop"`, then `agent_settled`
- **THEN** the recorded outcome is `settled`, not `failed`

#### Scenario: Abort is classified apart from error

- **WHEN** `agent_end` carries a last assistant message with `stopReason: "aborted"`, followed by `agent_settled`
- **THEN** the recorded outcome is `aborted` and not `failed`

#### Scenario: Outcome does not leak into the next run

- **WHEN** a run settles with outcome `failed` and the next `agent_settled` arrives without any intervening `agent_end`
- **THEN** the outcome consumed at the second settle is `unknown` and the `agentSettled` trigger is eligible

#### Scenario: Truncated output is not a failure

- **WHEN** `agent_end` carries a last assistant message with `stopReason: "length"`, followed by `agent_settled`
- **THEN** the recorded outcome is `settled`

### Requirement: Outcome-specific settle sounds

The system SHALL, on `agent_settled`, fire `agentFailed` instead of `agentSettled` when the recorded outcome is `failed`, and MUST select that trigger's file list as `agentFailed` when it is non-empty, otherwise the `error` file list (a fallback of file lists only).
Firing `agentFailed` MUST NOT read or modify the per-turn `error` dedupe state, so a failed run that already played the `error` sound for a tool error in the same turn still plays its failure sound.
The system SHALL, on `agent_settled`, fire `agentAborted` instead of `agentSettled` when the recorded outcome is `aborted`, and MUST play nothing when `agentAborted` lists no files; `agentAborted` MUST NOT fall back to `error` or to `agentFailed`.
Both triggers MUST draw from a randomly chosen file of their resolved list, exactly like any other event trigger.

#### Scenario: Failed run plays its configured sound

- **WHEN** the outcome is `failed`, `agentFailed` lists `["death.wav"]`, and `error` lists `["wut.wav"]`
- **THEN** `death.wav` plays and `agentSettled` does not

#### Scenario: Failed run inherits the error list

- **WHEN** the outcome is `failed`, `agentFailed` lists no files, and `error` lists `["wut.wav"]`
- **THEN** `wut.wav` plays and `agentSettled` does not

#### Scenario: Failure sound survives an earlier tool error in the same turn

- **WHEN** a `tool_result` with `isError: true` has already played the `error` sound in the current turn, the outcome becomes `failed`, and `agentFailed` lists no files
- **THEN** the failure sound still plays, chosen from the `error` file list

#### Scenario: Aborted run is silent by default

- **WHEN** the outcome is `aborted`, `agentAborted` lists no files, `error` lists files, and `agentSettled` lists files
- **THEN** no playback occurs

#### Scenario: Aborted run with its own sound

- **WHEN** the outcome is `aborted` and `agentAborted` lists `["cancelled.wav"]`
- **THEN** `cancelled.wav` plays and neither `agentSettled` nor the `error` list is used

#### Scenario: Neither failure nor abort configured

- **WHEN** the outcome is `failed`, and `agentFailed`, `error`, and `agentSettled` all list no files
- **THEN** no playback occurs and no error is raised

#### Scenario: Elapsed timer is cleared regardless of outcome

- **WHEN** the outcome is `failed` and an elapsed-time timer is armed
- **THEN** the timer is cleared at `agent_settled` before any settle sound selection takes effect
