## MODIFIED Requirements

### Requirement: Structural metadata is always captured

The system SHALL always capture structural, non-content metadata on traces and spans, regardless of the content-capture setting: token usage, cost, the final HTTP status code of each provider call, git branch/commit, compaction statistics, and attempt/turn indices.

#### Scenario: Metadata is present even with content capture disabled

- **WHEN** content capture is explicitly disabled in configuration
- **THEN** traces still include token usage, cost, git metadata, and turn/attempt indices

#### Scenario: Git metadata reflects the repository at run start

- **WHEN** a turn-cycle is traced while the pi process is running inside a Git repository
- **THEN** the trace's metadata includes the current branch and commit at the time the run started, even when git resolution takes longer than 100 ms (subject to each git command's own timeout), because settle awaits the already-started provenance lookup before ending/exporting the root

## REMOVED Requirements

### Requirement: Full content capture is opt-in and disabled by default

**Reason**: The extension's premise is personal, local-only tracing against a user-managed server, and its primary readability feature (MLflow Chat Sessions bubbles) is invisible unless content capture is enabled.
The SaaS-style opt-in default is replaced by an opt-out default.
**Migration**: To keep the previous structure-only behavior, set `"captureContent": false` explicitly in `pi-mlflow.json`.

## ADDED Requirements

### Requirement: Full content capture is opt-out and enabled by default

The system SHALL record full prompt text, tool call arguments/outputs, and provider request/response payload bodies on the relevant traces and spans unless content capture is explicitly disabled in configuration.
Content capture SHALL default to enabled.

#### Scenario: Content is recorded by default

- **WHEN** the configuration does not specify a content-capture setting (including when no configuration file exists)
- **THEN** prompt text, tool argument/output bodies, and provider payload bodies are recorded on the relevant spans

#### Scenario: Content is withheld when explicitly disabled

- **WHEN** the configuration explicitly disables content capture
- **THEN** no full prompt text, tool argument/output bodies, or provider payload bodies are recorded on any span
