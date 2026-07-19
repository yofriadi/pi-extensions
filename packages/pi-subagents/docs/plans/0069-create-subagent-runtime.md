---
issue: 69
issue_title: "refactor: eliminate module-scope mutable state in pi-subagents — create SubagentRuntime"
---

# Create SubagentRuntime

## Problem Statement

`pi-subagents` still uses pre-refactor patterns that `pi-permission-system` eliminated in #43.
`agent-runner.ts` holds module-scope mutable `let` variables (`defaultMaxTurns`, `graceTurns`) with getter/setter pairs that are called from `settings.ts` via callback injection.
`index.ts` holds closure-scoped `let` variables (`currentCtx`, `widget`) and a `Map` (`agentActivity`) that are captured by arrow closures and cannot be tested in isolation.
Both patterns hide real dependencies behind module-scope and closure-scope state, making isolated testing impossible.

## Goals

- Introduce a `SubagentRuntime` interface and `createSubagentRuntime()` factory in a new `src/runtime.ts`.
- Move `defaultMaxTurns`, `graceTurns`, `agentActivity`, `currentCtx`, and the widget reference into the runtime.
- Thread `defaultMaxTurns` and `graceTurns` through `RunOptions` so `agent-runner.ts` reads them from its call-time options — not from module scope.
- Give `AgentManager` a config getter so it can pass runtime values in `RunOptions`.
- Reduce `index.ts` to a composition root that creates the runtime and passes it to factories — no closure-scoped mutable `let` variables remain.
- Remove the module-scope `let` declarations and getter/setter exports from `agent-runner.ts`.
- No behavior change; pure structural refactor.

## Non-Goals

- Refactoring `AgentManager` into an options-object constructor (follow-up cleanup).
- Extracting event handlers into separate files.
- Changing tool behavior or the `SubagentsService` interface.
- Changing the `SettingsAppliers` interface in `settings.ts` — the callback pattern is already clean; only the closure targets change.

## Background

### Prior art

`pi-permission-system` solved the identical problem in #43.
`src/runtime.ts` there defines an `ExtensionRuntime` interface with all mutable state, a `createExtensionRuntime()` factory, and pure helper functions like `refreshExtensionConfig(runtime, ctx)` that write to the runtime instead of module-scope variables.
The extension's `index.ts` calls `createExtensionRuntime()` once and passes the runtime to handlers and factories.
This plan follows the same pattern.

### Module-scope state in agent-runner.ts

Two `let` variables and four getter/setter exports:

```typescript
let defaultMaxTurns: number | undefined;
let graceTurns = 5;

export function getDefaultMaxTurns(): number | undefined { ... }
export function setDefaultMaxTurns(n: number | undefined): void { ... }
export function getGraceTurns(): number { ... }
export function setGraceTurns(n: number): void { ... }
```

`runAgent` reads both from module scope during the turn-limit subscription callback:

```typescript
const maxTurns = normalizeMaxTurns(
  options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns,
);
// ...
} else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
```

### Closure-scoped state in index.ts

```typescript
const agentActivity = new Map<string, AgentActivity>();
let widget: AgentWidget;
let currentCtx: { pi: unknown; ctx: unknown } | undefined;
```

`widget` is assigned *after* `AgentManager` construction, but `notifications` closes over it immediately via arrow callbacks (`(id) => widget.markFinished(id)`).
`currentCtx` is written by `session_start` and read by `createSubagentsService`.
`agentActivity` is shared across the notification system, widget, agent tool, and menu handler.

### Settings flow

`settings.ts` defines `SettingsAppliers` with three setter callbacks.
`applyAndEmitLoaded(appliers, emit)` loads persisted settings and calls them.
`index.ts` wires the appliers to `setDefaultMaxTurns` / `setGraceTurns` from `agent-runner.ts` and `manager.setMaxConcurrent`.
After this refactor, the appliers closure targets change to the runtime — the `SettingsAppliers` interface itself stays the same.

### Data flow for defaultMaxTurns / graceTurns

Current: `settings.ts → setDefaultMaxTurns() → module-scope let → runAgent reads module scope`.

After: `settings.ts → applier closure → runtime.defaultMaxTurns → AgentManager.getRunConfig() → RunOptions → runAgent reads options`.

### Relevant constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- Pi SDK imports stay out of business-logic modules — `runtime.ts` must not import Pi SDK types.
- Do not read `process.env` / `process.cwd()` inside library functions — accept as parameter.
- Narrow interfaces per consumer — do not pass a shared dependency bag when a function only uses a subset.

## Design Overview

### SubagentRuntime interface

```typescript
export interface SubagentRuntime {
  // ── Execution config (was module-scope in agent-runner.ts) ──
  defaultMaxTurns: number | undefined;
  graceTurns: number;

  // ── Session state (was closure-scoped in index.ts) ──
  currentCtx: { pi: unknown; ctx: unknown } | undefined;
  readonly agentActivity: Map<string, AgentActivity>;
  widget: AgentWidget | null;
}
```

The interface is flat (no sub-objects) to match the prior art in `pi-permission-system`.
`agentActivity` is `readonly` because the Map itself is never replaced — only its entries change.
`widget` is nullable because it is constructed after `AgentManager` and assigned later.

### createSubagentRuntime factory

```typescript
export function createSubagentRuntime(): SubagentRuntime {
  return {
    defaultMaxTurns: undefined,
    graceTurns: 5,
    currentCtx: undefined,
    agentActivity: new Map(),
    widget: null,
  };
}
```

No parameters needed — the factory returns defaults.
Tests construct a fresh runtime per test for isolation.

### RunConfig — narrow interface for agent-manager

```typescript
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
}
```

`AgentManager` receives `getRunConfig?: () => RunConfig` as a constructor parameter.
When constructing `RunOptions` for `runAgent`, it calls `getRunConfig()` and spreads the values.
During the lift-and-shift phase (before module-scope removal), `runAgent` falls back to the module-scope values when the RunOptions fields are absent.

### RunOptions changes

Two new optional fields:

```typescript
export interface RunOptions {
  // ... existing fields ...
  /** Default max turns from runtime config. Overridden by per-agent maxTurns. */
  defaultMaxTurns?: number;
  /** Grace turns after soft limit steer. */
  graceTurns?: number;
}
```

`runAgent` changes its resolution chain from:

```typescript
const maxTurns = normalizeMaxTurns(
  options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns,
);
```

To:

```typescript
const maxTurns = normalizeMaxTurns(
  options.maxTurns ?? agentConfig?.maxTurns ?? options.defaultMaxTurns,
);
const effectiveGraceTurns = options.graceTurns ?? 5;
```

### normalizeMaxTurns stays in agent-runner.ts

`normalizeMaxTurns` is a pure function used by both the runtime setter logic (in `index.ts` wire-up) and `runAgent`'s maxTurns resolution.
It stays exported from `agent-runner.ts`.

### index.ts wire-up changes

After refactoring, the extension factory:

1. Calls `createSubagentRuntime()` to get the runtime.
2. Wires `applyAndEmitLoaded` appliers to write to `runtime.defaultMaxTurns` and `runtime.graceTurns` (with normalization).
3. Passes `getRunConfig: () => ({ defaultMaxTurns: runtime.defaultMaxTurns, graceTurns: runtime.graceTurns })` to `AgentManager`.
4. Uses `runtime.agentActivity` instead of a local `const agentActivity`.
5. Uses `runtime.currentCtx` instead of a local `let currentCtx`.
6. Sets `runtime.widget = new AgentWidget(...)` instead of a local `let widget`.
7. Arrow closures in notification deps, tool deps, and menu deps reference `runtime.widget!` / `runtime.agentActivity` / `runtime.currentCtx` by capturing `runtime` by reference.

No closure-scoped `let` variables remain.

### Edge cases

- **Widget null access**: Notification system callbacks reference `runtime.widget!.markFinished(id)`.
  This is safe because notifications only fire after agents complete, which is always after widget construction.
  The `!` assertion documents the invariant.
- **currentCtx undefined**: `getCtx: () => runtime.currentCtx` behaves identically to the current `() => currentCtx` — the arrow closure captures the runtime object by reference and reads the field at call time.
- **Backward compatibility during lift-and-shift**: During intermediate steps, `runAgent` falls back to module-scope state when `options.defaultMaxTurns` / `options.graceTurns` are absent, so the test suite stays green throughout.

## Module-Level Changes

### `src/runtime.ts` (new)

- `SubagentRuntime` interface — all mutable state fields.
- `RunConfig` interface — narrow config subset for `AgentManager`.
- `createSubagentRuntime()` factory — returns a fresh runtime with defaults.

### `src/agent-runner.ts` (modified)

- Add `defaultMaxTurns?: number` and `graceTurns?: number` to `RunOptions`.
- Update `runAgent`'s maxTurns resolution to prefer `options.defaultMaxTurns` over module scope (step 2), then remove module scope entirely (step 6).
- Update `graceTurns` usage in the turn-limit callback to prefer `options.graceTurns` over module scope (step 2), then remove fallback (step 6).
- Remove `let defaultMaxTurns`, `let graceTurns`, `getDefaultMaxTurns`, `setDefaultMaxTurns`, `getGraceTurns`, `setGraceTurns` exports (step 6).
- `normalizeMaxTurns` stays exported (pure function, no state dependency).

### `src/agent-manager.ts` (modified)

- Add optional `getRunConfig?: () => RunConfig` parameter to constructor.
- In `startAgent`, call `getRunConfig?.()` and pass `defaultMaxTurns` and `graceTurns` in the `RunOptions` object given to `runAgent`.

### `src/index.ts` (modified)

- Import `createSubagentRuntime` from `./runtime.js`.
- Create `const runtime = createSubagentRuntime()` at the top of the factory.
- Replace `const agentActivity = new Map<>()` with `runtime.agentActivity`.
- Replace `let widget: AgentWidget` with `runtime.widget`.
- Replace `let currentCtx` with `runtime.currentCtx`.
- Wire `applyAndEmitLoaded` appliers to `runtime.defaultMaxTurns` / `runtime.graceTurns` with normalization.
- Pass `getRunConfig` to `AgentManager` constructor.
- Update `snapshotSettings` to read from `runtime.defaultMaxTurns` / `runtime.graceTurns`.
- Remove imports of `getDefaultMaxTurns`, `setDefaultMaxTurns`, `getGraceTurns`, `setGraceTurns` from `agent-runner.js`.
- All arrow closures in notification, tool, menu, and service deps capture `runtime` by reference.

### `test/runtime.test.ts` (new)

- Factory returns expected defaults.
- Fields are independently mutable.
- Multiple instances are isolated.

### `test/agent-runner-settings.test.ts` (modified → removed or substantially rewritten)

- Current tests exercise `setDefaultMaxTurns` / `getDefaultMaxTurns` / `setGraceTurns` / `getGraceTurns` as module-scope getters/setters.
- After step 6 removes those exports, these tests must migrate.
- `normalizeMaxTurns` tests stay as-is (the function remains exported).
- Setter-behavior tests (clamping, unlimited marker) become tests of the normalization logic applied in `index.ts` wire-up or `runtime.test.ts`.
- The `runAgent` integration with `defaultMaxTurns` / `graceTurns` is tested via RunOptions in `agent-runner.test.ts`.

### `test/agent-manager.test.ts` (modified)

- Constructor calls gain `getRunConfig` parameter (or omit it — default is no-op).
- Existing tests pass `undefined` for `getRunConfig` (backward compatible).
- New tests verify that `runAgent` receives `defaultMaxTurns` / `graceTurns` from `getRunConfig`.

## Test Impact Analysis

### New unit tests enabled by the extraction

1. `test/runtime.test.ts` — `createSubagentRuntime` factory returns correct defaults, fields are independently mutable, multiple instances don't share state.
2. `test/agent-runner.test.ts` additions — `runAgent` uses `options.defaultMaxTurns` and `options.graceTurns` when provided, with correct fallback behavior.
3. `test/agent-manager.test.ts` additions — `AgentManager` calls `getRunConfig()` and passes values in `RunOptions`.

### Existing tests that become redundant

- `test/agent-runner-settings.test.ts` tests for `setDefaultMaxTurns` / `getDefaultMaxTurns` / `setGraceTurns` / `getGraceTurns` — these getter/setter pairs are removed.
  The normalization behavior they test is preserved via `normalizeMaxTurns` (which stays) and runtime wire-up tests.

### Existing tests that stay as-is

- `test/settings.test.ts` — tests `SettingsAppliers` via mock callbacks; interface unchanged.
- `test/service-adapter.test.ts` — tests `AdapterDeps` via mock callbacks; `getCtx` interface unchanged.
- `test/agent-runner.test.ts` — existing final-output-capture and usage-callback tests are unaffected (they don't test maxTurns/graceTurns state).
- All other test files (agent-types, custom-agents, notification, renderer, tools, UI, etc.) — no dependency on the moved state.

## TDD Order

1. **Create `src/runtime.ts` with SubagentRuntime interface and factory.**
   Write `test/runtime.test.ts` testing factory defaults and instance isolation.
   Commit: `feat: add SubagentRuntime interface and factory`

2. **Add `defaultMaxTurns` and `graceTurns` to RunOptions; update `runAgent` to prefer them over module scope.**
   In `agent-runner.ts`, add two optional fields to `RunOptions`.
   Change maxTurns resolution to `options.maxTurns ?? agentConfig?.maxTurns ?? options.defaultMaxTurns ?? defaultMaxTurns` (backward compatible — module-scope fallback retained).
   Change graceTurns usage to `options.graceTurns ?? graceTurns` (module-scope fallback retained).
   Add tests in `agent-runner.test.ts` verifying that when `options.defaultMaxTurns` / `options.graceTurns` are provided, they are used.
   Run `pnpm run check` to verify types.
   Commit: `feat: thread defaultMaxTurns and graceTurns through RunOptions`

3. **Wire `AgentManager` to pass runtime config in RunOptions.**
   Add `getRunConfig?: () => RunConfig` as the 5th constructor parameter (optional, backward compatible).
   In `startAgent`, call `getRunConfig?.()` and spread into the RunOptions for `runAgent`.
   Add agent-manager test verifying `runAgent` receives the config values.
   Existing tests omit the param — green with no changes.
   Commit: `refactor: agent-manager threads run config into RunOptions`

4. **Wire SubagentRuntime into index.ts — replace closure-scoped state.**
   Import `createSubagentRuntime` and call it at the top of the factory.
   Replace `const agentActivity`, `let widget`, and `let currentCtx` with runtime fields.
   Wire settings appliers to `runtime.defaultMaxTurns` (via `normalizeMaxTurns`) and `runtime.graceTurns` (via `Math.max(1, n)`).
   Pass `getRunConfig` callback to `AgentManager`.
   Update `snapshotSettings` to read from runtime.
   Remove imports of `getDefaultMaxTurns`, `setDefaultMaxTurns`, `getGraceTurns`, `setGraceTurns`.
   Run full test suite.
   Commit: `refactor: wire SubagentRuntime into extension factory`

5. **Remove module-scope state from `agent-runner.ts`.**
   Delete `let defaultMaxTurns`, `let graceTurns`, and all four getter/setter functions.
   Remove the module-scope fallback from `runAgent`'s resolution chain — `options.defaultMaxTurns` and `options.graceTurns` are now the sole source (with hardcoded defaults as a safety net: `undefined` and `5`).
   Update `test/agent-runner-settings.test.ts`: remove tests for deleted getters/setters, keep `normalizeMaxTurns` tests.
   Run `pnpm run check` and full test suite.
   Commit: `refactor: remove module-scope mutable state from agent-runner`

6. **Final cleanup and acceptance verification.**
   Verify acceptance criteria: `agent-runner.ts` contains no module-scope mutable state.
   `index.ts` contains no closure-scoped `let` variables that outlive their initialization block.
   `SubagentRuntime` interface exists with all mutable session state.
   Tests can construct a runtime and pass it to factories without importing `index.ts`.
   Full test suite passes.
   Remove any dead imports or vestigial code.
   Commit: `refactor: finalize SubagentRuntime migration (#69)`

## Risks and Mitigations

| Risk                                                                                                                              | Mitigation                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backward-compatibility break during incremental migration — removing module-scope state before all consumers switch to RunOptions | Lift-and-shift: steps 2–3 introduce the new path alongside the old (module-scope fallback); step 5 removes the old path only after all consumers use the new path.                                                         |
| AgentManager constructor gains a 5th positional parameter — fragile and hard to read                                              | Parameter is optional with no default behavior change. Plan notes this as a follow-up cleanup (convert to options object).                                                                                                 |
| `runtime.widget!` non-null assertions in notification closures could NPE if initialization order changes                          | Assertion documents the invariant; widget is always constructed before any agent can complete. Add a defensive `if (!runtime.widget) return;` guard in the notification callbacks as a safety net.                         |
| `normalizeMaxTurns` stays in `agent-runner.ts` after getter/setter removal — unclear ownership                                    | `normalizeMaxTurns` is a pure function used by the turn-limit logic in `runAgent`. It belongs in the module that uses it. If a future refactor moves turn-limit logic, the function moves with it.                         |
| Test file `agent-runner-settings.test.ts` needs substantial rewrite — risk of losing coverage                                     | Keep `normalizeMaxTurns` tests intact (they test the same pure function). The setter/getter behavior tests are replaced by runtime factory tests and RunOptions integration tests that cover the same normalization logic. |

## Open Questions

- Should `AgentManager`'s constructor be converted from positional parameters to a named-options object?
  This is natural cleanup but widens the blast radius.
  Defer to a follow-up issue if the 5th positional parameter feels too fragile during implementation.
- Should `SubagentRuntime` include utility methods (e.g., `reset()`, `shutdown()`) for session lifecycle?
  The issue's acceptance criteria focus on state ownership, not lifecycle methods.
  Defer until a pattern of scattered resets emerges in practice.
