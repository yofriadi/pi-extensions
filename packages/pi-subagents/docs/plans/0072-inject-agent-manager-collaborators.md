---
issue: 72
issue_title: "refactor: dependency-inject AgentManager's collaborators"
---

# Dependency-inject AgentManager's collaborators

## Problem Statement

`AgentManager` directly imports and calls `runAgent`, `resumeAgent`, `createWorktree`, `cleanupWorktree`, and `pruneWorktrees`.
Any test of `AgentManager` must mock entire modules via `vi.mock()`, coupling the test to the internal structure of `agent-runner.ts` and `worktree.ts` rather than to `AgentManager`'s own behavior.

## Goals

- Define an `AgentRunner` interface (execution boundary) and a `WorktreeManager` interface (real object with state) for the operations `AgentManager` actually needs.
- Inject both into `AgentManager` via a constructor options bag, replacing the current 6-positional-parameter constructor.
- Remove all runtime imports of `agent-runner.ts` and `worktree.ts` from `agent-manager.ts`.
- Migrate `agent-manager.test.ts` from `vi.mock()` module stubs to `vi.fn()` interface stubs.
- No behavior change.

## Non-Goals

- Changing `AgentManager`'s public method surface (`spawn`, `spawnAndWait`, `resume`, `abort`, etc.).
- Refactoring `agent-runner.ts` internals (done in #71).
- Capturing `pi: ExtensionAPI` inside the runner — `pi` stays per-call in `SpawnArgs` for now.
- Extracting the notification system or widget (done in #54).

## Background

### Prerequisites

| Issue | Title                                               | Status  |
| ----- | --------------------------------------------------- | ------- |
| #69   | Create `SubagentRuntime`                            | ✓ Done  |
| #71   | Extract pure agent-session assembler                | ✓ Done  |
| #76   | Inject `cwd` into `AgentManager`                    | ✓ Done  |
| #80   | Consolidate `getConfig`/`getAgentConfig`            | ✓ Done  |
| #84   | Extract `GitWorktreeManager` class from worktree.ts | ✓ Done  |

### Prior art

`pi-permission-system` `PermissionManager` takes a `PolicyLoader` via constructor injection.
The interface is defined in `policy-loader.ts` alongside the default `FilePolicyLoader` implementation.
`PermissionManager` imports the interface type-only — no runtime coupling to the loader module.

### Current imports in `agent-manager.ts`

```typescript
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";  // runtime + type
import { addUsage } from "./usage.js";                                          // runtime (pure utility, stays)
import { cleanupWorktree, createWorktree, pruneWorktrees } from "./worktree.js"; // runtime
```

After this refactor:

```typescript
import type { AgentRunner } from "./agent-runner.js";      // type-only (erased at compile)
import type { WorktreeManager } from "./worktree.js";      // type-only (erased at compile)
import { addUsage } from "./usage.js";                      // runtime (pure utility, stays)
```

### Relevant constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- When a shared interface references a collaborator, use a narrow interface type — not the concrete class.

## Design Overview

### Two collaborators, different natures

#### WorktreeManager — real object with state

The three worktree functions all operate on git worktrees relative to a repository root.
Today `cwd` is threaded to each call — `createWorktree(ctx.cwd, id)`, `cleanupWorktree(ctx.cwd, wt, desc)`, `pruneWorktrees(this.cwd)`.
In practice `ctx.cwd` and `this.cwd` are always the same value (the process working directory set at extension init).

A `WorktreeManager` class captures `cwd` at construction, eliminating the per-call threading:

```typescript
// In worktree.ts
export interface WorktreeManager {
  create(id: string): WorktreeInfo | undefined;
  cleanup(wt: WorktreeInfo, description: string): WorktreeCleanupResult;
  prune(): void;
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly cwd: string) {}
  create(id: string): WorktreeInfo | undefined { return createWorktree(this.cwd, id); }
  cleanup(wt: WorktreeInfo, description: string): WorktreeCleanupResult { return cleanupWorktree(this.cwd, wt, description); }
  prune(): void { pruneWorktrees(this.cwd); }
}
```

The existing free functions stay as the internal implementation and for any direct callers.

#### AgentRunner — execution boundary interface

`runAgent` and `resumeAgent` are stateless IO orchestrators.
They have no natural state to capture — `pi` is constant per extension but already flows through `SpawnArgs`.
The interface exists to decouple `AgentManager` (lifecycle management: queuing, concurrency, abort) from the execution engine (SDK sessions, prompt loops, event wiring):

```typescript
// In agent-runner.ts
export interface AgentRunner {
  run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
  resume(session: AgentSession, prompt: string, options?: ResumeOptions): Promise<string>;
}

export interface ResumeOptions {
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  signal?: AbortSignal;
}
```

The existing `{ run: runAgent, resume: resumeAgent }` structurally satisfies the interface — no wrapper class needed.

### Constructor options bag

The current 6-positional-parameter constructor becomes an options bag:

```typescript
export interface AgentManagerOptions {
  cwd: string;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  maxConcurrent?: number;
  getRunConfig?: () => RunConfig;
  onStart?: OnAgentStart;
  onComplete?: OnAgentComplete;
  onCompact?: OnAgentCompact;
}
```

All fields are used by `AgentManager` — no subset concern.

### Wiring in index.ts

```typescript
import { runAgent, resumeAgent } from "./agent-runner.js";
import { GitWorktreeManager } from "./worktree.js";

const worktrees = new GitWorktreeManager(process.cwd());
const manager = new AgentManager({
  cwd: process.cwd(),
  runner: { run: runAgent, resume: resumeAgent },
  worktrees,
  onComplete: (record) => { /* ... */ },
  onStart: (record) => { /* ... */ },
  onCompact: (record, info) => { /* ... */ },
  getRunConfig: () => ({ defaultMaxTurns: runtime.defaultMaxTurns, graceTurns: runtime.graceTurns }),
});
```

### `cwd` on AgentManager after WorktreeManager captures it

`AgentManager.cwd` was previously used for two purposes:

1. Worktree operations (`createWorktree(ctx.cwd, ...)`, `pruneWorktrees(this.cwd)`) — now handled by the injected `WorktreeManager`.
2. No other use remains inside `AgentManager` itself.

However, `cwd` is still passed as part of `AgentManagerOptions` because `dispose()` calls `this.worktrees.prune()` — the `WorktreeManager` now owns the `cwd` for that call.
The `cwd` field on `AgentManagerOptions` can be dropped if no other internal use remains after the refactor.
A grep in step 8 will confirm whether `this.cwd` has any remaining readers; if not, it is removed.

### Test pattern after DI

```typescript
function createManager(overrides?: Partial<AgentManagerOptions>) {
  const runner: AgentRunner = {
    run: vi.fn().mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false,
    }),
    resume: vi.fn().mockResolvedValue("resumed"),
  };
  const worktrees: WorktreeManager = {
    create: vi.fn(),
    cleanup: vi.fn(() => ({ hasChanges: false })),
    prune: vi.fn(),
  };
  return {
    manager: new AgentManager({ cwd: "/test-cwd", runner, worktrees, ...overrides }),
    runner,
    worktrees,
  };
}
```

Tests access the mock stubs directly — no `vi.mocked(runAgent)` needed:

```typescript
const { manager, runner } = createManager({ onComplete: (r) => { /* ... */ } });
manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test", isBackground: true });
expect(runner.run).toHaveBeenCalled();
```

## Module-Level Changes

### `src/worktree.ts` (no changes in this issue)

`WorktreeManager` interface and `GitWorktreeManager` class were added by #84.

### `src/agent-runner.ts` (modified)

- Add `AgentRunner` interface (2 methods: `run`, `resume`).
- Extract `ResumeOptions` as a named type from the inline parameter type in `resumeAgent`.
- Export both.
- No changes to `runAgent()` or `resumeAgent()` implementations.

### `src/agent-manager.ts` (modified)

- Add `AgentManagerOptions` interface.
- Replace 6-positional-parameter constructor with single `options: AgentManagerOptions` parameter.
- Replace `runAgent(ctx, ...)` with `this.runner.run(ctx, ...)`.
- Replace `resumeAgent(session, ...)` with `this.runner.resume(session, ...)`.
- Replace `createWorktree(ctx.cwd, id)` with `this.worktrees.create(id)`.
- Replace `cleanupWorktree(ctx.cwd, wt, desc)` with `this.worktrees.cleanup(wt, desc)`.
- Replace `pruneWorktrees(this.cwd)` with `this.worktrees.prune()`.
- Remove runtime imports from `agent-runner.ts` and `worktree.ts`; keep `import type` only.
- Remove `this.cwd` if grep confirms no remaining readers after the worktree delegation.

### `src/index.ts` (modified)

- Import `GitWorktreeManager` from `worktree.ts`.
- Construct `new GitWorktreeManager(process.cwd())`.
- Pass options bag to `new AgentManager({ ... })`.

### `test/agent-manager.test.ts` (modified)

- Remove `vi.mock("../src/agent-runner.js", ...)` block.
- Remove `vi.mock("../src/worktree.js", ...)` block.
- Remove `import { runAgent } from "../src/agent-runner.js"` and `import { pruneWorktrees } from "../src/worktree.js"`.
- Add `createManager()` test helper factory.
- Replace all 19 `new AgentManager(...)` calls with `createManager(...)`.
- Update assertions from `vi.mocked(runAgent)` to `runner.run` / `runner.resume`.
- Update assertions from `vi.mocked(pruneWorktrees)` to `worktrees.prune`.
- Update assertions from `vi.mocked(createWorktree)` to `worktrees.create`.

## Test Impact Analysis

### New unit tests enabled by DI

1. Queueing behavior — verify that excess background agents are queued and started in order when running agents complete, without needing module-level mocks.
2. Concurrency limit enforcement — verify `maxConcurrent` is respected with controlled stub resolution.
3. Abort semantics — verify that aborting a queued agent removes it from the queue and sets status, using stubs that never resolve.
4. Lifecycle callback ordering — verify `onStart`, `onComplete`, `onCompact` fire at the right moments with correct record state.
5. Worktree failure modes — verify that `create` returning `undefined` throws and leaves no orphan record, via a simple `vi.fn().mockReturnValue(undefined)`.

### Existing tests that are migrated (not removed)

All 19 test sites in `agent-manager.test.ts` are migrated from `vi.mock()` + `vi.mocked()` to the `createManager()` helper with injected stubs.
The test logic stays identical — only the mock setup mechanism changes.

### Existing tests that stay as-is

Tests in `agent-runner.test.ts`, `agent-runner-extension-tools.test.ts`, `agent-runner-settings.test.ts`, and `session-config.test.ts` are unaffected — they test the execution engine, not the lifecycle manager.

## TDD Order

Issue #84 (extract `GitWorktreeManager`) must land first.
This plan assumes `WorktreeManager` interface and `GitWorktreeManager` class already exist in `worktree.ts`.

### Phase A: Define AgentRunner interface

1. Add `AgentRunner` interface and named `ResumeOptions` type in `agent-runner.ts`.
   Export both.
   Run existing tests.
   Commit: `feat: define AgentRunner interface in agent-runner.ts`

### Phase B: Lift-and-shift test migration

2. Create `createManager()` test helper factory in `agent-manager.test.ts`.
   The factory constructs `AgentManager` using the **old** positional constructor, wrapping the same `vi.mock()` stubs in a consistent helper.
   Migrate all 19 `new AgentManager(...)` call sites to use the factory.
   All tests pass unchanged.
   Commit: `test: add createManager helper and migrate call sites`

### Phase C: Constructor conversion + DI

3. RED: Add a test that calls `createManager()` with `runner` and `worktrees` overrides and asserts `runner.run` is called when spawning an agent.
   This fails because the constructor does not accept the options bag yet.
   Commit: `test: add agent-manager test with injected AgentRunner`

4. GREEN: Convert `AgentManager` constructor to accept `AgentManagerOptions`.
   Replace internal calls to `runAgent`/`resumeAgent`/`createWorktree`/`cleanupWorktree`/`pruneWorktrees` with `this.runner.*`/`this.worktrees.*`.
   Remove runtime imports from `agent-runner.ts` and `worktree.ts`.
   Update `createManager()` factory to pass injected stubs via the options bag.
   Remove `vi.mock()` blocks for `agent-runner.js` and `worktree.js`.
   Update all test assertions that referenced `vi.mocked(runAgent)` etc. to reference the injected stubs.
   All tests pass.
   Commit: `feat: convert AgentManager to options-bag constructor with DI`

### Phase D: Wiring and verification

5. Wire `index.ts`: construct `GitWorktreeManager`, pass options bag to `AgentManager`.
   Run full test suite.
   Commit: `refactor: wire injected deps into AgentManager (#72)`

6. Add new tests enabled by DI: queueing order, concurrency enforcement, abort-from-queue, lifecycle callback timing.
   Commit: `test: add DI-enabled agent-manager tests`

7. Verify acceptance criteria.
   Grep `agent-manager.ts` for runtime imports from `agent-runner.ts` and `worktree.ts` (expect none).
   Grep for `this.cwd` — if no readers remain, remove the field and the `cwd` option.
   Run `pnpm run check` for type safety.
   Commit: `refactor: finalize AgentManager DI (#72)`

## Risks and Mitigations

| Risk                                                                                                             | Mitigation                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.cwd` and `this.cwd` differ for worktree operations, causing `GitWorktreeManager` to use the wrong directory | In practice both are `process.cwd()` — verified by tracing `session_start` and constructor call sites. If a difference surfaces, `WorktreeManager` can accept `cwd` per-call as a fallback.                           |
| Migrating 19 test call sites introduces test regressions                                                         | Phase B (step 3) migrates under the old constructor first, proving the helper factory works before any behavioral change. Phase C (step 5) changes the constructor and stubs atomically.                              |
| `import type` from `agent-runner.ts`/`worktree.ts` is considered a "top-level import" by reviewers               | `import type` is erased by TypeScript at compile time and creates zero runtime dependency. The compiled JS will have no import from these modules. This matches the `PolicyLoader` pattern in `pi-permission-system`. |
| New options bag breaks the `AgentManagerLike` interface in `service-adapter.ts`                                  | `AgentManagerLike` references `AgentManager`'s public methods (`spawn`, `getRecord`, etc.), not its constructor. The constructor change is invisible to the adapter.                                                  |
| `addUsage` remains as a direct runtime import from `usage.ts`                                                    | Intentional — `addUsage` is a pure accumulator function with no IO. The issue targets `agent-runner.ts` and `worktree.ts` specifically.                                                                               |

## Open Questions

- Should `AgentRunner` eventually capture `pi: ExtensionAPI` to eliminate the `pi` parameter from `spawn()` and `SpawnArgs`?
  Deferred — `pi` is already threaded through the call chain and removing it would change `AgentManager`'s public method signatures, which is a non-goal.
- Does the `WorktreeManager` abstraction surface further opportunities (e.g., non-git isolation strategies)?
  Noted for future consideration — the interface makes alternative implementations possible without changing `AgentManager`.
- The `AgentRunner` interface is a testability seam, not a stateful object.
  As the codebase continues untangling, a more natural execution abstraction may emerge.
  This interface is intentionally minimal to avoid premature abstraction.
