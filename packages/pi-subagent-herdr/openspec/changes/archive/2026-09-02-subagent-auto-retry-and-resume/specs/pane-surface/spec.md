## MODIFIED Requirements

### Requirement: seeded owned sessions

Every initial launch SHALL create deterministic JSONL recording owner-only versioned provenance metadata in the session header binding the canonical agent, without creating external ownership sidecar files.
Launch execution artifacts including startup scripts (`launch.sh`), prompt files (`task.md`, `sysprompt.md`), and telemetry (`activity.json`) SHALL be created inside the session companion directory `<session_dir>/<stem>/`.
All initial subagent sessions SHALL launch with fresh conversation context without copying parent conversation turns.
Agent frontmatter `seed` SHALL NOT be supported; its presence SHALL fail validation before queueing rather than being silently ignored.
Agent `model` and `thinking` SHALL use declared values or inherit omitted values from the invoking parent runtime.
No per-call seed, model, or thinking override SHALL exist.
The extension SHALL NOT expose an agent-facing API that reads the metadata to resume a session implicitly; resumption SHALL occur only through the explicit ownership-gated `session` tool parameter.

#### Scenario: always fresh context

- **WHEN** an initial subagent session is created
- **THEN** the child JSONL records parent lineage without copied conversation turns, always starting with a clean conversation transcript

#### Scenario: obsolete seed frontmatter fails

- **WHEN** a resolved agent definition declares `seed: fresh` or `seed: fork`
- **THEN** validation fails before queueing with a migration-style error instead of silently starting fresh

#### Scenario: ownership metadata

- **WHEN** an initial session is created
- **THEN** its session header records schema version, canonical agent ID, and lineage fields as write-only provenance in the `.jsonl` header line, and no external `owner.json` sidecar file is created

#### Scenario: launch artifacts stored in companion directory

- **WHEN** a subagent is launched
- **THEN** its launch script (`launch.sh`), prompt files, and activity telemetry file are placed in `<session_dir>/<stem>/` matching the `<stem>.jsonl` session file

### Requirement: pane lifecycle closes on settlement

The extension SHALL close or recognize absence of the child surface when a dispatched run completes, fails, aborts, or shuts down.
It SHALL remove region membership and preserve the child session file for diagnostics.
Direct user interaction with an open child pane SHALL NOT require an extension lifecycle tool.
The extension SHALL NOT expose an agent-facing API that reads the metadata to resume a session implicitly; resumption SHALL occur only through the explicit ownership-gated `session` tool parameter.
Automatic retry is the single exception to settlement-bound closure: a retried run SHALL close the failed attempt's surface and proceed with the replacement only once the failed attempt's child process is confirmed gone (a bounded pane-absence wait), SHALL preserve the run's region membership — removing the dead pane from the region — and row continuity, including start time, across the replacement surface, and SHALL recompute layout warnings for the replacement; settlement still closes the current surface.

#### Scenario: normal settlement

- **WHEN** a child completes or calls `subagent_done`
- **THEN** the process auto-exits, the pane closes idempotently, and the child session file remains available

#### Scenario: retry replaces the surface mid-run

- **WHEN** a run's failed attempt is automatically retried
- **THEN** the failed attempt's pane is closed, its child process is confirmed gone within a bounded wait, the replacement surface joins the run's existing region with the dead pane removed and layout warnings recomputed, the widget row keeps its identity and start time, and the run is not settled

#### Scenario: user interrupts directly

- **WHEN** the user presses Escape in the visible child pane
- **THEN** Pi handles the interruption in that pane without a `subagent_interrupt` tool call

#### Scenario: user continues directly

- **WHEN** the user types follow-up input into an open child pane
- **THEN** Pi handles the input in that pane without a `subagent_resume` tool call or a new extension admission entry

#### Scenario: child Escape is observable

- **WHEN** the user presses Escape in an active child pane and Pi settles that turn with `stopReason: "aborted"`
- **THEN** the child writes an interruption activity snapshot, the parent projects the run as interrupted, and the child pane remains available until newer child activity or terminal settlement; recorder reloads preserve sequence freshness so direct continuation clears the interrupted state

#### Scenario: child awaits user guidance

- **WHEN** a child needs guidance but has not completed through `subagent_done` or normal exit
- **THEN** it remains the current dispatched run and its admission slot remains occupied while the user interacts directly in the visible pane; no child ping tool can settle it early

#### Scenario: abandoned child releases admission

- **WHEN** a child has not produced completion evidence by the fixed, code-owned four-hour watcher cap
- **THEN** it is classified as watch-abandoned, its admission capacity releases, and its pane/session remain available for user recovery

#### Scenario: interrupted child remains unfinished

- **WHEN** the user interrupts a child in its pane and it neither exits nor reports `subagent_done`
- **THEN** it continues to occupy its admission slot until it settles or reaches the fixed four-hour watcher cap, after which it is watch-abandoned and capacity releases while the pane remains available

#### Scenario: caller ping

- **WHEN** a child attempts to use the legacy `caller_ping` control
- **THEN** no such extension tool is available; the child remains dispatched until normal settlement, `subagent_done`, or watch abandonment

#### Scenario: parent cancellation

- **WHEN** a queued or active run is cancelled by the parent harness or provider
- **THEN** queued work creates no surface, while active work closes its surface and releases layout ownership exactly once
