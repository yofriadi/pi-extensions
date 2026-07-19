---
issue: 230
issue_title: "Extract ConcurrencyQueue from AgentManager (Phase 15, Step 5)"
---

# Extract ConcurrencyQueue from AgentManager

## Problem Statement

`AgentManager` tangles two concerns: agent collection management and scheduling.
The scheduling concern — `queue[]`, `runningBackground`, `_getMaxConcurrent`, `drainQueue()`, `finalizeBackgroundRun()`, `notifyConcurrencyChanged()` — is 3 fields + 3 methods of cohesive, separable logic.
`notifyConcurrencyChanged()` is a scheduling method exposed as a public API on the wrong object so that `SettingsManager` can poke the queue after a concurrency limit change.
This cross-concern leak violates SRP and prevents independent testing of the queue.

## Goals

- Extract scheduling logic into a `ConcurrencyQueue` class in `src/lifecycle/concurrency-queue.ts`.
- Delete `notifyConcurrencyChanged()` from `AgentManager` — settings triggers drain on the queue directly via the existing callback wiring.
- Make scheduling independently testable with fast, focused unit tests.
- `AgentManager` becomes a pure collection manager (agents Map, lookup, cleanup, iteration) + observer wiring.

## Non-Goals

- Changing `SettingsManager` internals — `onMaxConcurrentChanged` callback stays; only the wiring target changes (queue.drain instead of manager.notifyConcurrencyChanged).
- Extracting `Agent.resume()` — tracked in #232.
- Changing the concurrency semantics (limits, drain order, foreground bypass).

## Background

### Dependencies

Both dependencies are implemented:

- Issue #229 (Agent.run()) — ✅ closed.
  Agent owns its full execution lifecycle; `startAgent` and `SpawnArgs` are gone.
- Issue #231 (runner self-contained) — ✅ closed.
  Agent holds the runner at construction.

### Current queue surface in AgentManager

| Member                            | Kind   | Purpose                                          |
| --------------------------------- | ------ | ------------------------------------------------ |
| `queue: string[]`                 | field  | IDs of background agents waiting to start        |
| `runningBackground: number`       | field  | Count of currently running background agents     |
| `_getMaxConcurrent: () => number` | field  | Injected getter for the concurrency limit        |
| `drainQueue()`                    | method | Start queued agents up to the limit              |
| `finalizeBackgroundRun()`         | method | Decrement counter, notify observer, drain        |
| `notifyConcurrencyChanged()`      | method | Public entry point for settings to trigger drain |

These 6 members form a cohesive unit — they only reference each other and the agents Map (for status checks during drain).

### Callers of queue logic in AgentManager

- `spawn()` — checks `runningBackground >= getMaxConcurrent()`, pushes to `queue` or starts.
- `buildObserver().onStarted` — increments `runningBackground`.
- `buildObserver().onRunFinished` — calls `finalizeBackgroundRun()`.
- `abort()` — filters `queue` to remove an aborted ID.
- `abortAll()` — iterates `queue`, clears it.
- `waitForAll()` — calls `drainQueue()`.
- `dispose()` — clears `queue`.

### Agent comment to update

`agent.ts` line 366 has a comment: "Queue removal stays on AgentManager until #230 extracts ConcurrencyQueue."
This comment should be updated to remove the forward reference.

## Design Overview

### ConcurrencyQueue class

```typescript
export class ConcurrencyQueue {
  private queue: string[] = [];
  private running = 0;

  constructor(
    private readonly getMaxConcurrent: () => number,
    private readonly startAgent: (id: string) => void,
  ) {}

  isFull(): boolean;
  enqueue(id: string): void;
  dequeue(id: string): boolean;
  markStarted(): void;
  markFinished(): void;   // running--, drain()
  drain(): void;
  get queuedIds(): readonly string[];
  clear(): void;
}
```

### Design decision: stored start callback

The issue proposes `drain(start: (id: string) => void)` with the callback as a parameter.
However, the issue also proposes `markFinished()` as no-arg with "running--, drain()" semantics — which contradicts `drain` requiring a callback parameter.

Resolution: store the `startAgent` callback at construction.
This makes `drain()` and `markFinished()` both no-arg, follows Tell-Don't-Ask (the queue is a self-contained unit), and avoids requiring callers to pass the same callback repeatedly.

The `startAgent` callback is provided by the wiring layer (`index.ts`) using the established forward-reference-via-closure pattern already used for `onMaxConcurrentChanged`:

```typescript
// index.ts
const queue = new ConcurrencyQueue(
  () => settings.maxConcurrent,
  (id) => {
    const agent = manager.getRecord(id);
    if (agent?.status !== "queued") return;
    agent.promise = agent.run();
  },
);
```

### Ordering note

`markFinished()` calls `drain()` internally.
The current `finalizeBackgroundRun()` order is: decrement → observer notification → drain.
After extraction: `queue.markFinished()` (decrement + drain) → observer notification.
Drain fires before the observer notification.

This reordering is safe: `drain()` only starts promises (no await), and the observer notification (`onAgentCompleted`) processes the completed agent's data without referencing queue state.

### AgentManager after extraction

```typescript
export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  queue: ConcurrencyQueue;         // was: getMaxConcurrent
  getRunConfig?: () => RunConfig;
  observer?: AgentManagerObserver;
}
```

`AgentManager` loses `queue`, `runningBackground`, `_getMaxConcurrent`, `drainQueue()`, `finalizeBackgroundRun()`, `notifyConcurrencyChanged()`.

### Settings wiring

Before:

```typescript
onMaxConcurrentChanged: () => manager.notifyConcurrencyChanged(),
```

After:

```typescript
onMaxConcurrentChanged: () => queue.drain(),
```

`SettingsManager` itself does not change — it still invokes the stored callback.
The callback wiring in `index.ts` targets the queue directly instead of the manager.

### Consumer call site (AgentManager.buildObserver)

```typescript
private buildObserver(options: AgentSpawnConfig): AgentLifecycleObserver {
  return {
    onStarted: (agent) => {
      if (options.isBackground) this.queue.markStarted();
      this.observer?.onAgentStarted(agent);
    },
    onRunFinished: (agent) => {
      if (options.isBackground) {
        this.queue.markFinished();
        try { this.observer?.onAgentCompleted(agent); }
        catch (err) { debugLog("onAgentCompleted observer", err); }
      }
    },
    // onSessionCreated, onCompacted unchanged
  };
}
```

### Test helper (createManager)

```typescript
function createManager(overrides?: { ...; getMaxConcurrent?: () => number; }) {
  let mgr: AgentManager;
  const queue = new ConcurrencyQueue(
    overrides?.getMaxConcurrent ?? (() => 4),
    (id) => {
      const record = mgr.getRecord(id);
      if (record?.status !== "queued") return;
      record.promise = record.run();
    },
  );
  mgr = new AgentManager({ ..., queue });
  return { manager: mgr, ..., queue };
}
```

The forward-reference-via-closure is safe because `drain()` is never called during construction.
The `getMaxConcurrent` parameter name stays in the test helper for readability; it's passed to `ConcurrencyQueue`.

## Module-Level Changes

| File                                       | Change                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lifecycle/concurrency-queue.ts`       | **Add** — new `ConcurrencyQueue` class                                                                                                                           |
| `src/lifecycle/agent-manager.ts`           | **Change** — remove 3 fields, 3 methods; add `queue: ConcurrencyQueue` to options; update `buildObserver`, `spawn`, `abort`, `abortAll`, `waitForAll`, `dispose` |
| `src/lifecycle/agent.ts`                   | **Change** — update comment on `abort()` (remove #230 forward reference)                                                                                         |
| `src/index.ts`                             | **Change** — create `ConcurrencyQueue`, pass to manager, wire settings to `queue.drain()`                                                                        |
| `test/lifecycle/concurrency-queue.test.ts` | **Add** — unit tests for ConcurrencyQueue                                                                                                                        |
| `test/lifecycle/agent-manager.test.ts`     | **Change** — update `createManager` helper to construct ConcurrencyQueue; no queue-behavior tests removed (they remain as integration tests)                     |
| `docs/architecture/architecture.md`        | **Change** — add `concurrency-queue.ts` to layout listing; update agent-manager description                                                                      |

## Test Impact Analysis

### New unit tests enabled by extraction

1. `isFull()` boundary — returns false when running < max, true when running >= max.
2. `enqueue()` / `dequeue()` — add/remove from queue, dequeue returns false for missing ID.
3. `markStarted()` / `markFinished()` — increment/decrement running count.
4. `drain()` — calls `startAgent` for each queued ID until full; skips when already full; handles empty queue.
5. `markFinished()` auto-drain — decrement triggers drain of next queued agent.
6. `clear()` — empties queue without starting agents.
7. `queuedIds` — snapshot of queue for iteration.

These tests were previously impossible because queue logic was interleaved with agent creation, observer notifications, and session management in `AgentManager`.

### Existing tests that stay as-is

- "queueing and concurrency with injected stubs" — integration tests verifying end-to-end spawn→queue→drain through the full AgentManager stack.
  They still provide value as wiring tests.
- All observer notification tests — test observer wiring which stays in AgentManager.
- Bug race condition tests, worktree tests, execution state tests, lifecycle observer forwarding tests — independent of queue.

### Existing tests that need updating

- `createManager` helper — accepts `getMaxConcurrent` but passes it to `ConcurrencyQueue` constructor instead of `AgentManagerOptions`.

## TDD Order

1. **Red→Green: ConcurrencyQueue class + tests.**
   New `src/lifecycle/concurrency-queue.ts` with `isFull`, `enqueue`, `dequeue`, `markStarted`, `markFinished`, `drain`, `clear`, `queuedIds`.
   New `test/lifecycle/concurrency-queue.test.ts` covering: full boundary, enqueue/dequeue, start/finish counting, drain ordering, markFinished auto-drain, clear, empty-queue no-op.
   Commit: `feat(pi-subagents): add ConcurrencyQueue class (#230)`

2. **Red→Green: Migrate AgentManager to use ConcurrencyQueue.**
   Update `AgentManagerOptions`: replace `getMaxConcurrent` with `queue: ConcurrencyQueue`.
   Update constructor, `buildObserver`, `spawn`, `abort`, `abortAll`, `waitForAll`, `dispose`.
   Delete: `queue` field, `runningBackground` field, `_getMaxConcurrent` field, `notifyConcurrencyChanged()`, `drainQueue()`, `finalizeBackgroundRun()`.
   Update `test/lifecycle/agent-manager.test.ts`: revise `createManager` helper to construct `ConcurrencyQueue` internally.
   Update `src/index.ts`: construct `ConcurrencyQueue`, pass to `AgentManager`, wire `onMaxConcurrentChanged` to `queue.drain()`.
   Update `src/lifecycle/agent.ts`: remove #230 forward-reference comment on `abort()`.
   Run `pnpm run check` after this step.
   Commit: `refactor(pi-subagents): replace inline queue with ConcurrencyQueue (#230)`

3. **Docs: Update architecture.**
   Update `docs/architecture/architecture.md`: add `concurrency-queue.ts` to layout listing under `lifecycle/`, update `agent-manager.ts` description from "collection manager + concurrency controller" to "collection manager + observer wiring".
   Commit: `docs(pi-subagents): update architecture for ConcurrencyQueue extraction (#230)`

## Risks and Mitigations

| Risk                                                                                                         | Mitigation                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forward-reference-via-closure in test helper and index.ts could break if drain is called during construction | ConcurrencyQueue constructor does not call drain; drain is only called after agents exist. Same pattern already used for `onMaxConcurrentChanged`.                                                       |
| `markFinished()` auto-drain changes ordering (drain before observer notification)                            | Verified: observer notification only processes the completed agent's data and does not reference queue state. Drain starts promises without awaiting — no observable behavior change.                    |
| `markStarted()` called synchronously inside drain loop could miscount                                        | Verified: `Agent.run()` calls `observer.onStarted()` synchronously before the first await, so `markStarted()` fires before control returns to the drain while-loop. The running count is always current. |
| Integration tests in agent-manager.test.ts break after migration                                             | Tests continue to work because the `createManager` helper constructs the ConcurrencyQueue internally with the same `getMaxConcurrent` semantics. Queue behavior is preserved.                            |

## Open Questions

None — the issue's proposed change is unambiguous and both dependencies are implemented.
