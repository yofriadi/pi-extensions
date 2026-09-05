## MODIFIED Requirements

### Requirement: pane lifecycle closes on settlement

The extension SHALL close or recognize absence of the child surface when a dispatched run completes, fails, aborts, or shuts down.
It SHALL remove region membership and preserve the child session file for diagnostics.
Direct user interaction with an open child pane SHALL NOT require an extension lifecycle tool.
The extension SHALL NOT expose an agent-facing API that reads the metadata to resume a session implicitly; resumption SHALL occur only through the explicit ownership-gated `session` tool parameter.
Automatic retry is the single exception to settlement-bound closure: a retried run SHALL close the failed attempt's surface and proceed with the replacement only once the failed attempt's child process is confirmed gone (a bounded pane-absence wait), SHALL preserve the run's region membership — removing the dead pane from the region — and row continuity, including start time, across the replacement surface, and SHALL recompute layout warnings for the replacement; settlement still closes the current surface.
A run that settles as failed through a child error outcome while its pane is still present SHALL have its pane closed and its region membership and session lease released as part of settlement — the same reap the success path performs — so the failed session file is immediately available for ownership-gated `session`-parameter resume; the sticky launch-failure pane and the watch-abandoned pane keep today's preservation semantics and are not reaped by this rule.
A failed session resumed through the `session` parameter continues its pane lineage from that session file (a new pane with the failed run's transcript in place); it is a new dispatched run with its own admission and widget identity, not a continuation of the failed run's row.

#### Scenario: normal settlement

- **WHEN** a child completes or calls `subagent_done`
- **THEN** the process auto-exits, the pane closes idempotently, and the child session file remains available

#### Scenario: retry replaces the surface mid-run

- **WHEN** a run's failed attempt is automatically retried
- **THEN** the failed attempt's pane is closed, its child process is confirmed gone within a bounded wait, the replacement surface joins the run's existing region with the dead pane removed and layout warnings recomputed, the widget row keeps its identity and start time, and the run is not settled

#### Scenario: failed settlement closes the pane

- **WHEN** a run settles as failed through a child error sidecar and its pane is still present
- **THEN** the pane is closed, region membership is removed, and the session lease is released as part of settlement, leaving the session file immediately resumable through the `session` parameter

#### Scenario: sticky launch failure keeps its pane

- **WHEN** a launch fails and its pane is captured as a sticky launch failure for inspection
- **THEN** the pane is not closed by the failure-settlement reap rule and keeps today's preservation semantics

#### Scenario: relaunch-failure pane keeps its lease

- **WHEN** a retry relaunch fails and the failed attempt's pane is still present (including past its confirmed-absence bound)
- **THEN** the surviving pane is preserved for inspection and its session lease is retained until confirmed pane absence, because it may still hold a live writer; the failure-settlement reap rule does not apply to it

#### Scenario: watch-abandoned run keeps its pane

- **WHEN** a run settles as watch-abandoned with its pane still present
- **THEN** the pane is preserved for inspection per the abandoned-watch rules and is not closed by the failure-settlement reap rule

#### Scenario: resumed session gets a fresh pane

- **WHEN** the parent resumes a failed session through the `session` parameter
- **THEN** the resumed run launches in a new pane carrying the failed session's transcript, admitted as a new run with its own identity; the failed run's sticky row clears when this admission runs (sticky rows clear at the next admission, not at settlement)

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
