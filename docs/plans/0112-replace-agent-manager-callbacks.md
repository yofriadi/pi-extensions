---
issue: 112
issue_title: "refactor(pi-subagents): replace AgentManager callbacks with observer interface"
---

# Replace AgentManager callbacks with observer interface

## Problem Statement

`AgentManagerOptions` accepts three fire-and-forget callbacks — `onStart`, `onComplete`, `onCompact` — that `index.ts` wires as closure lambdas capturing `runtime`, `pi`, `notifications`, and other extension state.
This is the same callback-threading pattern that was replaced with direct session subscriptions in #100, but one level up.
The callbacks are notification-style (fire-and-forget, no return value) and match the observer pattern exactly.

## Goals

- Replace the three callback parameters on `AgentManagerOptions` with a single `observer?: AgentManagerObserver` interface.
- `index.ts` constructs one observer object instead of three independent closure lambdas.
- `AgentManagerOptions` shrinks by two net fields (remove 3 callbacks, add 1 observer).
- Preserve all existing behavior: lifecycle events, record persistence, notification dispatch, compaction events.
- Non-breaking refactor — no public API changes (the callbacks are internal to the package).

## Non-Goals

- Extracting the observer implementation from `index.ts` into its own module — that can follow if the object grows.
- Changing `RecordObserverOptions` (session-level observer) — it remains a separate concern at a different layer.
- Narrowing `AgentToolDeps` or `AgentMenuDeps` — tracked in #114.
- Disambiguating `SpawnOptions` — tracked in #113.

## Background

### Current callback wiring

`agent-manager.ts` defines three callback type aliases and stores them as private fields:

```typescript
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
```

`AgentManager` invokes them at three points:

1. `onStart` — called in `startAgent()` after `record.markRunning()`.
2. `onComplete` — called in `startAgent()`'s `.then()` and `.catch()` handlers for background agents, and in `drainQueue()` on late failure.
3. `onCompact` — relayed through `subscribeRecordObserver()` → `RecordObserverOptions.onCompact`.

`index.ts` builds ~30 lines of closure lambdas (lines 73–116) that capture `pi`, `notifications`, and `buildEventData`.

### Observer pattern already established

`record-observer.ts` and `ui/ui-observer.ts` are session-level observers that subscribe directly to session events.
This refactoring applies the same principle at the manager level — grouping related notification callbacks into a single interface.

### Dependency: issue #111 (AgentRecord lifecycle split)

Issue #111 is closed.
The observer interface is designed against the current record shape, which reflects the post-#111 lifecycle split.

### Architecture reference

Phase 7, Step C in `docs/architecture/architecture.md`.

## Design Overview

### Observer interface

```typescript
export interface AgentManagerObserver {
  onAgentStarted(record: AgentRecord): void;
  onAgentCompleted(record: AgentRecord): void;
  onAgentCompacted(record: AgentRecord, info: CompactionInfo): void;
}
```

All three methods are fire-and-forget (void return, no async).
The interface uses past-tense naming (`Started`, `Completed`, `Compacted`) to signal that these are after-the-fact notifications, not hooks that influence the operation.

### `AgentManagerOptions` change

```typescript
export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  exec: ShellExec;
  registry: AgentTypeRegistry;
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  observer?: AgentManagerObserver;  // replaces onStart, onComplete, onCompact
}
```

Fields go from 9 → 7 (remove 3 callbacks, add 1 observer).

### AgentManager internal changes

The three private fields (`onStart`, `onComplete`, `onCompact`) become one: `private observer?: AgentManagerObserver`.
Call sites change from `this.onStart?.(record)` to `this.observer?.onAgentStarted(record)`.

The `onCompact` relay into `subscribeRecordObserver` changes from:

```typescript
onCompact: (r, info) => this.onCompact?.(r, info),
```

to:

```typescript
onCompact: (r, info) => this.observer?.onAgentCompacted(r, info),
```

### `CompactionInfo` stays in `agent-manager.ts`

`CompactionInfo` is a data shape consumed by the observer interface and already defined in `agent-manager.ts`.
It stays co-located since both `AgentManagerObserver` and `CompactionInfo` are exported from the same module.
`record-observer.ts` continues to import `CompactionInfo` from `agent-manager.ts`.

### Observer construction in `index.ts`

The three closure lambdas collapse into one object literal:

```typescript
const observer: AgentManagerObserver = {
  onAgentStarted(record) {
    pi.events.emit("subagents:started", {
      id: record.id, type: record.type, description: record.description,
    });
  },
  onAgentCompleted(record) {
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) pi.events.emit("subagents:failed", eventData);
    else pi.events.emit("subagents:completed", eventData);

    pi.appendEntry("subagents:record", { /* same fields as today */ });

    if (record.notification?.resultConsumed) {
      notifications.cleanupCompleted(record.id);
      return;
    }
    notifications.sendCompletion(record);
  },
  onAgentCompacted(record, info) {
    pi.events.emit("subagents:compacted", {
      id: record.id, type: record.type, description: record.description,
      reason: info.reason, tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  },
};
```

Passed as `observer` to `new AgentManager({ ..., observer })`.

### Removed exports

The three callback type aliases are removed:

- `OnAgentStart`
- `OnAgentComplete`
- `OnAgentCompact`

These are only imported in `agent-manager.test.ts` — no production consumers outside `agent-manager.ts`.

## Module-Level Changes

### `src/agent-manager.ts`

- Add `AgentManagerObserver` interface (3 methods).
- Remove `OnAgentStart`, `OnAgentComplete`, `OnAgentCompact` type aliases.
- Replace `onStart`, `onComplete`, `onCompact` fields in `AgentManagerOptions` with `observer?: AgentManagerObserver`.
- Replace three private fields with `private observer?: AgentManagerObserver`.
- Update constructor to assign `this.observer = options.observer`.
- Update all call sites: `this.onStart?.(record)` → `this.observer?.onAgentStarted(record)`, etc.
- The `onCompact` relay to `subscribeRecordObserver` uses `this.observer?.onAgentCompacted`.

### `src/index.ts`

- Replace the three closure-lambda properties (`onComplete:`, `onStart:`, `onCompact:`) with a single `observer` object literal.
- Import `AgentManagerObserver` from `agent-manager.ts`.
- Remove any now-unused callback type imports.

### `src/record-observer.ts`

- No changes.
  `RecordObserverOptions.onCompact` stays as-is — it is the session-level relay, not the manager-level observer.
  `CompactionInfo` import from `agent-manager.ts` stays unchanged.

### `test/agent-manager.test.ts`

- Update imports: remove `OnAgentStart`, `OnAgentComplete`, `OnAgentCompact`; add `AgentManagerObserver`.
- Update `createManager` helper: replace the three callback overrides with `observer?: Partial<AgentManagerObserver>`.
  The factory spreads a no-op default observer with test-provided overrides.
- Update each test that wires a callback to construct an observer object instead.

## Test Impact Analysis

1. No new unit tests are enabled by this refactoring — it's a 1:1 shape change.
2. No existing tests become redundant — each test exercises a specific lifecycle scenario (race condition, foreground vs background, error handling, queue drain).
3. All existing `agent-manager.test.ts` tests stay, with mechanical updates to the observer wiring.
   The assertions remain the same (e.g., "observer.onAgentCompleted fires with `resultConsumed=false` when `markConsumed` called after await").

## TDD Order

### Step 1: Introduce `AgentManagerObserver` interface alongside existing callbacks

Add the interface to `agent-manager.ts`.
No production behavior changes — the interface is unused at this point.

- Commit: `refactor: add AgentManagerObserver interface`

### Step 2: Switch `AgentManager` internals to observer

1. Replace the three `onStart`/`onComplete`/`onCompact` fields on `AgentManagerOptions` with `observer?: AgentManagerObserver`.
2. Replace the three private fields with one `private observer?: AgentManagerObserver`.
3. Update all internal call sites (`this.onStart?.(record)` → `this.observer?.onAgentStarted(record)`, etc.).
4. Remove the three callback type aliases (`OnAgentStart`, `OnAgentComplete`, `OnAgentCompact`).
5. Update `test/agent-manager.test.ts`: change imports, update `createManager` helper and all test call sites to construct observer objects instead of individual callbacks.
6. Run `pnpm run check` to verify types.

- Commit: `refactor: replace AgentManager callbacks with observer interface (#112)`

### Step 3: Update `index.ts` to construct observer

1. Replace the three closure-lambda properties in the `new AgentManager({...})` call with a single `observer` object.
2. Import `AgentManagerObserver` type.
3. Remove unused callback type imports.
4. Run full test suite.

- Commit: `refactor: construct AgentManagerObserver in index.ts (#112)`

## Risks and Mitigations

| Risk                                                                                                                | Mitigation                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests break silently because esbuild ignores excess properties — old `onComplete` fields pass through without error | Step 2 removes the type aliases, so TypeScript catches any test still using the old shape via `pnpm run check`                                                              |
| `onComplete` error-swallowing behavior changes                                                                      | The `try/catch` around `this.onComplete?.(record)` in the `.then()` path moves exactly to `this.observer?.onAgentCompleted(record)` — same guard, same catch, same debugLog |
| `Partial<AgentManagerObserver>` in test factory silently drops required methods                                     | Tests that need a specific method construct it explicitly; the factory only provides a convenient default for tests that don't care about any observer method               |

## Open Questions

- None — the issue's proposed design is unambiguous and aligns with the established session-observer pattern.
