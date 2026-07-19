---
issue: 145
issue_title: "Decompose execute and push ExtensionContext to the boundary (Phase 9, Step M)"
---

# Decompose execute and push ctx to the boundary

## Problem Statement

`agent-tool.ts` `execute` is ~140 lines mixing three concerns: boundary extraction (~5 lines reading `ctx`), config resolution (~60 lines unpacking `resolvedConfig` field by field), and dispatch (~80 lines building 14–16 field parameter bags for `spawnBackground` and `runForeground`).
The large parameter bags exist because config resolution happens inline instead of in a dedicated function.
Meanwhile, `ExtensionContext` is threaded from `execute` through `ForegroundParams.ctx` / `BackgroundParams.ctx` into `foreground-runner` and `background-spawner`, where the only thing consumed is `sessionManager.getSessionFile()` and `sessionManager.getSessionId()`.
`AgentManager.spawn()` and `spawnAndWait()` accept `ExtensionContext` directly and call `buildParentSnapshot(ctx)` internally — but this is already a pure boundary concern that belongs at the call site.
Additionally, `execute` reaches into `ctx` for model info and session identity — these are session-scoped values that `index.ts` already captures and could inject as collaborators, removing `execute`'s need to read `ctx` beyond the UI context it already delegates to `widget.setUICtx()`.

## Goals

- Extract config resolution into a pure function (`resolveSpawnConfig`) so `execute` becomes: resolve config → dispatch.
- Inject three missing collaborators into `createAgentTool` so `execute` no longer extracts values from `ctx`:
  - `buildSnapshot: (inheritContext: boolean) => ParentSnapshot` — closure over `ctx`, wired in `index.ts`.
  - `getModelInfo: () => ModelInfo` — provides `parentModel` and `modelRegistry` for `resolveSpawnConfig`.
  - `getSessionInfo: () => { parentSessionFile: string; parentSessionId: string }` — parent session identity.
- Replace `ForegroundParams.ctx` and `BackgroundParams.ctx` with plain domain values (`parentSessionFile`, `parentSessionId`, `snapshot`).
- Change `AgentManager.spawn()` and `spawnAndWait()` to accept `ParentSnapshot` instead of `ExtensionContext`.
- Move `buildParentSnapshot(ctx)` calls to the two boundaries: `index.ts` (via closure) and `service-adapter.ts`.
- Eliminate the `vi.mock("../src/parent-snapshot.js")` in `agent-manager.test.ts`.
- Apply the dependency bag convention: dissolve `ForegroundDeps`, `BackgroundDeps`, `AdapterDeps` (each ≤3 fields) into plain parameters.
- This is a breaking internal refactor — no public API changes.

## Non-Goals

- Narrowing menu handler ctx (Step N, #146) — deferred.
- Injecting text wrapping into ConversationViewer (Step O, #147) — unrelated track.
- Observation model consolidation (Step L, #144) — independent track.
- Changing the `SubagentsService` public API in `service.ts`.

## Background

### Relevant modules

| Module                        | Current role                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `tools/agent-tool.ts`         | `execute` callback — 140 lines, mixes boundary extraction, config resolution, dispatch           |
| `tools/foreground-runner.ts`  | `runForeground()` — receives 14-field `ForegroundParams` including `ctx` with `sessionManager`   |
| `tools/background-spawner.ts` | `spawnBackground()` — receives 14-field `BackgroundParams` including `ctx` with `sessionManager` |
| `agent-manager.ts`            | `spawn()` / `spawnAndWait()` accept `ExtensionContext`, call `buildParentSnapshot()` internally  |
| `parent-snapshot.ts`          | `buildParentSnapshot(ctx)` — pure function capturing `ParentSnapshot` from ctx                   |
| `service-adapter.ts`          | Cross-extension boundary — calls `manager.spawn(session.ctx, ...)`                               |
| `invocation-config.ts`        | `resolveAgentInvocationConfig()` — merges agent config with tool params                          |
| `model-resolver.ts`           | `resolveInvocationModel()` — resolves model strings to model instances                           |
| `index.ts`                    | Extension entry point — wires `createAgentTool` deps, captures `runtime.currentCtx`              |
| `runtime.ts`                  | `SubagentRuntime` — holds session-scoped mutable state including `currentCtx`                    |

### Constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- Keep Pi SDK imports out of business-logic modules.
- Business logic should be pure functions — keep IO at the edges.

### Phase 9 context

This is Step M of Phase 9.
It has no blockers and blocks Step N (#146), which narrows menu handler ctx.
After this step, `ExtensionContext` appears only at true SDK/extension boundaries: `index.ts` closures, `service-adapter.ts`, and menu handlers.

## Design Overview

### Part 1: Extract config resolution (done)

A new pure function `resolveSpawnConfig` in `spawn-config.ts` encapsulates all config resolution logic previously inline in `execute`.
`execute` calls `resolveSpawnConfig(params, registry, modelInfo, settings)` and dispatches on the result.
This is already committed.

### Part 2: Inject collaborators and push ctx out of execute

`execute` currently reads `ctx.model`, `ctx.modelRegistry`, `ctx.sessionManager`, and passes `ctx` to `buildParentSnapshot`.
These are all session-scoped values that `index.ts` captures at session start.
Three collaborators replace the `ctx` reads:

```typescript
// Injected as plain parameters into createAgentTool:
buildSnapshot: (inheritContext: boolean) => ParentSnapshot,
getModelInfo: () => ModelInfo,
getSessionInfo: () => { parentSessionFile: string; parentSessionId: string },
```

`index.ts` wires them as closures over `runtime.currentCtx`:

```typescript
createAgentTool({
  // ... existing params ...
  buildSnapshot: (inheritContext) => buildParentSnapshot(ctx, inheritContext),
  getModelInfo: () => ({
    parentModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
  }),
  getSessionInfo: () => ({
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    parentSessionId: ctx.sessionManager.getSessionId(),
  }),
})
```

After this, `execute` touches `ctx` only for `ctx.ui` — which is already delegated via `widget.setUICtx()`.
The `ExtensionContext` import in `agent-tool.ts` is removed entirely.

### Part 3: Push ctx out of AgentManager

`AgentManager.spawn()` and `spawnAndWait()` accept `ParentSnapshot` instead of `ExtensionContext`.
The internal `buildParentSnapshot(ctx, ...)` call is removed — `snapshot` arrives pre-built from the call sites.
`service-adapter.ts` calls `buildParentSnapshot(session.ctx, ...)` at its boundary before delegating.

### Part 4: Push ctx out of foreground-runner and background-spawner

`ForegroundParams.ctx` and `BackgroundParams.ctx` are replaced by `snapshot: ParentSnapshot`, `parentSessionFile: string`, `parentSessionId: string`.
The narrow manager interfaces change from `ctx: any` to `snapshot: ParentSnapshot`.

### Part 5: Shrink params bags with ResolvedSpawnConfig

`ForegroundParams` and `BackgroundParams` carry `ResolvedSpawnConfig` instead of 10+ individual fields that were computed during config resolution.
Only dispatch-specific fields (`rawType`, `fellBack`, `toolCallId`, `displayName`) remain as separate params fields.

### Part 6: Dissolve small dependency bags

Per the dependency bag convention:

- `ForegroundDeps` (3 fields) → plain parameters on `runForeground`.
- `BackgroundDeps` (3 fields) → plain parameters on `spawnBackground`.
- `AdapterDeps` (4 fields) → plain parameters on `createSubagentsService`.
- `AgentToolDeps` → destructured in the `createAgentTool` signature; the interface stays as a named type for the test factory.

The narrow `*ManagerDeps` and `*WidgetDeps` interfaces stay — they define the contract each function needs from its collaborators.

## Module-Level Changes

### New file: `src/tools/spawn-config.ts` (done)

- `ResolvedSpawnConfig` interface.
- `ModelInfo` interface.
- `resolveSpawnConfig()` pure function.

### Modified: `src/tools/agent-tool.ts`

- `execute` shrinks from ~140 to ~20 lines.
- `ExtensionContext` import removed — `execute` no longer reads `ctx` directly (beyond `ctx.ui` via widget).
- Three new collaborator parameters: `buildSnapshot`, `getModelInfo`, `getSessionInfo`.
- Calls `resolveSpawnConfig(params, registry, getModelInfo(), settings)`.
- Calls `buildSnapshot(config.inheritContext)` for the snapshot.
- Calls `getSessionInfo()` for parent session identity.
- Passes domain values (not `ctx`) to `runForeground` / `spawnBackground`.
- `AgentToolManager.spawn` and `spawnAndWait` signatures change to accept `ParentSnapshot`.
- `AgentToolDeps` stays as a named type (used by test factory) but its fields are destructured in `createAgentTool`.

### Modified: `src/tools/foreground-runner.ts`

- `ForegroundDeps` interface removed — `runForeground` accepts `manager`, `widget`, `agentActivity` as plain parameters.
- `ForegroundParams.ctx` removed — replaced by `snapshot`, `parentSessionFile`, `parentSessionId`.
- `ForegroundManagerDeps.spawnAndWait` signature changes from `ctx: any` to `snapshot: ParentSnapshot`.
- Individual config fields move into `ResolvedSpawnConfig`.

### Modified: `src/tools/background-spawner.ts`

- `BackgroundDeps` interface removed — `spawnBackground` accepts `manager`, `widget`, `agentActivity` as plain parameters.
- `BackgroundParams.ctx` removed — replaced by `snapshot`, `parentSessionFile`, `parentSessionId`.
- `BackgroundManagerDeps.spawn` signature changes from `ctx: any` to `snapshot: ParentSnapshot`.
- Individual config fields move into `ResolvedSpawnConfig`.

### Modified: `src/agent-manager.ts`

- `spawn()` signature changes from `ctx: ExtensionContext` to `snapshot: ParentSnapshot`.
- `spawnAndWait()` signature changes from `ctx: ExtensionContext` to `snapshot: ParentSnapshot`.
- Internal `buildParentSnapshot(ctx, ...)` call removed.
- Imports of `ExtensionContext` and `buildParentSnapshot` removed.

### Modified: `src/service-adapter.ts`

- `AdapterDeps` interface removed — `createSubagentsService` accepts plain parameters.
- `AgentManagerLike.spawn` signature changes from `ctx: unknown` to `snapshot: ParentSnapshot`.
- `spawn()` method calls `buildParentSnapshot(session.ctx, options?.inheritContext)` before delegating.
- Adds imports of `buildParentSnapshot` and `ParentSnapshot`.

### Modified: `src/index.ts`

- Wiring for `createAgentTool` adds three collaborator closures: `buildSnapshot`, `getModelInfo`, `getSessionInfo`.
- `manager.spawn` / `spawnAndWait` wiring adapters removed (closures no longer need to relay `ctx`).
- Wiring for `createSubagentsService` changes from bag to plain arguments.

## Test Impact Analysis

### New unit tests enabled

- `spawn-config.test.ts` (done) — pure-function tests for `resolveSpawnConfig`.

### Existing tests that simplify

- `agent-manager.test.ts` — the `vi.mock("../src/parent-snapshot.js")` block is removed.
  All tests pass a plain `ParentSnapshot` object directly instead of `mockCtx`.
- `foreground-runner.test.ts` — `makeCtx()` helper removed; plain strings for session identity.
- `background-spawner.test.ts` — same as foreground.
- `agent-tool.test.ts` — `makeCtx()` simplified; collaborator stubs replace `ctx.model` / `ctx.modelRegistry` reads.
- `service-adapter.test.ts` — adapter test setup changes from bag to plain parameters.

### Existing tests that stay

- `parent-snapshot.test.ts` — unchanged; `buildParentSnapshot` is still a standalone pure function.

## TDD Order

### Step 1: Extract resolveSpawnConfig (done)

1. ~~Write `spawn-config.test.ts`, implement `spawn-config.ts`.~~
   Commit: `feat: extract resolveSpawnConfig pure function (#145)` ✓

2. ~~Rewire `execute` to call `resolveSpawnConfig`.~~
   Commit: `refactor: use resolveSpawnConfig in execute (#145)` ✓

### Step 2: Push ctx out of AgentManager

3. Red: update `agent-manager.test.ts` — replace `mockCtx` with a plain `ParentSnapshot` object, remove `vi.mock("../src/parent-snapshot.js")`.
   Green: change `AgentManager.spawn()` and `spawnAndWait()` to accept `ParentSnapshot`.
   Update `agent-tool.ts` manager interface, `service-adapter.ts` to call `buildParentSnapshot` at its boundary, and `index.ts` wiring.
   Commit: `refactor: AgentManager accepts ParentSnapshot instead of ExtensionContext (#145)`

### Step 3: Inject collaborators into createAgentTool

4. Red: update `agent-tool.test.ts` — add `buildSnapshot`, `getModelInfo`, `getSessionInfo` stubs to `createToolDeps`; simplify `makeCtx()`.
   Green: add three collaborator parameters to `createAgentTool`; rewrite `execute` to use them instead of `ctx.model` / `ctx.modelRegistry` / `ctx.sessionManager`.
   Remove `ExtensionContext` import from `agent-tool.ts`.
   Update `index.ts` wiring to provide closures.
   Commit: `refactor: inject collaborators into createAgentTool, eliminate ctx reads (#145)`

### Step 4: Push ctx out of foreground-runner and background-spawner

5. Red: update `foreground-runner.test.ts` — remove `makeCtx()`, replace `ForegroundParams.ctx` with `snapshot` / `parentSessionFile` / `parentSessionId`.
   Green: change `ForegroundParams` to use plain domain values, update `runForeground` accordingly.
   Commit: `refactor: foreground-runner receives domain values instead of ctx (#145)`

6. Red: update `background-spawner.test.ts` — remove `makeCtx()`, replace `BackgroundParams.ctx` with `snapshot` / `parentSessionFile` / `parentSessionId`.
   Green: change `BackgroundParams` to use plain domain values, update `spawnBackground` accordingly.
   Commit: `refactor: background-spawner receives domain values instead of ctx (#145)`

### Step 5: Shrink params bags with ResolvedSpawnConfig

7. Red: update `foreground-runner.test.ts` `makeParams()` to use `ResolvedSpawnConfig` fields.
   Green: change `ForegroundParams` to carry `ResolvedSpawnConfig`.
   Update `agent-tool.ts` dispatch to pass the config through.
   Commit: `refactor: ForegroundParams carries ResolvedSpawnConfig (#145)`

8. Red: update `background-spawner.test.ts` `makeParams()` to use `ResolvedSpawnConfig` fields.
   Green: change `BackgroundParams` to carry `ResolvedSpawnConfig`.
   Update `agent-tool.ts` dispatch to pass the config through.
   Commit: `refactor: BackgroundParams carries ResolvedSpawnConfig (#145)`

### Step 6: Dissolve small dependency bags

9. Red: update `foreground-runner.test.ts` calls to pass `manager`, `widget`, `agentActivity` as plain args.
   Green: remove `ForegroundDeps` interface, change `runForeground` signature.
   Commit: `refactor: dissolve ForegroundDeps into plain parameters (#145)`

10. Red: update `background-spawner.test.ts` calls to pass plain args.
    Green: remove `BackgroundDeps` interface, change `spawnBackground` signature.
    Commit: `refactor: dissolve BackgroundDeps into plain parameters (#145)`

11. Red: update `service-adapter.test.ts` to pass plain parameters instead of `AdapterDeps` bag.
    Green: remove `AdapterDeps` interface, change `createSubagentsService` signature.
    Update `index.ts` wiring call site.
    Commit: `refactor: dissolve AdapterDeps into plain parameters (#145)`

12. Refactor: destructure `AgentToolDeps` in `createAgentTool` signature (keep the named type for test factory).
    Commit: `refactor: destructure AgentToolDeps in createAgentTool (#145)`

### Step 7: Final verification

13. Run full test suite and type check.

## Risks and Mitigations

| Risk                                                                  | Mitigation                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wide blast radius — touches 7+ source files and 5+ test files         | Incremental TDD steps; each commit leaves the repo green                                                                                                                        |
| `service-adapter.ts` now imports `buildParentSnapshot` — new coupling | Acceptable: the adapter is already a boundary module that bridges `ExtensionContext` to domain types                                                                            |
| `ResolvedSpawnConfig` could become a new "god object"                 | It is a pure data return from a single function; consumers destructure what they need                                                                                           |
| Three new collaborators grow `AgentToolDeps` from 6 to 9 fields       | The deps bag is destructured at the signature; the named type exists only for the test factory. The real dependency count stays the same — previously hidden behind `ctx` reads |
| `index.ts` closures capture `ctx` — stale reference risk              | Same pattern `service-adapter.ts` already uses via `runtime.currentCtx`; session lifecycle clears on shutdown                                                                   |

## Open Questions

- The exact boundary between fields that stay in `ForegroundParams` / `BackgroundParams` vs. fields that move into `ResolvedSpawnConfig` may shift during implementation.
  The guiding principle: if the field is computed during config resolution, it belongs in `ResolvedSpawnConfig`; if it is dispatch-specific (e.g., `toolCallId`, `signal`, `onUpdate`), it stays in the params type.
