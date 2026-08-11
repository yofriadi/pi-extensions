# Capability: pane-surface

## Purpose

Visible Herdr surfaces for admitted subagents, including attached-stack geometry for the full concurrency bound, transactional launch, robust pane operations, and idempotent close-on-settlement.

## Requirements

### Requirement: attached stack layout

Every admitted run SHALL open a real Herdr pane or tab and SHALL default to attached layout with direction `right` when per-call options are omitted: the first child splits the caller right and subsequent children split the tallest region pane down.
When a call explicitly sets `direction: down`, the first child splits the caller down and subsequent children split the widest region pane right.
Geometry SHALL be preferred, with deterministic depth/insertion-order fallback.
Package config SHALL NOT supply layout or direction defaults.

#### Scenario: first admitted run

- **WHEN** an admitted run finds an empty attached region and omits layout/direction
- **THEN** it splits the caller right using Herdr's default even split

#### Scenario: children stack on inverse axis

- **WHEN** up to five active runs occupy one parent region under the default `right` direction
- **THEN** subsequent admitted runs split the selected region pane down with deterministic tie-breaking

#### Scenario: geometry unavailable

- **WHEN** `pane layout` rectangles are unavailable
- **THEN** the shallowest tracked pane is selected, ties use insertion order, and growth remains deterministic

#### Scenario: minimum size fallback

- **WHEN** the prospective attached target is below the documented useful size
- **THEN** that admitted run opens in a tab and the acknowledgement/result reports the fallback

#### Scenario: empty region reset

- **WHEN** every region pane is settled or manually closed
- **THEN** region state resets and the next admitted run splits the caller anew

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

### Requirement: transactional launch

Launch SHALL transition through admitted, pane allocated, script accepted, watcher registered, and running.
A call SHALL be acknowledged as started only after `pane run` succeeds and the watcher/runtime record is installed.
Any failure before running SHALL roll back all created resources and release its slot/session lease exactly once.

#### Scenario: pane run fails after split

- **WHEN** the pane was created but script execution fails
- **THEN** the pane and region membership are removed, temporary launch resources are cleaned, no started acknowledgement is returned, and the next queued run may be admitted

#### Scenario: watcher registration fails

- **WHEN** child command acceptance succeeds but watcher registration fails
- **THEN** the child/pane is terminated or reaped, ownership is rolled back, and no untracked active process remains

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

### Requirement: permission-compatible launch execution

The child SHALL launch Pi from an executable script using the parent's exact cwd and Pi agent directory, canonical `PI_SUBAGENT_*` metadata, `PI_SUBAGENT_PARENT_SESSION`, the owned session JSONL, explicitly loaded child companion extension, selected skill resources, task artifact, and terminal sentinel.
It SHALL inject one canonical `<active_agent>` identity, use the agent Markdown body as the sole agent-authored identity prompt, and SHALL NOT launch before the definition and selected skills are valid.
The explicit companion SHALL assemble selected skill metadata in one standard `<available_skills>` container, creating it when absent, before normally discovered permission-system sanitization; launch SHALL fail closed before task submission if that ordering is not guaranteed or verified.

#### Scenario: canonical active agent

- **WHEN** an admitted named agent launches
- **THEN** its assembled system prompt contains one escaped `<active_agent name="<canonical-id>"/>` plus the definition's Markdown-body identity instructions and no duplicate identity prompt

#### Scenario: selected skill resources

- **WHEN** the agent declares valid selected skills
- **THEN** Pi starts with general skill discovery disabled and only their canonical resources explicitly loaded, without initial `/skill:` task prompts; their escaped metadata appears in exactly one `<available_skills>` section, created when Pi omits it

#### Scenario: parent agent root

- **WHEN** the child script is built
- **THEN** `PI_CODING_AGENT_DIR` is exactly the parent's Pi agent directory rather than a project substitute

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

### Requirement: herdr-only activation

The extension SHALL fail clearly when not running with the required Herdr environment and CLI.

#### Scenario: missing Herdr

- **WHEN** a valid subagent call reaches environment validation without `HERDR_ENV=1` or the Herdr CLI
- **THEN** it fails before admission with the missing requirement named
