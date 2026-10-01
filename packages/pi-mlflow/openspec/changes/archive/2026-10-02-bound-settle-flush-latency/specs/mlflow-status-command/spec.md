## ADDED Requirements

### Requirement: Status may report a degraded flush wait

The `/mlflow` command MAY report, as an additional status line while tracing remains active, that the most recent flush wait exceeded its grace period (degraded-but-active), including that the export continues in the background.
The system SHALL update this degraded indication at the end of each flush attempt, clearing it when an attempt completes within the grace period, SHALL NOT change tracing behavior based on it, and SHALL NOT present it as tracing being disabled.
This requirement adds no authority to display captured trace content; the existing content-exclusion requirement continues to govern all `/mlflow` output.

#### Scenario: Degraded flush is surfaced as active-with-slow-flush

- **WHEN** the most recent flush wait exceeded the grace period and the user runs `/mlflow` while tracing is otherwise active
- **THEN** the status output includes a degraded-flush indication alongside the active status, rather than reporting tracing as disabled

#### Scenario: Degraded indication clears on a subsequent bounded flush

- **WHEN** a later flush completes within the grace period
- **THEN** the degraded-flush indication is no longer reported by `/mlflow`

#### Scenario: Degraded indication is omitted while tracing is disabled

- **WHEN** tracing was silently disabled at startup and the user runs `/mlflow`
- **THEN** the command reports the disabled status and reason without displaying a degraded-flush or last-flush indication
