<!-- Archive precondition: archive `agents-dashboard-widget` first. This delta is written against its archived tree-widget requirement and supersedes only its caller-ping, ping-to-stopped, and manual-resume single-row-eviction language. Do not archive this change first. -->

## MODIFIED Requirements

### Requirement: exactly-once delivery state machine

Each settled run SHALL be atomically claimed, extracted, cleaned, capacity-released, and delivered or suppressed once.
`delivered` SHALL mean the parent delivery API accepted the message or the blocking tool result is being returned.
Failed async delivery SHALL remain pending under a bounded retry policy and SHALL NOT be silently deleted.
Waiting for delivery persistence SHALL itself be bounded: a delivery queued into a streaming parent SHALL be re-verified only while the parent remains active and only up to a cap far exceeding any plausible parent turn, after which the delivery SHALL be re-queued for bounded retry rather than waited on indefinitely.
Notifying an idle parent SHALL NOT be gated on persistence acknowledgement, because the notification is what causes the persisting turn to run.
Once a send has been accepted, registering its acknowledgement SHALL precede any presentation work, and presentation failures SHALL NOT fail or repeat a delivery.
An asynchronous delivery attempted while no matching session-bound completion API is active SHALL remain pending without consuming the ordinary send-attempt budget.
Deferral on an inactive runtime SHALL NOT be unbounded: a delivery deferred past a bounded deferral budget SHALL be marked undeliverable with the cause recorded.

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

- **WHEN** a blocking child attempts to invoke the removed `caller_ping` control
- **THEN** no ping result or resumable path is returned; the foreground slot remains occupied until normal settlement, `subagent_done`, cancellation, or watch abandonment

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

### Requirement: foreground delivery barrier

While any parent tool call is queued for or running foreground subagent work, background completion and stall/recovery notifications SHALL be held without re-entering the parent turn.
The foreground result SHALL return first; held notifications SHALL then flush in settlement order with one parent wake-up.

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

- **WHEN** the last queued or active foreground child would previously have settled through `caller_ping`
- **THEN** no ping settlement exists, so the foreground barrier remains until that foreground run settles through a supported terminal path

### Requirement: status widget includes queued and active work

The extension SHALL always enable the human-only status widget.
It SHALL list queued, starting, active, waiting, interrupted, blocked, stalled, running, and finalizing entries, with foreground/background class and active/open/queued counts.
It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous.
It SHALL NOT register a model-facing listing or lifecycle tool beyond `subagent`.
It SHALL NOT require or honor a package `status.enabled` (or any other package config) toggle to disable the widget.
A settled run awaiting handoff SHALL identify why it is waiting, and the wording SHALL NOT imply a fault for waits that are expected.
Elapsed wait time SHALL be measured from the start of the current wait, not from run start.
Results whose retry policy is exhausted SHALL be counted and labelled distinctly from results still being retried, and both SHALL continue to surface the last delivery error.
A delivery deferred because no session-bound runtime is active SHALL be counted and labelled as awaiting the runtime, distinctly from both actively-retrying and undeliverable results.

The widget SHALL present tracked work as a tree under a `Subagents` title.
Every tracked run (starting, running, active, waiting, interrupted, blocked, stalled, finalizing) SHALL render as a two-line row: an identity line carrying a state glyph, the agent display name, compact run-ID prefix, admission class, and elapsed duration, and an indented activity line that leads with the run's current state — the run label for starting/running/active runs, `blocked` with its wait duration for permission waits, the state name with its duration for waiting/interrupted/stalled runs, and the specific delivery-wait reason with its per-wait duration for settled runs awaiting handoff — followed, when reported by the child, by turn count, tool-call count, and context-token usage.
Opaque hexadecimal IDs SHALL use an eight-character widget prefix and expand only when needed to distinguish simultaneously visible entries; the full ID SHALL remain unchanged for runtime correlation.
The glyph SHALL animate only for starting, running, and active entries; all other states SHALL use static glyphs.
Queued entries SHALL render as individual rows with name, compact run-ID prefix, class, and queued state, up to three entries; entries beyond the third SHALL be summarized as a single overflow count line without claiming that a pane or process has started.
Elapsed durations SHALL use an adaptive format: tenths of seconds under one minute, minutes and seconds under one hour, hours and minutes at one hour and beyond.

The widget SHALL distinguish terminal failure outcomes from success.
A run that completes successfully SHALL leave no row once its bookkeeping completes; when nothing else is tracked the widget SHALL be removed entirely.
A run that fails SHALL persist as a sticky terminal row — `✗` for failures (non-zero exit, error, watch/launch error), `■` for runs interrupted before settling, `⚠` for watch-abandoned runs — with its frozen duration and final telemetry, until evicted.
Sticky rows SHALL render after live, queued, and pending-delivery rows, most recent first, up to three rows with a `+N more` overflow line.
The whole sticky set SHALL be evicted when the next subagent launch is admitted.
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

- **THEN** the row clears and counts update; when nothing else is tracked the widget is removed entirely

#### Scenario: settled row clears on success

- **WHEN** delivery or suppression bookkeeping completes for a run that completed successfully

- **THEN** the row clears and counts update; when nothing else is tracked the widget is removed entirely

#### Scenario: observed interruption remains visible

- **WHEN** activity observation reports that the user interrupted a child turn before settlement
- **THEN** status projects the interrupted state and preserves a stopped terminal row without requiring a ping or parent lifecycle tool

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

#### Scenario: active run renders as a two-line tree row

- **WHEN** a labelled run is active and its child reports turns, tool calls, and context usage
- **THEN** the identity line shows a spinner glyph, the agent display name, run ID, class, and elapsed duration, and the activity line leads with the label followed by turn, tool, and token chunks

#### Scenario: blocked run renders in the two-line family with a static glyph

- **WHEN** a healthy child pane is waiting on a permission dialog
- **THEN** its row uses a static glyph and the activity line leads with `blocked` and the wait duration

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

- **WHEN** a run fails, is interrupted before settling, or its watch is abandoned, and its bookkeeping completes
- **THEN** a terminal row remains — `✗` for failure, `■` for interrupted, `⚠` for watch-abandoned — with its frozen duration and final telemetry

#### Scenario: next launch evicts terminal rows

- **WHEN** sticky terminal rows are displayed and a new subagent launch is admitted
- **THEN** the sticky set clears and the header returns to the live `● Subagents` form

#### Scenario: manual resume clears its terminal row

- **WHEN** a user continues work directly in a previously stopped child pane and it later reports `subagent_done`
- **THEN** the original sticky terminal row remains until the next subagent admission clears the whole sticky set; direct pane interaction does not create correlated extension resume completion

#### Scenario: idle-with-failures header is hollow and bare

- **WHEN** no work is running, queued, or actively retrying, and only sticky terminal rows and/or exhausted deliveries remain
- **THEN** the header renders as `○ Subagents` with no counts segment

#### Scenario: terminal rows are capped with overflow

- **WHEN** more than three sticky terminal rows exist
- **THEN** the three most recent render individually and the remainder is summarized as a single `+N more` line
