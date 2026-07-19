---
issue: 227
issue_title: "Evolve AgentRecord into Agent with behavior (Phase 15, Step 1)"
---

# Evolve AgentRecord into Agent with behavior

## Problem Statement

`AgentRecord` is an anemic domain model — it holds identity, status transitions, and stats but no behavior.
`AgentManager` reaches into records 37 times, performing work that belongs on the agent:

- **abort**: `AgentManager.abort()` checks `record.status`, calls `record.abortController?.abort()`, calls `record.markStopped()` — this is the agent aborting itself, but the logic lives on the manager.
- **pending steers**: per-agent steer buffers live in a manager-level `Map<string, string[]>`, not on the agent.
- **steer flushing**: `flushPendingSteers(id, session)` iterates the manager map — should be `agent.flushPendingSteers(session)`.
- **worktree setup**: `setupWorktree()` creates a worktree and attaches it to the record — the agent should set up its own worktree.

## Goals

- Move per-agent behavior (`abort`, `queueSteer`/`flushPendingSteers`, `setupWorktree`) from `AgentManager` to the agent.
- `AgentManager` delegates to agents via Tell-Don't-Ask instead of reaching into records.
- Rename `AgentRecord` → `Agent`, `AgentRecordStatus` → `AgentStatus`, `AgentRecordInit` → `AgentInit` across the codebase.
- All changes are internal — the public `SubagentsService` API (`service.ts`) is unaffected.

## Non-Goals

- **`RunHandle` ownership** — moves to `Agent` in #228, not here.
- **Async `startAgent`** — deferred to #228.
- **`onSessionCreated` observer** — deferred to #229.
- **`ConcurrencyQueue` extraction** — deferred to #230.
  Queue removal logic stays on `AgentManager.abort()` until then.
- **Relay deps** — deferred to #231.
- **Resume unification** — deferred to #232.

## Background

### Relevant modules

| Module                                     | Responsibility                                          | Relationship to this change                                                        |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lifecycle/agent-record.ts` (201 LOC)  | Status state machine, stats accumulation                | Gains behavior methods, renames to `agent.ts`                                      |
| `src/lifecycle/agent-manager.ts` (541 LOC) | Agent collection, spawn, abort, queue, steer buffering  | Loses private methods, delegates to agent                                          |
| `src/lifecycle/worktree.ts`                | `WorktreeManager` interface and git worktree operations | Agent calls `worktrees.create()` directly                                          |
| `src/lifecycle/worktree-state.ts`          | Per-agent worktree lifecycle state                      | Already attached to agent — `setupWorktree` formalizes this                        |
| `src/tools/steer-tool.ts`                  | LLM-facing steer tool                                   | Calls `record.queueSteer()` directly instead of `manager.queueSteer()`             |
| `src/service/service-adapter.ts`           | Cross-extension API adapter                             | Calls `record.queueSteer()` directly; `queueSteer` removed from `AgentManagerLike` |
| `src/observation/record-observer.ts`       | Session event → agent stats accumulation                | Import rename only                                                                 |
| `src/types.ts`                             | Internal re-exports                                     | Re-export updates                                                                  |
| `test/helpers/make-record.ts`              | Shared test factory                                     | Renames to `make-agent.ts`, factory → `createTestAgent()`                          |

### Constraints

- The public export from `package.json` is `"./src/service.ts"` only — `AgentRecord` is internal, so the rename is not breaking for consumers.
- `WorktreeManager` is injected via the manager's constructor — `Agent.setupWorktree()` receives it as a parameter (no new constructor dependency).
- Queue removal in `abort()` stays on `AgentManager` because the queue is manager-owned until #230 extracts `ConcurrencyQueue`.

## Design Overview

### New methods on Agent

```typescript
class Agent {
  // Existing: markRunning, markCompleted, markAborted, markSteered, markError, markStopped,
  //           incrementToolUses, addUsage, incrementCompactions, resetForResume

  // --- New behavior ---

  /** Buffer a steer message for delivery once the session is ready. */
  queueSteer(message: string): void;

  /** Flush buffered steers to the session and clear the buffer. */
  flushPendingSteers(session: AgentSession): void;

  /** Abort a running agent: fire AbortController, transition to stopped. */
  abort(): boolean;

  /** Create a worktree for isolated execution. Throws if impossible. */
  setupWorktree(worktrees: WorktreeManager, isolation: IsolationMode | undefined): string | undefined;
}
```

### Steer buffering moves to agent

Before: `AgentManager` owns `pendingSteers: Map<string, string[]>` and exposes `queueSteer(id, msg)`.
After: each `Agent` owns `private pendingSteers: string[] = []`.
Callers that already hold a record reference (steer tool, service adapter) call `agent.queueSteer(msg)` directly — the manager's `queueSteer` method and the `pendingSteers` map are removed.

Consumer call-site (steer tool):

```typescript
// Before:
this.manager.queueSteer(record.id, params.message);
// After:
record.queueSteer(params.message);
```

### Abort moves to agent

`Agent.abort()` encapsulates the running-check + controller.abort + markStopped sequence:

```typescript
abort(): boolean {
  if (this._status !== "running") return false;
  this.abortController?.abort();
  this.markStopped();
  return true;
}
```

`AgentManager.abort(id)` retains queue-removal logic (queue is manager-owned until #230) and delegates the running case to `agent.abort()`.
`AgentManager.abortAll()` calls `agent.abort()` for running agents.

### Worktree setup moves to agent

`Agent.setupWorktree(worktrees, isolation)` replaces `AgentManager.setupWorktree(id, record, isolation)`.
The agent creates the worktree, sets `this.worktreeState`, and returns the worktree path.
The error message for impossible worktree creation stays identical.

### Rename strategy

The rename (`AgentRecord` → `Agent`) is the final step — a purely mechanical search-and-replace with no behavior change.
This keeps behavior-adding commits small and reviewable, then consolidates the rename noise into one commit.

Files affected by the rename:

| Layer                | Files                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source (lifecycle)   | `agent-record.ts` → `agent.ts`, `agent-manager.ts`, `execution-state.ts`                                                                                                 |
| Source (observation) | `record-observer.ts`, `notification.ts`                                                                                                                                  |
| Source (tools)       | `agent-tool.ts`, `steer-tool.ts`, `get-result-tool.ts`, `background-spawner.ts`, `foreground-runner.ts`                                                                  |
| Source (UI)          | `agent-menu.ts`, `agent-creation-wizard.ts`, `conversation-viewer.ts`                                                                                                    |
| Source (service)     | `service-adapter.ts`                                                                                                                                                     |
| Source (types)       | `types.ts`                                                                                                                                                               |
| Tests                | `agent-record.test.ts` → `agent.test.ts`, `agent-manager.test.ts`, `record-observer.test.ts`, `steer-tool.test.ts`, `get-result-tool.test.ts`, `service-adapter.test.ts` |
| Test helpers         | `make-record.ts` → `make-agent.ts`                                                                                                                                       |

## Module-Level Changes

### `src/lifecycle/agent-record.ts` → `src/lifecycle/agent.ts`

1. Add `private pendingSteers: string[] = []` field.
2. Add `queueSteer(message: string): void` — pushes to `pendingSteers`.
3. Add `flushPendingSteers(session: AgentSession): void` — iterates buffer, calls `session.steer()`, clears array.
4. Add `abort(): boolean` — if running, fires controller and marks stopped.
5. Add `setupWorktree(worktrees: WorktreeManager, isolation: IsolationMode | undefined): string | undefined` — creates worktree, sets `worktreeState`, returns path.
6. Add import for `WorktreeState`, `WorktreeManager`, `IsolationMode`.
7. Rename class `AgentRecord` → `Agent`, type `AgentRecordStatus` → `AgentStatus`, interface `AgentRecordInit` → `AgentInit`.

### `src/lifecycle/agent-manager.ts`

1. Remove `private pendingSteers = new Map<string, string[]>()`.
2. Remove `queueSteer(id, message)` public method.
3. Remove `private flushPendingSteers(id, session)` method.
4. In `startAgent`'s `onSessionCreated` callback: replace `this.flushPendingSteers(id, session)` with `record.flushPendingSteers(session)`.
5. Remove `private setupWorktree(id, record, isolation)` method.
6. In `startAgent`: replace `this.setupWorktree(id, record, options.isolation)` with `record.setupWorktree(this.worktrees, options.isolation)`.
7. Simplify `abort(id)`: delegate running case to `record.abort()`.
8. Simplify `abortAll()`: call `record.abort()` for running agents.
9. In `removeRecord`: remove `this.pendingSteers.delete(id)`.
10. Update imports: `AgentRecord` → `Agent`, `AgentRecordInit` → `AgentInit` (if used).

### `src/tools/steer-tool.ts`

1. Remove `queueSteer` from `SteerToolManager` interface.
2. Replace `this.manager.queueSteer(record.id, params.message)` with `record.queueSteer(params.message)`.
3. Update import: `AgentRecord` → `Agent`.

### `src/service/service-adapter.ts`

1. Remove `queueSteer` from `AgentManagerLike` interface.
2. In `steer()`: replace `this.manager.queueSteer(id, message)` with `record.queueSteer(message)` and return `true`.
3. Update import: `AgentRecord` → `Agent`.

### `src/types.ts`

1. Update re-export: `AgentRecord` → `Agent`, source path `#src/lifecycle/agent-record` → `#src/lifecycle/agent`.

### `src/observation/record-observer.ts`

1. Update import and parameter types: `AgentRecord` → `Agent`.

### `src/observation/notification.ts`

1. Update import and parameter types: `AgentRecord` → `Agent`.

### `src/tools/*.ts` (agent-tool, get-result-tool, background-spawner, foreground-runner)

1. Update imports and type annotations: `AgentRecord` → `Agent`.

### `src/ui/*.ts` (agent-menu, agent-creation-wizard, conversation-viewer)

1. Update imports and type annotations: `AgentRecord` → `Agent`.

### `test/helpers/make-record.ts` → `test/helpers/make-agent.ts`

1. Rename file.
2. Update imports: `AgentRecord` → `Agent`, `AgentRecordInit` → `AgentInit`.
3. Rename factory: `createTestRecord` → `createTestAgent`.
4. Update return type annotation.

### `test/lifecycle/agent-record.test.ts` → `test/lifecycle/agent.test.ts`

1. Rename file.
2. Update import: `AgentRecord` → `Agent`.
3. Update all `describe` block names and `new AgentRecord(...)` calls.
4. Add new test blocks for `queueSteer`, `flushPendingSteers`, `abort`, `setupWorktree`.

### `test/lifecycle/agent-manager.test.ts`

1. Remove tests for `AgentManager.queueSteer` (behavior moved to agent).
2. Update `abort()` tests to verify delegation.
3. Update imports if `AgentRecord` type is referenced.

### `test/tools/steer-tool.test.ts`

1. Remove `queueSteer` from mock manager.
2. Update "session not ready" test to verify `record.queueSteer()` is called.

### `test/service/service-adapter.test.ts`

1. Remove `queueSteer` from mock managers.
2. Update steer tests to verify `record.queueSteer()`.

### `packages/pi-subagents/docs/architecture/architecture.md`

1. Update file listing: `agent-record.ts` → `agent.ts`.
2. Update `AgentRecordInit` reference in interface width table.

## Test Impact Analysis

### New unit tests enabled by the extraction

1. **`Agent.queueSteer()` / `Agent.flushPendingSteers()`** — isolated tests for steer buffering without needing a full `AgentManager` setup.
   Previously the steer buffering was only testable via `AgentManager` integration tests.
2. **`Agent.abort()`** — isolated tests for the abort state machine (running → stopped, not-running → no-op) without needing manager scaffolding.
3. **`Agent.setupWorktree()`** — isolated tests for worktree creation and error handling with a mock `WorktreeManager`, without full spawn infrastructure.

### Existing tests that become redundant

1. `AgentManager — queueSteer` tests — the behavior is now tested directly on `Agent`.
   The manager no longer has a `queueSteer` method.
2. Parts of `AgentManager — abort` tests that verify controller.abort + markStopped — these are now `Agent.abort()` tests.
   The manager abort tests should focus on queue-removal logic and delegation.

### Existing tests that must stay

1. `AgentManager — abort` tests for the "queued" case (queue removal is still manager-owned).
2. `AgentManager — abortAll` tests (orchestrates both queue clearing and agent abort).
3. All `AgentManager — spawn/spawnAndWait` tests — the spawn flow still lives on the manager.
4. `steer-tool` and `service-adapter` tests for the steer path — updated to verify the new call pattern.

## TDD Order

1. **Red/Green: add `queueSteer()` and `flushPendingSteers()` to `AgentRecord`**
   - Add tests in `agent-record.test.ts` for buffering and flushing steers.
   - Implement the methods on `AgentRecord`.
   - Commit: `feat(pi-subagents): add steer buffering to AgentRecord`

2. **Refactor: delegate steer buffering from manager to agent**
   - Remove `pendingSteers` map, `queueSteer()`, `flushPendingSteers()` from `AgentManager`.
   - In `startAgent`'s `onSessionCreated`: call `record.flushPendingSteers(session)`.
   - In `removeRecord`: remove `pendingSteers.delete(id)`.
   - Update `steer-tool.ts`: remove `queueSteer` from `SteerToolManager`, call `record.queueSteer()`.
   - Update `service-adapter.ts`: remove `queueSteer` from `AgentManagerLike`, call `record.queueSteer()`.
   - Remove `AgentManager — queueSteer` tests; update steer-tool and service-adapter tests.
   - Run `pnpm run check` to verify no type errors.
   - Commit: `refactor(pi-subagents): delegate steer buffering from manager to agent`

3. **Red/Green: add `abort()` to `AgentRecord`**
   - Add tests in `agent-record.test.ts`: running → aborts and returns true; non-running → returns false; no controller → still marks stopped.
   - Implement the method.
   - Commit: `feat(pi-subagents): add abort() to AgentRecord`

4. **Refactor: delegate abort from manager to agent**
   - Simplify `AgentManager.abort()`: queued case stays, running case delegates to `record.abort()`.
   - Simplify `AgentManager.abortAll()`: call `record.abort()` for running agents.
   - Update manager abort tests to focus on queue removal and delegation.
   - Commit: `refactor(pi-subagents): delegate abort from manager to agent`

5. **Red/Green: add `setupWorktree()` to `AgentRecord`**
   - Add tests in `agent-record.test.ts`: non-worktree returns undefined; worktree created → sets `worktreeState` and returns path; creation fails → throws.
   - Implement the method (import `WorktreeState`, `WorktreeManager`, `IsolationMode`).
   - Commit: `feat(pi-subagents): add setupWorktree() to AgentRecord`

6. **Refactor: delegate worktree setup from manager to agent**
   - Remove `private setupWorktree()` from `AgentManager`.
   - In `startAgent`: replace `this.setupWorktree(id, record, options.isolation)` with `record.setupWorktree(this.worktrees, options.isolation)`.
   - Update any tests that verify worktree setup delegation.
   - Commit: `refactor(pi-subagents): delegate worktree setup from manager to agent`

7. **Rename `AgentRecord` → `Agent` across codebase**
   - Rename `src/lifecycle/agent-record.ts` → `src/lifecycle/agent.ts`.
   - Rename class `AgentRecord` → `Agent`, type `AgentRecordStatus` → `AgentStatus`, interface `AgentRecordInit` → `AgentInit`.
   - Update all source imports and type references (~20 source files).
   - Rename `test/lifecycle/agent-record.test.ts` → `test/lifecycle/agent.test.ts`.
   - Rename `test/helpers/make-record.ts` → `test/helpers/make-agent.ts`, factory `createTestRecord` → `createTestAgent`.
   - Update all test imports and references (~10 test files).
   - Rename `subscribeRecordObserver` → `subscribeAgentObserver` and `RecordObserverOptions` → `AgentObserverOptions` in `record-observer.ts`.
   - Run `pnpm run check` and full test suite.
   - Commit: `refactor(pi-subagents): rename AgentRecord to Agent`

8. **Update architecture docs**
   - Update `docs/architecture/architecture.md` file listing: `agent-record.ts` → `agent.ts`.
   - Update `AgentRecordInit` → `AgentInit` in the interface width table.
   - Update the Phase 15 Step 1 entry to reflect completion.
   - Commit: `docs(pi-subagents): update architecture for Agent rename`

## Risks and Mitigations

1. **Large rename diff in step 7** — The rename touches ~30 files.
   Mitigated by making it a purely mechanical change (no behavior change) in a dedicated commit, so reviewers can verify it's a clean rename.
2. **Queue-removal leaks into agent** — `Agent.abort()` must NOT remove from the manager's queue (that's #230's concern).
   Mitigated by scoping `Agent.abort()` to only handle the running case; `AgentManager.abort()` retains queue removal.
3. **Interface changes cascade** — Removing `queueSteer` from `SteerToolManager` and `AgentManagerLike` requires updating test mocks.
   Mitigated by handling interface changes and test updates in the same step (step 2).
4. **Test factory rename ripple** — `createTestRecord` → `createTestAgent` touches many test files.
   Mitigated by including this in the rename step (step 7), which is already a mechanical change.

## Open Questions

None — the issue's proposed change is unambiguous and scoped.
`RunHandle` ownership and other Phase 15 steps are explicitly deferred to their own issues.
