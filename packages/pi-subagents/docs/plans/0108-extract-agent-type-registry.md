---
issue: 108
issue_title: "refactor(pi-subagents): extract AgentTypeRegistry class from module-scoped state"
---

# Extract AgentTypeRegistry class

## Problem Statement

`agent-types.ts` manages a module-scoped `Map<string, AgentConfig>` mutated by `registerAgents()` and read by 12+ call sites across 6 files.
This is global mutable state hidden behind free functions — tests must call `registerAgents(new Map())` in `beforeEach` to reset it, and `reloadCustomAgents` is threaded as a callback through `AgentToolDeps` and `AgentMenuDeps` because there is no object to own the reload.

## Goals

- Wrap the module-scoped `agents` Map and its free functions into an injectable `AgentTypeRegistry` class.
- Replace the `reloadCustomAgents` callback (threaded through 2 dependency bags) with `registry.reload()`.
- Move `DEFAULT_AGENT_NAMES` from `types.ts` to the registry (it is a constant, not a type).
- Enable test isolation without module resets — each test creates its own registry instance.
- Use lift-and-shift: introduce the class alongside the free functions, migrate consumers incrementally, then remove the free functions.

## Non-Goals

- `SettingsManager` extraction (#109) — separate Phase 7 step.
- `AgentActivityTracker` extraction (#110) — separate Phase 7 step.
- Splitting `AgentRecord` lifecycle state (#111) — separate Phase 7 step.
- Narrowing `AgentConfig` (21 fields) — tracked in the architecture doc but out of scope.
- Moving `BUILTIN_TOOL_NAMES` — it is a constant with no Map dependency, stays as a module export.

## Background

### Architecture reference

Phase 7, Step A1 in `docs/architecture/architecture.md`.
Steps A1–A3 are independent and can proceed in any order.
This plan addresses A1 only.

### Relevant modules

| Module                      | Role                                                     | agent-types dependency                                                                                                                                 |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-types.ts`            | Module-scoped `agents` Map + 11 free functions           | Owns the state                                                                                                                                         |
| `default-agents.ts`         | `DEFAULT_AGENTS` Map constant                            | Read by `registerAgents`                                                                                                                               |
| `custom-agents.ts`          | `loadCustomAgents()` → disk scan                         | Imports `BUILTIN_TOOL_NAMES`                                                                                                                           |
| `session-config.ts`         | `assembleSessionConfig()`                                | Imports `resolveAgentConfig`, `getToolNamesForType`, `getMemoryToolNames`, `getReadOnlyMemoryToolNames`                                                |
| `agent-runner.ts`           | `runAgent()` → calls `assembleSessionConfig`             | No direct import (transitive via session-config)                                                                                                       |
| `agent-manager.ts`          | `AgentManager` → calls runner                            | No direct import                                                                                                                                       |
| `tools/agent-tool.ts`       | Agent tool definition                                    | Imports `resolveAgentConfig`, `resolveType`; receives `reloadCustomAgents` via `AgentToolDeps`                                                         |
| `ui/agent-menu.ts`          | `/agents` command handler                                | Imports `BUILTIN_TOOL_NAMES`, `getAllTypes`, `resolveAgentConfig`, `resolveType`; receives `reloadCustomAgents` via `AgentMenuDeps`                    |
| `ui/agent-widget.ts`        | Widget + `getDisplayName` / `getPromptModeLabel` helpers | Imports `resolveAgentConfig`                                                                                                                           |
| `ui/conversation-viewer.ts` | Live conversation overlay                                | Imports `getDisplayName`, `getPromptModeLabel` from `agent-widget.ts`                                                                                  |
| `tools/get-result-tool.ts`  | `get_subagent_result` tool                               | Imports `getDisplayName` from `agent-widget.ts`                                                                                                        |
| `index.ts`                  | Extension entry point, wiring                            | Imports `registerAgents`, `getAvailableTypes`, `getDefaultAgentNames`, `getUserAgentNames`, `resolveAgentConfig`; defines `reloadCustomAgents` closure |

### Test files affected

| Test file                                          | Current agent-types coupling                                              | Change needed                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `agent-types.test.ts` (333 lines)                  | Tests free functions directly, calls `registerAgents()` in `beforeEach`   | Add class tests; eventually migrate free-function tests to class tests |
| `session-config.test.ts` (601 lines)               | `vi.mock("../src/agent-types.js")`                                        | Pass mock registry param, remove module mock                           |
| `agent-runner.test.ts` (302 lines)                 | `vi.mock("../src/agent-types.js")`                                        | Provide mock registry in `RunOptions`, remove module mock              |
| `agent-runner-extension-tools.test.ts` (307 lines) | `vi.mock("../src/agent-types.js")`                                        | Same as `agent-runner.test.ts`                                         |
| `tools/agent-tool.test.ts` (240 lines)             | Mocks `reloadCustomAgents` in deps                                        | Replace with `registry` in deps                                        |
| `ui/agent-menu.test.ts` (184 lines)                | `vi.mock("../../src/agent-types.js")`, mocks `reloadCustomAgents` in deps | Replace with `registry` in deps, remove module mock                    |
| `agent-widget.test.ts` (26 lines)                  | Minimal                                                                   | Pass registry to widget constructor                                    |
| `agent-manager.test.ts` (712 lines)                | No `agent-types.js` mock                                                  | Add registry to constructor options                                    |

### Constraints from AGENTS.md / code-design skill

- **ISP:** `session-config.ts` should accept a narrow interface (only `resolveAgentConfig` + `getToolNamesForType`), not the full registry class.
- **DIP:** Accept collaborators as parameters; keep IO at the edges.
- **Pi SDK boundaries:** Pure helpers must not import Pi SDK types.
- **Lift-and-shift:** Never plan a single step that rewrites an entire large test file at once.

## Design Overview

### `AgentTypeRegistry` class

```typescript
export class AgentTypeRegistry {
  private agents = new Map<string, AgentConfig>();

  constructor(private loadUserAgents: () => Map<string, AgentConfig>) {
    this.reload();
  }

  /** Re-scan custom agents from disk and merge with defaults. */
  reload(): void { /* clear + merge DEFAULT_AGENTS + loadUserAgents() */ }

  resolveAgentConfig(type: string): AgentConfig { /* ... */ }
  resolveType(name: string): string | undefined { /* ... */ }
  getAvailableTypes(): string[] { /* ... */ }
  getAllTypes(): string[] { /* ... */ }
  getDefaultAgentNames(): string[] { /* ... */ }
  getUserAgentNames(): string[] { /* ... */ }
  isValidType(type: string): boolean { /* ... */ }
  getToolNamesForType(type: string): string[] { /* ... */ }

  static readonly DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;
}
```

The constructor accepts a `loadUserAgents` callback (typically `() => loadCustomAgents(process.cwd())`).
This keeps `process.cwd()` at the edge (in `index.ts`) and makes tests trivial — they pass `() => new Map()` or a fixture.

### What stays as free functions

- **`BUILTIN_TOOL_NAMES`** — constant array, no Map dependency.
  Stays as a module-level export in `agent-types.ts`.
- **`getMemoryToolNames` / `getReadOnlyMemoryToolNames`** — pure functions over constant arrays, no Map access.
  Stay as module-level exports.

### Narrow interface for `session-config.ts`

```typescript
/** Narrow registry interface for session-config (ISP). */
export interface AgentConfigLookup {
  resolveAgentConfig(type: string): AgentConfig;
  getToolNamesForType(type: string): string[];
}
```

`assembleSessionConfig` gains a `registry: AgentConfigLookup` parameter.
Tests construct a plain object satisfying this interface — no class instantiation needed.

### Threading through the call chain

`session-config.ts` ← called by `agent-runner.ts` ← called by `AgentManager`:

1. `assembleSessionConfig(type, ctx, options, env, registry)` — new param.
2. `RunOptions` gains `registry: AgentConfigLookup`.
3. `AgentManagerOptions` gains `registry: AgentTypeRegistry`.
4. `AgentManager` stores the registry and passes it to the runner via `RunOptions`.

### Replacing `reloadCustomAgents` callback

Before:

```typescript
// index.ts
const reloadCustomAgents = () => {
  const userAgents = loadCustomAgents(process.cwd());
  registerAgents(userAgents);
};

// AgentToolDeps / AgentMenuDeps
reloadCustomAgents: () => void;
```

After:

```typescript
// index.ts
const registry = new AgentTypeRegistry(() => loadCustomAgents(process.cwd()));

// AgentToolDeps / AgentMenuDeps
registry: AgentTypeRegistry;

// Callers use:
deps.registry.reload();
```

### Display helpers (`getDisplayName`, `getPromptModeLabel`)

These functions in `agent-widget.ts` call `resolveAgentConfig(type)`.
After the extraction, they accept the registry (or a `resolveAgentConfig` callback) as a parameter.
The `AgentWidget` constructor gains a `registry` parameter and passes it to these helpers internally.
External callers (`conversation-viewer.ts`, `get-result-tool.ts`, etc.) pass the registry they already hold via their deps.

## Module-Level Changes

### New

No new files.

### Modified

1. **`src/agent-types.ts`**
   - Add `AgentTypeRegistry` class with all instance methods.
   - Add `AgentConfigLookup` interface.
   - Keep free functions temporarily (delegation shim during migration).
   - Final step: remove free functions, module-scoped `agents` Map, and `registerAgents`.

2. **`src/types.ts`**
   - Remove `DEFAULT_AGENT_NAMES` constant (moved to `AgentTypeRegistry.DEFAULT_AGENT_NAMES`).

3. **`src/session-config.ts`**
   - `assembleSessionConfig` gains a `registry: AgentConfigLookup` parameter.
   - Remove imports of `resolveAgentConfig`, `getToolNamesForType` from `agent-types.ts`.

4. **`src/agent-runner.ts`**
   - `RunOptions` gains `registry: AgentConfigLookup`.
   - `runAgent` passes `options.registry` to `assembleSessionConfig`.

5. **`src/agent-manager.ts`**
   - `AgentManagerOptions` gains `registry: AgentTypeRegistry`.
   - `AgentManager` stores `this.registry` and passes it into `RunOptions` when calling `runner.run`.

6. **`src/tools/agent-tool.ts`**
   - `AgentToolDeps`: add `registry: AgentTypeRegistry`, remove `reloadCustomAgents`.
   - Replace `resolveType(...)` / `resolveAgentConfig(...)` imports with `deps.registry.resolveType(...)` / `deps.registry.resolveAgentConfig(...)`.
   - Replace `deps.reloadCustomAgents()` with `deps.registry.reload()`.

7. **`src/ui/agent-menu.ts`**
   - `AgentMenuDeps`: add `registry: AgentTypeRegistry`, remove `reloadCustomAgents`.
   - Replace `getAllTypes()`/`resolveAgentConfig()`/`resolveType()` imports with `deps.registry.*` calls.
   - `BUILTIN_TOOL_NAMES` import stays (it is a constant, not a method).
   - Replace `deps.reloadCustomAgents()` with `deps.registry.reload()`.

8. **`src/ui/agent-widget.ts`**
   - `AgentWidget` constructor gains a `registry: AgentTypeRegistry` (or narrow interface) parameter.
   - `getDisplayName(type, registry)` / `getPromptModeLabel(type, registry)` gain a registry parameter.
   - Internal render methods use `this.registry`.

9. **`src/ui/conversation-viewer.ts`**
   - `ConversationViewer` constructor gains a registry parameter.
   - Passes it to `getDisplayName` / `getPromptModeLabel` calls.

10. **`src/tools/get-result-tool.ts`**
    - `GetResultToolDeps` (or equivalent) gains registry.
    - Passes it to `getDisplayName` calls.

11. **`src/index.ts`**
    - Construct `AgentTypeRegistry` with `() => loadCustomAgents(process.cwd())`.
    - Pass registry to `AgentManager`, agent-tool deps, menu deps, widget, get-result-tool deps.
    - Remove `reloadCustomAgents` closure.
    - Remove free-function imports (`registerAgents`, `getDefaultAgentNames`, `getUserAgentNames`, `getAvailableTypes`, `resolveAgentConfig`).
    - Use `registry.*` methods directly for `buildTypeListText`.

### Removed

- Free functions from `agent-types.ts`: `registerAgents`, `resolveType`, `resolveAgentConfig`, `getAvailableTypes`, `getAllTypes`, `getDefaultAgentNames`, `getUserAgentNames`, `isValidType`, `getToolNamesForType` (final cleanup step).
- Module-scoped `agents` Map and `resolveKey` helper.
- `DEFAULT_AGENT_NAMES` from `types.ts`.
- `reloadCustomAgents` field from `AgentToolDeps` and `AgentMenuDeps`.

## Test Impact Analysis

### New tests enabled

- **Isolation without module resets:** Each test creates its own `AgentTypeRegistry` with a fixture callback, eliminating cross-test state leakage and the `registerAgents(new Map())` ceremony.
- **Reload behavior:** Tests can verify `registry.reload()` picks up new agents without touching module state.

### Existing tests that become redundant

- The existing free-function tests in `agent-types.test.ts` become redundant once the class tests cover the same behavior.
  They can be removed in the final cleanup step.

### Existing tests that must stay

- `session-config.test.ts` — tests `assembleSessionConfig` behavior; mock setup changes from `vi.mock("agent-types.js")` to passing a mock `AgentConfigLookup` object.
- `agent-runner.test.ts`, `agent-runner-extension-tools.test.ts` — test runner behavior; mock setup changes from `vi.mock("agent-types.js")` to providing mock registry in `RunOptions`.
- `tools/agent-tool.test.ts` — tests tool handler; deps mock changes from `reloadCustomAgents: vi.fn()` to `registry: mockRegistry`.
- `ui/agent-menu.test.ts` — tests menu handler; deps mock changes similarly.
- `agent-manager.test.ts` — must add a mock registry to constructor options.

## TDD Order

1. **Create `AgentTypeRegistry` class** — Add class to `agent-types.ts` alongside existing free functions.
   Add `AgentConfigLookup` interface.
   Test all methods in a new `describe('AgentTypeRegistry')` block in `agent-types.test.ts`: construction, `reload()`, `resolveAgentConfig`, `resolveType`, `getAvailableTypes`, `getAllTypes`, `getDefaultAgentNames`, `getUserAgentNames`, `isValidType`, `getToolNamesForType`.
   - Test surface: `agent-types.test.ts` — new describe block
   - Commit: `feat(pi-subagents): add AgentTypeRegistry class (#108)`

2. **Inject through the config-assembly chain** — `assembleSessionConfig` gains `registry: AgentConfigLookup` param.
   `RunOptions` gains `registry: AgentConfigLookup`.
   `AgentManagerOptions` gains `registry: AgentTypeRegistry`.
   Construct registry in `index.ts` and pass through `AgentManager` → `runAgent` → `assembleSessionConfig`.
   Update `session-config.test.ts` (replace `vi.mock("agent-types.js")` with mock `AgentConfigLookup` object), `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` (provide mock registry in `RunOptions`, remove `vi.mock`), `agent-manager.test.ts` (add registry to constructor options).
   - Test surface: `session-config.test.ts`, `agent-runner.test.ts`, `agent-runner-extension-tools.test.ts`, `agent-manager.test.ts`
   - Commit: `refactor(pi-subagents): inject registry through config-assembly chain (#108)`

3. **Inject into agent tool** — Add `registry: AgentTypeRegistry` to `AgentToolDeps`, remove `reloadCustomAgents`.
   Replace `resolveType` / `resolveAgentConfig` module imports with `deps.registry.*` calls.
   Replace `deps.reloadCustomAgents()` with `deps.registry.reload()`.
   Update `index.ts` agent-tool deps and `tools/agent-tool.test.ts`.
   - Test surface: `tools/agent-tool.test.ts`
   - Commit: `refactor(pi-subagents): inject registry into agent tool (#108)`

4. **Inject into agent menu** — Add `registry: AgentTypeRegistry` to `AgentMenuDeps`, remove `reloadCustomAgents`.
   Replace `getAllTypes` / `resolveAgentConfig` / `resolveType` module imports with `deps.registry.*` calls.
   Replace `deps.reloadCustomAgents()` with `deps.registry.reload()`.
   Update `index.ts` menu deps and `ui/agent-menu.test.ts`.
   - Test surface: `ui/agent-menu.test.ts`
   - Commit: `refactor(pi-subagents): inject registry into agent menu (#108)`

5. **Inject into agent widget and display helpers** — `AgentWidget` constructor gains `registry`.
   `getDisplayName(type, registry)` and `getPromptModeLabel(type, registry)` gain registry parameters.
   `ConversationViewer` constructor gains registry.
   `GetResultToolDeps` gains registry for `getDisplayName` calls.
   Update `index.ts` wiring, `agent-widget.test.ts`, and any test files that call these helpers.
   - Test surface: `agent-widget.test.ts`, related callers
   - Commit: `refactor(pi-subagents): inject registry into agent widget (#108)`

6. **Move `DEFAULT_AGENT_NAMES` to registry** — Add static `DEFAULT_AGENT_NAMES` property on `AgentTypeRegistry`.
   Remove the constant from `types.ts`.
   Grep confirms no import consumers exist — the constant is defined but unused.
   - Test surface: `agent-types.test.ts` — add assertion for static property
   - Commit: `refactor(pi-subagents): move DEFAULT_AGENT_NAMES to registry (#108)`

7. **Remove free-function exports** — Delete `registerAgents`, `resolveType`, `resolveAgentConfig`, `getAvailableTypes`, `getAllTypes`, `getDefaultAgentNames`, `getUserAgentNames`, `isValidType`, `getToolNamesForType`, the module-scoped `agents` Map, and `resolveKey` helper from `agent-types.ts`.
   Remove the free-function tests from `agent-types.test.ts` (now covered by class tests).
   Remove any remaining free-function imports from `index.ts`.
   Verify with `pnpm run check` that no dangling references remain.
   - Test surface: `agent-types.test.ts` — remove old describe block
   - Commit: `refactor(pi-subagents): remove free-function exports from agent-types (#108)`

## Risks and Mitigations

| Risk                                                                                          | Impact                                         | Mitigation                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Large blast radius — 11 source files, 8 test files                                            | Merge conflicts if other PRs land concurrently | Lift-and-shift: free functions keep working until final removal; each step is a valid commit |
| `vi.mock("agent-types.js")` removal in runner tests changes behavior                          | Tests may expose latent bugs in session-config | Mock `AgentConfigLookup` with the same values the current `vi.mock` provides                 |
| Display helpers (`getDisplayName`, `getPromptModeLabel`) thread registry through many callers | Signature churn in UI layer                    | These callers already have a deps bag or constructor params — registry fits naturally        |
| `agent-types.test.ts` (333 lines) needs migration from free-function tests to class tests     | Large test rewrite in step 7                   | Step 1 creates class tests first; step 7 only deletes the now-redundant free-function tests  |
| `AgentRunner` interface change (`RunOptions` gains `registry`)                                | Breaks callers that construct `RunOptions`     | Only `agent-manager.ts` constructs `RunOptions`; single-site change                          |

## Open Questions

- **`getDisplayName` / `getPromptModeLabel` placement:** These are thin display helpers that wrap `resolveAgentConfig`.
  The plan proposes adding a registry parameter.
  An alternative is to make them methods on the registry itself (e.g., `registry.getDisplayName(type)`), trading purity for convenience.
  Decide during implementation based on how natural the call sites feel.
