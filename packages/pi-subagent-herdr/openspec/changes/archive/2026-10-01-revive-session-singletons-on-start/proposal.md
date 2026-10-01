## Why

Switching sessions (`/resume`, `/new`, `/fork`) and resuming back leaves the target session permanently un-spawnable: every `subagent` call fails with "Subagent coordinator is shut down." (async) or "Subagent delivery suppressed during shutdown." (blocking).
The admission coordinator and foreground delivery barrier are terminally poisoned at switch-out, stored in session-ID-keyed process-global registries, and Pi restores the same session ID on resume-back, so the poisoned instances are retrieved again.
`session_start` never revives them, and this is the reported user-facing failure.

## What Changes

- Treat session-keyed singleton poisoning as revocable at activation: on `session_start`, detect a shut-down admission coordinator or a suppressed foreground delivery barrier cached for that session ID and REPLACE the poisoned instance with a fresh one in the same process-global registry (evict-and-insert, never in-place un-shutdown/un-suppress).
- Delegation first: the revival check goes through the existing getters (`getAdmissionCoordinator`, `getForegroundDeliveryBarrier`) so legacy v1→v2 migration and held-delivery adoption still run before the poisoned-instance check; revival never inspects the raw registry cache.
- Conditional replacement only: a healthy singleton (including a live coordinator adopted across `/reload` with active background leases) is returned unchanged, preserving reload survival of background subagents.
- Placement: revival runs in `handleParentSessionStart` before `reconcileActive`, so foreground-barrier reconciliation runs against the healthy barrier.
- Keep kill-on-switch semantics unchanged: background subagents still die, panes close, deliveries suppress, and pending work is exhausted at switch-out.
  Only re-spawnability after return changes.
- No changes to other session-keyed state (completion runtime already re-activates unconditionally; `deliveredRunIds`/`stickyTerminalRuns` are cleared at terminal shutdown; session leases and settlement claims are per-run).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `extension-runtime-safety`: Session-bound lifecycle state must be re-established at `session_start` after a terminal shutdown of the same session identity.
  A new requirement covers revival of poisoned session-keyed delivery singletons at activation time, with scenarios for resume-back revival, reload survival of healthy singletons, and fail-closed late deliveries.

## Impact

- **Code:** `packages/pi-subagent-herdr/src/coordinator.ts` (expose `isShutDown`, add `ensureHealthyAdmissionCoordinator`), `packages/pi-subagent-herdr/src/delivery-barrier.ts` (add `ensureHealthyForegroundDeliveryBarrier`), `packages/pi-subagent-herdr/src/index.ts` (`handleParentSessionStart` calls both before `reconcileActive`).
- **Tests:** coordinator and delivery-barrier unit tests for replace-when-poisoned / keep-when-healthy; a regression reproducing the user scenario (poison via `settleParentShutdown("resume", …)` → `session_start` → admission succeeds) driven through the registered `pi.handlers.session_start` event; a fail-closed late-watcher test after revival.
- **Runtime:** No tool schema, admission limits, delivery ordering, dedup, or retry-budget changes.
  No new process-global keys; the same registry keys are re-populated with fresh instances.
- **Compatibility:** Session-switch teardown behavior is unchanged for everything except spawning into a previously-visited session, which goes from permanently broken to working.
  Old lease/watcher closures from before the switch remain fail-closed by design.
