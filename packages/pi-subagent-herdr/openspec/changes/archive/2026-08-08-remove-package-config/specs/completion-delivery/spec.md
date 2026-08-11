# Capability: completion-delivery

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

#### Scenario: permission wait is blocked not stalled

- **WHEN** a healthy child pane is waiting on a permission dialog
- **THEN** status projects `blocked`; it is not classified as an unhealthy inspection stall

#### Scenario: settled row clears

- **WHEN** delivery or suppression bookkeeping completes
- **THEN** the row clears and counts update

#### Scenario: delivery wait states are distinguishable

- **WHEN** a settled run is held behind foreground work, is waiting for a streaming parent's turn boundary, or is awaiting persistence confirmation
- **THEN** the widget names that specific reason instead of showing one undifferentiated handoff label, so an expected wait is not read as a stuck delivery

#### Scenario: wait duration reflects the current wait

- **WHEN** a run works for a long period and only then begins waiting for delivery
- **THEN** the reported wait duration reflects only the current wait, not total run time

#### Scenario: exhausted retries are not reported as pending retries

- **WHEN** a result has exhausted its retry attempts and nothing is retrying it
- **THEN** it is counted and labelled as undeliverable rather than included in the actively-retrying count, and its last delivery error remains visible
