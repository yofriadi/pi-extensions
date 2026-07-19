---
issue: 374
issue_title: "Encapsulate run start and notification attachment on Subagent"
---

# Encapsulate Subagent.start() and read-only promise/notification

## Problem Statement

`Subagent.promise` is assigned from outside the class in three places — `SubagentManager.spawn()` (two sites: scheduled and immediate paths) — and `record.notification` is assigned from outside the class in seven test sites.
Both are output-argument smells (design-review check 3): the object should own the state its own methods read.
`Subagent.run()` already exists; the promise that tracks it lives outside the object purely so callers can `await record.promise`.
`notification` was already moved to the constructor in Phase 17 Step 2 (wired from `execution.parentSession?.toolCallId`), but the field is still publicly writable, so tests bypass the constructor path with direct assignment.

## Goals

- Add `Subagent.start()` that calls `run()`, stores the resulting promise internally, and returns it.
- Fold the abort-while-queued status guard into `start()`, removing the inline check from `SubagentManager`.
- Make `promise` externally read-only: private `_promise` field backed by a public `get promise()` accessor.
- Make `notification` externally read-only: private `_notification` field backed by a public `get notification()` accessor.
- Add `toolCallId?: string` to `TestSubagentOptions` so tests wire notification state via the constructor path without external writes.
- Achieve grep-verifiable outcome: `\.promise =` and `\.notification =` appear only inside `subagent.ts`.

## Non-Goals

- Extracting `RunListeners` or workspace-bracket collaborators from `Subagent` (Phase 17 Step 4, Issue [#375]).
- Extracting the manager observer from `index.ts` (Phase 17 Step 5, Issue [#376]).
- Any other Phase 17 step beyond Step 3.

## Background

Phase 17 Step 1 ([#381]) replaced `ConcurrencyQueue` with a `ConcurrencyLimiter` — the manager now calls `this.limiter.schedule(thunk)` and stores the scheduled promise on `record.promise`.
Phase 17 Step 2 ([#373]) extracted `SubagentState`, made `SubagentExecution` mandatory, and wired `notification` in the constructor via `execution.parentSession?.toolCallId`.

Current external write sites after Step 2:

| Field                 | Location                  | Count                                                                                                                    |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `record.promise`      | `SubagentManager.spawn()` | 2 (scheduled + immediate)                                                                                                |
| `record.promise`      | Test files                | 3 (`get-result-tool.test.ts`, `service-adapter.test.ts`, `make-subagent.test.ts`)                                        |
| `record.notification` | Test files                | 7 (`get-result-tool.test.ts` ×2, `subagent-manager.test.ts` ×2, `service-adapter.test.ts` ×1, `notification.test.ts` ×2) |

`SubagentManager.spawnAndWait()` and `waitForAll()` read `record.promise` via the public field — these become getter reads after the change.
`get-result-tool.ts` reads `record.promise` to `await` it when `wait=true` — unchanged (getter).

The `AGENTS.md` constraint that applies: **output arguments** — if a function sets a field on a received object, it is doing work that belongs inside the owning object.

## Design Overview

### `Subagent.start()` and the status guard

```typescript
private _promise?: Promise<void>;

/** Awaitable handle to the running promise. Set by start(). */
get promise(): Promise<void> | undefined {
  return this._promise;
}

/**
 * Start execution: call run(), store the promise, and return it.
 * Guards against non-active states (e.g. abort-while-queued): if the agent
 * is neither queued nor running, the promise resolves immediately (no-op).
 */
start(): Promise<void> {
  if (this.status !== "queued" && this.status !== "running") {
    this._promise = Promise.resolve();
    return this._promise;
  }
  this._promise = this.run();
  return this._promise;
}
```

The guard allows:

- `"queued"` — background agent waiting in the limiter; `run()` proceeds normally.
- `"running"` — foreground agent (status set to `"running"` at construction in the manager); `run()` proceeds normally.
- Any terminal state (`"stopped"`, `"error"`, `"completed"`, etc.) — agent was aborted while queued; `start()` becomes a no-op returning an immediately-resolving promise.

This folds the inline `if (record.status !== "queued") return Promise.resolve()` guard out of the `SubagentManager` limiter callback.

### `SubagentManager.spawn()` after the change

```typescript
// Queued background path
this.limiter.schedule(() => record.start());

// Immediate path (foreground or bypassQueue)
record.start();
```

`spawnAndWait()` continues to `await record.promise` (now uses the getter, no behavior change).
`waitForAll()`'s `pendingPromises()` continues to `r.promise` (getter — no behavior change).

### `notification` encapsulation

The constructor already writes to `this.notification` internally.
After the change, the constructor writes to `this._notification`:

```typescript
private _notification?: NotificationState;

get notification(): NotificationState | undefined {
  return this._notification;
}

// In constructor:
const toolCallId = init.execution.parentSession?.toolCallId;
if (toolCallId) {
  this._notification = new NotificationState(toolCallId);
}
```

No production writes to `notification` outside the constructor — only test sites need updating.

### `TestSubagentOptions` shorthand

Add `toolCallId?: string` so tests that need a `NotificationState` use the constructor path:

```typescript
// Before
const record = createTestSubagent();
record.notification = new NotificationState("tc-1");

// After
const record = createTestSubagent({ toolCallId: "tc-1" });
```

In `createTestSubagent`, `toolCallId` routes through `makeStubExecution({ parentSession: { toolCallId } })`.

### Tests that write `record.promise`

- **`service-adapter.test.ts`** ("strips promise from the record" tests): the test only needs `promise` to be absent from the serialized output.
  Since `toSubagentRecord()` already builds an explicit object without `promise`, these tests pass without any promise being set on the record.
  Remove the `record.promise = ...` setup.
- **`make-subagent.test.ts`** ("allows setting promise directly"): the test's intent was to verify the field was settable.
  Replace with a test that `start()` sets `promise` internally via the stub execution.
- **`get-result-tool.test.ts`** ("waits for promise when wait=true"): the test needs a running agent whose promise resolves and updates status to completed.
  Replace with an execution stub where `runTurnLoop` returns `{ responseText: "Finished after wait.", aborted: false, steered: false }` and call `record.start()`.
  The `createSubagentSessionStub()` default already resolves with `{ responseText: "done", ... }` — override `runTurnLoop` to return the expected text.

### `subagent-manager.test.ts` notification tests (lines 82, 100)

Tests that reproduce the race-condition bug (notification set post-spawn) become:

```typescript
const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
  description: "bg",
  isBackground: true,
  parentSession: { toolCallId: "tc-1" },
});
const record = manager.getRecord(id)!;
// notification is already wired from the constructor
await record.promise;
record.notification?.markConsumed();
```

The behavior under test (race: `markConsumed()` after `await` is too late) is unchanged.

## Module-Level Changes

- `src/lifecycle/subagent.ts`
  - Remove public writable `promise?: Promise<void>` field.
  - Add `private _promise?: Promise<void>`.
  - Add `get promise(): Promise<void> | undefined`.
  - Add `start(): Promise<void>` with the status guard.
  - Rename `this.notification` write in constructor to `this._notification`.
  - Remove public writable `notification?: NotificationState` field.
  - Add `private _notification?: NotificationState`.
  - Add `get notification(): NotificationState | undefined`.
- `src/lifecycle/subagent-manager.ts`
  - Replace `record.promise = this.limiter.schedule(() => { if (...) return ...; return record.run(); })` with `this.limiter.schedule(() => record.start())`.
  - Replace `record.promise = record.run()` with `record.start()`.
- `test/helpers/make-subagent.ts`
  - Add `toolCallId?: string` to `TestSubagentOptions`.
  - In `createTestSubagent`, map `toolCallId` to `makeStubExecution({ parentSession: { toolCallId } })`.
- `test/helpers/make-subagent.test.ts`
  - Replace "allows setting promise directly after construction" with a test that `start()` stores promise via the execution stub.
- `test/tools/get-result-tool.test.ts`
  - Replace `record.promise = Promise.resolve().then(...)` setup with a stub execution + `record.start()`.
  - Replace `record.notification = new NotificationState("tc-1")` (×2) with `createTestSubagent({ toolCallId: "tc-1" })`.
- `test/lifecycle/subagent-manager.test.ts`
  - Replace `record.notification = new NotificationState("tc-1")` (×2) with spawn options carrying `parentSession: { toolCallId: "tc-1" }`.
- `test/service/service-adapter.test.ts`
  - Remove `record.promise = Promise.resolve()` setup (×2) from tests that only need to verify `toSubagentRecord()` strips the field.
  - Replace `record.notification = new NotificationState("tc-1")` with `createTestSubagent({ toolCallId: "tc-1" })`.
- `test/observation/notification.test.ts`
  - Replace `record.notification = new NotificationState("tc-123/tc-1")` (×2) with `createTestSubagent({ toolCallId: "tc-123/tc-1" })`.
- `docs/architecture/architecture.md`
  - Mark Step 3 `✅ Complete` and add a "Landed" note.

## Test Impact Analysis

1. **New unit tests enabled**: `start()` behavior (promise stored, status guard no-op) can be tested directly in `subagent.test.ts` without touching the manager.
2. **Existing tests simplified**: The 7 test sites that do `record.notification = ...` drop an artificial mutation and instead use the natural constructor path — the tests are shorter and closer to production semantics.
3. **Tests that must stay**: The manager's race-condition tests (lines 74–120) verify ordering of `markConsumed()` vs `await promise` — they change setup only (spawn with toolCallId), not intent.
4. **Tests removed**: The `make-subagent.test.ts` "allows setting promise" test is replaced, since direct write is no longer possible.

## TDD Order

1. **Add `Subagent.start()` alongside the existing public `promise?` field**

   In `test/lifecycle/subagent.test.ts`, add tests:
   - `start()` on a running agent returns a defined promise.
   - `start()` on a stopped agent returns a resolving promise immediately (no-op guard).
   - After `start()`, `record.promise` matches the returned promise.

   In `src/lifecycle/subagent.ts`: add `private _promise`, `get promise()` (shadowing the old field — TypeScript will require removing the duplicate; advance to step 2 immediately), and `start()`.
   Commit: `test: add Subagent.start() tests and initial implementation (#374)`

2. **Make `promise` read-only — remove public field, update all write sites**

   Breaking change at the type level.
   Atomic commit must include:
   - `src/lifecycle/subagent.ts` — remove `promise?: Promise<void>` public field (only `private _promise` + getter remain).
   - `src/lifecycle/subagent-manager.ts` — replace both `record.promise = ...` sites with `record.start()` calls; limiter thunk becomes `() => record.start()`.
   - `test/helpers/make-subagent.test.ts` — replace write-promise test with `start()` test.
   - `test/tools/get-result-tool.test.ts` — replace `record.promise = ...` setup; use execution stub + `record.start()`.
   - `test/service/service-adapter.test.ts` — remove `record.promise = Promise.resolve()` setup (×2).

   Run `pnpm --filter @gotgenes/pi-subagents run check` to verify.
   Commit: `feat: make Subagent.promise read-only, add start() (#374)`

3. **Make `notification` read-only — remove public field, update all write sites**

   Breaking change at the type level.
   Atomic commit must include:
   - `src/lifecycle/subagent.ts` — rename public `notification?` to `private _notification`; add `get notification()`; constructor write becomes `this._notification = ...`.
   - `test/helpers/make-subagent.ts` — add `toolCallId?: string` to `TestSubagentOptions`; route through `makeStubExecution`.
   - `test/tools/get-result-tool.test.ts` — replace `record.notification = new NotificationState(...)` (×2) with `createTestSubagent({ toolCallId: ... })`.
   - `test/lifecycle/subagent-manager.test.ts` — replace `record.notification = new NotificationState(...)` (×2) with spawn options carrying `parentSession: { toolCallId: ... }`.
   - `test/service/service-adapter.test.ts` — replace `record.notification = new NotificationState(...)` with `createTestSubagent({ toolCallId: ... })`.
   - `test/observation/notification.test.ts` — replace `record.notification = new NotificationState(...)` (×2) with `createTestSubagent({ toolCallId: ... })`.

   Run `pnpm --filter @gotgenes/pi-subagents exec vitest run` and `pnpm --filter @gotgenes/pi-subagents run check`.
   Commit: `feat: make Subagent.notification read-only, update tests (#374)`

4. **Update architecture doc**

   In `docs/architecture/architecture.md`, mark Step 3 `✅ Complete` and add a "Landed" note summarizing the outcome.
   Also update the note at line 943 that says "Step 3 later folds the guard into `Subagent.start()`" to reflect it is now done.
   Commit: `docs: mark Phase 17 Step 3 complete in architecture.md (#374)`

## Risks and Mitigations

- **Risk**: Adding both `private _promise` and `get promise()` while the public `promise?` field still exists is a TypeScript error (duplicate identifier).
  **Mitigation**: Steps 1 and 2 are merged into one commit: introduce `start()`, remove the public writable field, and fix all consumers atomically.
  The TDD order describes testing `start()` first, but both the public field removal and the consumer updates land in the same `feat:` commit.
- **Risk**: The status guard in `start()` allows `"running"` for foreground agents, which have `status = "running"` at construction.
  If a foreground agent is stopped before `start()` is called (edge case), `run()` would call `markRunning()` on an already-stopped agent.
  **Mitigation**: Foreground agents are started synchronously at the end of `spawn()` — there is no window between construction and `start()` during which the abort path can fire.
  The guard is conservative and causes no regression.
- **Risk**: The race-condition test in `subagent-manager.test.ts` (lines 74–107) verifies that `markConsumed()` called after `await record.promise` is "too late" for the observer.
  Switching from `record.notification = new NotificationState("tc-1")` to the constructor path does not change timing semantics.
  **Mitigation**: The test body stays structurally identical; only the setup changes.
- **Risk**: `service-adapter.test.ts` tests that call `record.promise = Promise.resolve()` might be testing that the field exists on the Subagent type.
  **Mitigation**: The tests are testing `toSubagentRecord()` output, not the field type.
  Removing the setup doesn't change the assertion.

## Open Questions

- None.
  The design is fully specified by the Phase 17 Step 3 architecture note and the existing class structure.

[#373]: https://github.com/gotgenes/pi-packages/issues/373
[#375]: https://github.com/gotgenes/pi-packages/issues/375
[#381]: https://github.com/gotgenes/pi-packages/issues/381
