## ADDED Requirements

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
