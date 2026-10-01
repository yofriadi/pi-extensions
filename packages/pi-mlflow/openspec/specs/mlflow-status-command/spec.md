# mlflow-status-command Specification

## Purpose

TBD - created by archiving change add-pi-mlflow-tracing-extension.
Update Purpose after archive.

## Requirements

### Requirement: A status command reports current tracing configuration and state

The system SHALL provide a `/mlflow` command that reports the configured tracking URI, the resolved experiment (name and ID, if resolved), the current content-capture mode, and whether tracing is currently active or disabled.

#### Scenario: Status shown while tracing is active

- **WHEN** the user runs `/mlflow` while tracing is active
- **THEN** the command displays the tracking URI, resolved experiment name and ID, content-capture mode, and an active status

#### Scenario: Status shown while tracing is disabled due to an unreachable server

- **WHEN** the user runs `/mlflow` after tracing was silently disabled at startup because the tracking server was unreachable
- **THEN** the command displays that tracing is disabled and states the reason (tracking server unreachable at startup), rather than showing misleading "last flush" information as if tracing were active

### Requirement: The status command never displays captured content

The `/mlflow` command SHALL display only configuration and status information, and SHALL NOT display captured trace content (prompts, tool arguments/outputs, provider payloads) even when content capture is enabled.

#### Scenario: Status output excludes trace content

- **WHEN** the user runs `/mlflow` with content capture enabled and traces already recorded
- **THEN** the command's output includes configuration and status only, not the content of any recorded trace

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
