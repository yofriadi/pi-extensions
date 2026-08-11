# Delta: completion-delivery

## MODIFIED Requirements

### Requirement: status widget includes queued and active work

The extension SHALL always enable the human-only status widget.
It SHALL list queued, starting, active, waiting, interrupted, blocked, stalled, running, and finalizing entries, with foreground/background class and active/open/queued counts.
It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous.
It SHALL NOT register a model-facing listing tool.
It SHALL NOT require or honor a package `status.enabled` (or any other package config) toggle to disable the widget.
A settled run awaiting handoff SHALL identify why it is waiting, and the wording SHALL NOT imply a fault for waits that are expected.
Elapsed wait time SHALL be measured from the start of the current wait, not from run start.
Results whose retry policy is exhausted SHALL be counted and labelled distinctly from results still being retried, and both SHALL continue to surface the last delivery error.

The widget SHALL present tracked work as a tree under a `Subagents` title.
Every tracked run (starting, running, active, waiting, interrupted, blocked, stalled, finalizing) SHALL render as a two-line row: an identity line carrying a state glyph, the agent display name, compact run-ID prefix, admission class, and elapsed duration, and an indented activity line that leads with the run's current state — the run label for starting/running/active runs, `blocked` with its wait duration for permission waits, the state name with its duration for waiting/interrupted/stalled runs, and the specific delivery-wait reason with its per-wait duration for settled runs awaiting handoff — followed, when reported by the child, by turn count, tool-call count, and context-token usage.
Opaque hexadecimal IDs SHALL use an eight-character widget prefix and expand only when needed to distinguish simultaneously visible entries; the full ID SHALL remain unchanged for runtime correlation and tool targeting.
The glyph SHALL animate only for starting, running, and active entries; all other states SHALL use static glyphs.
Queued entries SHALL render as individual rows with name, compact run-ID prefix, class, and queued state, up to three entries; entries beyond the third SHALL be summarized as a single overflow count line without claiming that a pane or process has started.
Elapsed durations SHALL use an adaptive format: tenths of seconds under one minute, minutes and seconds under one hour, hours and minutes at one hour and beyond.

The widget SHALL distinguish terminal failure outcomes from success.
A run that completes successfully SHALL leave no row once its bookkeeping completes; when nothing else is tracked the widget SHALL be removed entirely.
A run that fails SHALL persist as a sticky terminal row — `✗` for failures (non-zero exit, error, watch/launch error), `■` for stopped runs (interrupted before settling, or self-paused via `caller_ping`), `⚠` for watch-abandoned runs — with its frozen duration and final telemetry, until evicted.
Sticky rows SHALL render after live, queued, and pending-delivery rows, most recent first, up to three rows with a `+N more` overflow line.
The whole sticky set SHALL be evicted when the next subagent launch is admitted, and a single sticky row SHALL be evicted when a completion correlated to that run arrives (manual resume followed by `subagent_done`).
The header SHALL render as `● Subagents` with the counts segment while live work exists (running, queued, or actively-retrying deliveries), and as `○ Subagents` with no counts segment when only sticky rows and/or exhausted deliveries remain.

#### Scenario: status is always enabled

- **WHEN** the extension loads with no package config files present
- **THEN** the status widget and status aggregation path are active

#### Scenario: package status toggle is ignored

- **WHEN** a leftover package-root config sets `status.enabled` to false
- **THEN** the status widget remains enabled

#### Scenario: queued capacity is visible

- **WHEN** foreground or background work waits for capacity
- **THEN** the widget identifies it as queued without claiming that a pane or process has started

#### Scenario: duplicate labels are distinguishable

- **WHEN** multiple tracked runs have the same canonical agent and presentation label
- **THEN** widget/result presentation includes stable run IDs sufficient for a human to distinguish those runs without changing permission or ownership identity

#### Scenario: long opaque run IDs stay compact

- **WHEN** a widget row carries a full opaque hexadecimal run ID
- **THEN** the widget shows an eight-character prefix, expanding it only if another visible row would otherwise have the same displayed ID, while runtime APIs retain the full ID

#### Scenario: permission wait is blocked not stalled

- **WHEN** a healthy child pane is waiting on a permission dialog
- **THEN** status projects `blocked`; it is not classified as an unhealthy inspection stall

#### Scenario: settled row clears

- **WHEN** delivery or suppression bookkeeping completes

- **THEN** the row clears and counts update

#### Scenario: settled row clears on success

- **WHEN** delivery or suppression bookkeeping completes for a run that completed successfully
- **THEN** the row clears and counts update; when nothing else is tracked the widget is removed entirely

#### Scenario: delivery wait states are distinguishable

- **WHEN** a settled run is held behind foreground work, is waiting for a streaming parent's turn boundary, or is awaiting persistence confirmation
- **THEN** the widget names that specific reason instead of showing one undifferentiated handoff label, so an expected wait is not read as a stuck delivery

#### Scenario: wait duration reflects the current wait

- **WHEN** a run works for a long period and only then begins waiting for delivery
- **THEN** the reported wait duration reflects only the current wait, not total run time

#### Scenario: exhausted retries are not reported as pending retries

- **WHEN** a result has exhausted its retry attempts and nothing is retrying it
- **THEN** it is counted and labelled as undeliverable rather than included in the actively-retrying count, and its last delivery error remains visible

#### Scenario: active run renders as a two-line tree row

- **WHEN** a run with the label `adversarial review` is active and its child reports turns, tool calls, and context usage
- **THEN** the identity line shows a spinner glyph, the agent display name, run ID, class, and elapsed duration, and the activity line leads with `adversarial review` followed by turn, tool, and token chunks

#### Scenario: blocked run renders in the two-line family with a static glyph

- **WHEN** a healthy child pane is waiting on a permission dialog
- **THEN** its row uses a static (non-animated) glyph and the activity line leads with `blocked` and the wait duration

#### Scenario: settled run shows its wait reason on the activity line

- **WHEN** a settled run is held behind foreground work or awaits a turn boundary or persistence confirmation
- **THEN** its activity line names that specific wait reason with the elapsed wait duration, followed by any reported telemetry chunks

#### Scenario: queued entries overflow past the display cap

- **WHEN** more than three entries are queued
- **THEN** the first three render as individual rows with run ID and class, and the remainder is summarized as a single `+N more queued` line

#### Scenario: durations adapt to magnitude

- **WHEN** runs have been active for 12.3 seconds, 2 minutes 17 seconds, and 1 hour 4 minutes respectively
- **THEN** their durations render as `12.3s`, `2m17s`, and `1h04m`

#### Scenario: failure outcomes persist as sticky terminal rows

- **WHEN** a run fails, is interrupted before settling, pauses itself via `caller_ping`, or its watch is abandoned, and its bookkeeping completes
- **THEN** a terminal row remains — `✗` for failure, `■` for stopped, `⚠` for watch-abandoned — with its frozen duration and final telemetry

#### Scenario: next launch evicts terminal rows

- **WHEN** sticky terminal rows are displayed and a new subagent launch is admitted
- **THEN** the sticky set clears and the header returns to the live `● Subagents` form

#### Scenario: manual resume clears its terminal row

- **WHEN** the user resumes a sticky run's session in its pane and the run reports completion via `subagent_done`
- **THEN** that run's sticky row clears

#### Scenario: idle-with-failures header is hollow and bare

- **WHEN** no work is running, queued, or actively retrying, and only sticky terminal rows and/or exhausted deliveries remain
- **THEN** the header renders as `○ Subagents` with no counts segment

#### Scenario: deferred deliveries are shown as awaiting the runtime

- **WHEN** a delivery is pending because no session-bound runtime is active and it has not exhausted its deferral budget

- **THEN** it is counted and labelled as awaiting the runtime, separately from both actively-retrying and undeliverable results

#### Scenario: terminal rows are capped with overflow

- **WHEN** more than three sticky terminal rows exist
- **THEN** the three most recent render individually and the remainder is summarized as a single `+N more` line
