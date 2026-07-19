---
issue: 228
issue_title: "Convert startAgent to async/await, move run lifecycle to Agent (Phase 15, Step 2)"
---

# Convert startAgent to async/await, dissolve RunHandle into Agent

## Problem Statement

`startAgent` is synchronous and uses `.then()`/`.catch()` to handle the runner promise.
This forces a promise-chain callback style even though `Agent` (as of #227) already owns per-agent behavior.

`RunHandle` is a private class in `agent-manager.ts` that does 6 things — 5 of which are Agent concerns (status transitions, worktree cleanup, execution state updates, listener lifecycle, signal wiring).
The only non-Agent concern is `onFinished`, a callback that connects to the manager's concurrency queue drain.

`resume()` duplicates the same pattern manually: subscribe observer, try/catch with `markCompleted`/`markError`, finally unsub.
Issue #232 wants to unify resume with the run lifecycle, and the architecture doc says "resume becomes a 4-line delegation."
If we just move `RunHandle` to `Agent` as a separate class, `resume()` still can't use it naturally — the signatures differ.
But if we dissolve `RunHandle` into Agent methods, both paths use the same primitives.

## Goals

- Zero `.then()`/`.catch()` in `agent-manager.ts`.
- Dissolve `RunHandle` into Agent methods: `completeRun`, `failRun`, `wireSignal`, `attachObserver`, `releaseListeners`, `onRunFinished` setter.
- `startAgent` is a straightforward async method: setup → await → handle result.
- `spawn()` assigns `record.promise = this.startAgent(...)`.
- Prepare the ground for #232 (resume unification) by giving Agent the run lifecycle primitives that `resume()` can reuse.

## Non-Goals

- **Resume unification** — deferred to #232.
  That issue will use the new Agent methods to simplify `AgentManager.resume()`.
- **`onSessionCreated` observer** — deferred to #229.
  The `onSessionCreated` callback in `startAgent` stays as-is.
- **`ConcurrencyQueue` extraction** — deferred to #230.
- **Relay deps** — deferred to #231.

## Background

### Relevant modules

| Module                                 | LOC | Relationship to this change                                   |
| -------------------------------------- | --- | ------------------------------------------------------------- |
| `src/lifecycle/agent-manager.ts`       | 492 | Loses `RunHandle` class (~85 LOC), `startAgent` becomes async |
| `src/lifecycle/agent.ts`               | 260 | Gains run lifecycle methods (~80 LOC)                         |
| `src/lifecycle/agent-runner.ts`        | —   | Exports `RunResult` type, now imported by `agent.ts`          |
| `test/lifecycle/agent.test.ts`         | 501 | Gains ~120 LOC of run lifecycle tests                         |
| `test/lifecycle/agent-manager.test.ts` | 768 | One assertion update (`Promise<void>`)                        |

### What RunHandle does today

| Concern                                                                | RunHandle method     | Who should own it                               |
| ---------------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| Listener lifecycle (unsub + detachFn)                                  | `releaseListeners()` | Agent — per-run cleanup handles                 |
| Run completion (worktree cleanup, status transition, execution update) | `complete(result)`   | Agent — all state mutations target Agent fields |
| Run failure (error marking, best-effort worktree cleanup)              | `fail(err)`          | Agent — same                                    |
| Signal wiring (parent abort → child abort)                             | `wireSignal()`       | Agent — per-run handle, released on completion  |
| Observer attachment (session event subscription)                       | `attachObserver()`   | Agent — per-run handle, released on completion  |
| onFinished callback (concurrency drain)                                | `fireOnFinished()`   | Manager concern, but just a stored `() => void` |

Five of six are Agent concerns.
RunHandle reaches into `this.record` for every operation and talks through `this.record.worktreeState` to a stranger.

### Dependency flow (no cycles)

`agent.ts` gains a type-only import of `RunResult` from `agent-runner.ts`.
`agent-runner.ts` imports from `agent-manager.ts` (not `agent.ts`), so no cycle is created.

### Constraints from AGENTS.md

- `promise` type change from `Promise<string>` to `Promise<void>` is internal — `Agent` is not exported from `package.json`.
- Worktree setup hoist preserves the synchronous-throw contract in `spawn()` (callers rely on catching `isolation: "worktree"` errors synchronously).

## Design Overview

### Dissolve RunHandle into Agent methods

Agent gains per-run listener fields and run lifecycle methods:

```typescript
class Agent {
  // --- Per-run listener state (released on completion or resume reset) ---
  private _unsub?: () => void;
  private _detachFn?: () => void;
  private _onRunFinished?: () => void;

  /** Wire a parent AbortSignal so it stops this agent when fired. */
  wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void;

  /** Store the record-observer unsubscribe handle. */
  attachObserver(unsub: () => void): void;

  /** Release observer + signal listener handles. */
  releaseListeners(): void;

  /** Set the callback fired once when the run finishes (for concurrency drain). */
  setOnRunFinished(fn: () => void): void;

  /** Complete a run: release listeners, worktree cleanup, status transition,
      execution update, fire onRunFinished. */
  completeRun(result: RunResult, worktrees: WorktreeManager): void;

  /** Fail a run: mark error, release listeners, best-effort worktree cleanup,
      fire onRunFinished. */
  failRun(err: unknown, worktrees: WorktreeManager): void;
}
```

`completeRun` and `failRun` take `worktrees: WorktreeManager` as a parameter rather than storing it on Agent.
Worktrees are only needed at run end — storing the reference would widen Agent's dependency surface for a single use.

Consumer call-site after the change (`startAgent`):

```typescript
record.setOnRunFinished(
  options.isBackground ? () => this.finalizeBackgroundRun(record) : undefined,
);
record.wireSignal(options.signal, () => this.abort(id));
try {
  const result = await this.runner.run(...);
  record.completeRun(result, this.worktrees);
} catch (err) {
  record.failRun(err, this.worktrees);
}
```

### Narrow `promise` to `Promise<void>`

The resolved string value of `record.promise` is dead — every consumer just `await`s it and reads `record.result`.
One test asserts `resolves.toBe("done")`; all others use `await record.promise`.
Narrowing to `Promise<void>` first makes the async conversion clean (async `startAgent` naturally returns `Promise<void>`).

### Hoist worktree setup from `startAgent` to callers

`record.setupWorktree()` can throw synchronously (strict isolation failure).
`spawn()` catches this and removes the orphan record.
`drainQueue()` catches it and marks the record as errored.

If `startAgent` becomes `async`, synchronous throws become rejected promises — neither caller catches them.
Fix: move `record.setupWorktree()` into the callers' existing try-catch blocks before calling async `startAgent`.
`startAgent` reads `record.worktreeState?.path` for the cwd instead.

### `resetForResume` releases listeners

After dissolution, `resetForResume` must call `releaseListeners()` and clear `_onRunFinished` to prevent stale handles from a previous run leaking into the resumed run.

## Module-Level Changes

### `src/lifecycle/agent.ts`

1. Add per-run listener fields: `_unsub`, `_detachFn`, `_onRunFinished`.
2. Add `wireSignal(signal, onAbort)` — logic from `RunHandle.wireSignal`.
3. Add `attachObserver(unsub)` — logic from `RunHandle.attachObserver`.
4. Add `releaseListeners()` — logic from `RunHandle.releaseListeners` (public).
5. Add `setOnRunFinished(fn)` — stores the callback.
6. Add private `fireOnRunFinished()` — idempotent clear-then-call pattern from `RunHandle.fireOnFinished`.
7. Add `completeRun(result, worktrees)` — logic from `RunHandle.complete`, returns `void` (not `string`).
8. Add `failRun(err, worktrees)` — logic from `RunHandle.fail`.
9. Update `resetForResume` — call `releaseListeners()` and clear `_onRunFinished`.
10. Change `promise` type from `Promise<string>` to `Promise<void>` (on both `AgentInit` and the class field).
11. Add imports: `type RunResult` from `agent-runner`, `debugLog` from `debug`.

### `src/lifecycle/agent-manager.ts`

1. Delete `RunHandle` class (~85 lines).
2. Remove `import type { RunResult }` (moved to `agent.ts`; `AgentRunner` import stays).
3. Convert `startAgent` to `async`, returning `Promise<void>`.
4. Replace RunHandle creation with Agent method calls: `record.setOnRunFinished(...)`, `record.wireSignal(...)`.
5. Replace `handle.attachObserver(...)` with `record.attachObserver(...)` in `onSessionCreated`.
6. Replace `.then()`/`.catch()` chain with `try { await ...; record.completeRun(...) } catch { record.failRun(...) }`.
7. Remove `record.promise = this.runner.run(...)` assignment — `record.promise` is now assigned by `spawn`/`drainQueue`.
8. In `spawn()`: hoist `record.setupWorktree(...)` before `startAgent` call (inside existing try-catch); assign `record.promise = this.startAgent(...)`.
9. In `drainQueue()`: hoist `record.setupWorktree(...)` before `startAgent` call (inside existing try-catch); assign `record.promise = this.startAgent(...)`.
10. In `startAgent`: remove `record.setupWorktree()` call; read `record.worktreeState?.path` for cwd.
11. Update `waitForAll` filter: `Promise<string>` → `Promise<void>`.

### `test/lifecycle/agent.test.ts`

1. Add `describe("Agent — completeRun")` — status transitions (completed/aborted/steered), worktree cleanup with branch append, execution state update, `onRunFinished` fires once, listeners released.
2. Add `describe("Agent — failRun")` — marks error, best-effort worktree cleanup, `onRunFinished` fires once, listeners released.
3. Add `describe("Agent — wireSignal")` — connects parent signal to abort callback, `releaseListeners` detaches.
4. Add `describe("Agent — attachObserver / releaseListeners")` — stores unsub, calls it on release, idempotent.
5. Update `describe("Agent — resetForResume")` — verify listeners are released and `_onRunFinished` is cleared.

### `test/lifecycle/agent-manager.test.ts`

1. Update one assertion: `resolves.toBe("done")` → `resolves.toBeUndefined()`.

### `packages/pi-subagents/docs/architecture/architecture.md`

1. Update Phase 15 smell table — mark `startAgent` callback row as resolved.
2. Update Step 2 description to note RunHandle dissolution (not just async conversion).
3. Update Step 6 (#232) description — RunHandle no longer exists; Agent already has `completeRun`/`failRun`/`releaseListeners` that `resume()` can use directly.

## Test Impact Analysis

### New unit tests enabled by the dissolution

1. **`Agent.completeRun()`** — isolated tests for run completion logic (status transitions based on `RunResult` flags, worktree cleanup, execution update, onRunFinished firing) without needing a full `AgentManager` scaffold with a mock runner.
2. **`Agent.failRun()`** — isolated tests for error handling and best-effort cleanup.
3. **`Agent.wireSignal()` / `Agent.attachObserver()` / `Agent.releaseListeners()`** — isolated tests for listener lifecycle without spawning a real agent.

These behaviors were previously only testable through `AgentManager` integration tests that required setting up a mock runner, worktrees, and observer.

### Existing tests that must stay

1. All `AgentManager — spawn/spawnAndWait` tests — they verify the full spawn flow including async orchestration.
2. All worktree isolation tests — they verify the synchronous-throw contract in `spawn()`.
3. All queue/concurrency tests — they verify the manager's orchestration around `drainQueue`.
4. All completion/notification tests — they verify end-to-end flow through the observer.

### Existing tests that change

1. One assertion in `agent-manager.test.ts`: `resolves.toBe("done")` → `resolves.toBeUndefined()` (promise type narrowing).

## TDD Order

1. **Narrow `Agent.promise` from `Promise<string>` to `Promise<void>`**
   - Change `AgentInit.promise` and `Agent.promise` field types.
   - In `startAgent`: wrap `.then()` callback body in braces (discard `handle.complete` return); remove `return ""` from `.catch()` callback.
   - Update `waitForAll` filter type guard.
   - Update one test assertion: `resolves.toBe("done")` → `resolves.toBeUndefined()`.
   - Run `pnpm run check` + `pnpm vitest run`.
   - Commit: `refactor(pi-subagents): narrow Agent.promise to Promise<void>`

2. **Red/Green: add run lifecycle methods to Agent**
   - Red: add tests in `agent.test.ts` for `completeRun`, `failRun`, `wireSignal`, `attachObserver`/`releaseListeners`, `resetForResume` listener cleanup.
   - Green: implement the methods on `Agent` — `wireSignal`, `attachObserver`, `releaseListeners`, `setOnRunFinished`, `fireOnRunFinished`, `completeRun`, `failRun`; update `resetForResume`.
   - Add `import type { RunResult }` and `import { debugLog }` to `agent.ts`.
   - Run `pnpm run check` + `pnpm vitest run`.
   - Commit: `feat(pi-subagents): add run lifecycle methods to Agent`

3. **Replace RunHandle with Agent methods in `startAgent`, delete RunHandle**
   - Replace `new RunHandle(record, this.worktrees, onFinished)` with `record.setOnRunFinished(onFinished)`.
   - Replace `handle.wireSignal(...)` with `record.wireSignal(...)`.
   - Replace `handle.attachObserver(...)` with `record.attachObserver(...)`.
   - Replace `handle.complete(result)` with `record.completeRun(result, this.worktrees)`.
   - Replace `handle.fail(err)` with `record.failRun(err, this.worktrees)`.
   - Delete `RunHandle` class.
   - Remove `import type { RunResult }` from `agent-manager.ts` (moved to `agent.ts`).
   - Run `pnpm run check` + `pnpm vitest run`.
   - Commit: `refactor(pi-subagents): replace RunHandle with Agent run lifecycle methods`

4. **Hoist worktree setup from `startAgent` to callers**
   - In `spawn()`: move `record.setupWorktree(this.worktrees, options.isolation)` before `this.startAgent()`, inside the existing try-catch.
   - In `drainQueue()`: move `record.setupWorktree(this.worktrees, next.args.options.isolation)` before `this.startAgent()`, inside its try-catch.
   - In `startAgent`: remove `record.setupWorktree()` call; use `record.worktreeState?.path` for `context.cwd`.
   - Existing worktree isolation tests pass unchanged.
   - Run `pnpm run check` + `pnpm vitest run`.
   - Commit: `refactor(pi-subagents): hoist worktree setup from startAgent to callers`

5. **Convert `startAgent` to async/await**
   - Make `startAgent` async, returning `Promise<void>`.
   - Replace `.then()`/`.catch()` chain with `try { const result = await this.runner.run(...); record.completeRun(result, this.worktrees); } catch (err) { record.failRun(err, this.worktrees); }`.
   - Remove `record.promise = this.runner.run(...)` assignment from inside `startAgent`.
   - In `spawn()`: assign `record.promise = this.startAgent(id, record, args)`.
   - In `drainQueue()`: assign `record.promise = this.startAgent(next.id, record, next.args)`.
   - Run `pnpm run check` + `pnpm vitest run`.
   - Commit: `refactor(pi-subagents): convert startAgent to async/await`

6. **Update architecture docs**
   - Mark Phase 15 Step 2 smell row as resolved.
   - Update Step 2 description to note RunHandle dissolution.
   - Update Step 6 (#232) description: RunHandle no longer exists; Agent has `completeRun`/`failRun`/`releaseListeners` that `resume()` can use directly.
   - Commit: `docs(pi-subagents): update architecture for async startAgent`

## Risks and Mitigations

1. **`resetForResume` must release listeners** — If not updated, resumed agents retain stale listener handles from the previous run.
   Mitigated by step 2 explicitly updating `resetForResume` to call `releaseListeners()` and clear `_onRunFinished`, with a test.

2. **Worktree hoist changes observer-throw semantics** — Currently, if `observer.onAgentStarted()` throws inside `startAgent`, `spawn()`'s try-catch catches it and removes the record.
   After async conversion, that throw becomes a rejected promise.
   This is a pre-existing inconsistency (`onAgentCompleted` is already wrapped in try-catch, `onAgentStarted` is not) and observers should not throw.
   Mitigated by noting the inconsistency; a future step could add try-catch around `onAgentStarted`.

3. **Agent grows by ~80 LOC** — Dissolving RunHandle adds methods to an already-substantial class.
   Mitigated by the fact that these methods replace logic that already operated on Agent's fields — they belong here by SRP.
   The net effect on `agent-manager.ts` is -85 LOC (RunHandle deletion), so the total codebase shrinks.

4. **`completeRun` takes `worktrees` parameter instead of storing it** — This means every caller must pass worktrees.
   Mitigated by there being exactly two callers today (startAgent and the future resume), both of which already have access to worktrees.
   Storing it would widen Agent's dependency surface for a single use.

## Open Questions

None — the design direction (dissolve rather than move) is settled.
The `worktrees` parameter vs. stored-reference question is resolved in favor of the parameter (ISP).
