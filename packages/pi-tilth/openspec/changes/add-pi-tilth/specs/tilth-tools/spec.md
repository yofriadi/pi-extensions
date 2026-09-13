## ADDED Requirements

The extension SHALL register six pi tools — `tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff` — each with a parameter schema mirroring the corresponding MCP tool's input schema (same parameter names, optionality, types, and documented defaults), and each with a description transcribed verbatim from the server's tool description as captured in the recorded schema fixture.
The sole sanctioned exception: `tilth_read` additionally accepts the client-side `raw` boolean (see the hashline-compat spec) — stripped before the call reaches the server, so the server-side schema stays mirrored exactly.
The extension SHALL NOT register `tilth_write`, SHALL NOT enable tilth's `--edit` mode, and SHALL NOT register `tilth_savings` as a tool.

### Scenario: Loader-level registration

- **WHEN** the extension is loaded through pi's extension loader (`loadExtensions` on the package's `src/index.ts`)
- **THEN** six tools named `tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff` are registered and no other tilth-prefixed tools exist

#### Scenario: Descriptions match the recorded server schema

- **WHEN** the registered `tilth_search` description is compared with the description in the recorded schema fixture captured during implementation (`test/fixtures`)
- **THEN** they are identical, character for character; the fixture is refreshed by re-dumping the live schema on tilth upgrades per the documented procedure

#### Scenario: No write surface

- **WHEN** the registered tool list is inspected
- **THEN** no `tilth_write` tool exists and the server is never invoked with `--edit`

### Requirement: Tools are unavailable-aware and never hang a session when tilth is missing

Every tool SHALL throw a static explanatory error (including remediation) when the transport resolved to unavailable at session start, without attempting a process spawn — pi's tool-error contract marks a result as error only when `execute()` throws.
When the transport is available, tools SHALL enforce the configured per-call timeout at the Exec seam and surface timeout failures as thrown tool errors.

#### Scenario: Call while unavailable

- **WHEN** session probing resolved to unavailable and the model calls `tilth_search`
- **THEN** the tool throws the static unavailability error and no `mcporter` process is spawned

### Requirement: Tool output is truncated predictably with full output recoverable

Each tool SHALL truncate its text output using pi's shared `truncateHead` with `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`; when truncated, the full output SHALL be written to a file under the OS temp directory and the tool result SHALL include the path to that file.
Output that fits SHALL be returned unmodified.

#### Scenario: Large search result

- **WHEN** a `tilth_search` call returns text exceeding the line or byte limit
- **THEN** the result contains the truncated head, a truncation notice, and a path to a file containing the complete output

### Requirement: Each tool provides prompt guidance without claiming to replace built-in tools

Each tool SHALL declare a `promptSnippet` and `promptGuidelines` that steer structural exploration (search-before-read, section-before-edit, deps-before-refactor) toward tilth.
The guidance SHALL NOT instruct the model that built-in tools are disabled or forbidden, because tool precedence across the user's other extensions is a user-level decision.

#### Scenario: Guidelines are advisory

- **WHEN** the system prompt is assembled with this extension active
- **THEN** tilth guidelines recommend when to prefer tilth, and nowhere state that pi's built-in read/grep/ls tools are unavailable or forbidden

### Requirement: A tilth skill ships with the package

The package SHALL ship `skills/tilth/SKILL.md` (registered via `pi.skills`) that teaches tool selection among the six tools, root/scope semantics, the section-before-edit flow, and when tilth is the wrong tool; it SHALL be adapted from tilth's upstream skill to pi's tool surface rather than copied blindly.
Because the adaptation derives from tilth's MIT-licensed material, the package SHALL ship tilth's license text under `THIRD_PARTY_LICENSES/`.

#### Scenario: Skill discovers tilth tools

- **WHEN** the package is installed and the agent loads skills
- **THEN** a `tilth` skill is available whose instructions reference the six pi tools by name and describe root/scope behavior
