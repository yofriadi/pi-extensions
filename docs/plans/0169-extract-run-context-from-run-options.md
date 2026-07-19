---
issue: 169
issue_title: "refactor(pi-subagents): extract RunContext from RunOptions (12 fields)"
---

# Extract RunContext from RunOptions

## Problem Statement

`RunOptions` in `agent-runner.ts` has 12 fields mixing two distinct concerns: parent execution context ("where/who is running") and per-call execution parameters ("how to run").
Extracting the context cluster into a named `RunContext` interface makes the separation explicit and reduces the flat field count from 12 to 9 (8 execution fields + 1 nested context).

## Goals

- Define a `RunContext` interface grouping the 4 parent-context fields: `exec`, `registry`, `cwd`, and `parentSession`.
- Nest `RunContext` inside `RunOptions` as `context: RunContext`, replacing the 4 flat fields.
- Update `runAgent()` to read context fields from `options.context.*`.
- Update `AgentManager.startAgent()` to construct the nested `context` object when building `RunOptions`.
- Update all test files that construct or assert on `RunOptions` fields.
- Non-breaking refactor — `RunOptions` is not part of the public API (`service.ts` export boundary).

## Non-Goals

- Changing the `AgentRunner` interface signature — `run()` keeps its 4 positional parameters; `RunContext` is nested inside `RunOptions`, not a separate parameter.
- Extracting `RunContext` into its own file — the interface is small (4 fields) and co-located with its consumer (`runAgent`).
- Further splitting the remaining 8 execution fields — they form a coherent "how to run" cluster.
- Hoisting `RunContext` construction to `AgentManager` instance level — two of the four fields (`cwd`, `parentSession`) vary per spawn, so a per-spawn construction is appropriate.

## Background

Issue #164 (closed) reorganized source into domain directories; the runner now lives at `src/lifecycle/agent-runner.ts`.
Issue #166 (closed) extracted `ParentSessionInfo` and nested it inside `RunOptions.parentSession`.
Issue #167 (closed) split `RunnerIO` into `EnvironmentIO` and `SessionFactoryIO`.
Issue #168 (closed) extracted `ToolFilterConfig` from `SessionConfig`.

This issue continues the structural improvement by separating the two concerns mixed in `RunOptions`.

### Field analysis

| Field              | Concern   | Usage in `runAgent()`                      |
| ------------------ | --------- | ------------------------------------------ |
| `exec`             | Context   | `io.detectEnv(options.exec, effectiveCwd)` |
| `registry`         | Context   | Passed to `assembleSessionConfig`          |
| `cwd`              | Context   | Override working directory (worktree)      |
| `parentSession`    | Context   | Session dir derivation + session linking   |
| `model`            | Execution | Per-call model override                    |
| `maxTurns`         | Execution | Turn limit                                 |
| `signal`           | Execution | Abort forwarding                           |
| `isolated`         | Execution | Extension isolation flag                   |
| `thinkingLevel`    | Execution | Thinking level override                    |
| `onSessionCreated` | Execution | Session delivery callback                  |
| `defaultMaxTurns`  | Execution | Fallback turn limit from runtime config    |
| `graceTurns`       | Execution | Grace window after soft limit              |

### Consumer analysis

`AgentManager.startAgent()` is the sole constructor of `RunOptions`.
The context fields come from two sources:

- Manager instance fields: `this.exec`, `this.registry`
- Per-spawn values: `worktreeCwd` (computed locally), `options.parentSession` (from `AgentSpawnConfig`)

## Design Overview

### `RunContext` interface

```typescript
export interface RunContext {
  /** Shell-exec callback for detectEnv — injected from pi.exec(). */
  exec: ShellExec;
  /** Agent config lookup — provides resolveAgentConfig and getToolNamesForType. */
  registry: AgentConfigLookup;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Parent session identity (file path + session ID). */
  parentSession?: ParentSessionInfo;
}
```

### Updated `RunOptions`

```typescript
export interface RunOptions {
  /** Parent execution context — where/who is running. */
  context: RunContext;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  onSessionCreated?: (session: AgentSession) => void;
  defaultMaxTurns?: number;
  graceTurns?: number;
}
```

### Call-site sketch — `AgentManager.startAgent`

```typescript
const promise = this.runner.run(snapshot, type, prompt, {
  context: {
    exec: this.exec,
    registry: this.registry,
    cwd: worktreeCwd,
    parentSession: options.parentSession,
  },
  model: options.model,
  maxTurns: options.maxTurns,
  // ... remaining execution fields
});
```

### Access pattern in `runAgent`

```typescript
const effectiveCwd = options.context.cwd ?? snapshot.cwd;
const env = await io.detectEnv(options.context.exec, effectiveCwd);
// ...
const sessionDir = io.deriveSessionDir(
  options.context.parentSession?.parentSessionFile,
  cfg.effectiveCwd,
);
```

## Module-Level Changes

### `src/lifecycle/agent-runner.ts`

1. Add `RunContext` interface (4 fields, exported) before `RunOptions`.
2. Replace the 4 flat context fields on `RunOptions` with `context: RunContext`.
3. Update all `options.*` reads in `runAgent()`:
   - `options.exec` → `options.context.exec`
   - `options.cwd` → `options.context.cwd`
   - `options.parentSession` → `options.context.parentSession`
   - `options.registry` → `options.context.registry`
4. Move JSDoc from the removed flat fields to `RunContext` interface members.
5. Export `RunContext`.

### `src/lifecycle/agent-manager.ts`

1. Update the `RunOptions` object literal in `startAgent()` to nest the four context fields under `context: { ... }`.
2. No import changes needed — `RunOptions` is consumed via the `AgentRunner` interface, not imported directly.

### No changes needed

- `src/lifecycle/agent-runner.ts` — `AgentRunner` interface signature unchanged (`options: RunOptions`).
- `src/lifecycle/agent-runner.ts` — `createAgentRunner()` unchanged.
- `src/index.ts` — no changes (doesn't import `RunOptions`).
- `src/runtime.ts` — comment-only reference to `RunOptions`; update comment if desired.
- `src/session/session-config.ts` — comment-only reference; update comment if desired.

## Test Impact Analysis

### New unit tests enabled

The extraction does not enable new test surfaces — `RunContext` is a plain data carrier with no behavior.
A type-check verification (`pnpm run check`) confirms the structural compatibility.

### Existing tests that need updates

1. `test/lifecycle/agent-runner.test.ts` — 9 `runAgent()` call sites: wrap `exec`, `registry`, `cwd`, and `parentSession` fields in `context: { ... }`.
2. `test/lifecycle/agent-runner-extension-tools.test.ts` — 7 `runAgent()` call sites: same wrapping.
3. `test/lifecycle/agent-manager.test.ts` — 3 assertion sites: update `runOpts.parentSession` → `runOpts.context.parentSession`, `runOpts.defaultMaxTurns` stays flat (execution field).

### Tests that stay as-is

- `test/lifecycle/agent-runner-settings.test.ts` — tests `normalizeMaxTurns` (pure function, no `RunOptions` involvement).
- All other test files — no `RunOptions` construction or assertion.

## TDD Order

1. **Define `RunContext` and update `RunOptions`** — add `RunContext` interface, replace 4 flat fields with `context: RunContext` on `RunOptions`.
   Update all `options.*` reads in `runAgent()` to `options.context.*`.
   Update `agent-manager.ts` `startAgent()` to construct nested context.
   Update `agent-runner.test.ts` (9 call sites) and `agent-runner-extension-tools.test.ts` (7 call sites) to nest context fields.
   Update `agent-manager.test.ts` assertions (3 sites) to read from `runOpts.context.*`.
   Run `pnpm run check` and `pnpm vitest run` to verify.
   Commit: `refactor: extract RunContext from RunOptions (#169)`

2. **Update comments** — update comment references in `runtime.ts` and `session-config.ts` that mention `RunOptions` field names.
   Commit: `docs: update RunOptions field references in comments (#169)`

## Risks and Mitigations

| Risk                                                              | Mitigation                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Test factories using spread patterns lose context fields silently | No test factory returns `Partial<RunOptions>` — all call sites construct the options inline, so TypeScript will reject missing `context` |
| `agent-manager.test.ts` assertions on execution fields break      | Only context-field assertions change; execution-field assertions (`defaultMaxTurns`, `graceTurns`) remain on `runOpts.*`                 |
| Nested access adds verbosity to `runAgent()`                      | Only 6 access sites gain the `.context` prefix; readability trade-off is minimal for the structural clarity gained                       |

## Open Questions

None — the extraction follows the natural "where/who vs. how" seam identified in the issue body.
The issue's proposed flat `parentSessionFile`/`parentSessionId` fields have been superseded by the already-implemented `parentSession?: ParentSessionInfo` grouping from #166.
