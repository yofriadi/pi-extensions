## MODIFIED Requirements

### Requirement: deterministic multi-channel settlement

The extension SHALL poll the child exit sidecar, terminal sentinel, and pane existence. Settlement SHALL be atomically claimed once. A valid sidecar observed in the same poll SHALL take precedence; sentinel and pane disappearance SHALL receive a bounded sidecar grace. Nonzero exits, malformed sidecars, stale assistant text, and empty successful output SHALL produce explicit deterministic outcomes. Watching SHALL be bounded by a per-run configurable deadline whose default is generous enough not to curtail legitimate long-running work. Every evidence probe SHALL itself be bounded, and a probe that exceeds its bound SHALL count as no reading rather than as evidence. On expiry the extension SHALL first sweep every evidence channel it polls — exit sidecar, sentinel file, and terminal tail — and prefer any real evidence found; only with no evidence SHALL it settle as a distinct abandoned-watch outcome that is not classified as a child or provider failure, routed through the normal delivery path.

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

#### Scenario: watch deadline expires without evidence

- **WHEN** a watched run records neither completion evidence nor pane disappearance before the watch deadline
- **THEN** watching stops and the run settles as a distinct abandoned-watch outcome, separate from a reported failure, stating that no evidence was recorded, and that outcome is delivered through the ordinary delivery path rather than leaving the run unsettled

#### Scenario: evidence races the watch deadline

- **WHEN** a sidecar, sentinel file, or terminal-tail sentinel becomes observable at or immediately after the watch deadline
- **THEN** that real completion evidence is returned instead of an abandoned-watch outcome

#### Scenario: evidence probe hangs at the deadline

- **WHEN** an evidence probe used by the deadline sweep never resolves
- **THEN** the sweep abandons that probe within its bound and still settles, so a bounded watch cannot become unbounded through its own final check

#### Scenario: pane probe hangs during watching

- **WHEN** the pane inspection probe never resolves
- **THEN** it is recorded as an unavailable observation rather than a missing pane, and watching continues to its deadline instead of stalling

#### Scenario: watch deadline disabled

- **WHEN** the watch deadline is explicitly disabled
- **THEN** watching continues until completion evidence appears or the run is aborted

#### Scenario: abandoned watch releases capacity but keeps the pane

- **WHEN** a run settles as an abandoned watch while its pane is still present
- **THEN** its admission slot is released immediately so later work is not blocked, its session lease is retained until explicit pane disappearance (the pane may still hold a live writer), and its pane is preserved for inspection rather than reaped

#### Scenario: abandoned watch is presented as unknown, not failed

- **WHEN** an abandoned-watch outcome is presented to the parent
- **THEN** it states that the outcome is unknown and the pane may still be alive, includes any output already recovered from the child session log, and does not claim the run produced no result or that a provider error occurred

#### Scenario: preserved error pane frees admission but keeps its session lease

- **WHEN** a run settles with a reported error (structured or unexpected) while its pane is preserved for inspection
- **THEN** its admission slot is released immediately rather than held until the pane is closed, and its session lease is retained until explicit pane disappearance

### Requirement: exactly-once delivery state machine

Each settled run SHALL be atomically claimed, extracted, cleaned, capacity-released, and delivered or suppressed once. `delivered` SHALL mean the parent delivery API accepted the message or the blocking tool result is being returned. Failed async delivery SHALL remain pending under a bounded retry policy and SHALL NOT be silently deleted. Waiting for delivery persistence SHALL itself be bounded: a delivery queued into a streaming parent SHALL be re-verified only while the parent remains active and only up to a cap far exceeding any plausible parent turn, after which the delivery SHALL be re-queued for bounded retry rather than waited on indefinitely. Notifying an idle parent SHALL NOT be gated on persistence acknowledgement, because the notification is what causes the persisting turn to run. Once a send has been accepted, registering its acknowledgement SHALL precede any presentation work, and presentation failures SHALL NOT fail or repeat a delivery.

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

### Requirement: status widget includes queued and active work

The extension SHALL display a human-only widget listing queued, starting, active, waiting, interrupted, blocked, stalled, running, and finalizing entries, with foreground/background class and active/open/queued counts. It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous. It SHALL NOT register a model-facing listing tool. A settled run awaiting handoff SHALL identify why it is waiting, and the wording SHALL NOT imply a fault for waits that are expected. Elapsed wait time SHALL be measured from the start of the current wait, not from run start. Results whose retry policy is exhausted SHALL be counted and labelled distinctly from results still being retried, and both SHALL continue to surface the last delivery error.

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
