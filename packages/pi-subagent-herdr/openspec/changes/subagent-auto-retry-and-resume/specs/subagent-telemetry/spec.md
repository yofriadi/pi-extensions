## ADDED Requirements

### Requirement: subagent retry state telemetry

When an active subagent undergoes automatic background retries, the extension SHALL reflect the retry attempt count in the run's parent-side lifecycle state and status widget (e.g. `retrying (2/3)`).
The retry presentation SHALL be distinct from delivery-retry presentation (`delivery retry N`).
The parent SHALL NOT write retry state into the child-owned activity telemetry; the widget state SHALL derive from parent-side lifecycle projection only.
The retry presentation SHALL render within the existing two-line tracked-run family — the `retrying` state is added to the vocabulary enumerated by the status-widget requirement by explicit modification, not by a new row family — with an explicit glyph (not the settled fall-through) and open/active work counting.

#### Scenario: widget reflects active retry

- **WHEN** a subagent is undergoing attempt 2 of 3 after an initial well-formed provider error sidecar
- **THEN** the status widget presents the run as retrying with the attempt count `(2/3)`, distinct from any delivery-retry wording

#### Scenario: retry state survives pane replacement

- **WHEN** a retried attempt closes the failed attempt's pane and opens a new pane for the same run
- **THEN** the widget row persists under the same run identity and continues presenting the retry attempt count
