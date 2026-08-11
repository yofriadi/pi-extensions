# mlflow-session-chat-summary Specification

## Purpose

TBD - created by archiving change add-mlflow-session-chat-bubbles.
Update Purpose after archive.

## Requirements

### Requirement: Root span carries a capture-gated chat turn summary

When `captureContent` is true, the system SHALL call the root `AGENT` span’s input/output setters with the cycle’s user prompt and final assistant summary as JavaScript strings before the root span is ended, so MLflow Chat Sessions can render chat bubbles from root I/O after normal SDK attribute serialization/deserialization.
When `captureContent` is false, the system SHALL NOT call those setters for the chat turn summary, and the exported root span SHALL omit chat-summary input and output attribute values (no `inputs` / `outputs` present on the root span for that summary — same observable form as other capture-off content omissions in existing lifecycle tests).

#### Scenario: Capture on publishes string root I/O at settle

- **WHEN** `captureContent` is true and a turn-cycle completes via `agent_settled` after a user prompt and at least one assistant message with text content
- **THEN** the root span’s inputs and outputs, as observed through the SDK’s deserialized span accessors (or equivalent test spies on `setInputs` / `setOutputs`), are strings equal to that cycle’s user prompt and the last non-empty assistant text from the cycle respectively

#### Scenario: Capture off leaves root without summary I/O attributes

- **WHEN** `captureContent` is false and a turn-cycle completes via `agent_settled`
- **THEN** the exported root span has no chat-turn-summary `inputs` or `outputs` values (deserialized root `inputs` and `outputs` are absent/undefined), matching capture-off assertions used for child span content

### Requirement: User prompt for the summary comes from before_agent_start

When `captureContent` is true, the system SHALL record the user prompt for the root summary from the `before_agent_start` event’s `prompt` field (post skill/template expansion) for the turn-cycle that opens the root span.

#### Scenario: Expanded prompt is stashed for the open cycle

- **WHEN** `captureContent` is true and `before_agent_start` fires with a non-empty `prompt` before the cycle’s root span is ended
- **THEN** that `prompt` value is used as the root span inputs string published for the cycle

#### Scenario: Re-entrant agent_start does not clear the stashed prompt

- **WHEN** `captureContent` is true and a second `agent_start` occurs in the same turn-cycle while the root span is already open (retry or continue)
- **THEN** the previously stashed user prompt for that cycle remains available for the root summary at settle

### Requirement: Assistant summary prefers last non-empty text then error

When `captureContent` is true, the system SHALL derive root outputs from assistant `message_end` events in the cycle by taking the last non-empty plain-text extraction from assistant message content (text parts only).
If no such text exists and an assistant `message_end` in the cycle has `stopReason` of `error` or `aborted`, the system SHALL set the outputs string from a structurally read string `errorMessage` on that message when present and non-empty; otherwise the system SHALL use the `stopReason` string itself.
If neither text nor error/abort summary exists, the system MAY use an empty string.

#### Scenario: Last prose wins over a later tool-only or empty assistant

- **WHEN** `captureContent` is true and an earlier assistant message in the cycle has text content and a later assistant message has only tool calls or empty content
- **THEN** root outputs equal the earlier non-empty assistant text

#### Scenario: Error cycle without assistant text uses error summary

- **WHEN** `captureContent` is true and the cycle produces no non-empty assistant text and a terminal assistant `error` or `aborted` stop reason is observed on `message_end`
- **THEN** root outputs equal a non-empty structural `errorMessage` when present on the message, otherwise equal the `stopReason` string (`error` or `aborted`)

### Requirement: Summary is published on settle and on shutdown if still open

On `agent_settled`, after force-closing incomplete child tool/LLM/turn spans and before ending the root span, the system SHALL publish the capture-gated root turn summary.
If `session_shutdown` runs while the root span is still open, the system SHALL publish the same summary (when `captureContent` is true) after the shutdown path’s child force-closes and before force-closing or ending the root.
Pending chat-summary state fields SHALL be cleared only in the settle/shutdown cycle reset after the root ends, not inside the publish helper and not on re-entrant `agent_start`.

#### Scenario: Settled path publishes after child force-close then ends root

- **WHEN** `agent_settled` fires with an open root span and `captureContent` is true
- **THEN** root inputs/outputs for the chat summary are set after incomplete child spans have been force-closed and before the root span is closed and traces are flushed

#### Scenario: Shutdown mid-cycle still publishes when capture on

- **WHEN** `session_shutdown` fires while a root span is open and `captureContent` is true and a user prompt was recorded for the cycle
- **THEN** root inputs are set from that prompt (and outputs from any recorded assistant summary or error) before the root is force-closed

### Requirement: Chat.messages belt is required if string I/O does not bubble

After implementing string root inputs/outputs, the implementer SHALL verify Chat Sessions bubbles on the documented MLflow server UI baseline (3.14.0 or the version recorded in verification notes).
If bubbles do not appear with string I/O alone, the system SHALL also set a root `mlflow.chat.messages` attribute to a two-message user/assistant array built from the same summary strings before the change is considered complete.

#### Scenario: Manual verification gates optional belt promotion

- **WHEN** string root inputs/outputs are exported with `captureContent` true but the Chat Sessions turn body on the baseline server UI still shows no user/assistant bubbles
- **THEN** the implementation adds root `mlflow.chat.messages` with the summary user and assistant strings and re-verifies until bubbles appear or a documented UI limitation is recorded

### Requirement: Operators are informed that Sessions needs content capture

Project documentation for the extension SHALL state that MLflow Chat Sessions conversation (bubbles / turn Inputs and Outputs) requires content capture, that content capture defaults to enabled, and that when it is explicitly disabled the Sessions turn body remains empty by design while structural tracing still works.
The README, `pi-mlflow.example.json` guidance, and the `/mlflow` status or command help surface SHALL collectively carry that information, as scoped by the scenarios below.

#### Scenario: README documents the requirement

- **WHEN** an operator reads the extension README for Chat Sessions or content capture
- **THEN** they are informed that content capture is required for session conversation bubbles and that it defaults to enabled

#### Scenario: Example config documents the requirement

- **WHEN** an operator reads `pi-mlflow.example.json` (or its adjacent documented keys)
- **THEN** they are informed that `captureContent` controls Sessions conversation text as well as child span bodies

#### Scenario: Status command surfaces content-capture implication for Sessions

- **WHEN** an operator runs the `/mlflow` status command
- **THEN** the status or help text indicates that content capture controls whether Sessions conversation text is recorded
