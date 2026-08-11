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

The root span for a trace SHALL be closed and the exporter flush SHALL be awaited at the corresponding `agent_settled` event, so that a crash occurring after one turn-cycle completes does not lose that turn-cycle's trace.
Export failures remain accepted (no local WAL).

#### Scenario: A completed turn-cycle is flushed before the next prompt

- **WHEN** `agent_settled` fires for a turn-cycle
- **THEN** that turn-cycle's root span is closed and `mlflow.flushTraces()` completion is awaited before the extension considers that trace complete

### Requirement: Open spans are swept and flushed at session shutdown

On `session_shutdown`, any span (root or child) still open SHALL be force-closed with an incomplete/warning status, and a final flush SHALL be triggered, so that an interrupted turn does not leave a dangling unflushed span.

#### Scenario: Session ends mid-turn

- **WHEN** the pi process receives a shutdown signal (Ctrl+C, Ctrl+D, SIGHUP, or SIGTERM) while a turn's span is still open
- **THEN** all open spans for that trace are force-closed with an incomplete status and a final flush is triggered before the process exits

### Requirement: Root span status reflects final cycle outcome

The system SHALL end the root span with status `ERROR` when the terminal turn of the cycle is erroneous or was force-closed incomplete, and SHALL end it with status `OK` when the final turn of the cycle succeeds — including after a recovery attempt that follows an earlier failed turn within the same cycle.

#### Scenario: A terminal error turn marks the root ERROR

- **WHEN** the last turn of a turn-cycle ends with an assistant `error` or `aborted` stop reason
- **THEN** both that turn span and the root span end with status `ERROR`

#### Scenario: A successful recovery restores root OK

- **WHEN** an earlier turn in the cycle ends with `error`/`aborted` and a later recovery turn in the same cycle ends successfully
- **THEN** the root span ends with status `OK`
