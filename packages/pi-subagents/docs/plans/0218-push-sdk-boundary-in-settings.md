---
issue: 218
issue_title: "Push SDK boundary in settings.ts (Phase 13, Step 5)"
---

# Push SDK boundary in settings.ts

## Problem Statement

`settings.ts` imports `getAgentDir` from the Pi SDK (`@earendil-works/pi-coding-agent`) and calls it inside `globalPath()` at invocation time.
This hides a platform dependency inside a module that is otherwise pure configuration logic — violating the project's SDK-boundary rule that pure helpers and domain modules should remain SDK-independent.
The SDK call also forces tests to redirect the env var `PI_CODING_AGENT_DIR` to control `getAgentDir()` output, rather than passing the value directly.

## Goals

- Remove the `getAgentDir` import from `settings.ts` (0 Pi SDK imports).
- Inject `agentDir: string` into `SettingsManager` constructor deps.
- Make `loadSettings` accept `agentDir` as an explicit parameter.
- Eliminate `PI_CODING_AGENT_DIR` env var manipulation from all settings tests.

## Non-Goals

- Removing `process.cwd()` defaults from `loadSettings`/`saveSettings` — that's a separate concern (Node.js API, not Pi SDK).
- Pushing SDK boundaries in other files (`skill-loader.ts`, `custom-agents.ts`, `agent-runner.ts`) — tracked separately in the Phase 13 roadmap.
- Changing the `saveSettings` signature — it only calls `projectPath(cwd)` and has no SDK dependency.

## Background

`settings.ts` exports a `SettingsManager` class and two free functions (`loadSettings`, `saveSettings`).
The only SDK import is `getAgentDir`, used in the private `globalPath()` helper to compute the global settings file path (`~/.pi/agent/subagents.json`).

The `SettingsManager` constructor already accepts a deps bag `{ emit, cwd, onMaxConcurrentChanged? }`.
Adding `agentDir` to this bag follows the established injection pattern.

In `index.ts`, `getAgentDir` is already imported for several other call sites (agent runner IO, agent tool, `/agents` menu).
Adding one more usage to the `SettingsManager` construction is zero new imports.

### Relevant AGENTS.md constraints

- **Pi SDK boundaries:** Keep Pi SDK imports out of business-logic modules; accept the value as a parameter or callback.
- **Code-design skill, DIP:** Default to dependency injection for non-trivial dependencies.

## Design Overview

### Change to `globalPath()`

Currently:

```typescript
function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}
```

After:

```typescript
function globalPath(agentDir: string): string {
  return join(agentDir, "subagents.json");
}
```

### Change to `loadSettings()`

Currently:

```typescript
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}
```

After:

```typescript
export function loadSettings(agentDir: string, cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath(agentDir)), ...readSettingsFile(projectPath(cwd)) };
}
```

### Change to `SettingsManager` constructor

Add `agentDir: string` to the deps bag:

```typescript
constructor(deps: { emit: SettingsEmit; cwd: string; agentDir: string; onMaxConcurrentChanged?: () => void }) {
  this.emit = deps.emit;
  this.cwd = deps.cwd;
  this.agentDir = deps.agentDir;
  this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
}
```

`SettingsManager.load()` passes `this.agentDir` to `loadSettings`:

```typescript
load(): SubagentsSettings {
  const settings = loadSettings(this.agentDir, this.cwd);
  // ... rest unchanged
}
```

### Wiring in `index.ts`

```typescript
const settings = new SettingsManager({
  emit: (event, payload) => pi.events.emit(event, payload),
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  onMaxConcurrentChanged: () => manager.notifyConcurrencyChanged(),
});
```

## Module-Level Changes

### `src/settings.ts`

1. Remove `import { getAgentDir } from "@earendil-works/pi-coding-agent"`.
2. Add `agentDir: string` field to the `SettingsManager` constructor deps interface.
3. Store `this.agentDir = deps.agentDir` as a private readonly field.
4. Change `globalPath()` signature to `globalPath(agentDir: string)`.
5. Change `loadSettings` signature to `loadSettings(agentDir: string, cwd?: string)`.
6. Update `SettingsManager.load()` to call `loadSettings(this.agentDir, this.cwd)`.
7. Update the header comment to reflect the new injection pattern.

### `src/index.ts`

1. Add `agentDir: getAgentDir()` to the `SettingsManager` constructor deps object.

### `test/settings.test.ts`

1. Remove all `PI_CODING_AGENT_DIR` env manipulation (`originalAgentDirEnv`, `beforeEach`/`afterEach` stubs).
2. Pass `globalDir` directly to `loadSettings(globalDir, projectDir)` in free-function tests.
3. Add `agentDir: globalDir` (or a dummy string for non-load tests) to all `new SettingsManager(...)` calls.
4. In `SettingsManager.load()` tests, pass `agentDir: globalDir` to the constructor.
5. In tests that don't exercise `load()`, use `agentDir: "/nonexistent"` or similar — the value is unused.

## Test Impact Analysis

1. **New capability:** Free-function tests (`loadSettings`, `saveSettings`) become pure — pass `globalDir` directly instead of manipulating `PI_CODING_AGENT_DIR`.
   This is simpler and more reliable.
2. **Redundant cleanup:** The `originalAgentDirEnv` save/restore pattern in `beforeEach`/`afterEach` can be removed from all `describe` blocks that use it.
3. **Existing tests stay:** All existing test scenarios remain valid; only their setup mechanics change.

## TDD Order

1. **Red → Green:** Change `loadSettings` signature to accept `agentDir` parameter; update `globalPath` to accept it.
   Update all free-function tests to pass `globalDir` directly instead of env var.
   Remove env-var manipulation from the `settings persistence` describe block.
   Commit: `feat: inject agentDir into loadSettings to remove SDK dependency`

2. **Red → Green:** Add `agentDir` to `SettingsManager` constructor deps; store as private field; thread into `load()`.
   Update all `new SettingsManager(...)` call sites in tests.
   Remove env-var manipulation from `SettingsManager` describe blocks.
   Remove `getAgentDir` import from `settings.ts`.
   Commit: `feat: inject agentDir into SettingsManager constructor`

3. **Green:** Wire `agentDir: getAgentDir()` into `SettingsManager` construction in `index.ts`.
   Run `pnpm run check` to confirm no type errors across the package.
   Commit: `feat: wire agentDir from SDK boundary in index.ts (#218)`

## Risks and Mitigations

| Risk                                                                                  | Mitigation                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Breaking the `loadSettings` export signature for hypothetical external callers        | The function is only called from `SettingsManager.load()` and tests; no external consumers exist.            |
| Test count is high (~35 constructor sites) — mechanical updates could introduce typos | Steps 1 and 2 are focused; run `pnpm vitest run test/settings.test.ts` after each to confirm.                |
| Forgetting a test site that still manipulates `PI_CODING_AGENT_DIR`                   | Grep for `PI_CODING_AGENT_DIR` after step 2 to confirm zero remaining references in `test/settings.test.ts`. |

## Open Questions

None — the issue's proposed change is unambiguous and follows the established injection pattern used in prior Phase 13 steps.
