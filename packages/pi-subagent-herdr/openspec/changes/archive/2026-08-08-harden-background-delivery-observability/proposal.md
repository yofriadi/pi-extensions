## Why

Background subagent results reported "delivery pending" persistently. Two independent faults were confirmed, and the widget could not distinguish either from a healthy wait — a settled run awaiting handoff and a genuinely stuck one both rendered as `finalizing…`, and every retry state (including exhausted entries that nothing was retrying) collapsed into one `N delivery pending` tally.

**A wake/acknowledgement deadlock made loss permanent.** The parent wake was gated behind `await ackPromise`. Against an idle parent nothing had yet persisted the steer, so verification failed, so the wake never fired, so no turn started, so nothing drained the steer — eight retries, then `undeliverable`. Observed in production: a completed review's result was never delivered while the child's full output sat in its own session log, recoverable only by hand.

**A historical verification defect.** Forensic analysis of 47 parent session logs found 9 of 21 delivery entries (all written before 2026-08-04) lacked `details.id`, making verification permanently impossible; already fixed by including `id: running.id`. It went undiagnosed for a week precisely because the widget could not tell the states apart.

Two unbounded waits in the same path could also strand a run indefinitely, so a run could sit in `finalizing…` forever with no retry ever engaging.

## What Changes

- **Wake is no longer gated on acknowledgement:** the parent is notified immediately after an accepted send. The wake is a `role: "user"` follow-up, so it does not carry the custom-message hook hazard that forced the retreat from `triggerTurn`, and it is what starts the turn that persists the steer. This closes the deadlock above.
- **Presentation cannot break delivery:** the wait observer is invoked through a guard, and an accepted send now registers its acknowledgement *before* any presentation work. Previously a throwing observer propagated out of the barrier's send callback, which retries up to three times — re-sending a steer that log-dedup cannot yet see, producing up to three copies of one result.
- **Bounded completion watch:** `waitForCompletion` gains a hard deadline (`CompletionOptions.timeoutMs`, default 4 hours, `0` disables), now reachable per run through `watchSubagent` and `RunningSubagent.completionTimeoutMs`. On expiry it sweeps every evidence channel it polls — exit sidecar, sentinel file, and terminal tail — before settling. The terminal tail matters most: `watchSubagent` passes no `sentinelFile`, so the tail is the only sentinel channel that runs in production, and ignoring it would falsely time out a run that had already printed its completion sentinel.
- **Timeout is a distinct outcome, not an error:** a new `reason: "timeout"` and `"timeout"` settlement source replace the previous reuse of `reason: "error"`. An expired watch is an admission that we stopped observing, not a finding of failure, and presenting it as a provider error was actively misleading.
- **Abandoned watches release capacity immediately but keep their pane:** capacity bounds *observed* work and we have stopped observing, so admission and session leases release at once. Previously ownership followed pane closure, and a timed-out child is precisely the one least likely to ever exit — four such runs would exhaust background capacity permanently. The pane is preserved because a timeout does not establish that the child finished, and killing possibly-live work is unrecoverable while leaving a pane costs only a pane.
- **Every evidence probe is bounded** (`CompletionOptions.probeTimeoutMs`), including those in the deadline sweep, so a wedged herdr subprocess cannot turn a bounded watch into an unbounded one. A probe that exceeds its bound counts as no reading, never as evidence — in particular a hung pane probe is `unavailable`, never `missing`.
- **Bounded stream acknowledgement:** the stream-aware re-verify loop in `acknowledgeDelivery` gains a cap (`STREAM_ACK_MAX_WAIT_MS`, 1 hour, overridable per call). Previously a dropped steer combined with a parent that never emits `agent_settled` hung the run in `finalizing…` permanently, never reaching the bounded retry pump. The cap is deliberately far longer than any plausible turn because expiry re-queues the delivery and a re-send can persist a duplicate when the original steer was merely slow.
- **Delivery wait reasons are reported and named:** a new `DeliveryWaitKind` (`barrier` | `turn-boundary` | `verifying`) is reported through a `deliverBackgroundMessage` `onWait` callback and rendered as `held · foreground busy`, `awaiting turn boundary`, or `confirming delivery`. All three are expected states, so the wording does not imply a fault.
- **Wait duration times from the phase change,** not from run start, so a run that worked 20 minutes then waited 2 seconds reports 2 seconds.
- **Exhausted deliveries are counted and labelled separately:** the merged `N delivery pending` tally splits into `N delivery retrying` and `N undeliverable`, and the row label changes from `delivery retry 8` to `undeliverable after 8`. Nothing retries an exhausted entry — the retry interval self-clears — so the old label implied work in progress that was not happening. `lastError` continues to surface on both row types.
- **`formatTimeoutBudget` no longer collapses sub-second budgets to `0s`,** which made tiny caps produce nonsensical messages.

Explicitly preserved: steer delivery without `triggerTurn` (a `triggerTurn` custom message makes persistence depend on surviving every loaded extension's `message_end` hook, and a hook that throws on `role: "custom"` kills the turn before persistence, silently, on every retry), the separate best-effort wake as a `role: "user"` follow-up, and result extraction from the child session JSONL.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `completion-delivery`: settlement watching becomes bounded per run with bounded probes and a full evidence sweep at the deadline; timeout becomes a distinct abandoned-watch outcome with its own pane and capacity policy; delivery notification is decoupled from acknowledgement and made robust against presentation failure; delivery acknowledgement becomes bounded; the status widget requirement gains distinguishable delivery-wait states and separates actively-retrying from undeliverable results.

## Impact

- **Files:** `src/completion.ts` (`reason: "timeout"`, deadline, `sweepFinalEvidence`, `probeWithTimeout`, `probeTimeoutMs`, `formatTimeoutBudget`), `src/index.ts` (wake ordering, guarded `onWait`, `resolveSettlementDisposition`, `watchAbandoned` presentation, `completionTimeoutMs` plumbing, `DeliveryWaitKind`, `STREAM_ACK_MAX_WAIT_MS`, widget counts and row labels), `src/settlement.ts` (`"timeout"` source).
- **Tests:** `test/completion-timeout.test.ts` (9 cases), `test/delivery-observability.test.ts` (5), `test/delivery-wake-ordering.test.ts` (5, new), `test/watch-abandoned.test.ts` (10, new), `test/delivery-verification.test.ts` (+2 bounded-ack cases), `package.json` registration. 307 tests pass.
- **Runtime:** no long-lived background run is failed early at default settings; the two previously unbounded waits and every evidence probe now terminate. A timeout claims settlement under a new `"timeout"` source and flows through the normal delivery path.
- **Blocking runs** share `watchSubagent` and therefore also inherit the bounded wait — previously a blocking tool call could suspend indefinitely.
- **Capacity accounting changes** for preserved panes (abandoned watches and reported errors): the admission slot releases at settle rather than at pane closure, so preserved panes cannot block later work. The session lease is retained until explicit pane disappearance, both to keep delivery's `finalizing` transition valid and because a preserved pane may hold a live writer. Leases are idempotent, so the pane monitor's later full release is safe.
- **Deliberately not added:** a persistent terminal widget row for abandoned runs. `updateWidget` clears the widget when all tracked maps are empty, so a terminal row would need a new home in the delivery state machine. The delivered result already states that the pane was left open and names the session log, and the pane remains listable, so discoverability is covered without that structural change.
- **Not addressed:** durable cross-restart delivery state (an outbox plus reconcile-on-`session_start`). The session-log evidence does not show restart loss as a contributing cause, and the confirmed causes are fixed above.
