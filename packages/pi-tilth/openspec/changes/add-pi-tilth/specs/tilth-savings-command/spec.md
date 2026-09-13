## ADDED Requirements

### Requirement: `/tilth-savings` reports the server's session savings on explicit user request

The extension SHALL register a `tilth-savings` command whose handler invokes the server's `tilth_savings` tool through the same transport as the six tools and displays its output to the user.
The capability SHALL NOT be exposed as a model-callable tool, matching the server's own restriction that it is called only on explicit user request.

#### Scenario: User invokes the command

- **WHEN** the user runs `/tilth-savings` with an available transport
- **THEN** the server's savings report is displayed to the user

#### Scenario: Unavailable transport

- **WHEN** the user runs `/tilth-savings` after the session probe resolved tilth to unavailable
- **THEN** a notification shows the same remediation text the tools surface, and no process is spawned

#### Scenario: Server reports an error

- **WHEN** the `tilth_savings` call returns an `isError` envelope
- **THEN** the error text is shown as a warning notification, not swallowed
