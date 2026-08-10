## 1. Diagnose before changing anything

- [x] 1.1 Scan parent session JSONL logs for `subagent_result` / `subagent_ping` entries and record record shape, `details` keys, and presence of `details.id`
- [x] 1.2 Correlate result entries with wake follow-ups to test the suspected wake/ack deadlock (disproved: 7–9 ms result→wake gaps show idle-parent steers persist synchronously)
- [x] 1.3 Identify the historical cause: 9 of 21 entries (all pre-2026-08-04) carry no `details.id`, making verification permanently impossible; confirm current code sets `id: running.id`
- [x] 1.4 Confirm the two unbounded waits by reading `waitForCompletion` and the `while (parentActivity.streaming)` loop in `acknowledgeDelivery`

## 2. Bound the completion watch

- [x] 2.1 Add `DEFAULT_COMPLETION_TIMEOUT_MS` (4h) and `CompletionOptions.timeoutMs` to `src/completion.ts`, documenting why the default is generous and that `0` disables
- [x] 2.2 Compute a deadline in `waitForCompletion` and check it each iteration before the evidence probes
- [x] 2.3 On expiry, sweep every evidence channel — exit sidecar, sentinel file, and terminal tail — and prefer real evidence over the synthetic outcome
- [x] 2.4 Include the terminal tail in that sweep: `watchSubagent` passes no `sentinelFile`, so the tail is the only sentinel channel that runs in production and a sentinel-file-only sweep left a false-timeout path
- [x] 2.5 Add `probeWithTimeout` and `CompletionOptions.probeTimeoutMs`; bound the pane inspection, the in-loop tail read, and both sweep probes so a wedged herdr cannot unbound the watch
- [x] 2.6 Treat an over-budget pane probe as `unavailable`, never `missing`, so a hung probe is not mistaken for a vanished pane
- [x] 2.7 Introduce `reason: "timeout"` (replacing the reuse of `reason: "error"`) and add a matching `"timeout"` settlement source in `src/settlement.ts`
- [x] 2.8 Plumb the per-run budget through `watchSubagent` and `RunningSubagent.completionTimeoutMs` so the documented override actually exists in production
- [x] 2.9 Add `formatTimeoutBudget` and stop sub-second budgets rendering as `0s`
- [x] 2.10 Verify a timeout still claims settlement and that blocking runs inherit the bound via `watchSubagent`

## 3. Fix the delivery notification path

- [x] 3.1 Move `wakeParent` ahead of `await ackPromise` so an idle parent is notified immediately after an accepted send, breaking the deadlock where verification waited on a persist that waited on a turn that waited on the wake
- [x] 3.2 Keep the `!queuedIntoStream` and `currentTurnAlreadySeesIt` guards — a stream-queued steer is drained by the running loop and needs no wake
- [x] 3.3 Register the in-flight acknowledgement immediately after an accepted send, before any presentation work, so nothing between the send and the registration can trigger the barrier's send retry
- [x] 3.4 Route `onWait` through a guard that swallows observer failures, and report the phase last
- [x] 3.5 Record at the call site why the ordering matters, including the production incident, so it is not reordered back

## 4. Decide pane and capacity disposition for an abandoned watch

- [x] 4.1 Add `resolveSettlementDisposition` mapping each completion reason to `{ watchAbandoned, preservePane, releaseAdmissionNow }` in one place
- [x] 4.2 Split `releaseAdmissionOnly` from `releaseRunOwnership`: release the admission slot immediately for an abandoned watch while retaining the session lease until explicit pane disappearance. Releasing the session lease here made the subsequent `sessionLease.transition("finalizing")` throw and destroyed delivery, and a live child could still be writing to that session
- [x] 4.3 Preserve the abandoned run's pane rather than reaping it, documenting that a timeout does not establish the child finished and that reaping possibly-live work is unrecoverable
- [x] 4.4 Apply the same admission-only release to reported errors (structured and the unexpected-watcher catch paths): the child has exited so its slot must not be held until the user closes the pane, while the session lease follows pane disappearance. Confirm leases are idempotent so an early admission release plus a later monitor release is safe
- [x] 4.5 Add `RunningSubagent.watchAbandoned` and `SubagentResult.watchAbandoned`, and propagate the flag into the delivered message details
- [x] 4.6 Give the abandoned outcome its own presentation branch in `resolveResultPresentation`: state the outcome is unknown, keep any recovered summary and session pointer, say the pane was left open and capacity released, and never claim the run produced no result or that a provider error occurred

## 5. Bound the delivery acknowledgement

- [x] 5.1 Add `STREAM_ACK_MAX_WAIT_MS` and an optional `streamWaitMs` override to `acknowledgeDelivery` in `src/index.ts`
- [x] 5.2 Apply the cap to the `while (parentActivity.streaming)` re-verify loop so expiry re-queues for bounded retry instead of hanging
- [x] 5.3 Set the cap to 1h and document at the constant that expiry can persist a duplicate, so it must mean "parent is broken" not "parent is busy" — preventing a future re-tightening

## 6. Make delivery waits distinguishable

- [x] 6.1 Add the `DeliveryWaitKind` type (`barrier` | `turn-boundary` | `verifying`) with doc comments stating all three are expected states
- [x] 6.2 Add `RunningSubagent.deliveryWait` (`{ kind, since }`)
- [x] 6.3 Add an `onWait` callback to `deliverBackgroundMessage` options
- [x] 6.4 Report `barrier` before the barrier drain (while held, no send is attempted) and `turn-boundary` / `verifying` after `sendMessage` using the existing `queuedIntoStream` flag
- [x] 6.5 Wire `onWait` at the `superviseBackgroundRun` call site, re-stamping `since` only on phase change so the duration reflects the current wait
- [x] 6.6 Clear `deliveryWait` in the delivery `finally` so a preserved error pane cannot render a stale wait label

## 7. Separate retrying from undeliverable in the widget

- [x] 7.1 Add `formatDeliveryWaitLabel` producing `held · foreground busy` / `awaiting turn boundary` / `confirming delivery`
- [x] 7.2 Have `formatLifecycleWidgetLabel` accept `deliveryWait` and render the named reason plus wait duration instead of `finalizing…`, keeping `finalizing…` when no reason was reported
- [x] 7.3 Split the header tally into `N delivery retrying` and `N undeliverable` based on the existing `PendingDelivery.exhausted` flag
- [x] 7.4 Change the exhausted row label to `undeliverable after N` while keeping `delivery retry N` for live retries, and keep `lastError` on both

## 8. Test and verify

- [x] 8.1 `test/completion-timeout.test.ts`: timeout settles as `reason: "timeout"` (not `error`); racing sidecar wins; racing sentinel-file wins; racing terminal-tail sentinel wins with its exit code preserved; a never-resolving tail probe still settles; a hung pane probe reports `unavailable` and keeps watching; `timeoutMs: 0` disables; default is finite; `formatTimeoutBudget` boundaries including sub-second
- [x] 8.2 `test/delivery-wake-ordering.test.ts`: the wake fires even when acknowledgement fails; the ordinary acked path still wakes; a throwing observer on an unlanded steer causes exactly one send; a throwing observer on a landed steer completes normally; the `verifying` phase is still reported
- [x] 8.3 `test/watch-abandoned.test.ts`: an abandoned watch is presented as unknown rather than failed, keeps its summary and session pointer, does not swallow genuine provider errors, leaves normal completions untouched; and the disposition releases capacity immediately, preserves the pane, and leaves error and normal dispositions unchanged
- [x] 8.4 Add bounded-ack cases to `test/delivery-verification.test.ts`: a never-settling streaming parent rejects within the cap; a drained steer resolves without waiting out the cap
- [x] 8.5 `test/delivery-observability.test.ts`: each wait kind renders distinguishably and never falls back to `finalizing`; absent wait still renders `finalizing…`; duration times from phase change; retrying vs undeliverable counted and labelled separately; `lastError` survives on both row types
- [x] 8.6 Register every new test file in the `package.json` test script
- [x] 8.7 Prove each fix is load-bearing by reverting the source change and confirming the corresponding test fails (wake ordering: 1 failure; observer ordering: 3 sends instead of 1)
- [x] 8.8 Confirm every new label — including the longest `undeliverable after 8 · <error>` row — stays within the frame at widths 8–100
- [x] 8.9 Run typecheck, the full test suite (307 pass), and lint; confirm no new warnings and re-run the timing-sensitive files repeatedly to rule out flakes
