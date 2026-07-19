---
issue: 229
issue_title: "Agent born complete: Agent.run() absorbs startAgent (Phase 15, Step 4)"
---

# Agent born complete — Agent.run() absorbs startAgent

## Problem Statement

`AgentManager.startAgent()` orchestrates the entire agent execution lifecycle on behalf of the agent.
The manager reaches into Agent 10 times across `spawn()` + `startAgent()`: writing `notification` and `execution` after construction, passing its own deps as method arguments, wiring callbacks through three layers, and calling completion methods with its own state.
Agent cannot run itself — it depends on the manager to push it through every phase.

The `onSessionCreated` callback threads through `AgentSpawnConfig` → `startAgent` → `RunOptions` → runner, crossing four module boundaries just to deliver a session reference to the tool boundary.

## Goals

- Agent receives `runner`, `worktrees`, and a lifecycle observer at construction — born complete with all dependencies.
- `Agent.run()` encapsulates the full execution lifecycle: worktree setup, runner invocation, session-creation handling, observer wiring, worktree cleanup, and status transitions.
- Delete `AgentManager.startAgent()`, `SpawnArgs`, and `onSessionCreated` from `AgentSpawnConfig`.
- Zero post-construction writes from `AgentManager` to Agent (`notification`, `execution`, `promise` all set internally).
- Move `ParentSessionInfo` and `CompactionInfo` out of `agent-manager.ts` to break the type-import cycle that would arise from `agent.ts` importing from `agent-manager.ts`.
- Worktree failures propagate through the async error surface (uniform with all other run errors).

## Non-Goals

- Extracting `ConcurrencyQueue` from `AgentManager` — deferred to #230.
- Adding `Agent.resume()` — deferred to #232.
- Removing scheduling fields from `AgentManager` (queue, runningBackground, drainQueue) — deferred to #230.
- Changing `agent-runner.ts` internals — the runner's `RunOptions.onSessionCreated` callback stays; Agent is the caller now instead of the manager.
- Restructuring `AgentInit` into nested sub-objects (identity/config/deps) — this plan adds optional fields alongside existing ones to minimize test churn; a follow-up can tighten the interface.

## Background

### Prerequisites (complete)

- Issue #227 (Agent with behavior) — moved abort, steer buffering, worktree setup, `completeRun`/`failRun` from manager to Agent. ✅
- Issue #228 (async startAgent) — converted `startAgent` to async/await, eliminated `.then()`/`.catch()`. ✅
- Issue #231 (runner self-contained) — moved `exec` and `registry` to `ConcreteAgentRunner` construction. ✅

### Key modules

| Module                  | Role                                     | Change                                                |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `agent.ts`              | Status machine + per-agent behavior      | Gains `run()`, lifecycle observer, run-config fields  |
| `agent-manager.ts`      | Collection + concurrency + orchestration | Loses `startAgent`, `SpawnArgs`; `spawn()` simplified |
| `agent-runner.ts`       | Session orchestration                    | Imports `ParentSessionInfo` from new location         |
| `background-spawner.ts` | Tool boundary for background spawn       | `onSessionCreated` → `observer` field                 |
| `foreground-runner.ts`  | Tool boundary for foreground spawn       | `onSessionCreated` → `observer` field                 |
| `record-observer.ts`    | Session event → Agent stats              | Imports `CompactionInfo` from new location            |

### Constraint: biome/eslint conflict

Per AGENTS.md, when both linters run on the same file, restructure code to eliminate assertions entirely with explicit `if` guards.

## Design Overview

### AgentLifecycleObserver interface

A per-agent observer created by `AgentManager` and passed to `Agent` at construction.
Replaces the scattered callback mechanisms (`onRunFinished`, `onSessionCreated`, `onCompact`).

```typescript
/** Per-agent lifecycle observer — created by AgentManager for each spawn. */
interface AgentLifecycleObserver {
  /** Fires when the agent transitions to running (inside run(), after markRunning). */
  onStarted?(agent: Agent): void;
  /** Fires when the runner creates the session — delivers the session to external consumers. */
  onSessionCreated?(agent: Agent, session: AgentSession): void;
  /** Fires once when the run completes or fails (for concurrency drain). */
  onRunFinished?(agent: Agent): void;
  /** Fires on compaction events during the run. */
  onCompacted?(agent: Agent, info: CompactionInfo): void;
}
```

All methods are optional — manager composes only the callbacks needed per agent.

### Agent constructor changes

New optional fields on `AgentInit` (alongside existing identity + status fields):

```typescript
interface AgentInit {
  // ... existing identity + status fields unchanged ...

  // Shared deps (new — required for run(), optional for tests)
  runner?: AgentRunner;
  worktrees?: WorktreeManager;
  observer?: AgentLifecycleObserver;
  getRunConfig?: () => RunConfig;

  // Run config (new — required for run(), optional for tests)
  snapshot?: ParentSnapshot;
  prompt?: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  isolation?: IsolationMode;
  parentSession?: ParentSessionInfo;
  isBackground?: boolean;
  signal?: AbortSignal;
}
```

Fields are optional so existing tests that only test status transitions and steer buffering continue to work unchanged.
`Agent.run()` guards on the required fields (`runner`, `snapshot`, `prompt`) and throws if missing.

Agent creates its own `AbortController` in the constructor (not passed in).
Agent creates its own `NotificationState` from `parentSession?.toolCallId` in the constructor (no external write).

### Agent.run() sketch

```typescript
async run(): Promise<void> {
  if (!this.runner || !this.snapshot) {
    throw new Error("Agent not configured for execution — missing runner or snapshot");
  }
  this.markRunning(Date.now());
  this.observer?.onStarted?.(this);
  this.wireSignal(this._signal, () => this.abort());

  try {
    this.setupWorktree();  // internal, uses this.worktrees + this.isolation
  } catch (err) {
    this.markError(err);
    this.observer?.onRunFinished?.(this);
    return;
  }

  const runConfig = this._getRunConfig?.();
  try {
    const result = await this.runner.run(this.snapshot, this.type, this._prompt, {
      context: { cwd: this.worktreeState?.path, parentSession: this._parentSession },
      model: this._model,
      maxTurns: this._maxTurns,
      defaultMaxTurns: runConfig?.defaultMaxTurns,
      graceTurns: runConfig?.graceTurns,
      isolated: this._isolated,
      thinkingLevel: this._thinkingLevel,
      signal: this.abortController!.signal,
      onSessionCreated: (session) => {
        const outputFile = session.sessionManager?.getSessionFile?.() ?? undefined;
        this.execution = { session, outputFile };
        this.flushPendingSteers(session);
        this.attachObserver(subscribeAgentObserver(session, this, {
          onCompact: (r, info) => this.observer?.onCompacted?.(r, info),
        }));
        this.observer?.onSessionCreated?.(this, session);
      },
    });
    this.completeRun(result);
  } catch (err) {
    this.failRun(err);
  }
}
```

### AgentManager.spawn() — after

```typescript
spawn(snapshot, type, prompt, options): string {
  const id = randomUUID().slice(0, 17);

  const compositeObserver = this.buildObserver(options);

  const record = new Agent({
    id, type,
    description: options.description,
    status: options.isBackground ? "queued" : "running",
    startedAt: Date.now(),
    invocation: options.invocation,
    // Run config
    snapshot, prompt,
    model: options.model,
    maxTurns: options.maxTurns,
    isolated: options.isolated,
    thinkingLevel: options.thinkingLevel,
    isolation: options.isolation,
    parentSession: options.parentSession,
    isBackground: options.isBackground,
    signal: options.signal,
    // Shared deps
    runner: this.runner,
    worktrees: this.worktrees,
    observer: compositeObserver,
    getRunConfig: this.getRunConfig,
  });
  this.agents.set(id, record);

  if (options.isBackground) this.observer?.onAgentCreated(record);

  if (options.isBackground && !options.bypassQueue
      && this.runningBackground >= this._getMaxConcurrent()) {
    this.queue.push(id);
    return id;
  }

  record.promise = record.run();
  return id;
}
```

### Observer composition — `buildObserver`

```typescript
private buildObserver(options: AgentSpawnConfig): AgentLifecycleObserver {
  return {
    onStarted: (agent) => {
      if (options.isBackground) this.runningBackground++;
      this.observer?.onAgentStarted(agent);
    },
    onSessionCreated: options.observer?.onSessionCreated,
    onRunFinished: (agent) => {
      if (options.isBackground) this.finalizeBackgroundRun(agent);
    },
    onCompacted: (agent, info) => {
      this.observer?.onAgentCompacted(agent, info);
    },
  };
}
```

### AgentSpawnConfig changes

```typescript
export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  parentSession?: ParentSessionInfo;
  /** Per-agent lifecycle observer — replaces onSessionCreated callback. */
  observer?: AgentLifecycleObserver;
  // DELETED: onSessionCreated
}
```

### Queue simplification

The queue changes from `{ id: string; args: SpawnArgs }[]` to `string[]` (agent IDs only).
`drainQueue` calls `record.run()` directly:

```typescript
private drainQueue() {
  while (this.queue.length > 0 && this.runningBackground < this._getMaxConcurrent()) {
    const id = this.queue.shift()!;
    const record = this.agents.get(id);
    if (record?.status !== "queued") continue;
    record.promise = record.run();
  }
}
```

The `setupWorktree` call and error handling in `drainQueue` are subsumed by `Agent.run()`.
Worktree errors propagate through the promise and surface on `record.error` via `Agent.run()`'s internal `catch` → `markError` → `observer.onRunFinished`.

### Error surface change

The synchronous-throw contract for worktree failure in `spawn()` is replaced by a uniform async error surface:

- `spawn()` never throws (no `setupWorktree` call; Agent.run() handles it internally).
- Background worktree failures surface as `record.error` via `get_subagent_result` and `/agents`.
- Foreground worktree failures surface when `spawnAndWait` awaits the promise and checks `record.status`.
- The try/catch in `background-spawner.ts` around `manager.spawn()` becomes unreachable for worktree errors but is retained for future-proofing.

### Type relocation

`ParentSessionInfo` and `CompactionInfo` move from `agent-manager.ts` to `types.ts` to break the circular type-import that would otherwise arise (`agent-manager.ts` imports `Agent` from `agent.ts`; `agent.ts` would import `ParentSessionInfo` from `agent-manager.ts`).

### Tool-layer changes

`background-spawner.ts` and `foreground-runner.ts` replace `onSessionCreated` callback with `observer` field:

```typescript
// Before (background-spawner)
onSessionCreated: (session) => {
  bgState.setSession(session);
  subscribeUIObserver(session, bgState);
},

// After
observer: {
  onSessionCreated: (_agent, session) => {
    bgState.setSession(session);
    subscribeUIObserver(session, bgState);
  },
},
```

The `foreground-runner.ts` `onSessionCreated(session, record)` becomes `observer.onSessionCreated(agent, session)` — the parameters swap order (agent first for observer consistency) and `record` becomes `agent`.

### completeRun / failRun signature change

These methods currently accept `worktrees: WorktreeManager` as a parameter (output-argument pattern inherited from the pre-#227 era).
Agent now owns `worktrees`, so the parameter is removed:

```typescript
// Before
completeRun(result: RunResult, worktrees: WorktreeManager): void { ... }
failRun(err: unknown, worktrees: WorktreeManager): void { ... }

// After
completeRun(result: RunResult): void { ... }  // uses this.worktrees internally
failRun(err: unknown): void { ... }           // uses this.worktrees internally
```

These methods also fire `this.observer?.onRunFinished?.(this)` instead of the old `fireOnRunFinished()` callback.
The `setOnRunFinished`, `_onRunFinished`, and `fireOnRunFinished` private members are deleted.

### setupWorktree signature change

`setupWorktree` currently accepts `(worktrees, isolation)` as parameters.
It becomes a private no-arg method using `this.worktrees` and `this._isolation` internally.

## Module-Level Changes

### `src/types.ts`

- Add `ParentSessionInfo` interface (moved from `agent-manager.ts`).
- Add `CompactionInfo` type (moved from `agent-manager.ts`).

### `src/lifecycle/agent.ts`

- Add `AgentLifecycleObserver` interface export.
- Expand `AgentInit` with optional run-config and deps fields: `runner`, `worktrees`, `observer`, `getRunConfig`, `snapshot`, `prompt`, `model`, `maxTurns`, `isolated`, `thinkingLevel`, `isolation`, `parentSession`, `isBackground`, `signal`.
- Remove `abortController` from `AgentInit` — Agent creates its own.
- Remove `promise` from `AgentInit` — set internally by `run()`.
- Store new fields as private readonly properties in the constructor.
- Create `AbortController` in constructor.
- Create `NotificationState` from `parentSession?.toolCallId` in constructor.
- Add `async run(): Promise<void>` method — absorbs the full `startAgent` logic.
- Change `setupWorktree` from public to private, remove parameters (uses own fields).
- Change `completeRun(result, worktrees)` → `completeRun(result)` (uses own fields).
- Change `failRun(err, worktrees)` → `failRun(err)` (uses own fields).
- Delete `setOnRunFinished`, `_onRunFinished`, `fireOnRunFinished` — replaced by observer.
- Import `subscribeAgentObserver` and `RunResult` types.
- Import `ParentSessionInfo`, `CompactionInfo` from `types.ts` (not `agent-manager.ts`).

### `src/lifecycle/agent-manager.ts`

- Remove `ParentSessionInfo` export (moved to `types.ts`; re-export for backward compat).
- Remove `CompactionInfo` export (moved to `types.ts`; re-export for backward compat).
- Delete `startAgent` private method.
- Delete `SpawnArgs` interface.
- Rewrite `spawn()` to create complete Agent with all deps and config, call `record.run()`.
- Remove `record.notification = ...` external write (Agent creates its own).
- Add private `buildObserver(options)` method to compose per-agent lifecycle observer.
- Simplify queue from `{ id: string; args: SpawnArgs }[]` to `string[]`.
- Simplify `drainQueue()` to call `record.run()` (no `setupWorktree`, no `startAgent`, no error catch).
- Remove `onSessionCreated` from `AgentSpawnConfig`, add `observer?: AgentLifecycleObserver`.
- Remove `import { subscribeAgentObserver }` (no longer used here).
- Remove `import { NotificationState }` (no longer used here).

### `src/lifecycle/agent-runner.ts`

- Change import of `ParentSessionInfo` from `#src/lifecycle/agent-manager` to `#src/types`.

### `src/observation/record-observer.ts`

- Change import of `CompactionInfo` from `#src/lifecycle/agent-manager` to `#src/types`.

### `src/tools/background-spawner.ts`

- Change import: remove `AgentSpawnConfig` (if no longer needed) or update as needed.
- Import `ParentSessionInfo` from `#src/types` (if source changes).
- Replace `onSessionCreated` callback with `observer` field in spawn call.
- The `BackgroundManagerDeps.spawn()` signature updates to match new `AgentSpawnConfig`.

### `src/tools/foreground-runner.ts`

- Replace `onSessionCreated` callback with `observer` field.
- Update parameter destructuring: `(session, record)` → `(agent, session)`.
- Import `ParentSessionInfo` from `#src/types`.
- The `ForegroundManagerDeps.spawnAndWait()` signature updates to match new config.

### `src/tools/agent-tool.ts`

- Import `ParentSessionInfo` from `#src/types` instead of `#src/lifecycle/agent-manager`.
- Update `AgentToolManager` interface if `AgentSpawnConfig` shape changed.

### `src/service/service-adapter.ts`

- No significant changes — `AgentManagerLike.spawn()` already accepts `unknown` options.

### `test/lifecycle/agent.test.ts`

- Add test suite for `Agent.run()` covering: full lifecycle, worktree setup, session creation, observer notifications, error handling, abort signal wiring.
- Update existing tests that use `completeRun(result, worktrees)` → `completeRun(result)`.
- Update existing tests that use `failRun(err, worktrees)` → `failRun(err)`.
- Update existing tests that use `setupWorktree(worktrees, isolation)` → remove (now private).
- Remove tests for `setOnRunFinished` / `fireOnRunFinished`.
- Update `AgentInit` usages that pass `abortController` — Agent creates its own.

### `test/lifecycle/agent-manager.test.ts`

- Remove/rewrite `onSessionCreated callback receives record` describe block — callback is deleted.
- Remove/rewrite `toolCallId notification wiring` tests — notification is now Agent-internal.
- Update `execution state` tests — execution is set internally by Agent.run(), not by the manager's `onSessionCreated`.
- Update mock runner stubs: runner mock should still fire `onSessionCreated` (Agent passes it to the runner).
- Update tests that inspect `runner.run()` call args for the `onSessionCreated` field.
- Update queue-related tests to reflect simplified queue (IDs only).

### `test/helpers/manager-stubs.ts`

- Update `createSessionRunner` — it fires `opts.onSessionCreated` which is now called by Agent.run() internally; the mock pattern stays similar but the caller changes.

### `test/tools/background-spawner.test.ts`

- Update spawn call to use `observer` instead of `onSessionCreated`.
- Update assertions that inspect the spawn options for `onSessionCreated`.

### `test/tools/foreground-runner.test.ts`

- Update `onSessionCreated` usage to `observer.onSessionCreated`.
- Update parameter order in callback assertions: `(agent, session)` instead of `(session, record)`.

### `test/helpers/make-agent.ts`

- Remove `abortController` from the factory default (if present) — Agent creates its own.
- No other changes needed — run-config fields are optional.

### `packages/pi-subagents/docs/architecture/architecture.md`

- Update Step 4 status from planned to complete.
- Update the file layout listing for `agent.ts` and `agent-manager.ts` descriptions.
- Mark `SpawnArgs` and `startAgent` as deleted in the listing.

## Test Impact Analysis

1. **New unit tests enabled by extraction:**
   - `Agent.run()` can be tested in isolation with mock runner and worktrees — no need for the full `AgentManager` + queue + concurrency infrastructure.
   - Lifecycle observer callbacks can be tested directly on a single Agent instance.
   - Worktree error handling in `run()` can be tested without the manager's `spawn()` error-recovery logic.

2. **Existing tests that become redundant:**
   - `AgentManager — onSessionCreated callback receives record` — the callback mechanism is deleted.
   - `AgentManager — toolCallId notification wiring` — Agent now creates its own `NotificationState`; manager-level tests for this become Agent-level tests.
   - Some `agent-manager.test.ts` tests that indirectly test execution/observer wiring can be simplified to verify that `agent.run()` is called (delegation test) rather than re-testing the internal lifecycle.

3. **Existing tests that stay as-is:**
   - Queue/concurrency tests in `agent-manager.test.ts` — these test manager-level scheduling, not run internals.
   - `record-observer.test.ts` — observer logic unchanged; only import path changes.
   - `agent-runner.test.ts` — runner internals unchanged.
   - Status transition tests in `agent.test.ts` — Agent status machine unchanged.
   - `background-spawner.test.ts` / `foreground-runner.test.ts` — updated for observer pattern but same behavioral coverage.

## TDD Order

1. **Move `ParentSessionInfo` and `CompactionInfo` to `types.ts`.**
   Add both to `types.ts`.
   Re-export from `agent-manager.ts` for backward compat.
   Update `agent-runner.ts` and `record-observer.ts` imports to use `types.ts`.
   Verify all existing tests pass.
   Commit: `refactor: move ParentSessionInfo and CompactionInfo to types.ts (#229)`

2. **Add `AgentLifecycleObserver` interface to `agent.ts`.**
   Define and export the interface with optional `onStarted`, `onSessionCreated`, `onRunFinished`, `onCompacted` methods.
   No behavioral changes — just the type definition.
   Commit: `feat: add AgentLifecycleObserver interface (#229)`

3. **Expand `AgentInit` with run-config and deps fields; Agent stores them.**
   Add optional fields to `AgentInit`: `runner`, `worktrees`, `observer`, `getRunConfig`, `snapshot`, `prompt`, `model`, `maxTurns`, `isolated`, `thinkingLevel`, `isolation`, `parentSession`, `isBackground`, `signal`.
   Agent stores them as private properties in the constructor.
   Agent creates its own `AbortController` in the constructor.
   Agent creates `NotificationState` from `parentSession?.toolCallId` in the constructor.
   Remove `abortController` from `AgentInit` (Agent creates its own).
   Update `createTestAgent` helper and `agent.test.ts` to remove `abortController` from init; tests that need abort can use `record.abortController` directly.
   Write tests: constructor stores deps and run config; constructor creates AbortController; constructor creates NotificationState when toolCallId present; constructor does not create NotificationState when toolCallId absent.
   Commit: `feat: expand AgentInit with run-config, deps, and self-created AbortController (#229)`

4. **Change `setupWorktree` to private, remove parameters.**
   Make `setupWorktree` a private method that uses `this.worktrees` and `this._isolation`.
   Update `AgentManager.spawn()` and `drainQueue()` call sites: `record.setupWorktree(this.worktrees, options.isolation)` → remove (will be called by `run()`).
   Temporarily call `setupWorktree` from the manager's `spawn` path (keep the old call pattern working until `run()` is added in step 6).
   Update `agent.test.ts` tests that called `setupWorktree` directly — convert to testing via `run()` or remove if redundant.
   Commit: `refactor: make setupWorktree private, remove parameters (#229)`

5. **Change `completeRun`/`failRun` to use own `worktrees`; replace `fireOnRunFinished` with observer.**
   Remove `worktrees` parameter from `completeRun` and `failRun`.
   Replace `fireOnRunFinished()` with `this.observer?.onRunFinished?.(this)`.
   Delete `setOnRunFinished`, `_onRunFinished`, `fireOnRunFinished`.
   Update `agent-manager.ts`: stop calling `record.setOnRunFinished(...)`, stop passing `this.worktrees` to `completeRun`/`failRun`.
   Update all `agent.test.ts` tests that call `completeRun(result, worktrees)` and `failRun(err, worktrees)`.
   Update `agent-manager.test.ts` tests that verify `setOnRunFinished` or concurrency drain — drain now works via the observer's `onRunFinished`.
   Write test: `completeRun` calls `observer.onRunFinished`; `failRun` calls `observer.onRunFinished`.
   Commit: `refactor: remove worktrees param from completeRun/failRun, replace fireOnRunFinished with observer (#229)`

6. **Add `Agent.run()` method — absorbs `startAgent` logic.**
   Implement `Agent.run()` following the design sketch above.
   Write tests for `Agent.run()`:
   - Happy path: run completes, status transitions, observer callbacks fire in order.
   - Session creation: execution state set, steers flushed, record-observer attached.
   - Worktree setup and cleanup on success.
   - Worktree setup failure: markError + observer.onRunFinished.
   - Runner error: failRun + observer.onRunFinished.
   - Abort signal forwarding.
   - RunConfig threading (defaultMaxTurns, graceTurns).
   Commit: `feat: add Agent.run() encapsulating full execution lifecycle (#229)`

7. **Rewrite `AgentManager.spawn()` to create complete Agent and call `agent.run()`.**
   Delete `startAgent`.
   Delete `SpawnArgs`.
   Add `buildObserver` private method.
   Rewrite `spawn()` to construct Agent with all fields, call `record.run()`.
   Remove `record.notification = ...` external write.
   Remove `subscribeAgentObserver` and `NotificationState` imports.
   Simplify queue from `{ id: string; args: SpawnArgs }[]` to `string[]`.
   Simplify `drainQueue()` to call `record.run()`.
   Replace `onSessionCreated` with `observer` on `AgentSpawnConfig`.
   Update `agent-manager.test.ts`:
   - Remove `onSessionCreated callback receives record` tests.
   - Update notification wiring tests (now Agent-internal).
   - Update mock runners if needed.
   - Verify queue/concurrency tests still pass.
   Commit: `feat!: AgentManager.spawn() creates complete Agent, deletes startAgent (#229)`

8. **Update tool-layer consumers: `background-spawner.ts`, `foreground-runner.ts`, `agent-tool.ts`.**
   Replace `onSessionCreated` callback with `observer` field in both spawner and runner.
   Update `foreground-runner.ts` callback: `(session, record)` → `(agent, session)`.
   Update `agent-tool.ts` imports: `ParentSessionInfo` from `#src/types`.
   Update narrow manager interfaces (`BackgroundManagerDeps`, `ForegroundManagerDeps`, `AgentToolManager`) to reflect new `AgentSpawnConfig` shape.
   Update `background-spawner.test.ts` and `foreground-runner.test.ts`.
   Commit: `refactor: update tool layer to use lifecycle observer instead of onSessionCreated (#229)`

9. **Remove backward-compat re-exports and update architecture docs.**
   Remove `ParentSessionInfo` and `CompactionInfo` re-exports from `agent-manager.ts` (if no external consumer depends on the old location).
   Update `docs/architecture/architecture.md`: mark Step 4 complete, update file listings.
   Commit: `docs: mark Phase 15 Step 4 complete, update architecture (#229)`

## Risks and Mitigations

1. **Large test surface.**
   `agent.test.ts` (684 lines) and `agent-manager.test.ts` (815 lines) both need significant updates.
   Mitigation: Lift-and-shift approach — new fields are optional on `AgentInit`, so most existing tests compile unchanged.
   Only tests that touch `completeRun`, `failRun`, `setupWorktree`, `setOnRunFinished`, `abortController`, or `onSessionCreated` need updating.

2. **Breaking change for `AgentSpawnConfig` consumers.**
   `onSessionCreated` is deleted.
   The `service-adapter.ts` and cross-extension consumers that pass `AgentSpawnConfig` may need updates.
   Mitigation: `service-adapter.ts` passes `unknown` for options — no compile error.
   The `observer` field is optional, so consumers that don't use `onSessionCreated` are unaffected.

3. **Async worktree error surface changes tool-layer behavior.**
   `background-spawner.ts` catch block around `manager.spawn()` becomes unreachable for worktree errors.
   Mitigation: Keep the catch block for other potential errors; the agent's error status surfaces the worktree failure message to users.

4. **`AgentInit` grows wide (15+ optional fields).**
   Mitigation: Fields are optional with sensible defaults.
   Follow-up #230 may restructure Agent's constructor (ConcurrencyQueue changes may motivate nesting).
   Tracked as a known smell to revisit.

## Open Questions

1. Should the backward-compat re-exports of `ParentSessionInfo`/`CompactionInfo` from `agent-manager.ts` stay permanently, or be removed in step 9?
   Decision: remove in step 9 if grep confirms no external consumers.
