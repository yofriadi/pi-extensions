---
issue: 80
issue_title: "refactor: consolidate getConfig / getAgentConfig into a single resolution path"
---

# Consolidate agent config lookup into resolveAgentConfig

## Problem Statement

`agent-types.ts` exports two overlapping lookup functions:

- `getConfig(type)` — returns a narrow shape (`displayName`, `description`, `builtinToolNames`, `extensions`, `skills`, `promptMode`) with a guaranteed-non-null fallback chain (unknown → general-purpose → absolute fallback).
- `getAgentConfig(type)` — returns the full `AgentConfig | undefined`.

Every field `getConfig()` returns also exists on `AgentConfig`.
Callers that need both must call both and keep them in sync:

```typescript
const config = getConfig(type);
const agentConfig = getAgentConfig(type);
```

This showed up concretely in `session-config.ts` (extracted in #71), where the assembler calls both, then handles the `agentConfig === undefined` fallback separately — duplicating the same fallback chain that `getConfig()` already handles internally.
Test mocks must also set up both `mockGetConfig` and `mockGetAgentConfig` with compatible values, which is error-prone.

## Goals

- Add a single `resolveAgentConfig(type): AgentConfig` function that returns a guaranteed-non-null `AgentConfig`, handling the fallback chain internally (unknown → general-purpose → absolute fallback).
- Migrate all callers of `getConfig()` and `getAgentConfig()` to `resolveAgentConfig()`.
- Remove `getConfig()` and `getAgentConfig()`.
- Simplify test mocks from two compatible stubs to one.

This is a pure internal refactor — no behavior change, no public API impact (the package's `exports` only expose `service.ts`).

## Non-Goals

- Changing the `AgentConfig` type shape.
- Refactoring `getToolNamesForType()` (it has its own lookup logic and is a separate concern).
- Modifying the public API surface (`service.ts`).
- Changing the fallback semantics (the chain stays: type → general-purpose → absolute fallback).

## Background

### Relevant modules

| Module                | Role                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `agent-types.ts`      | Unified agent type registry — owns `getConfig`, `getAgentConfig`, `resolveType`, `getToolNamesForType`, `isValidType` |
| `session-config.ts`   | Pure configuration assembler — calls both `getConfig` + `getAgentConfig`                                              |
| `ui/agent-widget.ts`  | Widget rendering — calls `getConfig` via `getDisplayName()` and `getPromptModeLabel()` helpers                        |
| `index.ts`            | Extension entry point — calls `getAgentConfig` (3 sites) for type listing and model label                             |
| `tools/agent-tool.ts` | Agent tool handler — calls `getAgentConfig` (1 site) after `resolveType()`                                            |
| `ui/agent-menu.ts`    | Agent menu UI — calls `getAgentConfig` (5 sites) for listing, detail, and existence checks                            |

### Current caller inventory

Source files that import `getConfig` or `getAgentConfig`:

| File                  | `getConfig` calls | `getAgentConfig` calls | Notes                                         |
| --------------------- | ----------------- | ---------------------- | --------------------------------------------- |
| `session-config.ts`   | 1                 | 1                      | Primary motivation; dual-call pattern         |
| `ui/agent-widget.ts`  | 2 (via helpers)   | 0                      | `getDisplayName()`, `getPromptModeLabel()`    |
| `index.ts`            | 0                 | 3                      | Iterates known names; `?.` is defensive       |
| `tools/agent-tool.ts` | 0                 | 1                      | After `resolveType()` — guaranteed to exist   |
| `ui/agent-menu.ts`    | 0                 | 5                      | 3 iterate known names; 2 are existence guards |

Test files that mock `agent-types.js` with both functions:

| Test file                              | Mocks `getConfig` | Mocks `getAgentConfig` |
| -------------------------------------- | ----------------- | ---------------------- |
| `session-config.test.ts`               | ✓                 | ✓                      |
| `agent-runner.test.ts`                 | ✓                 | ✓                      |
| `agent-runner-extension-tools.test.ts` | ✓                 | ✓                      |

### Caller migration notes

- **`session-config.ts`**: Replace both calls with one `resolveAgentConfig(type)`.
  Read `extensions` and `skills` directly from the returned `AgentConfig` instead of the narrow shape.
  The prompt-building fallback (`agentConfig` null → use `DEFAULT_AGENTS.get("general-purpose")`) collapses into the single call since `resolveAgentConfig` already handles the fallback.
- **`ui/agent-widget.ts`**: `getDisplayName()` becomes `resolveAgentConfig(type).displayName ?? resolveAgentConfig(type).name` (or cache the result).
  `getPromptModeLabel()` reads `.promptMode` from the resolved config.
- **`index.ts`**: All 3 call sites iterate names from `getDefaultAgentNames()` or `getUserAgentNames()` — configs are guaranteed to exist.
  Direct replacement with `resolveAgentConfig()`.
- **`tools/agent-tool.ts`**: Called after `resolveType()` — config guaranteed.
  Direct replacement.
- **`ui/agent-menu.ts`**: 3 of 5 calls iterate `getAllTypes()` — configs guaranteed.
  The 2 defensive existence guards (lines 187, 248) switch to `resolveType(name) != null` checks, then use `resolveAgentConfig()` for the config.

### Constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- Use `vi.hoisted()` for module-level mocks, `.mockClear()` when the factory provides a default.
- Run `pnpm run check` after interface changes.

## Design Overview

### `resolveAgentConfig` semantics

```typescript
export function resolveAgentConfig(type: string): AgentConfig
```

1. Case-insensitive key lookup via `resolveKey(type)`.
2. If found and `enabled !== false`, return the `AgentConfig`.
3. Fallback to `general-purpose` (if present and enabled).
4. Absolute fallback: a synthetic `AgentConfig` with safe defaults (same values as today's `getConfig` absolute fallback, plus the missing `AgentConfig` fields like `name`, `systemPrompt`).

The function is pure (reads from the module-level `agents` map) and deterministic.

### Absolute fallback shape

The absolute fallback is a complete `AgentConfig` synthesized inline, matching the current `getConfig` absolute fallback values plus required `AgentConfig` fields:

```typescript
{
  name: type,
  displayName: "Agent",
  description: "General-purpose agent for complex, multi-step tasks",
  builtinToolNames: BUILTIN_TOOL_NAMES,
  extensions: true,
  skills: true,
  systemPrompt: "",
  promptMode: "append",
}
```

### session-config.ts simplification

Before (two calls, two variables, null-check branching):

```typescript
const config = getConfig(type);
const agentConfig = getAgentConfig(type);
// ...
const extensions = options.isolated ? false : config.extensions;
const skills = options.isolated ? false : config.skills;
// ...
if (agentConfig) {
  systemPrompt = buildAgentPrompt(agentConfig, ...);
} else {
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  systemPrompt = buildAgentPrompt({ ...fallback, name: type }, ...);
}
```

After (one call, no null checks):

```typescript
const agentConfig = resolveAgentConfig(type);
// ...
const extensions = options.isolated ? false : agentConfig.extensions;
const skills = options.isolated ? false : agentConfig.skills;
// ...
systemPrompt = buildAgentPrompt(agentConfig, ...);
```

The `DEFAULT_AGENTS` import in `session-config.ts` becomes unnecessary.

## Module-Level Changes

### `src/agent-types.ts`

- **Add** `resolveAgentConfig(type: string): AgentConfig` — guaranteed-non-null lookup with fallback chain.
- **Remove** `getConfig(type)` — replaced by `resolveAgentConfig`.
- **Remove** `getAgentConfig(type)` — replaced by `resolveAgentConfig`.

### `src/session-config.ts`

- **Change** imports: replace `getConfig`, `getAgentConfig` with `resolveAgentConfig`.
- **Remove** `DEFAULT_AGENTS` import (no longer needed for the unknown-type fallback prompt path).
- **Simplify** `assembleSessionConfig()`: one `resolveAgentConfig(type)` call replaces two; remove the `if (agentConfig)` / `else` branch for prompt building.

### `src/ui/agent-widget.ts`

- **Change** import: replace `getConfig` with `resolveAgentConfig`.
- **Update** `getDisplayName()`: `const config = resolveAgentConfig(type); return config.displayName ?? config.name;`.
- **Update** `getPromptModeLabel()`: read `promptMode` from resolved config.

### `src/index.ts`

- **Change** import: replace `getAgentConfig` with `resolveAgentConfig`.
- **Update** 3 call sites: direct replacement (all iterate known names).

### `src/tools/agent-tool.ts`

- **Change** import: replace `getAgentConfig` with `resolveAgentConfig`.
- **Update** 1 call site: direct replacement (type already resolved via `resolveType()`).

### `src/ui/agent-menu.ts`

- **Change** import: replace `getAgentConfig` with `resolveAgentConfig`, add `resolveType` if not already imported.
- **Update** 5 call sites: 3 are direct replacements; 2 existence guards switch to `resolveType(name) != null` before calling `resolveAgentConfig()`.

### Test files

- **`test/agent-types.test.ts`**: Add tests for `resolveAgentConfig`; remove tests for `getConfig` and `getAgentConfig`.
- **`test/session-config.test.ts`**: Replace `mockGetConfig` + `mockGetAgentConfig` with a single `mockResolveAgentConfig`; remove all `mockGetConfig` usages.
- **`test/agent-runner.test.ts`**: Update `vi.mock("../src/agent-types.js")` factory: replace `getConfig` + `getAgentConfig` with `resolveAgentConfig`.
- **`test/agent-runner-extension-tools.test.ts`**: Same mock update as above.

## Test Impact Analysis

1. **New unit tests enabled**: `resolveAgentConfig` gets focused tests for the fallback chain (unknown → general-purpose → absolute fallback), case-insensitive lookup, and disabled-type fallback.
   These replace the scattered `getConfig` fallback tests in `agent-types.test.ts`.
2. **Redundant tests**: `getConfig`-specific tests (return shape, fallback, extension allowlist) become redundant since `resolveAgentConfig` returns the full `AgentConfig` directly.
   Remove them.
3. **Tests that must stay**: `agent-types.test.ts` tests for `registerAgents`, `resolveType`, `isValidType`, `getAvailableTypes`, `getAllTypes`, `getToolNamesForType`, `getMemoryToolNames`, `getReadOnlyMemoryToolNames` are unaffected.
   `session-config.test.ts` tests all stay — they test assembler behavior, just with a simpler mock setup.

## TDD Order

1. **Add `resolveAgentConfig` with tests** — add the function to `agent-types.ts` alongside existing functions.
   Tests: known type returns config; unknown type falls back to general-purpose; disabled type falls back; absolute fallback when general-purpose is missing; case-insensitive lookup.
   Commit: `feat: add resolveAgentConfig with guaranteed-non-null fallback chain`.

2. **Migrate `session-config.ts` and its tests** — replace `getConfig` + `getAgentConfig` imports with `resolveAgentConfig`; remove `DEFAULT_AGENTS` import; simplify the assembler body (one call, no null-check branch).
   Update `session-config.test.ts`: replace `mockGetConfig` + `mockGetAgentConfig` with single `mockResolveAgentConfig`; update all test setups.
   Commit: `refactor: migrate session-config to resolveAgentConfig`.

3. **Migrate `agent-widget.ts`** — update `getDisplayName()` and `getPromptModeLabel()` to use `resolveAgentConfig`.
   Commit: `refactor: migrate agent-widget to resolveAgentConfig`.

4. **Migrate remaining source callers** — update `index.ts` (3 sites), `tools/agent-tool.ts` (1 site), `ui/agent-menu.ts` (5 sites, including 2 existence-guard rewrites).
   Commit: `refactor: migrate remaining callers to resolveAgentConfig`.

5. **Update transitive test mocks** — update `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` mock factories to export `resolveAgentConfig` instead of `getConfig` + `getAgentConfig`.
   Commit: `test: update agent-runner test mocks for resolveAgentConfig`.

6. **Remove `getConfig` and `getAgentConfig`** — delete both functions from `agent-types.ts`; remove their tests from `agent-types.test.ts`.
   Run `pnpm run check` to verify no remaining references.
   Commit: `refactor: remove getConfig and getAgentConfig`.

## Risks and Mitigations

| Risk                                                                     | Mitigation                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlooked caller of removed functions                                   | Grep all `src/` and `test/` files for `getConfig` and `getAgentConfig` before the removal step; `pnpm run check` catches any remaining imports. |
| `agent-menu.ts` existence guards behave differently with `resolveType()` | `resolveType()` is already the canonical existence check used by `agent-tool.ts`; the guard semantics are identical.                            |
| Absolute fallback `AgentConfig` shape drift                              | The absolute fallback is a single inline literal — any future `AgentConfig` field additions will cause a type error at the definition site.     |
| Test mock compatibility during migration                                 | Lift-and-shift: `resolveAgentConfig` coexists with old functions until all callers are migrated; each step leaves tests green.                  |

## Open Questions

- `getToolNamesForType()` does its own lookup with similar fallback logic.
  It could be simplified to delegate to `resolveAgentConfig()`, but that is out of scope for this issue.
  Consider a follow-up if the duplication becomes a maintenance concern.
