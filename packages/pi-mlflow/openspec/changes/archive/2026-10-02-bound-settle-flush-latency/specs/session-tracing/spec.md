## MODIFIED Requirements

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
