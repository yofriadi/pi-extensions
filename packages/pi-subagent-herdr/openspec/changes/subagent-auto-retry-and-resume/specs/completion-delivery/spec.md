## MODIFIED Requirements

### Requirement: deterministic multi-channel settlement

The extension SHALL poll the child exit sidecar (`exit.json` inside the session companion directory `<session_dir>/<stem>/`), terminal sentinel, and pane existence.
Settlement SHALL be atomically claimed once.
A valid sidecar observed in the same poll SHALL take precedence; sentinel and pane disappearance SHALL receive a bounded sidecar grace.
Nonzero exits, malformed sidecars, stale assistant text, and empty successful output SHALL produce explicit deterministic outcomes.
Watching SHALL be bounded by a per-attempt configurable deadline whose default is generous enough not to curtail legitimate long-running work; each attempt of an automatically retried run SHALL begin a fresh watch with the same configured deadline, and backoff delays SHALL NOT count toward any watch budget.
Every evidence probe SHALL itself be bounded, and a probe that exceeds its bound SHALL count as no reading rather than as evidence.
On expiry the extension SHALL first sweep every evidence channel it polls — exit sidecar (`exit.json`), sentinel file, and terminal tail — and prefer any real evidence found; only with no evidence SHALL it settle as a distinct abandoned-watch outcome that is not classified as a child or provider failure, routed through the normal delivery path.
When a subagent attempt ends with a well-formed child error sidecar (`type: "error"`) and fewer than 3 total attempts have run, the extension SHALL close the failed attempt's pane and relaunch the same session file through the post-admission launch segment with a fresh per-attempt id after an abort-aware stepped delay, without claiming settlement for the failed attempt; malformed sidecars, pane disappearance, abandoned watch, and aborted runs SHALL NOT be retried.
A failure of the relaunch mechanics itself — replacement surface creation, launch-script writing, pane run, or the failed attempt's pane persisting past its confirmed-absence bound — SHALL settle the run through the ordinary reported-error path.
The exit sidecar SHALL be consumed (unlinked) on every read attempt regardless of outcome — valid, malformed, or stale.
Sidecar-triggered settlement SHALL be gated on verified sidecar ownership: a sidecar whose run does not match the current owned run SHALL be consumed and rejected, never becoming the settlement outcome.
For sidecar settlement the ownership comparand is the run's current attempt id — the id each attempt's sidecar runId is stamped with.
Companion-directory deletion SHALL happen at exactly one settlement site: the run's settlement disposition, after transcript extraction and the final activity observation.
The disposition SHALL key artifact deletion on the full completion outcome, per channel: a sidecar-derived success deletes only with exit code zero AND a runId present and equal to the run's current attempt id (fail-closed — absent or mismatched means preserve); a sentinel success deletes on exit code zero alone, the sentinel being read from the run's own freshly launched pane tail and so inherently bound to this run; a nonzero exit on any channel never deletes.
Upon such a verified success the disposition SHALL recursively remove the companion directory `<stem>/`; upon settlement with a nonzero exit code, crash, or abandoned watch, it SHALL preserve the remaining companion directory `<stem>/` for manual inspection and debugging.

#### Scenario: valid sidecar wins

- **WHEN** a valid sidecar and another completion signal are observable in one poll
- **THEN** the sidecar outcome is claimed and processed exactly once

#### Scenario: success deletes the companion directory

- **WHEN** an owned sidecar with exit code zero settles the run
- **THEN** the settlement disposition — after transcript extraction and the final activity observation — recursively removes the companion directory `<stem>/`; no run artifacts remain on disk beside the retained `<stem>.jsonl` (a late child write may still recreate a directory holding only the consumed sidecar — the guarantee is causal, not atomic)

#### Scenario: sentinel fallback

- **WHEN** no valid sidecar appears within grace and a sentinel reports exit code zero
- **THEN** the run settles successfully from the sentinel

#### Scenario: sentinel success deletes the companion directory

- **WHEN** a run settles successfully through the sentinel channel with exit code zero
- **THEN** the settlement disposition removes the companion directory `<stem>/` exactly as a sidecar success would — the sentinel result carries no runId and binds inherently to the run's own freshly launched pane tail

#### Scenario: nonzero sentinel

- **WHEN** no valid sidecar appears within grace and the sentinel has a nonzero code
- **THEN** the run settles as an error even if older assistant text exists

#### Scenario: nonzero sentinel preserves the companion directory

- **WHEN** the sentinel channel reports a nonzero exit code
- **THEN** the disposition's artifact decision keys on the exit code, not the channel, and the companion directory `<stem>/` is preserved intact on disk for inspection

#### Scenario: nonzero settlement preserves the companion directory

- **WHEN** a run settles with a nonzero exit code, a crash, a pane disappearance, or an abandoned watch
- **THEN** the companion directory `<stem>/` (minus the already-consumed `exit.json`) is preserved intact on disk for inspection

#### Scenario: stale sidecar never deletes the companion directory

- **WHEN** a sidecar is observed whose runId does not match the current owned run
- **THEN** the sidecar is consumed and rejected, never becomes the settlement outcome, and no companion-directory deletion occurs for the live run whose `launch.sh`, prompts, and `activity.json` remain intact

#### Scenario: unbound sidecar success preserves the companion directory

- **WHEN** a sidecar-derived success reaches the disposition without a runId equal to the run's current attempt id
- **THEN** deletion is fail-closed and the companion directory is preserved rather than removed (production ownership checks make this unreachable; the guard is belt-and-suspenders)

#### Scenario: pane disappears

- **WHEN** the pane disappears and no valid sidecar or sentinel wins during grace
- **THEN** the run settles with a pane-disappearance error and cleanup treats the already absent pane as cleaned

#### Scenario: malformed or stale sidecar

- **WHEN** a sidecar is malformed or does not belong to the current owned run
- **THEN** it is not accepted as successful settlement and the resulting error/race handling is visible

#### Scenario: consumed sidecar is removed deterministically

- **WHEN** any read attempt of `<stem>/exit.json` completes — valid, malformed, or stale
- **THEN** the sidecar file is unlinked as part of consumption, so a failed settlement leaves no readable sidecar behind

#### Scenario: auto-retry on retryable error succeeds

- **WHEN** a subagent attempt ends with a well-formed child error sidecar and fewer than 3 total attempts have run
- **THEN** the extension closes the failed attempt's pane, relaunches the same session file after the stepped delay, and upon a subsequent successful completion delivers the final result without reporting an intermediate failure

#### Scenario: retry reuses the original launch configuration

- **WHEN** a failed attempt is automatically retried
- **THEN** the relaunched command reproduces the agent-owned flags, companion extension, launch environment, skills, model, identity, and terminal sentinel verbatim through the same post-admission launch segment, with a fresh per-attempt id so earlier attempts' sidecars are rejected by the ownership check while the run's parent-side identity stays stable

#### Scenario: non-retryable outcomes settle immediately

- **WHEN** an attempt ends through a malformed sidecar, pane disappearance, watch abandonment, or an aborted run rather than a well-formed error sidecar
- **THEN** the run settles immediately through its ordinary deterministic outcome and no automatic retry is attempted

#### Scenario: auto-retry exhausted settles as failure

- **WHEN** a subagent run encounters well-formed error sidecars on all 3 total attempts
- **THEN** the run settles as a terminal failure through the ordinary failure path, preserving the final pane and companion directory, and reports that extension auto-retries were exhausted after 3 attempts with the session log path

#### Scenario: retry preserves capacity and lease across attempts

- **WHEN** a failed attempt is reaped and relaunched as a retry
- **THEN** the run keeps its admission slot and session lease without re-acquiring, the widget row persists under the same run identity, and only the final attempt's pane is preserved for inspection

#### Scenario: relaunch failure settles as reported error

- **WHEN** the relaunch mechanics fail — the replacement surface cannot be created, the launch script cannot be written, the pane run fails, or the failed attempt's pane persists past its confirmed-absence bound
- **THEN** the relaunch's own cleanup runs (close the replacement pane, remove the new launch script), the pre-existing session file and companion directory are untouched, and the run settles through the ordinary reported-error path with any surviving pane preserved

#### Scenario: watch deadline applies per attempt

- **WHEN** an attempt exhausts its watch deadline while automatic retries remain
- **THEN** the timeout is not retried and the run settles as an abandoned watch per the base rules; watch bounds apply per attempt, so every attempt that begins starts a fresh watch of the same configured length, with backoff delays outside the watch budget

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
- **THEN** its admission slot is released immediately so later work is not blocked, its session lease is retained until explicit pane disappearance (the pane may still hold a live writer), and its pane and companion directory are preserved for inspection rather than reaped

#### Scenario: abandoned watch is presented as unknown, not failed

- **WHEN** an abandoned-watch outcome is presented to the parent
- **THEN** it states that the outcome is unknown and the pane may still be alive, includes any output already recovered from the child session log, and does not claim the run produced no result or that a provider error occurred

#### Scenario: preserved error pane frees admission but keeps its session lease

- **WHEN** a run settles with a reported error (structured or unexpected) while its pane is preserved for inspection
- **THEN** its admission slot is released immediately rather than held until the pane is closed, and its session lease is retained until explicit pane disappearance

### Requirement: text-only result extraction

The extension SHALL walk the owned child JSONL backwards to the current run's final assistant message and join only text blocks.
It SHALL surface provider errors and SHALL NOT let stale text from a prior turn mask the current exit state.
When an error outcome is presented after exhausting automatic retries, the presentation SHALL keep the parseable provider/agent-error prefix, state that extension auto-retries were exhausted after 3 attempts, and reference the session log path.

#### Scenario: thinking and tool blocks excluded

- **WHEN** the final assistant message contains thinking, tool, and text blocks
- **THEN** only its text blocks form the presented answer

#### Scenario: provider error without text

- **WHEN** the current turn ends with provider error and no text
- **THEN** the result presents the provider error message

#### Scenario: retry exhaustion presentation

- **WHEN** the final attempt of an automatically retried run ends with a provider error and no text
- **THEN** the result presents the provider error message with the extension auto-retry-exhausted statement and the session log path, distinguishable from Pi-internal provider retries

#### Scenario: successful exit without assistant text

- **WHEN** the current run exits zero without a current assistant text message
- **THEN** the result explicitly reports missing output rather than reusing prior text

### Requirement: exactly-once delivery state machine

Each settled run SHALL be atomically claimed, extracted, cleaned, capacity-released, and delivered or suppressed once.
`delivered` SHALL mean the parent delivery API accepted the message or the blocking tool result is being returned.
Failed async delivery SHALL remain pending under a bounded retry policy and SHALL NOT be silently deleted.
Waiting for delivery persistence SHALL itself be bounded: a delivery queued into a streaming parent SHALL be re-verified only while the parent remains active and only up to a cap far exceeding any plausible parent turn, after which the delivery SHALL be re-queued for bounded retry rather than waited on indefinitely.
Notifying an idle parent SHALL NOT be gated on persistence acknowledgement, because the notification is what causes the persisting turn to run.
Once a send has been accepted, registering its acknowledgement SHALL precede any presentation work, and presentation failures SHALL NOT fail or repeat a delivery.
An asynchronous delivery attempted while no matching session-bound completion API is active SHALL remain pending without consuming the ordinary send-attempt budget.
Deferral on an inactive runtime SHALL NOT be unbounded: a delivery deferred past a bounded deferral budget SHALL be marked undeliverable with the cause recorded.
The automated parent wake notice dispatched to wake an idle parent on delivery SHALL be `"Subagent result delivered. Continue."`.

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

#### Scenario: shortened wake notice content

- **WHEN** an async subagent result wakes an idle parent session
- **THEN** the injected user message content is `"Subagent result delivered. Continue."`, with provenance carried by the delivered result payload rather than the wake text

### Requirement: status widget includes queued and active work

The extension SHALL always enable the human-only status widget.
It SHALL list queued, starting, active, waiting, interrupted, blocked, stalled, running, retrying, and finalizing entries, with foreground/background class and active/open/queued counts.
It SHALL use stable internal run IDs to distinguish repeated agents or duplicate labels where presentation would otherwise be ambiguous.
It SHALL NOT register a model-facing listing or lifecycle tool beyond `subagent`.
It SHALL NOT require or honor a package `status.enabled` (or any other package config) toggle to disable the widget.
A settled run awaiting handoff SHALL identify why it is waiting, and the wording SHALL NOT imply a fault for waits that are expected.
Elapsed wait time SHALL be measured from the start of the current wait, not from run start.
Results whose retry policy is exhausted SHALL be counted and labelled distinctly from results still being retried, and both SHALL continue to surface the last delivery error.
A delivery deferred because no session-bound runtime is active SHALL be counted and labelled as awaiting the runtime, distinctly from both actively-retrying and undeliverable results.

The widget SHALL present tracked work as a tree under a `Subagents` title.
Every tracked run (starting, running, active, waiting, interrupted, blocked, stalled, retrying, finalizing) SHALL render as a two-line row: an identity line carrying a state glyph, the agent display name, compact run-ID prefix, admission class, and elapsed duration, and an indented activity line that leads with the run's current state — the run label for starting/running/active runs, `retrying` with its attempt count (e.g. `retrying (2/3)`) for runs undergoing automatic attempt relaunch, `blocked` with its wait duration for permission waits, the state name with its duration for waiting/interrupted/stalled runs, and the specific delivery-wait reason with its per-wait duration for settled runs awaiting handoff — followed, when reported by the child, by turn count, tool-call count, and context-token usage.
Opaque hexadecimal IDs SHALL use an eight-character widget prefix and expand only when needed to distinguish simultaneously visible entries; the full ID SHALL remain unchanged for runtime correlation.
The glyph SHALL animate only for starting, running, active, and retrying entries; all other states SHALL use static glyphs.
Queued entries SHALL render as individual rows with name, compact run-ID prefix, class, and queued state, up to three entries; entries beyond the third SHALL be summarized as a single overflow count line without claiming that a pane or process has started.
Elapsed durations SHALL use an adaptive format: tenths of seconds under one minute, minutes and seconds under one hour, hours and minutes at one hour and beyond.

The widget SHALL distinguish terminal failure outcomes from success.
A run that completes successfully SHALL leave no row once its bookkeeping completes; when nothing else is tracked the widget SHALL be removed entirely.
A run that fails SHALL persist as a sticky terminal row — `✗` for failures (non-zero exit, error, watch/launch error), `■` for runs interrupted before settling, `⚠` for watch-abandoned runs — with its frozen duration and final telemetry, until evicted.
Sticky rows SHALL render after live, queued, and pending-delivery rows, most recent first, up to three rows with a `+N more` overflow line.
The whole sticky set SHALL be evicted when the next subagent launch is admitted.
The header SHALL render as `● Subagents` with the counts segment while live work exists (running, retrying, queued, or actively-retrying deliveries), and as `○ Subagents` with no counts segment when only sticky rows and/or exhausted deliveries remain.

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

#### Scenario: retrying run renders in the two-line family

- **WHEN** a run is undergoing an automatic attempt relaunch after a well-formed error sidecar
- **THEN** its row uses an animated glyph, the activity line leads with `retrying (2/3)`, the run is counted as open/active work in the header counts, and the row keeps its original identity and start time

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
