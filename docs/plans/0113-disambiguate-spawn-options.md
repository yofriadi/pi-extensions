---
issue: 113
issue_title: "refactor(pi-subagents): disambiguate SpawnOptions (public vs internal)"
---

# Disambiguate SpawnOptions (public vs internal)

## Problem Statement

`SpawnOptions` is defined in two places with the same name but incompatible shapes:

- `service.ts` (public API): 8 fields, JSON-friendly (`model` is `string`, `thinkingLevel` is `string`, uses `foreground` not `isBackground`).
- `agent-manager.ts` (internal): 13 fields, runtime types (`model` is `Model<any>`, `thinkingLevel` is `ThinkingLevel`, includes `signal`, `onSessionCreated`, `invocation`).

The name collision makes it ambiguous which type a reader is working with when they see `SpawnOptions` in a signature.
`service-adapter.ts` manually converts between the two shapes.

## Goals

- Rename the internal `SpawnOptions` in `agent-manager.ts` to `AgentSpawnConfig`.
- Keep the public `SpawnOptions` in `service.ts` unchanged — it's the published API.
- Update all internal consumers (`agent-tool.ts`, `agent-menu.ts`, `agent-manager.ts`) to use the new name.
- Update the `SpawnArgs` internal interface in `agent-manager.ts` to reference `AgentSpawnConfig`.
- Non-breaking refactor — the public API surface is unchanged.

## Non-Goals

- Splitting `AgentSpawnConfig` into agent-configuration fields vs execution/lifecycle fields — the issue mentions this as a "consider" item; defer to a follow-up if the type grows further.
- Narrowing `AgentToolDeps` or `AgentMenuDeps` — tracked in #114.
- Removing `onSessionCreated` — it's a legitimate per-spawn callback used by `agent-tool.ts` for UI streaming, structurally different from the lifecycle observer (#112).

## Background

### Current consumers of internal `SpawnOptions`

| File                  | How it references `SpawnOptions`                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `agent-manager.ts`    | Defines the type; uses it in `spawn()`, `spawnAndWait()`, and `SpawnArgs`                   |
| `tools/agent-tool.ts` | Imports and uses in `AgentToolManager.spawn` and `AgentToolManager.spawnAndWait` signatures |
| `ui/agent-menu.ts`    | Imports and uses in `AgentMenuManager.spawnAndWait` signature                               |

### Public `SpawnOptions` in `service.ts`

Defined alongside `SubagentsService`.
Used by `service-adapter.ts` at the conversion boundary.
Published via `package.json` exports — **not touched by this change**.

### Dependency: issue #112 (observer refactor)

Issue #112 is closed.
The observer eliminated `onStart`/`onComplete`/`onCompact` from `AgentManagerOptions`.
`onSessionCreated` remains on the internal `SpawnOptions` (now `AgentSpawnConfig`) — it's per-spawn, not per-manager.

### Architecture reference

Phase 7, Step D1 in `docs/architecture/architecture.md`.

## Design Overview

This is a pure rename — no structural or behavioral changes.
The internal `SpawnOptions` becomes `AgentSpawnConfig`.
Every `import type { SpawnOptions }` from `"../agent-manager.js"` or `"./agent-manager.js"` becomes `import type { AgentSpawnConfig }`.

The name `AgentSpawnConfig` was chosen because:

1. It disambiguates from the public `SpawnOptions`.
2. It follows the established naming convention in this package (`AgentRecord`, `AgentInvocation`, `AgentTypeRegistry`).
3. "Config" conveys that this is a configuration bag assembled by the caller and consumed by the manager — not a service-level options type.

### Type shape (unchanged)

```typescript
export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onSessionCreated?: (session: AgentSession) => void;
  parentSessionFile?: string;
  parentSessionId?: string;
}
```

## Module-Level Changes

### `src/agent-manager.ts`

- Rename `export interface SpawnOptions` → `export interface AgentSpawnConfig`.
- Update `SpawnArgs.options` type from `SpawnOptions` to `AgentSpawnConfig`.
- Update `spawn()` parameter type from `SpawnOptions` to `AgentSpawnConfig`.
- Update `spawnAndWait()` parameter type from `Omit<SpawnOptions, "isBackground">` to `Omit<AgentSpawnConfig, "isBackground">`.

### `src/tools/agent-tool.ts`

- Change import from `SpawnOptions` to `AgentSpawnConfig`.
- Update `AgentToolManager.spawn` and `AgentToolManager.spawnAndWait` signatures.

### `src/ui/agent-menu.ts`

- Change import from `SpawnOptions` to `AgentSpawnConfig`.
- Update `AgentMenuManager.spawnAndWait` signature.

### `src/service.ts`

- No changes — the public `SpawnOptions` stays as-is.

### `src/service-adapter.ts`

- No changes — it already uses `unknown` for the spawn options parameter in `AgentManagerLike`.

### `test/agent-manager.test.ts`

- No import changes needed — the test file does not import `SpawnOptions`.
- One test description string mentions "SpawnOptions" → update to "AgentSpawnConfig" for accuracy.

## Test Impact Analysis

1. No new tests are enabled by this rename — it's a 1:1 name substitution.
2. No existing tests become redundant.
3. All existing tests stay as-is — they construct raw object literals that structurally satisfy the type regardless of its name.

## TDD Order

### Step 1: Rename `SpawnOptions` to `AgentSpawnConfig` and update all consumers

1. Rename the interface in `agent-manager.ts`.
2. Update `SpawnArgs`, `spawn()`, and `spawnAndWait()` in `agent-manager.ts`.
3. Update the import and signatures in `tools/agent-tool.ts`.
4. Update the import and signature in `ui/agent-menu.ts`.
5. Update the test description string in `test/agent-manager.test.ts`.
6. Run `pnpm run check` to verify types.
7. Run `pnpm vitest run` to verify all tests pass.

- Commit: `refactor: rename internal SpawnOptions to AgentSpawnConfig (#113)`

This is a single-step refactor because the rename is mechanical and all consumers must be updated atomically for the type checker to stay green.

## Risks and Mitigations

| Risk                                                     | Mitigation                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Missed consumer still references old name                | `pnpm run check` will catch any unresolved `SpawnOptions` import from `agent-manager.ts` since the export no longer exists |
| Test descriptions become misleading                      | Grep for "SpawnOptions" in test files and update any description strings that reference the old name                       |
| Confusion with `service.ts` `SpawnOptions` during review | The plan is scoped to internal-only changes; `service.ts` is explicitly listed as "no changes"                             |

## Open Questions

- None — the rename is unambiguous and aligns with both the issue proposal and the architecture doc.
