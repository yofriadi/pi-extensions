---
issue: 111
issue_title: "refactor(pi-subagents): split AgentRecord lifecycle state into phase-specific objects"
---

# Split AgentRecord lifecycle state into phase-specific objects

## Problem Statement

`AgentRecord` is constructed in `AgentManager.spawn()` before most of its state exists, then mutated across 4 files as information trickles in.
The class header documents 12 "non-transition mutable state" public fields written by `agent-manager.ts`, `service-adapter.ts`, `tools/agent-tool.ts`, and `tools/get-result-tool.ts`.

Post-construction mutation is an output-argument pattern at the object level — external code stuffs fields into a collaborator it received.
The fix is not setter methods; it is splitting along lifecycle boundaries so each object is born complete at the moment its information becomes available.

This is Phase 7, Step B in `docs/architecture/architecture.md`.

## Goals

- Split `AgentRecord`'s non-transition mutable state into phase-specific collaborators, each born complete.
- Introduce `ExecutionState` (session, promise, outputFile) — constructed once when the runner creates the session.
- Introduce `WorktreeState` (worktree info, cleanup result) — constructed once when isolation is set up; only exists for worktree agents.
- Introduce `NotificationState` (toolCallId, resultConsumed) — constructed once when agent-tool assigns the tool call ID.
- Move `pendingSteers` to a `Map<string, string[]>` on `AgentManager`, where the steer buffering is actually coordinated.
- Reduce `AgentRecordInit` from 19 optional fields to ~7 construction-time fields.
- Eliminate all post-construction field writes from external code.
- Preserve all existing behavior — this is a pure encapsulation refactor.

## Non-Goals

- Replacing `AgentManager` callbacks with an observer (#112) — deferred to Step C.
- Disambiguating `SpawnOptions` (#113) — deferred to Step D1.
- Narrowing `AgentToolDeps` or `AgentMenuDeps` (#114) — deferred to Step D2.
- Converting `createNotificationSystem` to a class (#116) — deferred to Step E2.
- Splitting `agent-tool.ts` foreground/background (#115) — deferred to Step E1.

## Background

### Who writes non-transition fields today

| Field             | Written by                                                | When                                              |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `session`         | `agent-manager.ts` (onSessionCreated, completion .then)   | Session created; run completes                    |
| `outputFile`      | `agent-manager.ts` (onSessionCreated, completion .then)   | Session created; run completes                    |
| `promise`         | `agent-manager.ts` (startAgent)                           | After runner.run() call                           |
| `worktree`        | `agent-manager.ts` (startAgent)                           | Before run, if isolation=worktree                 |
| `worktreeResult`  | `agent-manager.ts` (.then, .catch)                        | Completion/error                                  |
| `pendingSteers`   | `steer-tool.ts`, `service-adapter.ts`, `agent-manager.ts` | Queued before session; flushed on session created |
| `toolCallId`      | `tools/agent-tool.ts`                                     | After spawn, for background agents                |
| `resultConsumed`  | `tools/get-result-tool.ts`                                | When parent reads result                          |
| `abortController` | constructor only                                          | At spawn                                          |
| `toolUses`        | `record-observer.ts`                                      | On tool_execution_end event                       |
| `lifetimeUsage`   | `record-observer.ts`                                      | On message_end event                              |
| `compactionCount` | `record-observer.ts`                                      | On compaction_end event                           |

### Who reads non-transition fields

| Field                                          | Read by                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session`                                      | `agent-manager.ts` (resume, abort, cleanup), `service-adapter.ts` (steer), `steer-tool.ts`, `get-result-tool.ts`, `notification.ts`, `ui/agent-menu.ts`, `ui/conversation-viewer.ts` |
| `promise`                                      | `agent-manager.ts` (spawnAndWait, waitForAll), `get-result-tool.ts` (wait mode)                                                                                                      |
| `outputFile`                                   | `agent-tool.ts`, `notification.ts`                                                                                                                                                   |
| `worktree`                                     | `agent-manager.ts` (cleanup on completion/error)                                                                                                                                     |
| `worktreeResult`                               | `service-adapter.ts` (toSubagentRecord)                                                                                                                                              |
| `toolCallId`                                   | `notification.ts`                                                                                                                                                                    |
| `resultConsumed`                               | `index.ts` (onComplete), `notification.ts`                                                                                                                                           |
| `pendingSteers`                                | `agent-manager.ts` (flush), `steer-tool.ts`, `service-adapter.ts`                                                                                                                    |
| `abortController`                              | `agent-manager.ts` (abort, abortAll, signal passing)                                                                                                                                 |
| `toolUses`, `lifetimeUsage`, `compactionCount` | `notification.ts`, `service-adapter.ts`, `get-result-tool.ts`, `steer-tool.ts`, `agent-tool.ts`, `index.ts`, `ui/conversation-viewer.ts`                                             |

### Dependency on #110

Issue #110 (AgentActivityTracker) is implemented and merged.
The `AgentActivityTracker` class established the encapsulation pattern this issue follows: transition methods for writes, read-only accessors for reads.

### AGENTS.md constraints

- Design principle 8 (construct complete): objects should be born ready-to-go.
- Output arguments: do not write back into a received dependency bag.
- One concern per file: each new collaborator gets its own module.
- Avoid `any`: use typed accessors.
- Lift-and-shift for large test migrations: introduce new alongside old, migrate incrementally.

## Design Overview

### Lifecycle phases and their objects

```text
spawn()                    → AgentRecord (identity + status + stats + abortController)
  ↓ worktree setup         → WorktreeState (path, branch) — optional, only for isolation=worktree
  ↓ runner creates session → ExecutionState (session, promise, outputFile)
  ↓ agent-tool sets ID     → NotificationState (toolCallId, resultConsumed)
  ↓ steer before session   → pendingSteers Map on AgentManager
  ↓ run completes          → WorktreeState gains cleanupResult (immutable replacement)
```

### ExecutionState

New file: `src/execution-state.ts`.

Born when `onSessionCreated` fires inside `startAgent()`.
Contains the session, promise, and output file — the three fields that only exist once the runner creates the session.

```typescript
export interface ExecutionState {
  readonly session: AgentSession;
  readonly outputFile: string | undefined;
  readonly promise: Promise<string>;
}
```

This is a plain interface (not a class) because all fields are set at construction and never mutated.
The `promise` is set immediately after `runner.run()` returns, but the `session` and `outputFile` are known inside the `onSessionCreated` callback.
Because these become available at slightly different moments (session in callback, promise from `runner.run()` return), a two-phase construction is needed:

1. Inside `onSessionCreated`, capture `session` and `outputFile` in local variables.
2. After `runner.run()` returns the promise, construct `ExecutionState` with all three and attach it to the record.

However, the promise wraps the entire run — it resolves when the agent completes.
The `onSessionCreated` callback fires during the run.
So the timeline is: `runner.run()` is called → internally, session is created → `onSessionCreated` fires → run continues → promise resolves.
The promise is returned by `runner.run()`, so it exists before `onSessionCreated` fires only as a `Promise` variable.

In practice, we need `Promise.withResolvers()` to construct the promise shell first, then resolve it when the run completes.
The `ExecutionState` can then be constructed inside `onSessionCreated`:

```typescript
const { promise, resolve } = Promise.withResolvers<string>();

// Inside onSessionCreated:
record.execution = { session, outputFile, promise };

// runner.run() result wired to resolve:
runner.run(...).then(result => { resolve(result.responseText); ... });
```

Wait — this changes the semantics.
Currently `record.promise` is the full `.then()` chain that includes worktree cleanup, status transitions, and notification.
Callers like `spawnAndWait` and `get-result-tool` await it to wait for the agent to fully complete (including post-processing).

To preserve this, `ExecutionState.promise` should remain the full chain promise (the one currently assigned as `record.promise`).
We construct the `ExecutionState` after `runner.run()` returns, using the session/outputFile captured in `onSessionCreated`:

```typescript
let capturedSession: AgentSession | undefined;
let capturedOutputFile: string | undefined;

const runPromise = this.runner.run(snapshot, type, prompt, {
  ...
  onSessionCreated: (session) => {
    capturedSession = session;
    capturedOutputFile = session.sessionManager?.getSessionFile?.();
    // flush steers, subscribe observer, etc.
  },
}).then(({ responseText, session, ... }) => {
  // post-processing (worktree cleanup, status transitions)
  // Update session/outputFile from completion if newer
  ...
  return responseText;
});

record.execution = {
  session: capturedSession!,   // guaranteed set before .then runs
  outputFile: capturedOutputFile,
  promise: runPromise,
};
```

This has a problem: `record.execution` is set synchronously after `runner.run()` is called, but `onSessionCreated` fires asynchronously during the run.
So `capturedSession` is undefined at the point we'd assign `record.execution`.

The cleanest solution: make `execution` settable from the `onSessionCreated` callback, where the session is known, and update `promise` separately after `runner.run()` returns.
Use two fields on the record:

1. `execution?: ExecutionState` — set inside `onSessionCreated` (session + outputFile known)
2. `promise?: Promise<string>` — set after `runner.run()` returns

This keeps `promise` as a separate top-level field.
It's set once by the manager after `runner.run()`, never mutated, and only exists during execution.
The execution state (session + outputFile) is a separate concern from the completion promise.

Revised design:

```typescript
/** Execution-phase state — set when onSessionCreated fires. */
export interface ExecutionState {
  readonly session: AgentSession;
  readonly outputFile: string | undefined;
}
```

`promise` stays as a field on `AgentRecord` because it's set at a different moment (after `runner.run()` returns) and its lifecycle differs (it's the full chain including post-processing).

### WorktreeState

New file: `src/worktree-state.ts`.

Born when `startAgent()` creates the worktree (before the run begins).
Only exists for agents with `isolation: "worktree"`.

```typescript
export class WorktreeState {
  readonly path: string;
  readonly branch: string;
  private _cleanupResult?: WorktreeCleanupResult;

  constructor(info: WorktreeInfo) {
    this.path = info.path;
    this.branch = info.branch;
  }

  get cleanupResult(): WorktreeCleanupResult | undefined {
    return this._cleanupResult;
  }

  /** Record the cleanup result. Called once on completion or error. */
  recordCleanup(result: WorktreeCleanupResult): void {
    this._cleanupResult = result;
  }
}
```

This is a class (not a plain interface) because `cleanupResult` is set later — at completion/error — and we want to encapsulate that single mutation behind a method.

### NotificationState

New file: `src/notification-state.ts`.

Born when agent-tool sets the tool call ID for background agents.
Owns the two notification-tracking fields.

```typescript
export class NotificationState {
  readonly toolCallId: string;
  private _resultConsumed = false;

  constructor(toolCallId: string) {
    this.toolCallId = toolCallId;
  }

  get resultConsumed(): boolean {
    return this._resultConsumed;
  }

  /** Mark the result as consumed — suppresses the completion notification. */
  markConsumed(): void {
    this._resultConsumed = true;
  }
}
```

For foreground agents that never get a `toolCallId`, `record.notification` stays `undefined`.

### pendingSteers → Map on AgentManager

New private field on `AgentManager`:

```typescript
private pendingSteers = new Map<string, string[]>();
```

New methods:

```typescript
/** Queue a steer for an agent whose session isn't ready yet. */
queueSteer(id: string, message: string): boolean { ... }

/** Whether any steers are queued for this agent. */
hasPendingSteers(id: string): boolean { ... }
```

Flush logic stays in `onSessionCreated` but reads from the map instead of the record.
`steer-tool.ts` and `service-adapter.ts` call `manager.queueSteer()` instead of writing `record.pendingSteers`.

The steer-tool and service-adapter need a way to call `queueSteer`.
For steer-tool, the `SteerToolDeps` interface gains `queueSteer: (id: string, msg: string) => boolean`.
For service-adapter, the `AgentManagerLike` interface gains the same method.

### Stats fields (toolUses, lifetimeUsage, compactionCount)

These are written by `record-observer.ts` via direct field mutation (`record.toolUses++`, `addUsage(record.lifetimeUsage, ...)`, `record.compactionCount++`).
They are read by many consumers for display.

These remain on `AgentRecord` because they're known at spawn time (initialized to zero/empty) and accumulate over the record's lifetime.
However, the direct mutation should be encapsulated behind methods:

```typescript
/** Increment tool use count. Called by record-observer on tool_execution_end. */
incrementToolUses(): void { this._toolUses++; }

/** Accumulate usage delta. Called by record-observer on message_end. */
addUsage(delta: { input: number; output: number; cacheWrite: number }): void { ... }

/** Increment compaction count. Called by record-observer on compaction_end. */
incrementCompactions(): void { this._compactionCount++; }
```

Read access through getters: `get toolUses()`, `get lifetimeUsage()`, `get compactionCount()`.

### Revised AgentRecord shape

```typescript
export class AgentRecord {
  // Identity — set once at construction
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly invocation?: AgentInvocation;
  readonly abortController?: AbortController;

  // Status-transition state (unchanged from today)
  // ... _status, _result, _error, _startedAt, _completedAt with getters

  // Stats — initialized at construction, mutated via methods
  private _toolUses: number;
  private _lifetimeUsage: LifetimeUsage;
  private _compactionCount: number;

  // Phase-specific collaborators — each set once, born complete
  execution?: ExecutionState;
  worktreeState?: WorktreeState;
  notification?: NotificationState;
  promise?: Promise<string>;
}
```

### Revised AgentRecordInit

```typescript
export interface AgentRecordInit {
  id: string;
  type: SubagentType;
  description: string;
  status?: AgentRecordStatus;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  abortController?: AbortController;
  invocation?: AgentInvocation;
}
```

Down from 19 optional fields to 8 (plus the 3 required).
Stats fields (`toolUses`, `lifetimeUsage`, `compactionCount`) initialize to zero/empty in the constructor — no need to pass them.

### Consumer call-site changes

Callers that read `record.session` change to `record.execution?.session`.
Callers that read `record.outputFile` change to `record.execution?.outputFile`.
Callers that read `record.worktree` change to `record.worktreeState`.
Callers that read `record.worktreeResult` change to `record.worktreeState?.cleanupResult`.
Callers that read `record.toolCallId` change to `record.notification?.toolCallId`.
Callers that read `record.resultConsumed` change to `record.notification?.resultConsumed`.
Callers that write `record.resultConsumed = true` change to `record.notification?.markConsumed()`.
Callers that write `record.toolUses++` change to `record.incrementToolUses()`.
Callers that write `addUsage(record.lifetimeUsage, ...)` change to `record.addUsage(...)`.
Callers that write `record.compactionCount++` change to `record.incrementCompactions()`.

## Module-Level Changes

### New files

| File                        | What                                                   |
| --------------------------- | ------------------------------------------------------ |
| `src/execution-state.ts`    | `ExecutionState` interface (session + outputFile)      |
| `src/worktree-state.ts`     | `WorktreeState` class (path, branch, cleanupResult)    |
| `src/notification-state.ts` | `NotificationState` class (toolCallId, resultConsumed) |

### Modified source files

| File                            | What changes                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent-record.ts`           | Remove 12 public mutable fields. Add `execution?`, `worktreeState?`, `notification?`, `promise?` collaborator fields. Encapsulate stats behind methods (`incrementToolUses`, `addUsage`, `incrementCompactions`) with read-only getters. Trim `AgentRecordInit` to ~10 fields.                                                                       |
| `src/agent-manager.ts`          | Add `pendingSteers: Map<string, string[]>` and `queueSteer`/`hasPendingSteers` methods. Set `record.execution` in `onSessionCreated`. Set `record.worktreeState` in `startAgent`. Set `record.promise` after `runner.run()`. Flush steers from map. Update all `record.session`/`record.outputFile`/`record.worktree`/`record.worktreeResult` reads. |
| `src/service-adapter.ts`        | Update `steer()` to read `record.execution?.session` and call `manager.queueSteer()`. Update `toSubagentRecord()` to read from collaborators. Add `queueSteer` to `AgentManagerLike`.                                                                                                                                                                |
| `src/record-observer.ts`        | Call `record.incrementToolUses()`, `record.addUsage(...)`, `record.incrementCompactions()` instead of direct field mutation.                                                                                                                                                                                                                         |
| `src/notification.ts`           | Read `record.notification?.toolCallId`, `record.notification?.resultConsumed`, `record.execution?.session`, `record.execution?.outputFile`.                                                                                                                                                                                                          |
| `src/index.ts`                  | Read `record.notification?.resultConsumed` in onComplete.                                                                                                                                                                                                                                                                                            |
| `src/tools/agent-tool.ts`       | Create `NotificationState` and assign to `record.notification`. Read `record.execution?.outputFile`.                                                                                                                                                                                                                                                 |
| `src/tools/get-result-tool.ts`  | Call `record.notification?.markConsumed()`. Read `record.execution?.session`, `record.promise`.                                                                                                                                                                                                                                                      |
| `src/tools/steer-tool.ts`       | Call `deps.queueSteer(id, msg)` instead of writing `record.pendingSteers`. Read `record.execution?.session`. Add `queueSteer` to `SteerToolDeps`.                                                                                                                                                                                                    |
| `src/ui/agent-menu.ts`          | Read `record.execution?.session`.                                                                                                                                                                                                                                                                                                                    |
| `src/ui/conversation-viewer.ts` | Read from `record` stats via getters (no structural change since property names stay the same via getters).                                                                                                                                                                                                                                          |
| `src/types.ts`                  | Re-export `ExecutionState`, `WorktreeState`, `NotificationState`. Remove `AgentRecordInit` fields that are gone.                                                                                                                                                                                                                                     |

### Modified test files

| File                                 | What changes                                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/helpers/make-record.ts`        | Remove fields dropped from `AgentRecordInit` (session, promise, outputFile, worktree, worktreeResult, toolCallId, resultConsumed, pendingSteers, toolUses, lifetimeUsage, compactionCount). Set up collaborators where tests need them. |
| `test/agent-record.test.ts`          | Update to test new methods (`incrementToolUses`, `addUsage`, `incrementCompactions`). Remove tests for removed init fields. Add tests for collaborator attachment.                                                                      |
| `test/agent-manager.test.ts`         | Update to verify steer queueing via manager's map. Verify `record.execution` is set. Verify `record.worktreeState` is set.                                                                                                              |
| `test/record-observer.test.ts`       | Call new methods via assertions (verify `record.incrementToolUses` etc. are called, or verify `record.toolUses` value after events).                                                                                                    |
| `test/service-adapter.test.ts`       | Update `toSubagentRecord` tests to set up collaborators. Update steer tests to verify `queueSteer` call.                                                                                                                                |
| `test/notification.test.ts`          | Set up `record.notification` and `record.execution` for tests that read those fields.                                                                                                                                                   |
| `test/tools/agent-tool.test.ts`      | Verify `NotificationState` creation. Read `record.execution?.outputFile`.                                                                                                                                                               |
| `test/tools/get-result-tool.test.ts` | Call `record.notification?.markConsumed()`. Set up `record.execution` for tests.                                                                                                                                                        |
| `test/tools/steer-tool.test.ts`      | Verify `deps.queueSteer()` call instead of `record.pendingSteers` write. Set up `record.execution`.                                                                                                                                     |
| `test/ui/agent-menu.test.ts`         | Set up `record.execution` for session-dependent tests.                                                                                                                                                                                  |
| `test/conversation-viewer.test.ts`   | Verify stats accessed via getters (likely no structural change).                                                                                                                                                                        |
| `test/usage.test.ts`                 | No change expected (tests `addUsage` and `getSessionContextPercent` directly).                                                                                                                                                          |

### Removed from AgentRecord

| Symbol                           | Replaced by                                        |
| -------------------------------- | -------------------------------------------------- |
| `session` (public field)         | `execution?.session`                               |
| `outputFile` (public field)      | `execution?.outputFile`                            |
| `worktree` (public field)        | `worktreeState` (WorktreeState)                    |
| `worktreeResult` (public field)  | `worktreeState?.cleanupResult`                     |
| `toolCallId` (public field)      | `notification?.toolCallId`                         |
| `resultConsumed` (public field)  | `notification?.resultConsumed` / `.markConsumed()` |
| `pendingSteers` (public field)   | `AgentManager.pendingSteers` Map                   |
| `toolUses` (public field)        | `get toolUses()` + `incrementToolUses()`           |
| `lifetimeUsage` (public field)   | `get lifetimeUsage()` + `addUsage()`               |
| `compactionCount` (public field) | `get compactionCount()` + `incrementCompactions()` |

Grep verification: all 12 non-transition mutable fields and their usage sites across `src/` and `test/` are accounted for in the file lists above.

## Test Impact Analysis

### New unit tests enabled

1. `WorktreeState` — `recordCleanup` method, read-only `path`/`branch`, `cleanupResult` accessor.
2. `NotificationState` — `markConsumed` transition, `toolCallId` immutability, initial `resultConsumed` is false.
3. `ExecutionState` — interface only (no class), tested implicitly via AgentRecord attachment.
4. `AgentRecord.incrementToolUses/addUsage/incrementCompactions` — unit tests for stat accumulation methods that were previously untestable without going through `record-observer.ts` + a mock session.
5. `AgentManager.queueSteer/hasPendingSteers` — steer buffering logic now testable in isolation.

### Existing tests that simplify

- `test/helpers/make-record.ts` — the factory drops from ~12 default fields to ~6, since stats initialize to zero internally and collaborators are set up only where needed.
- `test/record-observer.test.ts` — assertions can verify method calls (`incrementToolUses`, `addUsage`, `incrementCompactions`) or resulting values through getters.
  The tests become cleaner because the mutation contract is explicit.

### Existing tests that stay as-is

- `test/agent-record.test.ts` — status-transition tests (`markRunning`, `markCompleted`, etc.) are unchanged since that part of AgentRecord is not being modified.
- `test/usage.test.ts` — tests the `addUsage` utility function directly, not through AgentRecord.
- `test/ui/agent-activity-tracker.test.ts` — tests the activity tracker, which is unrelated to this change.

## TDD Order

### 1. Add WorktreeState class with unit tests

New file: `src/worktree-state.ts` with `WorktreeState` class.
New test file: `test/worktree-state.test.ts` — constructor from `WorktreeInfo`, read-only `path`/`branch`, `recordCleanup` sets `cleanupResult`, `cleanupResult` starts undefined.

Commit: `feat: add WorktreeState class (#111)`

### 2. Add NotificationState class with unit tests

New file: `src/notification-state.ts` with `NotificationState` class.
New test file: `test/notification-state.test.ts` — constructor sets `toolCallId`, `resultConsumed` starts false, `markConsumed` sets it true.

Commit: `feat: add NotificationState class (#111)`

### 3. Add ExecutionState interface

New file: `src/execution-state.ts` with `ExecutionState` interface.
No test file needed (interface only).

Commit: `feat: add ExecutionState interface (#111)`

### 4. Encapsulate stats on AgentRecord (lift phase)

Add private `_toolUses`, `_lifetimeUsage`, `_compactionCount` with getters and mutation methods (`incrementToolUses`, `addUsage`, `incrementCompactions`).
Keep the old public fields as aliases during migration (or remove them and update callers in the same step — since `record-observer.ts` is the only writer and the tools/notification are read-only consumers, a single step works).

Update `record-observer.ts` to call the new methods.
Update `test/agent-record.test.ts` to cover the new methods.
Update `test/record-observer.test.ts` to verify via getters.
Update `test/helpers/make-record.ts` to remove `toolUses`, `lifetimeUsage`, `compactionCount` from defaults (they auto-initialize to zero).

Run `pnpm run check` to catch any remaining direct field writes.

Commit: `refactor: encapsulate stats fields on AgentRecord (#111)`

### 5. Add collaborator fields to AgentRecord (lift phase)

Add `execution?: ExecutionState`, `worktreeState?: WorktreeState`, `notification?: NotificationState` fields to `AgentRecord`.
Keep old fields (`session`, `outputFile`, `worktree`, `worktreeResult`, `toolCallId`, `resultConsumed`, `pendingSteers`) for now — both old and new coexist.

Update `AgentRecordInit` to accept the new optional fields.
Update `test/helpers/make-record.ts` as needed.

Commit: `refactor: add phase-specific collaborator fields to AgentRecord (#111)`

### 6. Migrate AgentManager to use WorktreeState

In `startAgent()`, construct `WorktreeState` instead of setting `record.worktree`.
In `.then()` and `.catch()`, call `record.worktreeState.recordCleanup()` instead of setting `record.worktreeResult`.
Read `record.worktreeState` instead of `record.worktree` for cleanup logic.

Update `test/agent-manager.test.ts` for worktree-related assertions.

Commit: `refactor: migrate AgentManager to WorktreeState (#111)`

### 7. Migrate AgentManager to use ExecutionState

In `onSessionCreated`, construct `ExecutionState` and set `record.execution`.
After `runner.run()`, set `record.promise` (kept separate from ExecutionState).
In `.then()`, update `record.execution` with final session/outputFile if changed.
Update all `record.session` reads in `agent-manager.ts` to `record.execution?.session`.

Update `test/agent-manager.test.ts` for execution-state assertions.

Commit: `refactor: migrate AgentManager to ExecutionState (#111)`

### 8. Move pendingSteers to AgentManager

Add `pendingSteers: Map<string, string[]>` and `queueSteer(id, msg)`/`hasPendingSteers(id)` to `AgentManager`.
Flush steers from the map in `onSessionCreated` instead of reading `record.pendingSteers`.
Remove `record.pendingSteers` field.

Update `steer-tool.ts` and `service-adapter.ts` to call `queueSteer` via their deps interfaces.
Update `SteerToolDeps` and `AgentManagerLike` interfaces.
Update `test/agent-manager.test.ts`, `test/tools/steer-tool.test.ts`, `test/service-adapter.test.ts`.

Commit: `refactor: move pendingSteers to AgentManager (#111)`

### 9. Migrate agent-tool to use NotificationState

After `manager.spawn()` for background agents, create `NotificationState(toolCallId)` and assign to `record.notification`.
Read `record.execution?.outputFile` instead of `record.outputFile`.

Update `test/tools/agent-tool.test.ts`.

Commit: `refactor: migrate agent-tool to NotificationState (#111)`

### 10. Migrate get-result-tool, notification, and index.ts

Update `get-result-tool.ts`: read `record.execution?.session`, `record.promise`, call `record.notification?.markConsumed()`.
Update `notification.ts`: read `record.notification?.toolCallId`, `record.notification?.resultConsumed`, `record.execution?.session`, `record.execution?.outputFile`.
Update `index.ts`: read `record.notification?.resultConsumed` in onComplete.

Update `test/tools/get-result-tool.test.ts`, `test/notification.test.ts`.

Commit: `refactor: migrate notification consumers to phase-specific state (#111)`

### 11. Migrate remaining consumers (steer-tool UI, agent-menu, service-adapter, conversation-viewer)

Update `steer-tool.ts`: read `record.execution?.session`.
Update `ui/agent-menu.ts`: read `record.execution?.session`.
Update `ui/conversation-viewer.ts`: stats accessed via getters (likely no change needed since getter names match old field names).
Update `service-adapter.ts`: `toSubagentRecord()` reads from collaborators; `steer()` reads `record.execution?.session`.

Update corresponding test files.

Commit: `refactor: migrate remaining consumers to phase-specific state (#111)`

### 12. Remove old fields and trim AgentRecordInit

Remove `session`, `outputFile`, `worktree`, `worktreeResult`, `toolCallId`, `resultConsumed`, `pendingSteers` from `AgentRecord` and `AgentRecordInit`.
Remove `toolUses`, `lifetimeUsage`, `compactionCount` from `AgentRecordInit` (they auto-initialize).

Run `pnpm run check` to verify no remaining references.
Run full test suite.

Update `src/types.ts` re-exports if needed.

Commit: `refactor: remove legacy fields from AgentRecord, trim AgentRecordInit (#111)`

## Risks and Mitigations

| Risk                                                                                                                                  | Mitigation                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record.execution` is undefined before `onSessionCreated` fires — callers that read `record.session` without null-checking will break | All current read sites already use optional chaining or guard checks (`if (!record.session)` etc.). Changing to `record.execution?.session` preserves the same null-safety. Grep all read sites to verify.                        |
| `promise` kept as a separate field rather than inside `ExecutionState` adds a conceptual split                                        | Documented in design: the promise is the full post-processing chain, set at a different moment than the session. Keeping it separate avoids lifecycle confusion. The field count on AgentRecord still drops from 12 to 5.         |
| Lift-and-shift creates a window where both old and new fields coexist                                                                 | Each step migrates writers and readers together; the old field is removed in the final cleanup step. `pnpm run check` after each step catches stale references.                                                                   |
| `NotificationState` is undefined for foreground agents — code that unconditionally reads `record.toolCallId` will get undefined       | Today `toolCallId` is already optional (`toolCallId?: string`). All read sites already handle undefined. `record.notification?.toolCallId` has the same semantics.                                                                |
| Test factory (`make-record.ts`) changes break many test files at once                                                                 | Step 4 updates the factory and all test files that construct records with stats fields. Steps 5-11 update test files incrementally per-collaborator. No single step rewrites all tests.                                           |
| `WorktreeState.recordCleanup` is a post-construction mutation                                                                         | It's encapsulated behind a single method on the owning object. The alternative (immutable replacement) would require re-attaching a new `WorktreeState` to the record on cleanup, which is more disruptive for the same semantic. |

## Open Questions

- Whether `record.execution` should be writable once via a `setExecution()` method or simply a public assignable field.
  Leaning toward public field for simplicity since it's set exactly once and the constructor-complete principle applies to the *collaborator* (ExecutionState), not the field that holds it.
  Revisit if more than one site needs to write it.
- Whether `record.promise` should move into `ExecutionState` in a follow-up once the timing concern is resolved (e.g., by using `Promise.withResolvers`).
  Not blocking for this issue — the field count reduction is still significant.
