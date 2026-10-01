## Context

Pi emits `session_shutdown` with reason `"resume"`, `"new"`, or `"fork"` when switching sessions, then `session_start` for the replacement session.
The extension's `shouldPreserveSubagentsOnShutdown` treats every reason except `"reload"` as terminal: `settleTerminalShutdown` closes all panes, kills all runs, clears pending deliveries, and — critically — poisons two session-keyed singletons stored in process-global `Symbol.for` registries that deliberately survive module reload:

- `getAdmissionCoordinator(sessionId).shutdownNow()` sets an irreversible `shutdown = true`; later `request()` throws "Subagent coordinator is shut down."
- `getForegroundDeliveryBarrier(sessionId).suppressPending()` sets an irreversible `suppressedError`; later `enter()`/`deliver()` throw "Subagent delivery suppressed during shutdown."

Pi's session ID is read from the session-file header, so resuming back to a previously-active session restores the same ID and retrieves the poisoned instances from the same registry keys.
`handleParentSessionStart` only in-place-upgrades legacy v1 instances; a v2-but-shut-down instance is returned as-is.
Result: any previously-visited session is permanently un-spawnable after one switch away.
This was verified against the bundled `@earendil-works/pi-coding-agent` and upstream pi-mono sources (session-manager restores `sessionId` from the session header on resume).

A plan-reviewer adversarial review verified the diagnosis, the three invariants below, the fail-closed paths, and that all singleton call sites resolve lazily per use (`tool-execute.ts` `beginAdmission`/`createForegroundBarrierLease`, `subagent-launch.ts` `handleBackgroundDeliveryFailure`), so registry replacement suffices — no stale module-level references exist.

## Goals / Non-Goals

**Goals:**

- After `session_start` for a session whose singletons were terminally poisoned, spawning must work again (admission accepted, foreground barrier enterable).
- Preserve `/reload` survival: a live coordinator holding background admission leases and an unsuppressed barrier are returned unchanged.
- Keep old closures (pre-switch lease objects, held-delivery promises, watcher references) fail-closed against the revived session.
- Preserve legacy v1→v2 migration and held-delivery adoption semantics.

**Non-Goals:**

- Changing kill-on-switch teardown behavior: subagents still die, panes close, deliveries suppress, pending work is exhausted at switch-out (Option B — subagents surviving session switches — was considered and explicitly rejected for now).
- Changing admission limits, retry budgets, delivery ordering, dedup, or the completion-runtime record (which already re-activates unconditionally on `session_start`).
- Any durable cross-process state or new process-global keys.

## Decisions

### 1. Replace poisoned instances; never un-poison in place

Revival inserts a fresh instance into the process-global registry rather than flipping `shutdown = false` or deleting `suppressedError` on the cached object.

Rationale: in-place revival would resurrect references held by pre-switch closures.
The load-bearing hazard is the barrier — an in-place `delete suppressedError` (without a generation bump) can flip a still-running `retryAcceptedDelivery` loop's `shouldContinue` back to true mid-flush, letting a delivery proceed against a session that was torn down.
For the coordinator, cancelled leases stay fail-closed even under in-place revival (`lease.state !== "admitted"` in `isAdmissionCurrent`), so replace-not-revive is justified primarily by the barrier; the coordinator follows the same rule for symmetry and honesty about object identity.

Fresh instances keep old references fail-closed by construction: `isAdmissionCurrent` compares `activeLeases.get(id) === lease` against an empty map, and a fresh barrier has no held deliveries to flush.

**Alternative considered:** in-place revival with a generation bump.
Rejected: it mutates an object other closures still reference, and the barrier's flush/migration logic makes reasoning about a mid-flight un-suppression subtle enough to be a defect magnet.

### 2. Conditional replacement, keyed on terminal state only

The wrappers replace an instance only when it is terminally poisoned (`coordinator.isShutDown()` / `barrier.isSuppressed()`).
A healthy instance — including a live coordinator adopted across `/reload` with active background leases — is returned unchanged.

Rationale: `shutdownNow()` cancels every active lease, so a shut-down coordinator never owns live leases and replacement is safe.
A live coordinator across `/reload` does own leases (reload reaps foreground only), and replacing it would orphan background admission slots — leases would release against the old object while the new instance's counters drift toward over-admission.
The poisoned check is exactly the discriminator between "safe to replace" and "must preserve."

**Alternative considered:** unconditional fresh instances at every `session_start`.
Rejected: it would silently break reload adoption of background subagents.

### 3. Delegation first; never inspect the raw registry cache

Both wrappers call the existing getter first and apply the poisoned-instance check to the getter's result, then evict-and-insert through the same registry map.

Rationale (plan-reviewer warning): the getters carry live migration behavior the handlers depend on.
`getForegroundDeliveryBarrier` replaces legacy objects and adopts their held deliveries; `getAdmissionCoordinator` performs the in-place prototype upgrade preserving `legacyActiveIds`/`wasShutdown`.
A wrapper that peeked the raw cache and called `cached.isSuppressed()` would throw a `TypeError` inside `session_start` whenever the cached object is a legacy v1 barrier, and dropping the standalone getter call in `handleParentSessionStart` would silently lose the coordinator upgrade.
Delegating first composes the two paths: a v1 coordinator shut down pre-reload upgrades to v2 with `shutdown = true` preserved → ensure-healthy then replaces it.

**Alternative considered:** wrappers owning their own registry reads.
Rejected: duplicates migration logic or bypasses it; the getter is the single owner of registry shape.

### 4. Revival runs in `handleParentSessionStart`, before `reconcileActive`

Both ensure-healthy calls happen at the top of the session-activation handler, before `reconcileActive(activeForegroundRunIds())`, so barrier reconciliation runs against the healthy barrier.

Rationale: `session_start` is the activation boundary Pi guarantees after rebinding extensions to the replacement session; it fires for `startup`, `reload`, `new`, `resume`, and `fork`, covering every path that can land on a previously-poisoned session ID (fork/clone poison the old ID; resume-back hits it).
Ordering before `reconcileActive` avoids reconciling into a barrier that is about to be replaced.

**Alternative considered:** revival inside the getters themselves.
Rejected: getters are hot-path call sites (admission, launch, delivery); folding a session-lifecycle concern into them widens blast radius and would replace singletons mid-flight from tool execution rather than at the single activation boundary.

### 5. Test access via the registered event, not a new `__test__` seam

`handleParentSessionStart` is module-private and not in `__test__`.
Regression tests drive it through the registered handler — `pi.handlers.session_start({}, fakeCtx(sessionId))` — matching the existing pattern in `test/runtime-safety.test.ts`, rather than exporting a test-only hook.

## Risks / Trade-offs

- [Old closures interacting with fresh singletons] → They cannot: old lease objects fail the identity check in `isAdmissionCurrent` against an empty `activeLeases` map; old barrier held-deliveries were already rejected by `suppressPending`.
  Late watchers of killed runs are gated by the run's own `lifecycle.delivery = "suppressed"` (checked by `shouldDeliverSubagentCompletion`), not the barrier, and `handleBackgroundDeliveryFailure` only re-queues when the barrier is unsuppressed — with `pendingDeliveries` cleared at terminal shutdown, post-revival redrive is a no-op.
- [Regression risk to reload adoption] → Covered by an explicit test: healthy coordinator with active leases is identity-preserved across `session_start`.
- [Mixed-version coexistence (package-installed old copy + working-tree load in one process)] → Unchanged: the fix re-populates the same `Symbol.for` registry keys with fresh v2 instances; an older copy without the wrappers keeps today's behavior for itself and cannot poison the new instances beyond what already happens.
- [Alternating switches (A → B → A → B → A)] → Each switch-out poisons, each `session_start` revives; bounded by switch frequency, no accumulation (fresh instance per revival, old instance garbage-collected once unreferenced).
- [Pi emitting `session_start` for a session ID before its terminal `session_shutdown`] → Would defeat revival: poison after revival stays poisoned with no later `session_start` to heal it.
  Verified impossible today (see Assumption below), guarded by a reversed-order regression test (task 3.6) asserting the documented, intended outcome.

**Assumption (load-bearing, verified against the bundled `@earendil-works/pi-coding-agent` dist):** for every path that can land a session on a poisoned singleton, Pi emits the terminal `session_shutdown` for that session ID *before* the `session_start` that must heal it.
Verified orderings: `/reload` (`agent-session.js` `reload()` — `emitSessionShutdownEvent(reason: "reload")`, old runner invalidated, runtime rebuilt, then `emit({ type: "session_start", reason: "reload" })`, same session ID throughout) and session switch (`agent-session-runtime.js` — `teardownCurrent(reason)` emits the old session's `session_shutdown` before `apply(createRuntime(...))` emits the replacement's `session_start`).
Note `test/runtime-safety.test.ts` deliberately hand-crafts the reversed order for the reload path; that fixture exercises ownership protection for a reason (`reload`) that never poisons, so it is safe there and is not evidence that the reversed order occurs in practice.

## Migration Plan

Single extension-package release.
No data or schema migration: process-global registries are in-memory only.
Rollback is reverting the package version.
The first `session_start` after upgrade heals any already-poisoned sessions automatically (revival runs even when poisoning predates the fix).

## Open Questions

None.
Round-one review findings are incorporated as Decisions 3 and 5; round-two findings are incorporated as the Risks Assumption paragraph and task 3.6 (reversed-order guard), task 3.1 (collapsed getter calls), and test-pattern notes in 2.2/3.2.
