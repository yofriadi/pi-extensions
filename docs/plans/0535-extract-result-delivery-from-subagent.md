---
issue: 535
issue_title: "pi-subagents Phase 20 Step 1: extract result delivery from Subagent"
---

# Extract result delivery from `Subagent`

## Release Recommendation

**Release:** mid-batch — defer (batch "result-delivery"); confirm at ship time

This is Phase 20 Step 1, the head of the `result-delivery` batch whose tail is Step 2 ([#536]).
The step lands as `refactor:` commits — a hidden changelog type that cuts no release on its own — and auto-batches with Step 2 into the next unhidden release.
The architecture roadmap tags it `Release: batch "result-delivery"`, so do not cut a release at ship time; leave the release-please PR open for the batch tail.

## Problem Statement

Result delivery — whether the parent consumed a subagent's result, when to nudge, how the result reaches the caller — is a distinct domain from execution, but its state is fused into the `Subagent` execution record.
`NotificationState` (`toolCallId`, `resultConsumed`) lives on `Subagent`, and consumers reach through the record to touch it: `get-result-tool` calls `record.notification?.markConsumed()` at two sites, each paired with `notifications.cancelNudge(id)` — a scattered two-step reset spanning two objects.
The architecture doc already names `notification.resultConsumed` a "homeless field."

## Goals

- Remove the `_notification` / `notification` field from `Subagent`; stop constructing `NotificationState` at all.
- `NotificationManager` owns the consumed-state keyed by agent id behind a single tell operation, `consume(id)`, that also cancels the pending nudge.
- Delete `notification-state.ts` — the `toolCallId` carrier becomes a `Subagent.toolCallId` getter over `execution.parentSession`, and the `resultConsumed` carrier dissolves into the manager.
- `subagent-events-observer` and `get-result-tool` call the delivery interface instead of reaching through the record.
- Preserve the pre-await consumption ordering ("Bug 1" race): consuming before awaiting must still suppress the completion nudge.

This change is **not breaking** — it is an internal refactor.
The public `SubagentsService` contract, the `<task-notification>` XML output, and the background-notification behavior are all unchanged.

## Non-Goals

- Decomposing `get-result-tool.execute` — that is Step 2 ([#536]), which builds on the delivery interface introduced here.
- Decomposing the notification renderer (`renderer.ts`) — that is Step 7 ([#541]), soft-ordered after this step so the notification-domain files settle first.
- Any change to how `parentSession.toolCallId` flows from the tool boundary into spawn — that wiring (`agent-tool`, `background-spawner`, `SubagentManager.spawn`) is untouched; only the record's storage of it changes.

## Background

- `src/observation/notification-state.ts` — `NotificationState` holds a readonly `toolCallId` and a private `_resultConsumed` boolean, with `markConsumed()` / `resultConsumed`.
- `src/lifecycle/subagent.ts` — the constructor reads `init.execution.parentSession?.toolCallId` and, when present, constructs `_notification = new NotificationState(toolCallId)`, exposed via the `notification` getter.
- `src/observation/notification.ts` — `NotificationManager` owns `pendingNudges` (a `Map` keyed by agent id) with public `cancelNudge(key)`, `sendCompletion(record)`, `dispose()`, and private `scheduleNudge` / `emitIndividualNudge`.
  `emitIndividualNudge` gates on `record.notification?.resultConsumed`.
  The pure helper `formatTaskNotification(record, ...)` reads `record.notification?.toolCallId`.
- `src/observation/subagent-events-observer.ts` — `onSubagentCompleted` pre-checks `record.notification?.resultConsumed` before `notifications.sendCompletion(record)`.
- `src/tools/get-result-tool.ts` — two sites do `record.notification?.markConsumed(); this.notifications.cancelNudge(params.agent_id);` (the pre-await consume and the terminal consume), depending on the narrow `GetResultToolNotifications` interface (`cancelNudge(key)`).

The four `record.notification?.` reach-throughs (`formatTaskNotification`, `emitIndividualNudge`, observer pre-check, and the two `get-result-tool` sites — counted as the four in the Phase 20 health table) are exactly the sites this step clears.

Constraint from AGENTS.md: this package ships source directly but carries type-declaration bundles; deleting `notification-state.ts` touches no public entry (it is internal), so no `verify:public-types` change is required.

## Design Overview

Two responsibilities move off `NotificationState` in opposite directions:

1. **`toolCallId` (identity)** → a `Subagent.toolCallId` getter over the snapshot it already holds:

   ```typescript
   /** The tool call ID that spawned this background agent, if any. */
   get toolCallId(): string | undefined {
     return this.execution.parentSession?.toolCallId;
   }
   ```

   `formatTaskNotification` then reads `record.toolCallId` directly — no reach-through, no notification object.

2. **`resultConsumed` (delivery state)** → a `Set<string>` of consumed agent ids inside `NotificationManager`, behind one tell operation:

   ```typescript
   private readonly consumed = new Set<string>();

   /** Record the parent consumed this agent's result: suppress its completion nudge. */
   consume(id: string): void {
     this.consumed.add(id);
     this.cancelNudge(id);
   }
   ```

   `sendCompletion` gates on the set (replacing the observer's pre-check), and `cancelNudge` becomes **private** (its only external caller was `get-result-tool`, now on `consume`):

   ```typescript
   sendCompletion(record: Subagent): void {
     if (this.consumed.has(record.id)) return;
     this.scheduleNudge(record.id, () => this.emitIndividualNudge(record));
   }
   ```

   `emitIndividualNudge` keeps a defensive gate against the same set (`this.consumed.has(record.id)`) rather than `record.notification?.resultConsumed`.
   `dispose()` clears `consumed` alongside the pending nudges.

### Consumer call sites (Tell-Don't-Ask verification)

`get-result-tool` collapses each two-object two-step reset into one tell:

```typescript
// pre-await (wait=true on a running agent)
this.notifications.consume(params.agent_id);
await record.promise;
// terminal (already-settled agent)
if (record.status !== "running" && record.status !== "queued") {
  this.notifications.consume(params.agent_id);
}
```

The observer drops its reach-through entirely and delegates the decision to the manager:

```typescript
onSubagentCompleted(record: Subagent): void {
  // ...emit + appendEntry unchanged...
  this.notifications.sendCompletion(record); // manager decides whether to nudge
}
```

### Interface segregation

- `GetResultToolNotifications` narrows from `{ cancelNudge(key): void }` to `{ consume(id): void }` — the only method the tool needs.
- `NotificationSystem` (the observer's dependency) drops `cancelNudge`, keeping `{ sendCompletion(record); dispose() }` — the observer only ever called `sendCompletion`.
- The concrete `NotificationManager` satisfies both; `cancelNudge` is no longer on any public interface.

### Bug 1 ordering (preserved invariant)

The pre-await path calls `consume(id)` **before** `await record.promise`.
When the run then settles, `onSubagentCompleted` → `sendCompletion` finds the id already in `consumed` and skips scheduling — identical suppression to today, now decided in one place.

### Edge case — consumed-set growth

`consumed` is keyed by unique per-spawn agent ids and lives for the session; it is cleared on `dispose()` (session shutdown), matching `pendingNudges`.
Per-session growth is bounded by spawn count, consistent with the Phase 20 "no net LOC growth" target.

## Module-Level Changes

- `src/observation/notification-state.ts` — **deleted**; `NotificationState` dissolves.
- `src/observation/notification.ts` — add `consumed: Set<string>` and `consume(id)`; make `cancelNudge` private; gate `sendCompletion` on `consumed`; switch `emitIndividualNudge`'s gate to `consumed`; clear `consumed` in `dispose`; `formatTaskNotification` reads `record.toolCallId`; narrow the `NotificationSystem` interface to drop `cancelNudge`.
- `src/lifecycle/subagent.ts` — remove the `NotificationState` import, the `_notification` field, the `notification` getter, and the constructor construction; add the `toolCallId` getter.
- `src/observation/subagent-events-observer.ts` — drop the `record.notification?.resultConsumed` pre-check in `onSubagentCompleted`; call `sendCompletion` unconditionally.
- `src/tools/get-result-tool.ts` — replace both `markConsumed()` + `cancelNudge()` pairs with `notifications.consume(id)`; change `GetResultToolNotifications` to `{ consume(id): void }`.
- `src/types.ts` — reword the `toolCallId` doc comment (line ~111) from "spawn attaches NotificationState" to reflect that the record exposes it via `Subagent.toolCallId` (no `NotificationState`).
- `test/observation/notification-state.test.ts` — **deleted** (the class is gone).
- `test/observation/notification.test.ts` — replace the `resultConsumed`-via-record test with a `consume(id)` skip test; the `cancelNudge` test moves to exercising `consume` (or drops, since `cancelNudge` is private); `formatTaskNotification` toolCallId tests keep asserting XML output (unchanged) but no longer touch `record.notification`; add a `dispose` clears-consumed assertion.
- `test/observation/subagent-events-observer.test.ts` — drop the "does not call sendCompletion when result is already consumed" test (that decision now lives in the manager, covered in `notification.test.ts`); keep "calls sendCompletion".
- `test/lifecycle/subagent.test.ts` — replace the two `NotificationState`-creation tests and the defaults-block `record.notification` assertion with `record.toolCallId` assertions.
- `test/lifecycle/subagent-manager.test.ts` — migrate the "Bug 1 race condition" describe block and the "toolCallId notification wiring" describe block off `record.notification` (Bug 1 → assert nudge suppression via the manager's `consume`/`sendCompletion`; wiring → assert `record.toolCallId`).
- `test/tools/get-result-tool.test.ts` — `makeNotifications` returns `{ consume: vi.fn() }`; assertions switch from `record.notification!.resultConsumed` / `cancelNudge` to `consume` called with the agent id.
- `docs/architecture/architecture.md` — remove `+notification?: NotificationState` from the `Subagent` class diagram (line ~117); remove the `notification-state.ts` module-tree entry (line ~322) and fold its "per-agent notification tracking" note into `notification.ts`; on ship, tick the Phase 20 health-table row `record.notification?.` reach-throughs 4 → 0 (the batch-tail retro may consolidate the metrics update — see Step 2).
- `.pi/skills/package-pi-subagents/SKILL.md` — drop `notification-state.ts` from the Observation domain row (6 → 5 modules) and its "notification tracking" clause.

## Test Impact Analysis

1. **New tests enabled** — the consumed decision is now a first-class `NotificationManager` behavior, unit-testable at the manager boundary: `consume(id)` suppresses a subsequent `sendCompletion(id)`; `consume(id)` cancels an already-scheduled nudge; `dispose()` clears consumed state.
   Previously this logic was split between a record-owned `NotificationState` boolean and the manager's timer map, testable only through the record.
2. **Redundant tests** — `notification-state.test.ts` (the standalone `NotificationState` class suite) is deleted; the observer's "already consumed" test is redundant with the new manager-level skip test.
3. **Tests that stay** — `formatTaskNotification` XML-shape tests (they assert output, not storage); `agent-tool` / `background-spawner` spawn-wiring tests (they exercise `parentSession.toolCallId` reaching `spawn`, unaffected); `print-mode` background-notification integration test (end-to-end behavior, unchanged).

## Invariants at risk

- **Pre-await consumption ("Bug 1")** — consuming before awaiting suppresses the completion nudge.
  Pinned by the "Bug 1 race condition" describe block in `test/lifecycle/subagent-manager.test.ts`; migrated in Step 2 to assert suppression through the manager rather than `record.notification`.
- **`<task-notification>` XML shape** (includes `<tool-use-id>` when a tool call id is present, omits it otherwise) — pinned by the `formatTaskNotification` tests in `test/observation/notification.test.ts`; the getter swap must leave the XML byte-identical.
- **Phase 17 `SubagentState` delegation** — `Subagent`'s status/metrics getters delegate one line to the private `SubagentState`.
  Removing the `notification` field must not disturb that delegation; pinned by the `subagent.test.ts` defaults/delegation suite.

## TDD Order

1. **Add `Subagent.toolCallId`; migrate `formatTaskNotification`** (prep / lift-and-shift).
   - Red: `test/lifecycle/subagent.test.ts` — new test asserting `record.toolCallId` returns `execution.parentSession.toolCallId` (and `undefined` when absent).
   - Green: add the getter; change `formatTaskNotification` to read `record.toolCallId`.
   `NotificationState` and `record.notification` remain in place — nothing breaks.
   Commit: `refactor(pi-subagents): expose Subagent.toolCallId for notification formatting`
2. **Move consumed-state into `NotificationManager`; delete `NotificationState`** (atomic core).
   Removing the `NotificationState` export and the `record.notification` surface breaks every importer and its tests at the type level in one commit, so the manager change, both consumer updates, the file/interface deletions, and all consumer-test migrations land together.
   - Red: `test/observation/notification.test.ts` — `consume(id)` suppresses a later `sendCompletion(id)`; `consume` cancels an already-scheduled nudge; `dispose` clears consumed.
   - Green: add `consumed` + `consume` to `NotificationManager`; gate `sendCompletion` and `emitIndividualNudge` on `consumed`; make `cancelNudge` private; clear `consumed` in `dispose`; narrow `NotificationSystem`.
     Remove `_notification` / `notification` / the constructor construction / the import from `subagent.ts`.
     Drop the observer pre-check; call `sendCompletion` unconditionally.
     Switch `get-result-tool`'s two sites to `consume`; narrow `GetResultToolNotifications`.
     Delete `notification-state.ts` and `notification-state.test.ts`.
     Migrate `subagent.test.ts`, `subagent-manager.test.ts` (Bug 1 + wiring blocks), `get-result-tool.test.ts`, and `subagent-events-observer.test.ts`.
   Commit: `refactor(pi-subagents): move result-delivery consumed-state into NotificationManager`
3. **Docs + skill sync** (docs).
   - Update `docs/architecture/architecture.md` (class diagram, module tree, Observation-domain note) and `.pi/skills/package-pi-subagents/SKILL.md` (Observation domain row 6 → 5) and the `src/types.ts` `toolCallId` doc comment.
   Commit: `docs(pi-subagents): drop NotificationState from architecture and skill after result-delivery extraction`

The `refactor:` verify gate for each code step: `pnpm --filter @gotgenes/pi-subagents run check && … run lint && … run test`, plus `pnpm fallow dead-code` after Step 2 to confirm no orphaned `NotificationState` / `cancelNudge` symbol survives.

## Risks and Mitigations

- **Silent nudge regression** — the consumed decision moves from two record-level checks to a manager-owned set; a missed migration could double-send or drop a notification.
  Mitigation: the Bug 1 race tests and the observer/manager skip tests pin both the pre-await and terminal paths; migrate them in the same commit as the source.
- **XML drift** — the `toolCallId` getter must produce byte-identical `<task-notification>` output.
  Mitigation: the existing `formatTaskNotification` tests assert the XML directly and are unchanged.
- **Unbounded consumed set** — bounded per session and cleared on `dispose`; consistent with `pendingNudges` lifetime.

## Open Questions

None — the decomposition is roadmap-specified (dissolve into the manager, expose `toolCallId` off `execution.parentSession`), and the interface shapes follow the existing `NotificationSystem` / `GetResultToolNotifications` seam.

[#536]: https://github.com/gotgenes/pi-packages/issues/536
[#541]: https://github.com/gotgenes/pi-packages/issues/541
