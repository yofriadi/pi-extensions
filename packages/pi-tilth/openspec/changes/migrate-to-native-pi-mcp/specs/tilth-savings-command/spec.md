## MODIFIED Requirements

### Requirement: `/tilth-savings` reports the server's session savings on explicit user request

The extension SHALL register a `tilth-savings` command whose handler invokes the server's `tilth_savings` tool through the active in-process `McpClient` session and displays its output to the user.
The handler SHALL surface whatever savings report the persistent server session produces.
If the transport is not yet connected when the command is invoked, the handler SHALL trigger connection (bounded by `connectTimeoutMs` plus `callTimeoutMs`).
The capability SHALL NOT be exposed as a model-callable tool.

#### Scenario: User invokes the command

- **WHEN** the user runs `/tilth-savings` after file reads have occurred in the session
- **THEN** the in-process MCP client queries `tilth_savings` and the server's accumulated savings report is displayed to the user via UI notification

#### Scenario: User invokes the command before any reads

- **WHEN** the user runs `/tilth-savings` before any file reads have occurred
- **THEN** the command reports the server's initial empty notice (e.g. "No measured reads yet this session") without throwing an error

#### Scenario: Unavailable transport

- **WHEN** the user runs `/tilth-savings` after the session probe resolved tilth to unavailable
- **THEN** a notification shows the same remediation text the tools surface, and no process is spawned

#### Scenario: Server reports an error

- **WHEN** the `tilth_savings` call returns an `isError` result
- **THEN** the error text is shown as a warning notification, not swallowed
