# Capability: event-sound-triggers

## Purpose

Mapping of Pi lifecycle events and derived conditions (quota responses, turn milestones, elapsed time) to sound triggers.

## Requirements

### Requirement: Lifecycle event triggers

The system SHALL fire the configured trigger for each of these Pi events: `sessionStart` on `session_start`, `promptSubmit` on `input`, `agentStart` on `agent_start`, `agentSettled` on `agent_settled`, and `question` on `ui_prompt_start` (requires `@earendil-works/pi-coding-agent` ≥ 0.85.1, the declared peer floor).
A trigger whose configured file list is empty or absent MUST NOT fire.
On `session_start` dispatch, the configuration cache MUST be refreshed before the `sessionStart` trigger is evaluated, so a settings edit taking effect with the new session also governs the session-start sound.

#### Scenario: Prompt submit triggers configured sound

- **WHEN** an `input` event is received and `promptSubmit` lists one file
- **THEN** playback of that file is scheduled (asynchronously, fire-and-forget) at the time the input is received, before agent processing begins

#### Scenario: All input sources trigger

- **WHEN** an `input` event arrives with `source` of `"interactive"`, `"rpc"`, or `"extension"` and `promptSubmit` is configured
- **THEN** the trigger fires for every source value

#### Scenario: Unconfigured event stays silent

- **WHEN** `agent_settled` fires and `agentSettled` is not configured
- **THEN** no playback occurs

#### Scenario: Config refresh precedes session-start sound

- **WHEN** a `session_start` event fires and the settings file was edited since the previous session
- **THEN** the refreshed configuration governs whether and which `sessionStart` sound plays

### Requirement: Error trigger with per-turn dedupe

The system SHALL fire the `error` trigger when a `tool_result` event has `isError: true`, and MUST fire at most once per turn regardless of how many tool errors occur in that turn.
The dedupe state MUST reset on `turn_start` and `session_start`.

#### Scenario: Three tool errors in one turn

- **WHEN** three `tool_result` events with `isError: true` arrive within one turn
- **THEN** the error sound plays exactly once

### Requirement: Quota triggers on assistant error text

The system SHALL classify assistant error messages (`message_end` with `stopReason: "error"`) into two distinct provider-failure triggers: `quota` for transient throttling — `errorMessage` matching (case-insensitively) a `quotaPatterns` entry (defaults: `429`, `rate.?limit`, `too many requests`, `overloaded`, `service.?unavailable`, `server.?error`, `internal.?error`, `provider.?returned.?error`, grounded in `@earendil-works/pi-ai`'s RETRYABLE_PROVIDER_ERROR_PATTERN) — and `quotaExhausted` for terminal quota exhaustion — `errorMessage` matching an `exhaustedPatterns` entry (defaults: `insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, `available balance`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, grounded in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN).
When both match, `quotaExhausted` MUST take precedence.
Repeated matching messages within a shared 5-second window MUST be deduped so automatic retries play at most one sound.
A trigger MUST NOT fire when its own file list is empty — an unconfigured `quotaExhausted` MUST NOT fall back to `quota`.

#### Scenario: Rate-limit error message

- **WHEN** a `message_end` event carries an assistant message with `stopReason: "error"` and `errorMessage` `"Rate limit reached (429)"`, and `quota` lists one file
- **THEN** that file plays once

#### Scenario: Quota-exhausted error message

- **WHEN** a `message_end` event carries an assistant message with `stopReason: "error"` and `errorMessage` `"insufficient_quota: billing hard limit reached"`, and `quotaExhausted` lists one file
- **THEN** that file plays once

#### Scenario: Exhaustion takes precedence over transient

- **WHEN** the error text matches both a `quotaPatterns` entry and an `exhaustedPatterns` entry, and both triggers list files
- **THEN** only the `quotaExhausted` sound plays

#### Scenario: Unconfigured exhausted trigger does not fall back

- **WHEN** the error text matches only `exhaustedPatterns`, `quotaExhausted` lists no files, and `quota` lists files
- **THEN** no sound plays

#### Scenario: Retry storm dedupe

- **WHEN** four assistant `message_end` error events with quota-matching text arrive within two seconds
- **THEN** the quota sound plays exactly once

#### Scenario: Non-quota error message

- **WHEN** a `message_end` event carries an assistant message with `stopReason: "error"` and `errorMessage` `"Unexpected EOF"`
- **THEN** no quota sound plays

#### Scenario: Successful assistant message

- **WHEN** a `message_end` event carries an assistant message with `stopReason: "stop"`
- **THEN** no quota sound plays

### Requirement: Turn-count milestone trigger

The system SHALL fire the turn-milestone trigger on `turn_start` when `turnIndex` is greater than zero and divisible by the configured `turns.every` value.
The trigger MUST NOT fire when `turns` or `turns.files` is unconfigured or empty.

#### Scenario: Turn 100 with every=100

- **WHEN** `turn_start` arrives with `turnIndex: 100` and `turns.every` is 100
- **THEN** a randomly chosen file from `turns.files` plays

#### Scenario: Turn 37 with every=100

- **WHEN** `turn_start` arrives with `turnIndex: 37` and `turns.every` is 100
- **THEN** no turn-milestone sound plays

### Requirement: Elapsed-time trigger

The system SHALL arm a timer on `agent_start` when `elapsed.seconds` and `elapsed.files` are configured, fire the elapsed trigger after `elapsed.seconds` have passed, and repeat every `elapsed.seconds` while the agent is still running when `elapsed.repeat` is true.
Timers MUST be cleared on `agent_settled` and `session_shutdown`, and MUST be `unref()`'d so they never keep the process alive.

#### Scenario: One-shot five-minute reminder

- **WHEN** `elapsed.seconds` is 300, `elapsed.repeat` is false, and the agent runs for more than 5 minutes
- **THEN** the elapsed sound plays exactly once, 300 seconds after `agent_start`

#### Scenario: Timer cleared on settle

- **WHEN** `agent_settled` fires 60 seconds after `agent_start` with `elapsed.seconds` of 300
- **THEN** the elapsed sound never plays for that run

#### Scenario: Repeating timer

- **WHEN** `elapsed.seconds` is 300, `elapsed.repeat` is true, and the agent runs for 11 minutes
- **THEN** the elapsed sound plays at 300 and 600 seconds (twice)
