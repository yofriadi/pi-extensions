## MODIFIED Requirements

### Requirement: Tools are unavailable-aware and never hang a session when tilth is missing

Every tool SHALL throw a static explanatory error (including remediation) when the transport resolved to unavailable at session start, without attempting a process spawn — pi's tool-error contract marks a result as error only when `execute()` throws.
When the transport is available, tools SHALL enforce the configured per-call timeout via `callTool`'s `timeoutMs: config.callTimeoutMs` parameter and surface timeout failures as thrown tool errors.

#### Scenario: Call while unavailable

- **WHEN** session probing resolved to unavailable and the model calls `tilth_search`
- **THEN** the tool throws the static unavailability error and no `tilth` child process is spawned

#### Scenario: Call exceeds per-call timeout

- **WHEN** a tool call exceeds `callTimeoutMs`
- **THEN** the in-process MCP client cancels the request and the tool throws a timeout error without leaving a hanging request
