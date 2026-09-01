## MODIFIED Requirements

### Requirement: seeded owned sessions

Every initial launch SHALL create deterministic JSONL recording owner-only versioned provenance metadata in the session header binding the canonical agent, without creating external ownership sidecar files.
Launch execution artifacts including startup scripts (`launch.sh`), prompt files (`task.md`, `sysprompt.md`), and telemetry (`activity.json`) SHALL be created inside the session companion directory `<session_dir>/<stem>/`.
Agent frontmatter `seed` SHALL be `fresh` or `fork`, defaulting to fresh.
Agent `model` and `thinking` SHALL use declared values or inherit omitted values from the invoking parent runtime.
No per-call seed, model, or thinking override SHALL exist.
The extension SHALL NOT expose an agent-facing API that reads the metadata to resume a session.

#### Scenario: fresh seed

- **WHEN** `seed` is omitted or `fresh`
- **THEN** the child JSONL records parent lineage without copied conversation turns

#### Scenario: fork seed

- **WHEN** the resolved agent declares `seed: fork`
- **THEN** parent turns through the last user message are copied before launch and lineage is recorded

#### Scenario: ownership metadata

- **WHEN** an initial session is created
- **THEN** its session header records schema version, canonical agent ID, and lineage fields as write-only provenance in the `.jsonl` header line, and no external `owner.json` sidecar file is created

#### Scenario: launch artifacts stored in companion directory

- **WHEN** a subagent is launched
- **THEN** its launch script (`launch.sh`), prompt files, and activity telemetry file are placed in `<session_dir>/<stem>/` matching the `<stem>.jsonl` session file
