## MODIFIED Requirements

### Requirement: surface options

The extension SHALL support per-call `layout: attached|single`, `surface: pane|tab`, and `direction: right|down` for `subagent`.
When omitted, effective values SHALL be `layout: attached`, `surface: pane`, and `direction: right`.
Package-level config SHALL NOT set these values.
A conflicting direction SHALL NOT silently mutate a nonempty attached region.

#### Scenario: omitted surface options use code defaults

- **WHEN** a call omits `layout`, `surface`, and `direction`
- **THEN** the run uses attached layout, pane surface, and right-then-down stacking

#### Scenario: explicit tab

- **WHEN** `surface: tab` is effective
- **THEN** the child is created with the Herdr no-focus tab path

#### Scenario: single split

- **WHEN** `layout: single` is effective
- **THEN** the run gets one split of the caller and is not added to attached-region stacking geometry

#### Scenario: direction conflict

- **WHEN** a call requests a direction different from a nonempty region's direction
- **THEN** it waits for that region to empty or uses a documented isolated surface path rather than silently ignoring the request

### Requirement: validation and queueing precede surface creation

Agent, skill, and initial-session validation SHALL complete before admission queue insertion.
Queue waiting SHALL create no pane.
Surface creation SHALL begin only after the relevant foreground/background slot is atomically acquired.
If a queued blocking call's parent tool execution is aborted before admission, or queued work is cancelled or shut down, the entry SHALL be removed without later launch or resource creation.

#### Scenario: queued call has no pane

- **WHEN** a valid call is waiting for capacity
- **THEN** Herdr layout contains no pane for it and widget status is queued

#### Scenario: queued call is aborted

- **WHEN** a queued blocking call's parent execution aborts, or queued foreground/background work is cancelled or shut down before admission
- **THEN** it is removed without creating a surface or launch resource and cannot be admitted later

#### Scenario: invalid call has no side effects

- **WHEN** validation fails
- **THEN** no queue entry, pane, tab, session, artifact, launch script, or region row is created

### Requirement: robust pane operations

Pane creation SHALL retry only classified transient control-plane failures within a bounded budget.
Permanent usage errors SHALL fail without retry.
A successful exit without a pane ID SHALL count as failure.
Cleanup close SHALL verify or tolerate absence and remain idempotent.

#### Scenario: transient split failure

- **WHEN** a split fails with a classified transient error
- **THEN** it retries within budget and either proceeds or fails visibly

#### Scenario: missing pane ID

- **WHEN** Herdr exits zero without returning a pane ID
- **THEN** the attempt is classified as failure and never acknowledged as started

#### Scenario: missing pane before interrupt

- **WHEN** no agent-facing interrupt control exists and a user has already removed a child pane before any extension cleanup runs
- **THEN** no extension send-keys operation is attempted; cleanup tolerates the missing pane idempotently without targeting another pane

#### Scenario: pane already absent during cleanup

- **WHEN** cleanup closes a pane already removed by the user
- **THEN** cleanup succeeds idempotently, region/slot/lease cleanup continues, and the original run outcome is preserved

### Requirement: seeded owned sessions

Every initial launch SHALL create deterministic JSONL plus owner-only versioned provenance metadata binding the canonical agent.
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
- **THEN** its owner-only metadata records schema version, canonical agent ID, and lineage fields as write-only provenance without enabling an extension resume tool

### Requirement: pane lifecycle closes on settlement

The extension SHALL close or recognize absence of the child surface when a dispatched run completes, fails, aborts, or shuts down.
It SHALL remove region membership and preserve the child session file for diagnostics.
Direct user interaction with an open child pane SHALL NOT require an extension lifecycle tool.

#### Scenario: normal settlement

- **WHEN** a child completes or calls `subagent_done`
- **THEN** the process auto-exits, the pane closes idempotently, and the child session file remains available

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
