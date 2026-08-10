## MODIFIED Requirements

### Requirement: exactly-once delivery state machine

Each settled run SHALL be atomically claimed, extracted, cleaned, capacity-released, and delivered or suppressed once. `delivered` SHALL mean the parent delivery API accepted the message or the blocking tool result is being returned. Failed async delivery SHALL remain pending under a bounded retry policy and SHALL NOT be silently deleted. Waiting for delivery persistence SHALL itself be bounded: a delivery queued into a streaming parent SHALL be re-verified only while the parent remains active and only up to a cap far exceeding any plausible parent turn, after which the delivery SHALL be re-queued for bounded retry rather than waited on indefinitely. Notifying an idle parent SHALL NOT be gated on persistence acknowledgement, because the notification is what causes the persisting turn to run. Once a send has been accepted, registering its acknowledgement SHALL precede any presentation work, and presentation failures SHALL NOT fail or repeat a delivery. An asynchronous delivery attempted while no matching session-bound completion API is active SHALL remain pending without consuming the ordinary send-attempt budget. Deferral on an inactive runtime SHALL NOT be unbounded: a delivery deferred past a bounded deferral budget SHALL be marked undeliverable with the cause recorded.

#### Scenario: async accepted

- **WHEN** an async result is accepted by the active session-bound `sendMessage` API
- **THEN** it is marked delivered and removed from tracked/pending state exactly once

#### Scenario: async delivery fails

- **WHEN** the active session-bound `sendMessage` rejects or throws
- **THEN** the result remains pending for bounded retry and duplicate watchers cannot deliver it twice

#### Scenario: queued delivery drains at a turn boundary

- **WHEN** a delivery is queued into a streaming parent and the running loop drains it before the acknowledgement cap
- **THEN** the delivery is acknowledged as persisted without being re-sent

#### Scenario: streaming parent never settles

- **WHEN** a delivery is queued into a streaming parent, is never persisted, and the parent never reports settling
- **THEN** acknowledgement stops at the cap and the delivery is re-queued under the bounded retry policy instead of waiting indefinitely

#### Scenario: idle parent is notified before acknowledgement

- **WHEN** a result is sent to an idle parent whose persistence cannot be confirmed yet
- **THEN** the parent is notified anyway, so a turn can start and drain the send, rather than the notification waiting on an acknowledgement that itself waits on that turn

#### Scenario: presentation failure during delivery

- **WHEN** reporting why a delivery is waiting fails after the send was accepted
- **THEN** the delivery proceeds unaffected and the accepted send is not repeated

#### Scenario: inactive runtime defers without exhaustion

- **WHEN** asynchronous delivery is attempted during a reload gap or before the target session has an active bound API
- **THEN** no action method is called, the result remains pending, and its ordinary delivery attempt count is not incremented

#### Scenario: first deferral records zero attempts

- **WHEN** a completion settles while the runtime is inactive and is first enqueued as pending
- **THEN** it is recorded with zero ordinary send attempts rather than one, and the widget presents it as awaiting the runtime rather than as an ordinary retry

#### Scenario: deferral interval resets once a runtime is reached

- **WHEN** a deferred delivery's next attempt reaches a matching active session-bound runtime
- **THEN** its deferral interval is cleared, so the deferral budget measures one continuous unavailable interval and the `awaiting runtime` state applies only when the most recent outcome was a deferral

#### Scenario: deferral is bounded

- **WHEN** a pending delivery remains continuously deferred past its bounded deferral budget
- **THEN** it is marked undeliverable with the cause recorded and is not retried as an ordinary send

#### Scenario: deferral-exhausted entries survive reload without flapping

- **WHEN** a delivery exhausted by the deferral budget is re-driven on a later reload or session start
- **THEN** both its deferral interval and its exhausted flag are reset before retry, so it leaves the undeliverable count, renders as awaiting the runtime, and a broken or never-reactivated session does not immediately re-exhaust or oscillate between deferred and undeliverable

#### Scenario: blocking delivery

- **WHEN** a blocking run settles normally
- **THEN** its result returns only through the suspended tool call, delivery bookkeeping completes, and no `subagent_result` steer is sent

#### Scenario: blocking caller ping settles foreground

- **WHEN** a blocking child calls `caller_ping`
- **THEN** its help message and resumable path return only through the suspended tool call, the foreground slot releases, and any later resume is separately admitted as background work

#### Scenario: shutdown suppression

- **WHEN** the parent is shutting down before delivery
- **THEN** the outcome is marked suppressed, no parent wake-up occurs, and resources/slots/leases release exactly once

### Requirement: reload and shutdown ownership

Coordinator, queue, watcher, delivery, lease, and suppression state SHALL survive extension reload through fork-specific process globals. Async runs SHALL transfer to the latest session-bound extension API without duplicate delivery. A completion that settles while the old runtime is shut down SHALL remain pending until the replacement session is active. Because a suspended blocking tool result cannot be reconstructed after reload, its eventual outcome SHALL be suppressed rather than converted to an async steer, while cleanup and foreground release still occur.

#### Scenario: async completion across reload

- **WHEN** a background child completes during extension reload
- **THEN** the latest bound owner delivers it exactly once after `session_start`, and the old unbound or stale API is never called

#### Scenario: deferred delivery does not consume the barrier wake slot

- **WHEN** a delivery is deferred because the runtime is inactive while a foreground barrier drain is in progress
- **THEN** the deferral is detected before entering the barrier drain so the deferred entry neither reserves the batch's wake slot nor leaves an already-sent sibling unwoken

#### Scenario: selected-skill discovery does not break reload delivery

- **WHEN** selected-skill validation constructs a standalone resource loader while an async child is running
- **THEN** the active parent API remains usable and the child result is delivered once

#### Scenario: blocking completion after reload

- **WHEN** reload loses a blocking call's return continuation
- **THEN** the child is reaped, its result is suppressed, no replacement steer is sent, and the foreground slot is released

#### Scenario: final shutdown

- **WHEN** the parent session shuts down
- **THEN** queued work is cancelled without resource creation, active watchers are aborted, panes are closed idempotently, pending delivery is suppressed, and all leases/slots are released

### Requirement: status widget includes queued and active work

The extension SHALL always enable the human-only status widget. It SHALL list queued, starting, active, waiting, interrupted, blocked, stalled, running, and finalizing entries, with foreground/background class and active/open/queued counts. It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous. It SHALL NOT register a model-facing listing tool. It SHALL NOT require or honor a package `status.enabled` (or any other package config) toggle to disable the widget. A settled run awaiting handoff SHALL identify why it is waiting, and the wording SHALL NOT imply a fault for waits that are expected. Elapsed wait time SHALL be measured from the start of the current wait, not from run start. Results whose retry policy is exhausted SHALL be counted and labelled distinctly from results still being retried, and both SHALL continue to surface the last delivery error. A delivery deferred because no session-bound runtime is active SHALL be counted and labelled as awaiting the runtime, distinctly from both actively-retrying and undeliverable results.

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

#### Scenario: deferred deliveries are shown as awaiting the runtime

- **WHEN** a delivery is pending because no session-bound runtime is active and it has not exhausted its deferral budget
- **THEN** it is counted and labelled as awaiting the runtime, separately from both actively-retrying and undeliverable results
