## ADDED Requirements

### Requirement: Structural metadata is always captured

The system SHALL always capture structural, non-content metadata on traces and spans, regardless of the content-capture setting: token usage, cost, the final HTTP status code of each provider call, git branch/commit, compaction statistics, and attempt/turn indices.

#### Scenario: Metadata is present even with content capture disabled

- **WHEN** content capture is disabled (default configuration)
- **THEN** traces still include token usage, cost, git metadata, and turn/attempt indices

#### Scenario: Git metadata reflects the repository at run start

- **WHEN** a turn-cycle is traced while the pi process is running inside a Git repository
- **THEN** the trace's metadata includes the current branch and commit at the time the run started, even when git resolution takes longer than 100 ms (subject to each git command's own timeout), because settle awaits the already-started provenance lookup before ending/exporting the root

### Requirement: Full content capture is opt-in and disabled by default

The system SHALL NOT record full prompt text, tool call arguments/outputs, or provider request/response payload bodies on any trace or span unless content capture is explicitly enabled in configuration.
Content capture SHALL default to disabled.

#### Scenario: Content is withheld by default

- **WHEN** the configuration does not set content capture to enabled
- **THEN** no full prompt text, tool argument/output bodies, or provider payload bodies are recorded on any span

#### Scenario: Content is recorded when explicitly enabled

- **WHEN** the configuration explicitly enables content capture
- **THEN** prompt text, tool argument/output bodies, and provider payload bodies are recorded on the relevant spans

### Requirement: HTTP status metadata excludes response bodies

When recording the HTTP status of a provider request, the system SHALL record the status code only, and SHALL NOT record HTTP response bodies as part of this always-on structural metadata, regardless of the content-capture setting.

Note: pi's extension API does not expose per-attempt status information for a provider request that pi retried internally — only the status of the attempt that ultimately succeeded is observable (`after_provider_response` fires at most once per provider call, for the successful attempt only).
The system therefore records that single final status code; it does not report a retry count or a sequence of per-attempt statuses.

#### Scenario: A completed request records its status code without a body

- **WHEN** a provider request completes (whether or not pi retried it internally before it succeeded)
- **THEN** the LLM span records the final HTTP status code, without recording any response body content

### Requirement: Session and provenance metadata uses reserved trace metadata keys

The system SHALL set session-grouping and git-provenance information using the tracing SDK's trace-level metadata mechanism with its reserved metadata keys, and SHALL NOT set this information as free-form tags.

#### Scenario: Session identifier is set as metadata, not a tag

- **WHEN** a trace is created for a turn-cycle within a pi session
- **THEN** the pi session identifier is set via the trace's reserved session metadata key, not via a free-form tag

#### Scenario: Git commit is set as metadata, not a tag

- **WHEN** a trace is created while running inside a Git repository with a resolvable commit
- **THEN** the git commit is set via the trace's reserved git-provenance metadata key, not via a free-form tag
