# session-tracing Specification

## Purpose

TBD - created by archiving change add-pi-mlflow-tracing-extension.
Update Purpose after archive.

## Requirements

### Requirement: Trace boundary is one pi turn-cycle

The system SHALL create exactly one MLflow trace per pi turn-cycle, opening a root span on the `agent_start` event and closing that root span on the corresponding `agent_settled` event.
The system SHALL NOT create a single trace spanning an entire pi CLI session.

#### Scenario: A prompt with tool calls produces one trace

- **WHEN** the user sends a prompt that triggers `agent_start`, one or more turns with tool calls, and eventually `agent_settled`
- **THEN** exactly one MLflow trace is created for that turn-cycle, with its root span opened at `agent_start` and closed at `agent_settled`

#### Scenario: Multiple prompts in one session produce multiple traces

- **WHEN** the user sends two separate prompts in the same pi session, each completing its own `agent_start`...`agent_settled` cycle
- **THEN** two independent MLflow traces are created, each with its own root span

### Requirement: Traces are grouped by session via metadata

Every trace SHALL carry the pi session identifier as trace metadata (`mlflow.trace.session`), set via the tracing SDK's trace-metadata API, so traces from the same pi session can be filtered/grouped in the MLflow UI even though each is a separate trace.

#### Scenario: Two traces from the same session share a session tag

- **WHEN** two prompts are traced within the same pi CLI session
- **THEN** both resulting traces carry the same `mlflow.trace.session` metadata value

### Requirement: Turn spans nest under the trace root

Each pi turn (`turn_start`...`turn_end`) SHALL produce a child span of the trace's root span, using span type `CHAIN`.

#### Scenario: A turn-cycle with two turns produces two nested turn spans

- **WHEN** a turn-cycle involves two turns (e.g. one tool-calling turn followed by a final response turn)
- **THEN** the trace contains two `CHAIN`-typed spans, both children of the root span

### Requirement: LLM calls are traced as LLM spans

Each assistant LLM call within a turn SHALL produce a span of type `LLM`, nested under that turn's span, carrying token usage and cost information sourced from pi's own computed usage/cost data (not reconstructed from raw HTTP payload inspection).

#### Scenario: An LLM call records token usage

- **WHEN** an assistant message completes via `message_end` with usage data present
- **THEN** the corresponding `LLM` span records input/output/total token counts as span attributes

#### Scenario: An LLM call records cost

- **WHEN** an assistant message completes via `message_end` with cost data present on `event.message.usage.cost`
- **THEN** the corresponding `LLM` span records that cost as a span attribute

### Requirement: Tool executions are traced by call ID, not execution order

Each tool execution SHALL produce a span of type `TOOL`, tracked using the tool call's unique identifier (`toolCallId`) as the correlation key between `tool_execution_start` and `tool_execution_end`, rather than relying on start/end call ordering.

#### Scenario: Sequential tool calls are each traced correctly

- **WHEN** a turn executes two tools one after another
- **THEN** each tool produces its own `TOOL` span, correctly closed with its own result

#### Scenario: Parallel tool calls finishing out of start order are each traced correctly

- **WHEN** a turn starts two tools in parallel and the second tool's `tool_execution_end` fires before the first tool's `tool_execution_end`
- **THEN** each tool's span is closed with that specific tool's result, not the other tool's result

#### Scenario: A tool span still open when its turn ends is force-closed

- **WHEN** a turn's `turn_end` event fires while a tool span started during that turn has not yet received its `tool_execution_end`
- **THEN** the still-open tool span is force-closed with an incomplete status and remains a child of that turn's span, before the turn span itself closes

### Requirement: Compaction is traced according to its trigger and timing

Compaction events (`session_compact`) SHALL be placed in the span tree according to their `reason` and whether a trace is currently active, and SHALL NOT be traced at all when no trace is active.

#### Scenario: Overflow compaction nests under the turn it interrupted, and the retry stays a descendant of that turn

- **WHEN** `session_compact` fires with `reason: "overflow"` for a turn that has just ended (pi fires this compaction event after that turn's `turn_end`, not while it is still open)
- **THEN** a compaction span is created as a child of that (now-ended) turn's span; the retried LLM call that follows is recorded as a new `LLM` span nested under a new turn span, and that new turn span is itself nested under the compaction span — so the retry remains a descendant of the turn it overflowed rather than becoming a sibling of it under the trace root

#### Scenario: Manual or threshold compaction between turns nests under the trace root

- **WHEN** `session_compact` fires with `reason: "manual"` or `reason: "threshold"` while a trace's root span is open but no turn is currently in progress
- **THEN** a compaction span is created as a child of the trace's root span

#### Scenario: Compaction with no active trace is not traced

- **WHEN** `session_compact` fires while no root span is open (pi is idle between prompts)
- **THEN** no compaction span is created and the event is not recorded in any trace

### Requirement: Every trace is durably flushed

The root span for a trace SHALL be closed and the exporter flush SHALL be awaited at the corresponding `agent_settled` event for at most a fixed grace period, so that a crash occurring after one turn-cycle completes does not lose that turn-cycle's trace when the flush completes in time, without letting a slow or unreachable tracking server stall pi's settle path indefinitely.
The grace period bounds the flush wait only.
Other bounded work on the settle path — the git-provenance lookup awaited before the root ends, whose commands carry their own timeouts — is additive to it and is not governed by this requirement.
The system SHALL NOT cancel the in-flight export when the grace period elapses: the export continues in the background.
The system SHALL retain a normalized reference to an abandoned flush attempt and include it in the next flush attempt, awaiting the retained work for at most the same grace period; the system SHALL NOT rely on the tracing SDK re-joining an abandoned export on its own.
This retention is best-effort within one extension-instance lifetime — that is, within one session runtime: a concurrent flush attempt may supersede the retained reference, and rebuilding the extension instance (any session switch, extension reload, or working-directory change) discards it.
Every flush attempt SHALL attach handlers for both fulfillment and rejection of its underlying SDK promise, including when either occurs after the grace period has elapsed, so no flush attempt can produce an unhandled promise rejection.
Export failures and exports still unawaited when the process exits remain accepted losses (no local WAL).

#### Scenario: A completed turn-cycle is flushed before the next prompt

- **WHEN** `agent_settled` fires for a turn-cycle and the combined flush work completes within the grace period
- **THEN** that turn-cycle's root span is closed and `mlflow.flushTraces()` completion is awaited before the extension considers that trace complete

#### Scenario: A slow or unreachable server does not stall the settle flush wait

- **WHEN** `agent_settled` fires for a turn-cycle and the combined flush work has not completed within the grace period (for example, the tracking server died mid-session after a healthy startup)
- **THEN** the extension's `agent_settled` handling returns within the grace period measured from the start of the flush wait (plus any git-provenance wait still pending at that point, which is separately bounded and not governed here), instead of blocking on the SDK request timeouts; the in-flight export is not cancelled, and no retry loop or interactive warning is introduced

#### Scenario: A later attempt still awaits abandoned work

- **WHEN** a flush exceeded the grace period and another flush is later attempted (next turn-cycle's settle, or a session teardown) within the same session runtime — no session switch, extension reload, or working-directory change in between
- **THEN** that attempt includes the retained normalized reference to the abandoned flush as well as the current flush operation, awaiting both for at most the same grace period so earlier work is not silently forgotten by the extension

#### Scenario: A late flush rejection does not crash the process

- **WHEN** a flush promise that exceeded the grace period eventually rejects after the extension has already stopped waiting
- **THEN** the rejection is handled without producing an unhandled promise rejection

### Requirement: Open spans are swept and flushed at session shutdown

On `session_shutdown`, any span (root or child) still open SHALL be force-closed with an incomplete/warning status, and a final flush SHALL be triggered and awaited for at most the same fixed grace period that bounds the settle-path flush, so that an interrupted turn does not leave a dangling unflushed span and so that the extension's shutdown handling returns within that grace period instead of blocking on the SDK's request timeouts.
This requirement bounds the extension's shutdown handling only.
It does not bound process exit: the in-flight export SHALL NOT be cancelled when the grace period elapses, its uncancelled requests may keep the event loop busy afterwards, and whether the process exits promptly remains the host's decision, as before.
Exports still unawaited when a session is torn down or the process exits remain accepted losses (no local WAL).

#### Scenario: Session ends mid-turn

- **WHEN** `session_shutdown` fires while a turn's span is still open — whether from a shutdown signal (Ctrl+C, Ctrl+D, SIGHUP, or SIGTERM) or from a session teardown that does not exit the process (`/new`, `/resume`, `/fork`, session import, or an extension reload)
- **THEN** all open spans for that trace are force-closed with an incomplete status and a final flush is triggered before the session is torn down (process exit or session replacement)

#### Scenario: Teardown handling is not delayed by an unreachable server

- **WHEN** `session_shutdown` fires while the tracking server is slow or unreachable and the final flush does not complete within the grace period
- **THEN** the extension's shutdown handling returns within the grace period rather than blocking until the SDK's own request timeouts elapse, and the in-flight export is not cancelled

### Requirement: Root span status reflects final cycle outcome

The system SHALL end the root span with status `ERROR` when the terminal turn of the cycle is erroneous or was force-closed incomplete, and SHALL end it with status `OK` when the final turn of the cycle succeeds — including after a recovery attempt that follows an earlier failed turn within the same cycle.

#### Scenario: A terminal error turn marks the root ERROR

- **WHEN** the last turn of a turn-cycle ends with an assistant `error` or `aborted` stop reason
- **THEN** both that turn span and the root span end with status `ERROR`

#### Scenario: A successful recovery restores root OK

- **WHEN** an earlier turn in the cycle ends with `error`/`aborted` and a later recovery turn in the same cycle ends successfully
- **THEN** the root span ends with status `OK`
