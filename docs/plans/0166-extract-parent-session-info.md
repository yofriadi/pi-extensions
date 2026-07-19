---
issue: 166
issue_title: "refactor(pi-subagents): extract ParentSessionInfo from AgentSpawnConfig (13 fields)"
---

# Extract ParentSessionInfo from AgentSpawnConfig

## Problem Statement

`AgentSpawnConfig` in `agent-manager.ts` has 13 fields.
Three of those fields — `parentSessionFile`, `parentSessionId`, and `toolCallId` — form a natural cluster around parent session identity.
They always travel together through `agent-tool.ts` → `foreground-runner.ts` / `background-spawner.ts` → `AgentManager.spawn()`.
Extracting them into a named value object reduces `AgentSpawnConfig` from 13 to 11 fields (10 + 1 nested) and introduces the `ParentSessionInfo` domain concept.

## Goals

- Extract `ParentSessionInfo` interface with `parentSessionFile`, `parentSessionId`, and `toolCallId`.
- Replace the three flat optional fields on `AgentSpawnConfig` with a single optional `parentSession?: ParentSessionInfo` field.
- Replace the flat fields on `BackgroundParams`, `ForegroundParams`, and `RunOptions` with the same grouped type.
- Update all callers (agent-tool, foreground-runner, background-spawner, agent-manager, agent-runner) and their tests.
- Non-breaking refactor — no public API changes (the `SubagentsService` boundary does not expose these fields).

## Non-Goals

- Changing the `NotificationState` or `notification` module — they remain as-is; `toolCallId` is just extracted from the group at the `AgentManager.spawn` boundary.
- Further decomposition of `AgentSpawnConfig` (e.g., extracting execution or callback clusters) — tracked separately.
- Modifying `session-dir.ts` or `deriveSubagentSessionDir` — the function signature stays the same; callers just unwrap `parentSession.parentSessionFile` before calling it.

## Background

Issue #165 (closed) decomposed `ResolvedSpawnConfig` into `SpawnIdentity`, `SpawnExecution`, and `SpawnPresentation`.
This issue continues that structural improvement by grouping the parent-session fields that flow from `agent-tool.ts` through to `agent-runner.ts`.

The three fields are:

- `parentSessionFile` — path to the parent session's JSONL file, used by `deriveSubagentSessionDir` to place child sessions next to the parent.
- `parentSessionId` — session ID of the parent agent, stored in the child session's `parentSession` header via `sessionManager.newSession()`.
- `toolCallId` — tool call ID for background notification wiring; when set, `AgentManager.spawn` creates a `NotificationState`.

All three originate in `agent-tool.ts`'s `execute` function and are threaded unchanged through intermediate modules.

### Current flow

```text
agent-tool execute → getSessionInfo() + toolCallId param
  → BackgroundParams { parentSessionFile, parentSessionId, toolCallId }
  → spawnBackground → manager.spawn(opts: AgentSpawnConfig { ...flat fields })
    → AgentManager.spawn → options.toolCallId → NotificationState
    → startAgent → runner.run(RunOptions { parentSessionFile, parentSessionId })
      → deriveSessionDir(parentSessionFile, ...)
      → sessionManager.newSession({ parentSession: parentSessionId })

  → ForegroundParams { parentSessionFile, parentSessionId }
  → runForeground → manager.spawnAndWait(opts: AgentSpawnConfig { ...flat fields })
    → (same AgentManager path)
```

### After extraction

```text
agent-tool execute → getSessionInfo() + toolCallId param
  → parentSession: ParentSessionInfo { parentSessionFile, parentSessionId, toolCallId }
  → BackgroundParams { parentSession }
  → spawnBackground → manager.spawn(opts: AgentSpawnConfig { parentSession })
    → AgentManager.spawn → parentSession.toolCallId → NotificationState
    → startAgent → runner.run(RunOptions { parentSession })
      → deriveSessionDir(parentSession?.parentSessionFile, ...)
      → sessionManager.newSession({ parentSession: parentSession?.parentSessionId })

  → ForegroundParams { parentSession }
  → runForeground → manager.spawnAndWait(opts: AgentSpawnConfig { parentSession })
    → (same AgentManager path)
```

## Design Overview

### `ParentSessionInfo` interface

```typescript
export interface ParentSessionInfo {
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
  /** Tool call ID for background notification wiring. When set, spawn attaches NotificationState. */
  toolCallId?: string;
}
```

All three fields remain optional — they are only available when spawning from an active session (the `SubagentsService` boundary omits them entirely).

The interface lives in `lifecycle/agent-manager.ts` alongside `AgentSpawnConfig` since that is the primary consumer.
If a future refactoring moves `AgentSpawnConfig` to its own file, `ParentSessionInfo` should move with it.

### Consumer call-site sketch

```typescript
// agent-tool.ts execute():
const parentSession: ParentSessionInfo = {
  parentSessionFile: sessionInfo.parentSessionFile,
  parentSessionId: sessionInfo.parentSessionId,
  toolCallId,
};
// ...
spawnBackground(manager, widget, agentActivity, { config, snapshot, parentSession });
```

The grouped object eliminates the three-field spread that was repeated in both `spawnBackground` and `runForeground` call sites.

### `AgentSpawnConfig` change

```typescript
export interface AgentSpawnConfig {
  // ... existing fields (description, model, maxTurns, etc.)
  /** Parent session identity — grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
  // Remove: parentSessionFile, parentSessionId, toolCallId
}
```

### `RunOptions` change

```typescript
export interface RunOptions {
  // ... existing fields
  /** Parent session identity (file path + session ID). */
  parentSession?: ParentSessionInfo;
  // Remove: parentSessionFile, parentSessionId
}
```

Note: `RunOptions` does not use `toolCallId` — it was never threaded to the runner.
The runner only reads `parentSessionFile` and `parentSessionId` from the group.

### `getSessionInfo` return type update

The `getSessionInfo` callback in `AgentToolDeps` currently returns `{ parentSessionFile: string; parentSessionId: string }`.
It should remain unchanged — it does not include `toolCallId` (which comes from the `execute` callback's first argument).
The `agent-tool.ts` execute function constructs a `ParentSessionInfo` by merging `getSessionInfo()` output with `toolCallId`.

## Module-Level Changes

### New types

1. `src/lifecycle/agent-manager.ts` — add `ParentSessionInfo` interface (exported).

### Modified interfaces

1. `src/lifecycle/agent-manager.ts` — `AgentSpawnConfig`: replace `parentSessionFile?`, `parentSessionId?`, `toolCallId?` with `parentSession?: ParentSessionInfo`.
2. `src/lifecycle/agent-runner.ts` — `RunOptions`: replace `parentSessionFile?`, `parentSessionId?` with `parentSession?: ParentSessionInfo`.
3. `src/tools/background-spawner.ts` — `BackgroundParams`: replace `parentSessionFile`, `parentSessionId`, `toolCallId` with `parentSession: ParentSessionInfo`.
4. `src/tools/foreground-runner.ts` — `ForegroundParams`: replace `parentSessionFile`, `parentSessionId` with `parentSession: ParentSessionInfo`.

### Modified implementations

1. `src/lifecycle/agent-manager.ts` — `AgentManager.spawn()`: read `options.parentSession?.toolCallId` instead of `options.toolCallId`; pass `parentSession` to `RunOptions`.
2. `src/lifecycle/agent-runner.ts` — `runAgent()`: read `options.parentSession?.parentSessionFile` and `options.parentSession?.parentSessionId`.
3. `src/tools/agent-tool.ts` — `createAgentTool` execute: construct `ParentSessionInfo` from `getSessionInfo()` + `toolCallId`, pass as `parentSession` to both spawners.
4. `src/tools/background-spawner.ts` — `spawnBackground()`: read `params.parentSession` and pass fields to `AgentSpawnConfig`.
5. `src/tools/foreground-runner.ts` — `runForeground()`: read `params.parentSession` and pass fields to `AgentSpawnConfig`.

### No changes needed

- `src/tools/agent-tool.ts` — `AgentToolDeps.getSessionInfo` return type stays the same.
- `src/session/session-dir.ts` — `deriveSubagentSessionDir` signature unchanged.
- `src/observation/notification-state.ts` — constructor signature unchanged.
- `src/service/service-adapter.ts` — does not pass parent session fields.
- `src/index.ts` — `getSessionInfo` callback unchanged.

## Test Impact Analysis

### New tests enabled

No new unit tests are enabled — this is a structural grouping, not new behavior.

### Existing tests that need updates

1. `test/lifecycle/agent-manager.test.ts` — update spawn calls from flat `parentSessionFile`/`parentSessionId`/`toolCallId` to nested `parentSession: { ... }` form; update assertions to read from `parentSession`.
2. `test/lifecycle/agent-runner.test.ts` — update `RunOptions` construction from flat to nested `parentSession`.
3. `test/tools/agent-tool.test.ts` — update assertion checking `toolCallId` on spawn opts to check `parentSession.toolCallId`.
4. `test/tools/background-spawner.test.ts` — update `makeParams` factory from flat fields to `parentSession: { ... }`.
5. `test/tools/foreground-runner.test.ts` — update params construction from flat fields to `parentSession: { ... }`.
6. `test/helpers/make-deps.ts` — `getSessionInfo` mock stays unchanged (returns flat `{ parentSessionFile, parentSessionId }`).

### Tests that stay as-is

- `test/session/session-dir.test.ts` — tests `deriveSubagentSessionDir` directly, no interface change.
- `test/observation/notification-state.test.ts` — tests `NotificationState` constructor directly.
- `test/observation/notification.test.ts` — tests notification formatting with `record.notification`, not spawn config.

## TDD Order

1. **Define `ParentSessionInfo` and update `AgentSpawnConfig`** — add interface, replace three flat fields with `parentSession?`.
   Update `AgentManager.spawn` and `startAgent` to read from the nested group.
   Update `agent-manager.test.ts` to use nested form.
   Run `pnpm run check` to verify no downstream type errors remain.
   Commit: `refactor: define ParentSessionInfo and nest in AgentSpawnConfig`

2. **Update `RunOptions` in `agent-runner.ts`** — replace flat `parentSessionFile?`/`parentSessionId?` with `parentSession?`.
   Update `runAgent` to read `options.parentSession?.parentSessionFile` and `options.parentSession?.parentSessionId`.
   Update `agent-runner.test.ts`.
   Commit: `refactor: nest ParentSessionInfo in RunOptions`

3. **Update `BackgroundParams` and `spawnBackground`** — replace three flat fields with `parentSession: ParentSessionInfo`.
   Update `spawnBackground` to pass `parentSession` to spawn opts.
   Update `background-spawner.test.ts`.
   Commit: `refactor: nest ParentSessionInfo in BackgroundParams`

4. **Update `ForegroundParams` and `runForeground`** — replace two flat fields with `parentSession: ParentSessionInfo`.
   Update `runForeground` to pass `parentSession` to spawn opts.
   Update `foreground-runner.test.ts`.
   Commit: `refactor: nest ParentSessionInfo in ForegroundParams`

5. **Update `agent-tool.ts` execute** — construct `ParentSessionInfo` from `getSessionInfo()` + `toolCallId`, pass as `parentSession` to both spawner call sites.
   Update `agent-tool.test.ts`.
   Commit: `refactor: construct ParentSessionInfo in agent-tool execute`

6. **Final verification** — run full test suite (`pnpm vitest run`) and type check (`pnpm run check`).
   No separate commit unless adjustments are needed.

## Risks and Mitigations

| Risk                                                                                                          | Mitigation                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Deep-merge trap: test factories using `Partial<BackgroundParams>` spread may silently ignore nested overrides | Audit `makeParams` in `background-spawner.test.ts` — convert from flat-field spread to nested `parentSession` construction           |
| `toolCallId` conditionally absent for foreground calls                                                        | `ParentSessionInfo.toolCallId` is optional; `ForegroundParams.parentSession` includes it but won't set it — matches current behavior |
| Type check passes but runtime breaks due to nested access on undefined                                        | `parentSession?` is optional on `AgentSpawnConfig`; all reads use optional chaining (`options.parentSession?.toolCallId`)            |

## Open Questions

None — the extraction is mechanical and the issue description is unambiguous.
