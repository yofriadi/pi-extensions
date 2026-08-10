# Capability: completion-delivery

Settlement detection and exactly-once delivery for background steers and foreground tool results, with a foreground delivery barrier, status projection, reload ownership, and deterministic cleanup.

## ADDED Requirements

### Requirement: deterministic multi-channel settlement

The extension SHALL poll the child exit sidecar, terminal sentinel, and pane existence. Settlement SHALL be atomically claimed once. A valid sidecar observed in the same poll SHALL take precedence; sentinel and pane disappearance SHALL receive a bounded sidecar grace. Nonzero exits, malformed sidecars, stale assistant text, and empty successful output SHALL produce explicit deterministic outcomes.

#### Scenario: valid sidecar wins

- **WHEN** a valid sidecar and another completion signal are observable in one poll
- **THEN** the sidecar outcome is claimed and processed exactly once

#### Scenario: sentinel fallback

- **WHEN** no valid sidecar appears within grace and a sentinel reports exit code zero
- **THEN** the run settles successfully from the sentinel

#### Scenario: nonzero sentinel

- **WHEN** no valid sidecar appears within grace and the sentinel has a nonzero code
- **THEN** the run settles as an error even if older assistant text exists

#### Scenario: pane disappears

- **WHEN** the pane disappears and no valid sidecar or sentinel wins during grace
- **THEN** the run settles with a pane-disappearance error and cleanup treats the already absent pane as cleaned

#### Scenario: malformed or stale sidecar

- **WHEN** a sidecar is malformed or does not belong to the current owned run
- **THEN** it is not accepted as successful settlement and the resulting error/race handling is visible

### Requirement: text-only result extraction

The extension SHALL walk the owned child JSONL backwards to the current run's final assistant message and join only text blocks. It SHALL surface provider errors and SHALL NOT let stale text from a prior turn mask the current exit state.

#### Scenario: thinking and tool blocks excluded

- **WHEN** the final assistant message contains thinking, tool, and text blocks
- **THEN** only its text blocks form the presented answer

#### Scenario: provider error without text

- **WHEN** the current turn ends with provider error and no text
- **THEN** the result presents the provider error message

#### Scenario: successful exit without assistant text

- **WHEN** the current run exits zero without a current assistant text message
- **THEN** the result explicitly reports missing output rather than reusing prior text

### Requirement: exactly-once delivery state machine

Each settled run SHALL be atomically claimed, extracted, cleaned, capacity-released, and delivered or suppressed once. `delivered` SHALL mean the parent delivery API accepted the message or the blocking tool result is being returned. Failed async delivery SHALL remain pending under a bounded retry policy and SHALL NOT be silently deleted.

#### Scenario: async accepted

- **WHEN** an async result is accepted by `sendMessage`
- **THEN** it is marked delivered and removed from tracked/pending state exactly once

#### Scenario: async delivery fails

- **WHEN** `sendMessage` rejects or throws
- **THEN** the result remains pending for bounded retry and duplicate watchers cannot deliver it twice

#### Scenario: blocking delivery

- **WHEN** a blocking run settles normally
- **THEN** its result returns only through the suspended tool call, delivery bookkeeping completes, and no `subagent_result` steer is sent

#### Scenario: blocking caller ping settles foreground

- **WHEN** a blocking child calls `caller_ping`
- **THEN** its help message and resumable path return only through the suspended tool call, the foreground slot releases, and any later resume is separately admitted as background work

#### Scenario: shutdown suppression

- **WHEN** the parent is shutting down before delivery
- **THEN** the outcome is marked suppressed, no parent wake-up occurs, and resources/slots/leases release exactly once

### Requirement: foreground delivery barrier

While any parent tool call is queued for or running foreground subagent work, background completion, stall/recovery, and async `caller_ping` notifications SHALL be held without re-entering the parent turn. A blocking child's ping is the foreground tool result itself and SHALL NOT enter this notification queue. The foreground result SHALL return first; held notifications SHALL then flush in settlement order with one parent wake-up.

#### Scenario: background completes during foreground work

- **WHEN** one or more background runs settle while a foreground call is queued or active
- **THEN** their notifications are retained and no steer interrupts the suspended foreground turn

#### Scenario: barrier flush

- **WHEN** the foreground call returns or is cancelled
- **THEN** retained notifications flush in settlement order as one wake-up without duplicate delivery

#### Scenario: multiple foreground calls queued

- **WHEN** one foreground result returns but another blocking call remains queued
- **THEN** the barrier remains active until no foreground tool call is queued or active

#### Scenario: blocking ping releases the barrier

- **WHEN** the last queued or active foreground call settles through `caller_ping`
- **THEN** its ping result returns first, the foreground barrier clears, and held background notifications may flush before any later background-class resume

### Requirement: status widget includes queued and active work

The extension SHALL display a human-only widget listing queued, starting, active, waiting, interrupted, blocked, stalled, running, and finalizing entries, with foreground/background class and active/open/queued counts. It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous. It SHALL NOT register a model-facing listing tool.

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

### Requirement: stall supervision

The extension SHALL supervise pane/activity health at the configured interval. Background stall/recovery notifications SHALL pass through the foreground delivery barrier. Blocking runs SHALL project stall state in the widget but SHALL NOT emit stall steers.

#### Scenario: background stall notification

- **WHEN** a background run meets the unhealthy stall threshold and no foreground barrier is active
- **THEN** one stall notification wakes the parent

#### Scenario: blocking run stalls

- **WHEN** a foreground run meets the unhealthy stall threshold
- **THEN** the widget shows stalled but no steer is emitted

### Requirement: reload and shutdown ownership

Coordinator, queue, watcher, delivery, lease, and suppression state SHALL survive extension reload through fork-specific process globals. Async runs SHALL transfer to the latest extension API without duplicate delivery. Because a suspended blocking tool result cannot be reconstructed after reload, its eventual outcome SHALL be suppressed rather than converted to an async steer, while cleanup and foreground release still occur.

#### Scenario: async completion across reload

- **WHEN** a background child completes during extension reload
- **THEN** the latest owner delivers it exactly once

#### Scenario: blocking completion after reload

- **WHEN** reload loses a blocking call's return continuation
- **THEN** the child is reaped, its result is suppressed, no replacement steer is sent, and the foreground slot is released

#### Scenario: final shutdown

- **WHEN** the parent session shuts down
- **THEN** queued work is cancelled without resource creation, active watchers are aborted, panes are closed idempotently, pending delivery is suppressed, and all leases/slots are released
