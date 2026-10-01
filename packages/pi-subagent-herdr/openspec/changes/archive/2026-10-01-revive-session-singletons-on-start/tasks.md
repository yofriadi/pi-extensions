## 1. Coordinator revival

- [x] 1.1 Expose `isShutDown()` on `AdmissionCoordinator` in `packages/pi-subagent-herdr/src/coordinator.ts` (public read of the existing `shutdown` flag; no behavior change).
- [x] 1.2 Add `ensureHealthyAdmissionCoordinator(parentSessionId)` in `coordinator.ts`: resolve via `getAdmissionCoordinator` first (preserving v1→v2 migration), then if the returned instance `isShutDown()`, insert a fresh `AdmissionCoordinator` into the process-global coordinators map under the same session key and return it; otherwise return the resolved instance unchanged.
- [x] 1.3 Unit tests (extend `packages/pi-subagent-herdr/test/coordinator.test.ts`): a shut-down instance is returned as-is by `getAdmissionCoordinator`; `ensureHealthyAdmissionCoordinator` replaces it with a fresh instance that admits a request; a healthy instance is identity-preserved (same object reference returned).

## 2. Barrier revival

- [x] 2.1 Add `ensureHealthyForegroundDeliveryBarrier(parentSessionId)` in `packages/pi-subagent-herdr/src/delivery-barrier.ts`: resolve via `getForegroundDeliveryBarrier` first (preserving legacy replacement and held-delivery adoption), then if the returned instance `isSuppressed()`, insert a fresh v2 `ForegroundDeliveryBarrier` into the process-global barriers map under the same session key and return it; otherwise return the resolved instance unchanged.
- [x] 2.2 Unit tests (extend `packages/pi-subagent-herdr/test/delivery-barrier.test.ts`): a suppressed barrier is replaced (fresh instance not the mutated original; original still suppressed and unusable) and the fresh instance accepts `enter()`/`deliver()`; an unsuppressed instance is identity-preserved; a legacy cached instance migrates through the getter before the suppression check applies (no raw-cache `TypeError`).

## 3. Activation wiring

- [x] 3.1 In `packages/pi-subagent-herdr/src/index.ts` `handleParentSessionStart`, replace the standalone `getAdmissionCoordinator(parentSessionId)` call (redundant after this change since `ensureHealthyAdmissionCoordinator` delegates to it) with `ensureHealthyAdmissionCoordinator(parentSessionId)`, and make the barrier line `ensureHealthyForegroundDeliveryBarrier(parentSessionId).reconcileActive(activeForegroundRunIds())` — collapsing three getter calls into two and structurally guaranteeing reconciliation runs against the healthy barrier.
- [x] 3.2 Regression test for the reported failure (new `packages/pi-subagent-herdr/test/session-revival.test.ts`): poison session X's singletons via `settleParentShutdown("resume", X)` with running/queued/pending maps populated (injecting `safeClose`/`release`/`abortTransactions` no-ops, mirroring the existing pattern in `test/test.ts`); invoke the registered `pi.handlers.session_start({}, fakeCtx(X))` (matching the event-driven pattern in `test/runtime-safety.test.ts`); then assert admission via `getAdmissionCoordinator(X)` succeeds and the barrier `enter()` works — no "Subagent coordinator is shut down." / "Subagent delivery suppressed during shutdown." throw.
- [x] 3.3 Reload-survival regression in the same file: with a healthy coordinator holding an active background lease and an unsuppressed barrier, `session_start` preserves both instance identities (no eviction), and the lease remains current.
- [x] 3.4 Fail-closed regression in the same file: a run killed and marked `lifecycle.delivery = "suppressed"` at terminal shutdown attempts delivery after revival; the run's own suppression gate still blocks it (late watcher cannot deliver into the revived session), and no pending-delivery redrive occurs.
- [x] 3.5 Alternating-switch test: poison+revive session X twice (simulating A → B → A → B → A) and assert each revival yields a spawnable state with no accumulation.
- [x] 3.6 Reversed-order guard (design Assumption): `session_start(X)` revival followed by a terminal `settleParentShutdown("resume", X)` on the SAME session ID leaves the session terminally shut down (status quo, not a regression — revival cannot re-heal without a later `session_start`); assert this documented outcome so a future Pi ordering change that breaks the shutdown-before-start assumption fails loudly here rather than silently no-op'ing.

## 4. Verification

- [x] 4.1 Run `pnpm run check` from the repo root and fix all errors/warnings; run `pnpm test` from the repo root and ensure the full unit suite passes, including the new revival tests.
- [x] 4.2 Repeat the timing-sensitive revival and reload-survival tests to rule out flakes.
- [x] 4.3 Update `packages/pi-subagent-herdr/CHANGELOG.md` with the user-facing fix (spawn failures after switching sessions and resuming back), then run `openspec validate --change revive-session-singletons-on-start --strict` and fix any findings.
