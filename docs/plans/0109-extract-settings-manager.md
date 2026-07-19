---
issue: 109
issue_title: "refactor(pi-subagents): extract SettingsManager class"
---

# Extract SettingsManager class

## Problem Statement

The settings read/write/persist cycle is spread across free functions in `settings.ts` (`loadSettings`, `saveSettings`, `applySettings`, `applyAndEmitLoaded`, `saveAndEmitChanged`), a `SettingsAppliers` callback interface, and 6 settings-related fields in `AgentMenuDeps`.
The in-memory values live on two different objects (`SubagentRuntime` for `defaultMaxTurns`/`graceTurns`, `AgentManager` for `maxConcurrent`).
This is mutable state plus the methods that read and write it — a class waiting to happen.

## Goals

- Encapsulate the settings concern into a single testable `SettingsManager` class.
- Own all three in-memory settings values (`defaultMaxTurns`, `graceTurns`, `maxConcurrent`).
- Absorb the `SettingsAppliers` interface and the composite functions `applyAndEmitLoaded`, `saveAndEmitChanged`.
- Collapse the 6 settings-related fields in `AgentMenuDeps` to a single `settings` collaborator (13 → 8 fields).
- Replace `getDefaultMaxTurns` in `AgentToolDeps` with a narrow settings accessor.
- Move `maxConcurrent` ownership from `AgentManager` to `SettingsManager`; `AgentManager` reads via injected function.
- Keep pure helpers (`sanitize`, `loadSettings`, `saveSettings`, `persistToastFor`) as private/internal implementation details.
- This is a non-breaking refactoring change — no public API surface changes.

## Non-Goals

- Changing the persistence format (`subagents.json`) or the global-vs-project merge strategy.
- Extracting `AgentActivityTracker` (#110) — that is the next step in Phase 7.
- Changing the `SubagentsService` public API (`service.ts`).
- Touching `RunConfig` — it stays as-is; `SettingsManager` naturally satisfies it.

## Background

### Current module map

| Module                | Settings concern                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`         | Free functions: `loadSettings`, `saveSettings`, `applySettings`, `applyAndEmitLoaded`, `saveAndEmitChanged`, `persistToastFor`. Types: `SubagentsSettings`, `SettingsAppliers`, `SettingsEmit`.                         |
| `runtime.ts`          | `SubagentRuntime.defaultMaxTurns` and `.graceTurns` — mutable fields read by `AgentManager` via `getRunConfig`.                                                                                                         |
| `agent-manager.ts`    | `private maxConcurrent` — used for queue decisions (`spawn`, `drainQueue`). Exposed via `get/setMaxConcurrent`.                                                                                                         |
| `index.ts`            | Wires callbacks: constructs `SettingsAppliers` closures, calls `applyAndEmitLoaded` at startup, builds 6 callback fields for `AgentMenuDeps`.                                                                           |
| `ui/agent-menu.ts`    | `AgentMenuDeps` has 6 settings fields: `getDefaultMaxTurns`, `setDefaultMaxTurns`, `getGraceTurns`, `setGraceTurns`, `snapshotSettings`, `saveSettings`. `AgentMenuManager` has `getMaxConcurrent`, `setMaxConcurrent`. |
| `tools/agent-tool.ts` | `AgentToolDeps.getDefaultMaxTurns` — reads the runtime default for the Agent tool.                                                                                                                                      |

### Architecture reference

Phase 7, Step A2 in `docs/architecture/architecture.md`.
Predecessor A1 (`AgentTypeRegistry`, #108) is complete.

### Applicable constraints (from AGENTS.md / code-design)

- One concern per file — the class consolidates what is currently scattered.
- Prefer explicit configuration over hidden behavior.
- Dependency inversion — consumers accept narrow interfaces, not the concrete class.
- No output arguments — the current `SettingsAppliers` callback pattern writes into external state; the class owns the state directly.
- ES2024 target; pnpm only.

## Design Overview

### SettingsManager class

```typescript
export class SettingsManager {
  // Private fields with built-in defaults
  private _defaultMaxTurns: number | undefined = undefined;
  private _graceTurns: number = 5;
  private _maxConcurrent: number = 4; // DEFAULT_MAX_CONCURRENT

  private readonly emit: SettingsEmit;
  private readonly cwd: string;

  constructor(deps: { emit: SettingsEmit; cwd: string });

  // ── Property accessors with normalization ──
  get defaultMaxTurns(): number | undefined;
  set defaultMaxTurns(n: number | undefined);  // 0 or undefined → undefined; else max(1, n)

  get graceTurns(): number;
  set graceTurns(n: number);                    // max(1, n)

  get maxConcurrent(): number;
  set maxConcurrent(n: number);                 // max(1, n)

  // ── Lifecycle methods ──

  /** Load merged settings (global + project), apply to in-memory, emit settings_loaded. */
  load(): SubagentsSettings;

  /** Snapshot current values for persistence (defaultMaxTurns uses 0 for unlimited). */
  snapshot(): { maxConcurrent: number; defaultMaxTurns: number; graceTurns: number };

  /** Persist snapshot, emit settings_changed, return toast. */
  saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" };
}
```

The setter for `defaultMaxTurns` inlines the `normalizeMaxTurns` logic (`0 → undefined`, else `Math.max(1, n)`) to avoid a new dependency from `settings.ts` → `agent-runner.ts`.
The `normalizeMaxTurns` export in `agent-runner.ts` stays for per-invocation normalization in the Agent tool.

### maxConcurrent ownership transfer

`AgentManager` currently owns `maxConcurrent` and calls `this.drainQueue()` in `setMaxConcurrent`.
After the change:

1. `SettingsManager` owns the value.
2. `AgentManager` accepts a `getMaxConcurrent: () => number` function (injected via `AgentManagerOptions`).
   All internal reads (`spawn` queue check, `drainQueue` loop) use `this.getMaxConcurrent()` instead of `this.maxConcurrent`.
3. `AgentManager.setMaxConcurrent(n)` is replaced with `notifyConcurrencyChanged()` — it only drains the queue; the value has already been set on `SettingsManager` by the caller.
4. `AgentMenuManager` loses `getMaxConcurrent` and `setMaxConcurrent`; gains `notifyConcurrencyChanged`.
   The menu reads `settings.maxConcurrent` directly for display.

### Consumer interface narrowing

Each consumer gets the narrowest type it needs:

| Consumer                               | Interface                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentMenuDeps.settings`               | `{ maxConcurrent: number; defaultMaxTurns: number \| undefined; graceTurns: number; saveAndNotify(msg: string): { message: string; level: "info" \| "warning" } }` |
| `AgentToolDeps.settings`               | `{ readonly defaultMaxTurns: number \| undefined }`                                                                                                                |
| `AgentManagerOptions.getMaxConcurrent` | `() => number` (function, not object)                                                                                                                              |
| `AgentManagerOptions.getRunConfig`     | Unchanged — `SettingsManager` satisfies `RunConfig` structurally.                                                                                                  |

### RunConfig compatibility

`SettingsManager` has `defaultMaxTurns` and `graceTurns` as readable properties, so it structurally satisfies the existing `RunConfig` interface.
In `index.ts`, the `getRunConfig` option becomes `() => settings` (returning the `SettingsManager` instance directly).

### SubagentRuntime cleanup

`SubagentRuntime.defaultMaxTurns` and `.graceTurns` are removed.
These fields exist solely for settings; after the extraction, `SubagentRuntime` only retains session state and widget delegation.

## Module-Level Changes

### `src/settings.ts`

- **Add** `SettingsManager` class (constructor, 3 property accessors, `load`, `snapshot`, `saveAndNotify`).
- **Keep** `SubagentsSettings`, `SettingsEmit`, `loadSettings`, `saveSettings`, `sanitize`, `persistToastFor` as internal helpers (some may become unexported).
- **Remove** `SettingsAppliers` interface.
- **Remove** `applySettings`, `applyAndEmitLoaded`, `saveAndEmitChanged` functions.

### `src/runtime.ts`

- **Remove** `defaultMaxTurns` and `graceTurns` fields from `SubagentRuntime`.
- **Remove** `RunConfig` interface (no longer needed — consumers read from `SettingsManager` directly).

### `src/agent-manager.ts`

- **Change** `AgentManagerOptions`: remove `maxConcurrent?: number`; add `getMaxConcurrent?: () => number`.
- **Change** constructor: store `getMaxConcurrent` function instead of a value.
- **Replace** `private maxConcurrent: number` with `private readonly getMaxConcurrent: () => number`.
- **Replace** `setMaxConcurrent(n)` with `notifyConcurrencyChanged()` (public, just calls `drainQueue()`).
- **Keep** `getRunConfig` — wiring changes in `index.ts` to point at settings.

### `src/ui/agent-menu.ts`

- **Remove** from `AgentMenuDeps`: `getDefaultMaxTurns`, `setDefaultMaxTurns`, `getGraceTurns`, `setGraceTurns`, `snapshotSettings`, `saveSettings`.
- **Add** to `AgentMenuDeps`: `settings` with the narrow inline interface.
- **Remove** from `AgentMenuManager`: `getMaxConcurrent`, `setMaxConcurrent`.
- **Add** to `AgentMenuManager`: `notifyConcurrencyChanged: () => void`.
- **Update** `showSettings`: read from `deps.settings`, write to `deps.settings`, call `deps.manager.notifyConcurrencyChanged()` after concurrency change.
- **Update** `notifyApplied`: call `deps.settings.saveAndNotify(msg)`.

### `src/tools/agent-tool.ts`

- **Remove** `getDefaultMaxTurns` from `AgentToolDeps`.
- **Add** `settings: { readonly defaultMaxTurns: number | undefined }` to `AgentToolDeps`.
- **Update** usage: `deps.getDefaultMaxTurns()` → `deps.settings.defaultMaxTurns`.

### `src/index.ts`

- **Create** `SettingsManager` before `AgentManager`; call `.load()`.
- **Pass** `getMaxConcurrent: () => settings.maxConcurrent` to `AgentManager`.
- **Pass** `getRunConfig: () => settings` to `AgentManager`.
- **Pass** `settings` to `AgentMenuDeps` and `AgentToolDeps`.
- **Remove** the ad-hoc `applyAndEmitLoaded` call and the 6 callback fields.
- **Remove** `runtime.defaultMaxTurns` and `runtime.graceTurns` references.

## Test Impact Analysis

### New unit tests enabled

- **Integrated settings lifecycle**: construct → `load()` → mutate → `saveAndNotify()` → verify snapshot and events, all on a single object.
  Previously impossible because state was scattered across free functions, callbacks, and two separate objects.
- **Normalization in setters**: direct tests for `set defaultMaxTurns(0) → undefined`, `set graceTurns(0) → 1`, `set maxConcurrent(0) → 1`.
  Previously tested only indirectly through `applySettings` + callback mocks.
- **Snapshot consistency**: verify that `snapshot()` reflects the current in-memory state after mutations.

### Existing tests that become redundant

- `applySettings` tests — the SettingsAppliers callback pattern is removed; normalization logic moves into the class setters.
- `applyAndEmitLoaded` tests — absorbed into `SettingsManager.load()` tests.
- `saveAndEmitChanged` tests — absorbed into `SettingsManager.saveAndNotify()` tests.

### Existing tests that must stay

- All `loadSettings` / `saveSettings` / sanitizer tests — these test the I/O + validation layer, which remains as internal helpers.
- `persistToastFor` tests — pure function, still used internally by `saveAndNotify`.
- `agent-menu.test.ts` settings tests — still needed; mock shape changes from 6 fields to a settings object.
- `agent-tool.test.ts` — mock shape changes from `getDefaultMaxTurns` function to `settings` object.
- `agent-manager.test.ts` — mock shape changes from `maxConcurrent` number to `getMaxConcurrent` function.

## TDD Order

### Cycle 1: SettingsManager — constructor, defaults, get/set normalization

1. Red: test constructor produces correct defaults (`defaultMaxTurns: undefined`, `graceTurns: 5`, `maxConcurrent: 4`).
   Test setter normalization: `defaultMaxTurns = 0 → undefined`, `graceTurns = 0 → 1`, `maxConcurrent = 0 → 1`, `defaultMaxTurns = 10 → 10`.
2. Green: implement `SettingsManager` class with private fields, constructor, and property accessors.
3. Commit: `feat: add SettingsManager class with get/set normalization`

### Cycle 2: SettingsManager — load, snapshot, saveAndNotify, events

1. Red: test `load()` reads merged settings from disk, applies to in-memory values, emits `subagents:settings_loaded`.
   Test `snapshot()` returns current values with `defaultMaxTurns ?? 0`.
   Test `saveAndNotify()` persists to disk, emits `subagents:settings_changed`, returns toast.
   Test save failure returns warning-level toast.
2. Green: implement `load()`, `snapshot()`, `saveAndNotify()` using existing `loadSettings`, `saveSettings`, `persistToastFor`.
3. Commit: `feat: SettingsManager load, save, snapshot, and lifecycle events`

### Cycle 3: Narrow AgentMenuDeps — collapse 6 fields to settings

1. Red: update `makeDeps` in `agent-menu.test.ts` — replace 6 settings fields with a `settings` mock object; replace `getMaxConcurrent`/`setMaxConcurrent` on manager with `notifyConcurrencyChanged`.
   All existing menu tests fail due to mock shape change.
2. Green: update `AgentMenuDeps` and `AgentMenuManager` interfaces; update `showSettings` and `notifyApplied` to use `deps.settings`.
3. Run `pnpm run check` to verify types.
4. Commit: `refactor: collapse settings fields in AgentMenuDeps to SettingsManager`

### Cycle 4: Narrow AgentToolDeps — replace getDefaultMaxTurns

1. Red: update `makeDeps` in `agent-tool.test.ts` — replace `getDefaultMaxTurns` with `settings: { defaultMaxTurns: undefined }`.
2. Green: update `AgentToolDeps` interface; update `createAgentTool` to read `deps.settings.defaultMaxTurns`.
3. Run `pnpm run check`.
4. Commit: `refactor: replace getDefaultMaxTurns with settings in AgentToolDeps`

### Cycle 5: Move maxConcurrent from AgentManager to SettingsManager

1. Red: update `agent-manager.test.ts` — replace `maxConcurrent` option with `getMaxConcurrent` function; replace `setMaxConcurrent` calls with `notifyConcurrencyChanged`.
2. Green: update `AgentManagerOptions` (replace `maxConcurrent?: number` with `getMaxConcurrent?: () => number`), update constructor, replace `private maxConcurrent` with `private readonly getMaxConcurrent`, rename `setMaxConcurrent` → `notifyConcurrencyChanged`.
3. Run `pnpm run check`.
4. Commit: `refactor: AgentManager reads maxConcurrent from SettingsManager`

### Cycle 6: Wire SettingsManager in index.ts

1. Update `index.ts`: create `SettingsManager` before `AgentManager`; call `.load()`; pass to all consumers; remove `applyAndEmitLoaded` call and ad-hoc callback closures.
2. Run full test suite.
3. Commit: `refactor: wire SettingsManager in extension init`

### Cycle 7: Remove SubagentRuntime settings fields

1. Remove `defaultMaxTurns` and `graceTurns` from `SubagentRuntime`.
2. Remove `RunConfig` interface from `runtime.ts` (import from `settings.ts` if still needed, or inline).
3. Run `pnpm run check`.
4. Commit: `refactor: remove settings fields from SubagentRuntime`

### Cycle 8: Remove superseded free functions and types

1. Remove `SettingsAppliers`, `applySettings`, `applyAndEmitLoaded`, `saveAndEmitChanged` from `settings.ts`.
2. Remove corresponding test sections from `settings.test.ts`.
3. Make `loadSettings`, `saveSettings` unexported if no external consumers remain (keep exported if tests import them directly for the sanitizer/IO tests).
4. Run full test suite.
5. Commit: `refactor: remove superseded settings free functions and SettingsAppliers`

## Risks and Mitigations

| Risk                                                                    | Mitigation                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent` ownership transfer breaks queue drain timing            | `notifyConcurrencyChanged()` preserves the drain-on-change behavior; `AgentManager` reads via function on every queue decision, so the value is always current.                                                                   |
| Large mock updates in agent-menu.test.ts cause merge conflicts          | Lift-and-shift: cycles 1–2 add the new class without touching existing code; cycles 3–5 migrate one consumer at a time.                                                                                                           |
| `normalizeMaxTurns` logic duplicated between setter and agent-runner.ts | The setter inlines trivial normalization (`0 → undefined`, else `max(1, n)`); `normalizeMaxTurns` stays in `agent-runner.ts` for per-invocation use. Both are simple enough that duplication is cheaper than a shared dependency. |
| `RunConfig` removal from `runtime.ts` breaks imports                    | Grep all `RunConfig` imports before removing; move the type to `settings.ts` or inline at the use site if needed.                                                                                                                 |

## Open Questions

- Should `loadSettings` and `saveSettings` remain exported (for the standalone sanitizer/IO tests) or become private to the module?
  Defer until cycle 8 — check whether any test imports them directly.
