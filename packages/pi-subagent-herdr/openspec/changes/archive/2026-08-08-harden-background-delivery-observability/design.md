## Context

Background subagent results were persistently reported as "delivery pending". Investigation across 47 parent session JSONL logs established that the reported symptom had two unrelated sources, and that the widget's presentation made them indistinguishable.

Current delivery flow (unchanged by this design): a settled run's result is written to the parent session log via `sendMessage(..., { deliverAs: "steer" })` **without** `triggerTurn`, then verified by polling the log, then the parent is woken with a separate `role: "user"` follow-up. `triggerTurn` is deliberately avoided: it makes persistence depend on a triggered turn surviving every loaded extension's `message_end` hook, and a hook that throws on `role: "custom"` kills the turn before persistence — silently, on every retry.

Evidence gathered:

- **Confirmed historical cause.** 9 of 21 real delivery entries (all written 2026-07-29 → 2026-08-02) have `details` keys `[agent, elapsed, exitCode, name, runtimePlan, sessionFile, task]` with **no `id`**. Verification requires `details?.id === expectedRunId`, so those deliveries could never be verified despite being present in the log: every retry failed, attempts exhausted, and the run showed "delivery pending" forever. All 12 entries from 2026-08-04 onward carry `details.id`. Current code already sets `id: running.id`, so this is fixed.
- **Confirmed wake/acknowledgement deadlock.** The wake sat after `await ackPromise`. Against an idle parent, verification could not succeed until a turn ran, and the wake that starts that turn never fired — so retries exhausted and the result was reported `undeliverable` while the child's complete output sat in its own session log.

  This was initially *mis-ruled-out*. Result→wake gaps of 7–9 ms in earlier sessions were read as proof that an idle-parent steer persists synchronously; they only showed that when a turn was already imminent the steer drained fast and the ack passed. A later run sat idle for 90 minutes with nothing persisted, which is the counterexample. The lesson recorded here: a fast path observed under favourable timing is not evidence that the unfavourable path works.
- **Presentation could duplicate a delivery.** `onWait` ran after `sendMessage` but before the acknowledgement was registered, unguarded. A throwing observer propagated out of the barrier's send callback, which retries up to three times, re-sending a steer that log-dedup cannot see because it has not landed. Reverting the fix reproduces three sends for one result. This defect was *not* the cause of the observed production failure — traced separately — but is real.
- **Remaining expected wait.** A run settling while the parent is mid-turn is queued into the steer stream and persists only at the turn boundary. This is correct behaviour, but rendered identically to a fault.
- **Two unbounded waits.** `waitForCompletion` had no deadline (only an elapsed counter for ticks). `acknowledgeDelivery`'s `while (parentActivity.streaming)` re-verify loop had no cap, so a dropped steer plus a lost `agent_settled` event hung a run in `finalizing…` permanently, never reaching the retry pump.

## Goals / Non-Goals

**Goals:**

- No wait in the settle→deliver path may be unbounded.
- A person reading the widget can tell an expected wait from a stuck delivery, and a retrying delivery from an abandoned one, without reading logs.
- Timeout is a settlement outcome, not a special case: it reuses the existing delivery path.
- Preserve every existing correctness property: hook-safe steer delivery, dedup layers, foreground barrier ordering, exactly-once settlement.

**Non-Goals:**

- Durable cross-restart delivery state (outbox + reconcile-on-`session_start`). Deferred: session-log evidence does not show restart loss contributing, and the confirmed cause is already fixed. If pursued later it additionally needs a dead-letter terminal state, `parentSessionId` scoping, retention/GC, and debounced writes against the 1 s retry pump.
- Switching to `triggerTurn`-based delivery.
- Changing the result envelope, delivery ordering, dedup, or the foreground barrier.
- Imposing a work-duration SLA on subagents.

## Decisions

### Notification is not gated on acknowledgement

The wake fires immediately after an accepted send, before `await ackPromise`. The reverse order deadlocks against an idle parent: verification waits for a persist, the persist waits for a turn, and the turn waits for the wake. The wake is safe to fire early because it is a `role: "user"` follow-up — it does not carry the custom-message `message_end` hook hazard that forced the retreat from `triggerTurn`.

The cost is that a wake may fire for a delivery that ultimately fails, so the parent is nudged and finds nothing. That is self-correcting; the deadlock was not.

### An accepted send registers its acknowledgement before any presentation

Ordering, not just error handling, is the fix. `onWait` is additionally wrapped so an observer can never propagate, but the ordering is what makes it safe: the barrier's `retryAcceptedDelivery` retries the send callback up to three times, so anything that throws after `sendMessage` re-sends a steer that log-dedup cannot see (it has not landed yet). Presentation therefore runs last, after the acknowledgement is registered.

*Alternative considered:* only wrapping `onWait` in try/catch. Rejected — it leaves the same hazard for any future statement placed between the send and the registration.

### Timeout is its own reason, not a reused error

`reason: "timeout"` with a matching `"timeout"` settlement source. Reusing `reason: "error"` conflated two different facts: "the child reported failure" and "we stopped watching and do not know". That conflation drove two concrete defects — the run was presented as a provider error, and it inherited the error path's pane/capacity policy.

*Alternative considered:* throwing an abort-style error. Rejected — abort bypasses delivery, so the parent would learn nothing about a run that silently stopped being watched, which is the failure being fixed.

### Abandoned watches release capacity immediately, but keep their pane

Three distinct dispositions, expressed in one place (`resolveSettlementDisposition`): normal completion closes the pane; a reported error keeps the pane; an abandoned watch keeps the pane. In **both** preserved cases the admission slot is released immediately and only the session lease is retained until explicit pane disappearance.

Admission is split from the session lease deliberately. Releasing the session lease at settlement made the very next step (`sessionLease.transition("finalizing")`) throw, destroying delivery of the result being settled — and a preserved pane may still hold a live writer, so dropping exclusivity would allow a concurrent resume against it. Admission, by contrast, bounds *observed concurrent work*, and after settlement nothing is being observed: holding a slot for an unobserved run is pure loss. A timed-out child is the one least likely to ever exit, and a reported-error child has already exited but leaves its pane open for inspection — so tying either slot to pane closure leaks it indefinitely (four preserved panes would block all later background work). The unexpected-watcher catch paths apply the same admission-only release. Leases are idempotent, so an early admission release plus the pane monitor's later full release is safe.

The pane is kept because a timeout is an admission of ignorance, not a finding of failure: the child may be mid-task with live state. Killing it converts uncertainty into unrecoverable destruction, whereas leaving it costs one pane and stays inspectable.

*Alternative considered:* reaping the pane to guarantee cleanup. Rejected — unrecoverable, and it destroys exactly the state needed to diagnose why the watch expired.

### Watch deadline default of 4 hours, not 30 minutes

At this layer a legitimately long background run is indistinguishable from a hung one: pane present, no completion evidence yet. A tight cap therefore converts slow-but-healthy work into a false error. The cap exists to stop a *stranded* watcher from leaking forever, not to bound useful work. `timeoutMs: 0` disables it; the per-run override is reachable through `watchSubagent` and `RunningSubagent.completionTimeoutMs` — an earlier version of this change documented that override while nothing plumbed it through, so it did not exist in production.

*Alternative considered:* the 30-minute default used by a comparable project. Rejected as too aggressive for this project's workloads given the false-failure cost.

### The deadline sweeps every evidence channel, each bounded

The deadline check necessarily runs before the loop's own probes, so settling on the deadline alone reports "no evidence" for a run that had just finished. The sweep therefore probes the exit sidecar, the sentinel file, **and** the terminal tail.

The terminal tail is the important one: `watchSubagent` passes no `sentinelFile`, so the tail is the only sentinel channel that runs in production. An earlier version of this change probed only the sentinel file, which is dead code in production — so the "fixed" deadline still had a false-timeout path for the real configuration.

Every probe is bounded (`probeTimeoutMs`), including those in the sweep, so a wedged herdr subprocess cannot turn a bounded watch into an unbounded one through the final check. A probe that exceeds its bound counts as *no reading*, never as evidence — in particular a hung pane probe yields `unavailable`, never `missing`, so it can never be mistaken for the pane having vanished.

### Stream acknowledgement cap of 1 hour

Expiry re-queues the delivery, and a re-send can persist a **duplicate** if the original steer was merely slow rather than dropped — dedup-before-send scans the session log and cannot see a steer that has not landed yet. So the cap must only fire when it means "the parent is broken", never "the parent is busy". A healthy long turn eventually emits `agent_settled` and exits the loop normally; only a lost event reaches the cap. One hour trades a permanent hang for negligible duplicate exposure.

*Alternative considered:* 10 minutes. Rejected after review — heavy tool-use turns can plausibly exceed it, which would have made duplicate `subagent_result` entries routine.

### Wait reason is pushed from the delivery path, not inferred by the widget

`deliverBackgroundMessage` accepts an `onWait(kind)` callback and reports at the two points where waiting actually begins: barrier hold (before any send is attempted) and post-send, where the already-computed `queuedIntoStream` flag distinguishes a stream-queued steer from an idle write. The widget renders what it is told.

*Alternative considered:* having the widget infer state from `runtime.parentActivity` and barrier internals. Rejected — it would duplicate delivery-phase logic in the renderer and drift from it.

### Wait duration is stamped on phase change

`onWait` re-stamps `deliveryWait.since` only when the kind changes. Timing from run start would report a 20-minute wait for a run that worked 20 minutes and waited 2 seconds — recreating the same false alarm in different words.

### Exhausted entries are a distinct presentation state, not a distinct data model

Exhaustion is already recorded as `PendingDelivery.exhausted`. The widget splits counts and row labels on that existing flag (`undeliverable after N` vs `delivery retry N`) rather than introducing a new terminal state, because reload already re-drives exhausted entries and a new state would have to be reconciled with that.

## Risks / Trade-offs

- **A genuinely hung run now waits up to 4 hours before being abandoned** → Accepted deliberately: the alternative is falsely failing healthy long work. The new wait labels make an in-progress watch visible meanwhile, and `completionTimeoutMs` allows a tighter per-run bound.
- **Acknowledgement-cap expiry can persist a duplicate result** → Mitigated by setting the cap far above any plausible turn length, so expiry indicates a broken parent rather than a busy one. Documented at the constant so it is not re-tightened without the rationale.
- **The wake may fire for a delivery that never persists** → Accepted: the parent is nudged and finds nothing, which is self-correcting. The alternative ordering deadlocks permanently.
- **Longer widget labels could overflow narrow frames** → Verified by rendering every new label, including the longest `undeliverable after 8 · <error>` row, at widths 8–100 and confirming all lines stay within the frame.
- **An abandoned watch could be mistaken for a child failure** → It carries its own `reason`, its own settlement source, and its own presentation stating the outcome is unknown, that the pane may still be alive, and where the session log is. It never claims the run produced no result.
- **An abandoned run's pane can linger indefinitely** → Accepted, and the deliberate trade: a lingering pane is recoverable and inspectable, whereas reaping possibly-live work is not. Capacity is no longer coupled to it, so a lingering pane cannot block later work.
- **An abandoned run leaves no persistent widget row** → `updateWidget` clears the widget once all tracked maps are empty, so a terminal row needs a new home in the delivery state machine. Deferred rather than bolted on; the delivered result and the still-listable pane cover discoverability.
- **Deferring the outbox leaves cross-restart loss unaddressed** → Accepted: not evidenced as a contributing cause. The new labels mean a recurrence will identify its own state rather than presenting as an undifferentiated "pending".
- **Verified only at unit level** → No live end-to-end run has exercised the new wake ordering, wait labels, or abandoned-watch path; the first real background completion confirms them. Each fix was instead validated by reverting the source change and confirming the corresponding test fails.

## Migration Plan

No migration. All changes are additive or presentational: `timeoutMs` and `streamWaitMs` are optional with safe defaults, and the widget changes are display-only. Rollback is a straight revert with no persisted-state implications.

## Open Questions

- Should the watch deadline be user-configurable per agent definition rather than only per run?
- Should an abandoned run keep a persistent terminal widget row, and if so where should it live given that `updateWidget` clears on empty maps?
- Should `findDeliveryEntry` fall back to content matching when `details.id` is absent, so a future record-shape regression degrades to a soft match instead of permanent unverifiability?
