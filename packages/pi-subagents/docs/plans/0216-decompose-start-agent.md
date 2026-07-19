---
issue: 216
issue_title: "Decompose startAgent in agent-manager.ts (Phase 13, Step 3)"
---

# Decompose `startAgent` via `RunHandle` lifecycle object

## Problem Statement

`startAgent` in `agent-manager.ts` is a ~125-line method whose complexity comes not from length alone but from **mutable closure state shared across callbacks**.
Two `let` variables (`unsubRecordObserver`, `detachParentSignal`) are written in one closure (`onSessionCreated` / setup block) and read in two others (`.then()` / `.catch()`).
The `.then()` and `.catch()` handlers duplicate finalization logic (observer unsubscription, signal detach, worktree cleanup, background counter management).

The original issue proposed extracting three methods (`handleRunCompletion`, `handleRunError`, `finalizeBackgroundRun`).
This plan replaces that mechanical extraction with a structural fix: introduce a **`RunHandle` lifecycle object** that owns the per-run cleanup state, eliminating the mutable closures and the duplicated finalization.

## Goals

- Eliminate mutable closure state from `startAgent` — all per-run state lives on `RunHandle`.
- Eliminate duplicated cleanup/finalization logic in `.then()`/`.catch()` via Tell-Don't-Ask on `RunHandle`.
- Teach `WorktreeState` to self-clean via `performCleanup()`, removing the ask-tell dance from callers.
- Reduce `startAgent` to a coordinator (~35–40 lines) with zero mutable `let` bindings.
- Keep all 929 lines of existing `agent-manager.test.ts` passing unchanged.

## Non-Goals

- Extracting `RunHandle` to a separate file — it stays private in `agent-manager.ts` for now.
- Changing the `runner.run()` options shape or the `RunResult` type.
- Reducing `agent-manager.test.ts` duplication (tracked in #219).
- Moving `pendingSteers` state to a different owner (the timing gap between `spawn()` and `startAgent()` makes this non-trivial).

## Background

### Closure tangle in `startAgent`

```text
unsubRecordObserver  ──written in──▶  onSessionCreated callback
                     ──read in────▶  .then() handler
                     ──read in────▶  .catch() handler

detachParentSignal   ──written in──▶  setup block
                     ──read via───▶  detach closure
                     ──read in────▶  .then() handler (via detach)
                     ──read in────▶  .catch() handler (via detach)
```

Both variables are resource-release handles — acquired at different times, released in the same place.
They have no owner; they float as mutable `let` bindings shared across closures.

### Duplicated finalization

Both `.then()` and `.catch()` perform:

1. `unsubRecordObserver?.(); detach();` — release listeners
2. Worktree cleanup via `this.worktrees.cleanup()` + `record.worktreeState.recordCleanup()` — ask-tell dance
3. Background finalization: `this.runningBackground--`, `this.observer?.onAgentCompleted(record)`, `this.drainQueue()`

### Existing types

- `RunResult` is already exported from `agent-runner.ts` — `RunHandle.complete()` can accept it directly.
- `WorktreeManager.cleanup()` accepts `WorktreeInfo`, which `WorktreeState` satisfies structurally (has `path` and `branch`).
- `record.description` is available on `AgentRecord` at cleanup time, so `RunHandle` doesn't need a separate `description` parameter.

## Design Overview

### `WorktreeState.performCleanup(worktrees, description)`

Teach `WorktreeState` to orchestrate its own cleanup instead of requiring callers to do the ask-tell dance:

```typescript
performCleanup(worktrees: WorktreeManager, description: string): WorktreeCleanupResult {
  const result = worktrees.cleanup(this, description);
  this._cleanupResult = result;
  return result;
}
```

This replaces the two-step pattern at both call sites:

```typescript
// Before (caller orchestrates):
const wtResult = this.worktrees.cleanup(record.worktreeState, options.description);
record.worktreeState.recordCleanup(wtResult);

// After (Tell-Don't-Ask):
const wtResult = record.worktreeState.performCleanup(this.worktrees, record.description);
```

### `RunHandle` lifecycle object

A short-lived object born when a run starts, consumed when it ends.
Owns the two resource-release handles and exposes `complete()`/`fail()` as the only way to finish a run.

```typescript
class RunHandle {
  private unsub?: () => void;
  private detach?: () => void;
  private onFinished?: () => void;

  constructor(
    private readonly record: AgentRecord,
    private readonly worktrees: WorktreeManager,
    onFinished?: () => void,
  ) { this.onFinished = onFinished; }

  wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void;
  attachObserver(unsub: () => void): void;
  complete(result: RunResult): string;
  fail(err: unknown): void;

  private detachListeners(): void;
  private fireOnFinished(): void;  // idempotent — nulls callback after first call
}
```

Key design decisions:

1. **`onFinished` callback** — set once at construction, fires at most once (idempotent guard).
   For background agents this is `() => this.finalizeBackgroundRun(record)`.
   For foreground agents it is `undefined`.
   This eliminates the `if (options.isBackground)` check from both `.then()` and `.catch()`.

2. **`fireOnFinished` is idempotent** — if `complete()` throws (e.g., worktree cleanup fails on the success path) and the promise chain falls through to `.catch()` → `fail()`, the callback fires exactly once.
   `AgentRecord`'s transition guards (`if (this._status !== "stopped")`) protect against double state transitions.

3. **`complete()` returns `result.responseText`** — the branch-suffix text is stored on the record via `markCompleted(finalResult)` but the promise resolves with the original response text, matching current behavior.

4. **No `worktrees` or `description` parameters on `complete()`/`fail()`** — `RunHandle` gets `worktrees` at construction; `description` comes from `record.description`.

### `finalizeBackgroundRun(record)` on `AgentManager`

Extracts the shared background finalization:

```typescript
private finalizeBackgroundRun(record: AgentRecord): void {
  this.runningBackground--;
  try { this.observer?.onAgentCompleted(record); }
  catch (err) { debugLog("onAgentCompleted observer", err); }
  this.drainQueue();
}
```

Note: the current `.catch()` handler does not wrap `onAgentCompleted` in try/catch, but `.then()` does.
The extracted method always wraps it — an observer error must never prevent `drainQueue()` from running.

### Small helpers on `AgentManager`

Two additional extractions to keep `startAgent` focused:

```typescript
private setupWorktree(
  id: string, record: AgentRecord, isolation: IsolationMode | undefined,
): string | undefined;

private flushPendingSteers(id: string, session: AgentSession): void;
```

### Resulting `startAgent` shape

After all extractions, `startAgent` becomes a coordinator with **zero mutable `let` bindings**:

```typescript
private startAgent(id: string, record: AgentRecord, { snapshot, type, prompt, options }: SpawnArgs) {
  const worktreeCwd = this.setupWorktree(id, record, options.isolation);

  record.markRunning(Date.now());
  if (options.isBackground) this.runningBackground++;
  this.observer?.onAgentStarted(record);

  const handle = new RunHandle(
    record, this.worktrees,
    options.isBackground ? () => this.finalizeBackgroundRun(record) : undefined,
  );
  handle.wireSignal(options.signal, () => this.abort(id));

  const runConfig = this.getRunConfig?.();
  record.promise = this.runner.run(snapshot, type, prompt, {
    context: { exec: this.exec, registry: this.registry, cwd: worktreeCwd, parentSession: options.parentSession },
    model: options.model, maxTurns: options.maxTurns,
    defaultMaxTurns: runConfig?.defaultMaxTurns, graceTurns: runConfig?.graceTurns,
    isolated: options.isolated, thinkingLevel: options.thinkingLevel,
    signal: record.abortController!.signal,
    onSessionCreated: (session) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const outputFile = session.sessionManager?.getSessionFile?.() ?? undefined;
      record.execution = { session, outputFile };
      this.flushPendingSteers(id, session);
      handle.attachObserver(subscribeRecordObserver(session, record, {
        onCompact: (r, info) => this.observer?.onAgentCompacted(r, info),
      }));
      options.onSessionCreated?.(session, record);
    },
  })
    .then((result) => handle.complete(result))
    .catch((err: unknown) => { handle.fail(err); return ""; });
}
```

The `.then()` and `.catch()` are one-liners.
The `onSessionCreated` callback captures only `const` references (no mutable closure state).
The `record.promise` assignment moves inline (no intermediate `const promise`).

## Module-Level Changes

| File                                    | Change                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lifecycle/worktree-state.ts`       | Add `performCleanup(worktrees, description)` method                                                                                                 |
| `src/lifecycle/agent-manager.ts`        | Add `RunHandle` class (private); add `finalizeBackgroundRun()`, `setupWorktree()`, `flushPendingSteers()` methods; rewrite `startAgent` to use them |
| `test/lifecycle/worktree-state.test.ts` | Add tests for `performCleanup`                                                                                                                      |

## Test Impact Analysis

1. **New unit tests**: `WorktreeState.performCleanup` — directly testable with a mock `WorktreeManager`.
   `RunHandle` is tested indirectly through the existing `agent-manager.test.ts` suite (929 lines, comprehensive coverage of success/error/worktree/signal/background paths).
2. **Redundant tests**: None — all existing tests exercise the same public API (`spawn`, `spawnAndWait`, `abort`, `resume`).
3. **Tests that must stay as-is**: All of `agent-manager.test.ts` — the refactoring is behavior-preserving and these tests verify every path through `RunHandle.complete()` and `RunHandle.fail()`.

## TDD Order

1. **`WorktreeState.performCleanup`** — red: test that `performCleanup` calls the manager, records the result, and returns it.
   Green: implement `performCleanup` on `WorktreeState`.
   Commit: `feat: add WorktreeState.performCleanup for self-cleanup (#216)`

2. **Use `performCleanup` in `startAgent`** — refactor both cleanup sites in `.then()` and `.catch()` to use `record.worktreeState.performCleanup()`.
   Verify: all existing agent-manager tests pass.
   Commit: `refactor: use WorktreeState.performCleanup in startAgent (#216)`

3. **Extract `finalizeBackgroundRun`** — extract the shared background finalization block.
   Add try/catch around `onAgentCompleted` (unifying the asymmetry between `.then()` and `.catch()`).
   Verify: all existing agent-manager tests pass.
   Commit: `refactor: extract finalizeBackgroundRun from startAgent (#216)`

4. **Introduce `RunHandle` and rewire `startAgent`** — add `RunHandle` class with `wireSignal`, `attachObserver`, `complete`, `fail`, `detachListeners`, `fireOnFinished`.
   Extract `setupWorktree` and `flushPendingSteers`.
   Rewrite `startAgent` to use `RunHandle`, eliminating all mutable `let` bindings.
   Verify: all existing agent-manager tests pass.
   Run `pnpm run check` to verify types.
   Commit: `refactor: introduce RunHandle lifecycle object in startAgent (#216)`

## Risks and Mitigations

1. **`complete()` throws after `fireOnFinished`** — if worktree cleanup succeeds, state transition succeeds, but `fireOnFinished` itself throws (observer error), the `.catch()` handler calls `fail()` which calls `fireOnFinished` again.
   Mitigation: `fireOnFinished` is idempotent (nulls callback after first call), and `finalizeBackgroundRun` wraps `onAgentCompleted` in try/catch.
   `AgentRecord` transition guards prevent double state transitions.

2. **`complete()` throws before state transition** — e.g., `worktrees.cleanup()` throws on the success path.
   The `.catch()` handler calls `fail()`, which marks the record as error and does best-effort worktree cleanup.
   This matches current behavior (the success-path worktree cleanup is not wrapped in try/catch today).

3. **Subtle behavior change in error-path observer notification** — current `.catch()` does not wrap `onAgentCompleted` in try/catch; `finalizeBackgroundRun` does.
   This is a minor hardening, not a behavior change — an observer throwing during error finalization would previously have prevented `drainQueue()` from running.

## Open Questions

- None — the design is straightforward and all decisions are driven by eliminating the identified smells.
