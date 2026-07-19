---
issue: 99
issue_title: "Replace live `ctx` capture with ParentSnapshot in AgentManager"
---

# Replace live ctx capture with ParentSnapshot

## Problem Statement

`AgentManager.spawn()` captures a live `ctx: ExtensionContext` reference into `SpawnArgs`, which is held in the concurrency queue until a slot opens.
When the queued agent eventually dequeues, `runAgent()` reads from this live reference — `ctx.cwd`, `ctx.getSystemPrompt()`, `ctx.model`, `ctx.modelRegistry` — all of which may have changed since the agent was queued (model switch, cwd change, session restart).

Additionally, `inheritContext` calls `ctx.sessionManager.getBranch()` at run time, forking the conversation as it exists at dequeue rather than at the point the user asked for the agent.

`pi: ExtensionAPI` is also stored in `SpawnArgs` but is only relayed to `runner.run()`, which only uses it for `detectEnv()` — a classic parameter-relay smell.

## Goals

- Replace `ctx: ExtensionContext` in `SpawnArgs` with a `ParentSnapshot` data object captured once at spawn time.
- Remove `pi: ExtensionAPI` from `SpawnArgs` by injecting a narrow `ShellExec` callback into `AgentManager` at construction.
- Update `AgentRunner.run()` to accept `ParentSnapshot` instead of `ctx`.
- Narrow `detectEnv()` to accept `ShellExec` instead of the full `ExtensionAPI`.
- Simplify test mocks — plain data snapshots replace SDK mock objects.

## Non-Goals

- Session-event observation / callback-threading removal (architecture.md Step 3, #100) — separate issue, depends on this one.
- Cleaning up `runtime.currentCtx` — it holds a live `{ pi, ctx }` for the service-adapter but is always "current" (set on `session_start`, cleared on `session_shutdown`); staleness is not a risk there.
  Simplifying it is a natural follow-up but out of scope.
- Changes to `SpawnOptions` or the public `SubagentsService` API — both are unchanged.

## Background

### Relevant modules

| Module                   | Role in this change                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/agent-manager.ts`   | Owns `SpawnArgs`, `spawn()`, `startAgent()` — primary target                            |
| `src/agent-runner.ts`    | `runAgent()` consumes `ctx` + `pi`; `AgentRunner` interface defines `run()` signature   |
| `src/env.ts`             | `detectEnv()` accepts `ExtensionAPI` — narrowing to `ShellExec`                         |
| `src/context.ts`         | `buildParentContext()` reads `ctx.sessionManager.getBranch()` — called at snapshot time |
| `src/session-config.ts`  | `AssemblerContext` is already a narrow interface; `runAgent` builds it from ctx today   |
| `src/types.ts`           | Will host `ParentSnapshot` and `ShellExec` type definitions                             |
| `src/service-adapter.ts` | `AgentManagerLike.spawn` — narrow interface that mirrors `AgentManager.spawn()`         |
| `src/index.ts`           | Wires `pi.exec` into `AgentManager`; wraps `spawn`/`spawnAndWait` for tools             |
| `src/ui/agent-menu.ts`   | `AgentMenuManagerDeps.spawnAndWait` — narrow interface referencing `pi` parameter       |

### Code-style constraints

- **Parameter relay** (code-design skill): `pi` threads through `spawn` → `SpawnArgs` → `startAgent` → `RunOptions` → `runAgent` → `detectEnv`.
  The intermediaries (`spawn`, `startAgent`) never read `pi`.
  Fix: inject exec at the `AgentManager` level.
- **Dependency width** (code-design skill): `runAgent` receives `ctx: ExtensionContext` but only reads 4 fields plus `sessionManager.getBranch()`.
  Fix: `ParentSnapshot` — a narrow interface with exactly the fields consumed.
- **Law of Demeter** (design-review): `ctx.sessionManager.getBranch()` is a reach-through that forces tests to mock a nested `sessionManager` object.
  Fix: snapshot pre-computes `parentContext` as a string.

### Prerequisite status

- Issue #98 (AgentRecord state machine) — **done**.
  `AgentRecord` is a class with encapsulated transition methods.
- Issue #102 (shared test record factory) — **done**.
  All test record construction goes through `createTestRecord()`.

## Design Overview

### ParentSnapshot interface

A plain data object capturing everything `runAgent()` reads from `ctx`:

```typescript
export interface ParentSnapshot {
  /** Parent working directory. */
  cwd: string;
  /** Parent's effective system prompt (for append-mode agents). */
  systemPrompt: string;
  /** Parent's current model instance (fallback when agent config has no model). */
  model: unknown;
  /** Model registry for resolving config.model strings and creating sessions. */
  modelRegistry: {
    find(provider: string, modelId: string): unknown;
    getAvailable?(): Array<{ provider: string; id: string }>;
  };
  /** Pre-built parent conversation text (when inheritContext was requested). */
  parentContext?: string;
}
```

The `modelRegistry` field is a reference capture, not a data copy — it's a registry object with methods.
This is acceptable because the registry is structurally stable within a session (models don't change at runtime).
The key staleness risks (`cwd`, `systemPrompt`, `model`, conversation state) are all captured as values.

### ShellExec type

A narrow callback type replacing `ExtensionAPI` in `detectEnv`:

```typescript
export type ShellExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
```

This matches the shape of `pi.exec()` but carries no SDK dependency.

### Snapshot built in spawn()

`spawn()` keeps receiving `ctx` as a parameter (so callers don't need to know about `ParentSnapshot`).
Internally, it immediately snapshots `ctx` and stores the snapshot in `SpawnArgs` — never the live `ctx` reference.

```typescript
spawn(ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
  const snapshot: ParentSnapshot = buildParentSnapshot(ctx, options.inheritContext);
  const args: SpawnArgs = { snapshot, type, prompt, options };
  // ...
}
```

The `pi` parameter is removed from `spawn()`.
The `exec` function is injected into `AgentManager` at construction time via `AgentManagerOptions`, since `pi.exec` is a stable capability (same function reference for the extension's lifetime).

### buildParentSnapshot helper

A new `src/parent-snapshot.ts` module with a single exported function:

```typescript
export function buildParentSnapshot(
  ctx: ExtensionContext,
  inheritContext?: boolean,
): ParentSnapshot {
  return {
    cwd: ctx.cwd,
    systemPrompt: ctx.getSystemPrompt(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    parentContext: inheritContext ? buildParentContext(ctx) : undefined,
  };
}
```

This is the only place that touches `ExtensionContext` to build a snapshot.
It calls `buildParentContext(ctx)` (from `context.ts`) which reads `ctx.sessionManager.getBranch()` — capturing the conversation at spawn time, not dequeue time.

### SpawnArgs changes

```typescript
// Before
interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

// After
interface SpawnArgs {
  snapshot: ParentSnapshot;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}
```

### AgentRunner.run() signature change

```typescript
// Before
run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;

// After
run(snapshot: ParentSnapshot, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
```

### RunOptions changes

```typescript
// Removed fields:
//   pi: ExtensionAPI         → replaced by exec: ShellExec
//   inheritContext?: boolean → handled by snapshot.parentContext

// Added field:
exec: ShellExec;
```

### runAgent flow changes

Inside `runAgent()`, all `ctx.*` reads become `snapshot.*` reads:

```typescript
// Before
const effectiveCwd = options.cwd ?? ctx.cwd;
const env = await detectEnv(options.pi, effectiveCwd);
const cfg = assembleSessionConfig(type, {
  cwd: ctx.cwd,
  parentSystemPrompt: ctx.getSystemPrompt(),
  parentModel: ctx.model,
  modelRegistry: ctx.modelRegistry,
}, ...);

// After
const effectiveCwd = options.cwd ?? snapshot.cwd;
const env = await detectEnv(options.exec, effectiveCwd);
const cfg = assembleSessionConfig(type, {
  cwd: snapshot.cwd,
  parentSystemPrompt: snapshot.systemPrompt,
  parentModel: snapshot.model,
  modelRegistry: snapshot.modelRegistry,
}, ...);
```

The `inheritContext` block changes:

```typescript
// Before
if (options.inheritContext) {
  const parentContext = buildParentContext(ctx);
  if (parentContext) effectivePrompt = parentContext + prompt;
}

// After
if (snapshot.parentContext) {
  effectivePrompt = snapshot.parentContext + prompt;
}
```

The `createAgentSession()` call changes:

```typescript
// Before: modelRegistry: ctx.modelRegistry
// After:  modelRegistry: snapshot.modelRegistry as ModelRegistry
```

### AgentManager constructor change

```typescript
export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  exec: ShellExec;              // NEW — injected from pi.exec
  maxConcurrent?: number;
  getRunConfig?: () => RunConfig;
  onStart?: OnAgentStart;
  onComplete?: OnAgentComplete;
  onCompact?: OnAgentCompact;
}
```

`startAgent()` uses `this.exec` when building `RunOptions`:

```typescript
const promise = this.runner.run(snapshot, type, prompt, {
  exec: this.exec,
  model: options.model,
  // ... (no more pi field)
});
```

### Caller updates

`index.ts`:

```typescript
// Before
const manager = new AgentManager({
  runner: { run: runAgent, resume: resumeAgent },
  worktrees: new GitWorktreeManager(process.cwd()),
  // ...
});

// After — adds exec
const manager = new AgentManager({
  runner: { run: runAgent, resume: resumeAgent },
  worktrees: new GitWorktreeManager(process.cwd()),
  exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
  // ...
});
```

Spawn wrappers simplify — no more `pi` injection:

```typescript
// Before
spawn: (ctx, type, prompt, opts) => manager.spawn(pi, ctx, type, prompt, opts),
// After
spawn: (ctx, type, prompt, opts) => manager.spawn(ctx, type, prompt, opts),
```

`service-adapter.ts`:

```typescript
// AgentManagerLike.spawn — drops pi parameter
spawn(ctx: unknown, type: string, prompt: string, options: unknown): string;
```

`ui/agent-menu.ts` — `spawnAndWait` drops `pi` parameter:

```typescript
// Before
spawnAndWait: (pi: ExtensionAPI | null, ctx: ExtensionContext, ...) => Promise<AgentRecord>;
// After
spawnAndWait: (ctx: ExtensionContext, ...) => Promise<AgentRecord>;
```

## Module-Level Changes

### New files

1. `src/parent-snapshot.ts` — `buildParentSnapshot()` function (cycle 3).
2. `test/parent-snapshot.test.ts` — unit tests for the builder (cycle 3).

### Changed files (source)

Phase 1 (pi elimination):

1. `src/types.ts` — add `ShellExec` type (cycle 1); add `ParentSnapshot` interface (cycle 3).
2. `src/env.ts` — `detectEnv()` accepts `ShellExec` instead of `ExtensionAPI` (cycle 1).
3. `src/agent-runner.ts` — `RunOptions` replaces `pi` with `exec` (cycle 1); `runAgent()` first param changes to `ParentSnapshot`, removes `inheritContext` from `RunOptions` (cycle 4).
4. `src/agent-manager.ts` — `AgentManagerOptions` adds `exec`, `startAgent` uses `this.exec` (cycle 1); `spawn`/`spawnAndWait` drop `pi`, `SpawnArgs` drops `pi` (cycle 2); `spawn` builds snapshot, `SpawnArgs` replaces `ctx` with `snapshot` (cycle 5).
5. `src/index.ts` — pass `exec` to `AgentManager` constructor (cycle 1); simplify `spawn`/`spawnAndWait` wrappers (cycle 2).
6. `src/service-adapter.ts` — `AgentManagerLike.spawn` drops `pi` (cycle 2).
7. `src/ui/agent-menu.ts` — `AgentMenuManagerDeps.spawnAndWait` drops `pi` (cycle 2).

### Changed files (tests)

1. `test/env.test.ts` — `mockPi()` → `mockExec()` (cycle 1).
2. `test/agent-runner.test.ts` — `{ pi }` → `{ exec: vi.fn() }` (cycle 1); `ctx` mock → `ParentSnapshot` (cycle 4).
3. `test/agent-runner-extension-tools.test.ts` — same as agent-runner (cycles 1, 4).
4. `test/agent-manager.test.ts` — add `exec` to `createManager()` (cycle 1); remove `mockPi` from 27 `spawn()` calls (cycle 2); mock `buildParentSnapshot` (cycle 5).
5. `test/service-adapter.test.ts` — `AgentManagerLike.spawn` mock drops `pi` (cycle 2).
6. `test/ui/agent-menu.test.ts` — `spawnAndWait` mock drops `pi` (cycle 2).

### Unchanged files

- `src/service.ts` — public API unchanged.
- `src/context.ts` — `buildParentContext()` keeps its current signature; called by `buildParentSnapshot()`.
- `src/session-config.ts` — `AssemblerContext` unchanged; `runAgent` builds it from snapshot fields.
- `src/agent-record.ts` — unrelated.
- `src/tools/agent-tool.ts` — already uses narrow `deps.manager` interface without `pi`; the `(ctx, type, prompt, opts)` shape is unchanged.
- All other source and test files.

## Test Impact Analysis

### New tests enabled by the extraction

- `buildParentSnapshot()` tested in isolation — verifies field mapping and `inheritContext` pre-computation.
  Previously impossible: the snapshot was implicit (live ctx was passed through).
- `detectEnv()` tests become SDK-free — a plain `ShellExec` stub replaces the `ExtensionAPI` mock.

### Existing tests that simplify

- `agent-runner.test.ts` — the `ctx` mock loses its methods (`getSystemPrompt: vi.fn()`, `sessionManager.getBranch: vi.fn()`) and becomes a plain data object.
  The `pi` mock (`{} as any`) is replaced by `exec: vi.fn()`.
  Every `runAgent(ctx, ...)` call is a mechanical replacement.
- `agent-manager.test.ts` — `mockPi` is eliminated entirely (28 spawn calls).
  The `createManager()` helper gains an `exec` field.
- `env.test.ts` — `mockPi()` factory simplifies to a `vi.fn()` returning exec results.

### Existing tests that stay as-is

All `agent-manager.test.ts` tests that verify lifecycle (spawn, complete, abort, resume, queue drain, worktree) remain unchanged in intent — they verify the wiring between `AgentManager` and the record/runner.
Only the mock construction and `spawn()` call sites change mechanically.

## TDD Order

The cycles are organized into two phases following the Kent Beck principle "make the change that makes the change easy."
Phase 1 (cycles 1–2) eliminates the `pi` parameter relay — an orthogonal concern that would otherwise cascade through every snapshot cycle.
Phase 2 (cycles 3–5) introduces `ParentSnapshot`, landing on clean ground.

### Phase 1: Eliminate pi relay

#### Cycle 1: ShellExec type + exec injection into runner path

Test surface: `test/env.test.ts`, `test/agent-runner.test.ts`, `test/agent-runner-extension-tools.test.ts`, `test/agent-manager.test.ts` (updated).

This cycle replaces `pi: ExtensionAPI` with `exec: ShellExec` in the runner path (leaf → middle → top), and injects `exec` into `AgentManager`.
`SpawnArgs` still carries `pi` (unused) — removed in cycle 2.

Changes:

- `src/types.ts`: add `ShellExec` type.
- `src/env.ts`: `detectEnv()` accepts `ShellExec` instead of `ExtensionAPI`.
- `src/agent-runner.ts`: `RunOptions` replaces `pi: ExtensionAPI` with `exec: ShellExec`; `runAgent()` uses `options.exec` for `detectEnv()`; remove `ExtensionAPI` import.
- `src/agent-manager.ts`: `AgentManagerOptions` adds `exec: ShellExec`; `startAgent()` passes `exec: this.exec` in `RunOptions` instead of `pi` from `SpawnArgs`; stop destructuring `pi` from `SpawnArgs` (it stays in the type for one cycle).
- `src/index.ts`: pass `exec: (cmd, args, opts) => pi.exec(cmd, args, opts)` to `AgentManager` constructor.
- `test/env.test.ts`: `mockPi()` → `mockExec()` returning a `ShellExec` stub.
- `test/agent-runner.test.ts`: `{ pi }` → `{ exec: vi.fn() }` in all `runAgent()` calls.
- `test/agent-runner-extension-tools.test.ts`: same.
- `test/agent-manager.test.ts`: add `exec: vi.fn()` to `createManager()` defaults.
- Run full test suite + `pnpm run check`.

Commit: `refactor: inject ShellExec into runner path, replacing ExtensionAPI (#99)`

#### Cycle 2: Remove pi from spawn path and callers

Test surface: `test/agent-manager.test.ts`, `test/service-adapter.test.ts`, `test/ui/agent-menu.test.ts` (updated).

With `exec` already injected and `pi` unused in `startAgent()`, this cycle removes it from the remaining surfaces.

Changes:

- `src/agent-manager.ts`: `SpawnArgs` drops `pi`; `spawn()` drops `pi` parameter; `spawnAndWait()` drops `pi` parameter; remove `ExtensionAPI` import.
- `src/service-adapter.ts`: `AgentManagerLike.spawn()` drops `pi` parameter; `createSubagentsService().spawn()` passes `session.ctx` only.
- `src/ui/agent-menu.ts`: `AgentMenuManagerDeps.spawnAndWait()` drops `pi` parameter; call site drops `null` first arg.
- `src/index.ts`: simplify `spawn` wrapper — `(ctx, type, prompt, opts) => manager.spawn(ctx, type, prompt, opts)`; simplify `spawnAndWait` wrappers similarly.
- `test/agent-manager.test.ts`: remove `mockPi` constant; drop it from all 27 `spawn()` call sites.
- `test/service-adapter.test.ts`: update `AgentManagerLike.spawn` mock.
- `test/ui/agent-menu.test.ts`: update `spawnAndWait` mock.
- Run full test suite + `pnpm run check`.

Commit: `refactor: remove pi parameter from spawn path (#99)`

### Phase 2: ParentSnapshot

#### Cycle 3: ParentSnapshot type and builder

Test surface: `test/parent-snapshot.test.ts` (new file).

Tests cover:

- Snapshots `cwd`, `systemPrompt` (from `getSystemPrompt()`), `model`, `modelRegistry` from a mock `ctx`.
- When `inheritContext` is true and conversation exists, `parentContext` is populated.
- When `inheritContext` is false or undefined, `parentContext` is undefined.
- When `inheritContext` is true but conversation is empty, `parentContext` is undefined.

Changes:

- Add `ParentSnapshot` interface to `src/types.ts`.
- Create `src/parent-snapshot.ts` with `buildParentSnapshot()`.
- Create `test/parent-snapshot.test.ts`.

Commit: `feat: add ParentSnapshot type and builder (#99)`

#### Cycle 4: runAgent and AgentRunner accept ParentSnapshot

Test surface: `test/agent-runner.test.ts`, `test/agent-runner-extension-tools.test.ts` (updated).

With `pi` already eliminated (phase 1), this cycle only changes the first parameter of `runAgent()` — no other `RunOptions` churn.

Changes:

- `src/agent-runner.ts`:
  - `runAgent()` first parameter: `ctx: ExtensionContext` → `snapshot: ParentSnapshot`.
  - `AgentRunner.run()` interface: first parameter changes to `snapshot: ParentSnapshot`.
  - Remove `inheritContext` from `RunOptions` (snapshot has `parentContext`).
  - `inheritContext` block → `if (snapshot.parentContext)`.
  - `assembleSessionConfig` and `createAgentSession` calls read from `snapshot.*` instead of `ctx.*`.
  - Remove `ExtensionContext` import; remove `buildParentContext` import (no longer called here).
- `test/agent-runner.test.ts`: replace `ctx` mock with a plain `ParentSnapshot` object.
- `test/agent-runner-extension-tools.test.ts`: same.
- Run `pnpm run check` — catches `agent-manager.ts` type error in `startAgent()`'s `runner.run()` call (still passing `ctx`); addressed in cycle 5.

Commit: `refactor: AgentRunner accepts ParentSnapshot instead of ExtensionContext (#99)`

#### Cycle 5: AgentManager spawn builds snapshot

Test surface: `test/agent-manager.test.ts` (updated).

Changes:

- `src/agent-manager.ts`:
  - `spawn()` calls `buildParentSnapshot(ctx, options.inheritContext)` and stores the snapshot in `SpawnArgs`.
  - `SpawnArgs`: replace `ctx: ExtensionContext` with `snapshot: ParentSnapshot`.
  - `startAgent()` destructures `snapshot` from `SpawnArgs`; passes it to `runner.run(snapshot, ...)`.
  - Remove `ExtensionContext` import.
- `test/agent-manager.test.ts`: `vi.mock("../src/parent-snapshot.js")` to isolate `buildParentSnapshot`; `mockCtx` stays minimal (`{ cwd: "/tmp" } as any`) because `spawn()` delegates to the mocked builder.
- Run full test suite + `pnpm run check`.

Commit: `refactor: AgentManager captures ParentSnapshot at spawn time (#99)`

## Risks and Mitigations

| Risk                                                                                                       | Mitigation                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRegistry` is a reference capture, not a data copy — could theoretically go stale                     | Registries are structurally stable within a session; the staleness risk applies to `cwd`/`systemPrompt`/`model`/conversation, all of which are value-captured  |
| Large test files (~410 + ~686 lines) need mechanical updates                                               | Phase 1 handles `pi` churn (27 spawn calls) separately from phase 2's `ctx` → `snapshot` change, so each cycle touches one concern per test file               |
| `spawn()` still receives `ctx` — caller could accidentally use it post-snapshot                            | `ctx` is a function parameter, not stored; `SpawnArgs` holds only the snapshot; the type system prevents re-storing ctx since `SpawnArgs.ctx` no longer exists |
| `buildParentContext` still accepts `ExtensionContext` — mocking it requires a nested `sessionManager` mock | The mock only appears in `parent-snapshot.test.ts` (one place); a follow-up could narrow `buildParentContext` to accept just the branch data                   |
| Phase 1 temporarily leaves `pi` in `SpawnArgs` (cycle 1) before removing it (cycle 2)                      | The field is unused after cycle 1 (`startAgent` uses `this.exec` instead); cycle 2 removes it in the next commit                                               |

## Open Questions

- Whether to narrow `buildParentContext()` to accept `getBranch()` data directly instead of `ExtensionContext`.
  This would eliminate the last `ExtensionContext` usage in the snapshot path but is a separate refactoring of `context.ts`.
  Deferred — the current `buildParentSnapshot` wrapper isolates the SDK dependency to one module.
- Whether `runtime.currentCtx` should be simplified from `{ pi, ctx }` to just `ctx` now that `pi` is not passed to `spawn()`.
  Natural follow-up but out of scope — `currentCtx.pi` has no other consumers and removing it is a 3-line change.
