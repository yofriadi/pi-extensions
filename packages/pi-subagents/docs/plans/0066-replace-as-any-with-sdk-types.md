---
issue: 66
issue_title: "refactor: replace `as any` casts in extracted tool/menu factories with proper SDK types"
---

# Replace `as any` casts in factory dep interfaces with proper SDK types

## Problem Statement

The decomposition in #54 introduced 14 `as any` casts at the wiring boundary in `src/index.ts`.
These exist because the factory dep interfaces (`AgentToolManager`, `GetResultDeps`, `SteerToolDeps`, `AgentMenuDeps`, `NotificationDeps`) declare `unknown` or `object` for parameters that are actually well-typed SDK exports.
Every cast papers over a real type that the SDK already exports.
For comparison, `pi-permission-system` imports SDK types directly in its internal interfaces and has zero `as any` casts.

## Goals

- Replace every `as any` cast in `src/index.ts` by typing the corresponding dep interface parameter with the actual SDK type.
- Keep factory modules decoupled from `AgentManager` where possible — use shared types (`types.ts`) or SDK imports.
- No runtime behavior change — this is purely a type-safety improvement.
- Existing tests continue to pass without modification (factory `execute` methods use `ctx: any` or `ctx: unknown`, so test mocks are unaffected).

## Non-Goals

- Fixing `as any` casts in `agent-runner.ts`, `conversation-viewer.ts`, `tools/helpers.ts`, or `tools/agent-tool.ts:550` — those access untyped SDK message internals, a different concern.
- Removing the `ctx as UICtx` cast (line 196) — that is a named cast, not `as any`.
- Removing `as any` from test files (e.g., `agent-menu.test.ts`'s `ctx as any`) — test mocks are intentionally narrow.

## Background

### Current cast inventory (`src/index.ts`)

| Line | Cast                                            | Root cause                                                                  |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| 59   | `msg as any, opts as any`                       | `NotificationDeps.sendMessage(msg: unknown, opts: unknown)`                 |
| 188  | `ctx as any, opts as any`                       | `AgentToolManager.spawn(ctx: unknown, …, opts: object)`                     |
| 189  | `ctx as any, opts as any`                       | `AgentToolManager.spawnAndWait(ctx: unknown, …, opts: object)`              |
| 208  | `}) as any`                                     | Cascading from above — `createAgentTool` return doesn't match `defineTool`  |
| 215  | `session as any`                                | `GetResultDeps.getConversation(session: unknown)`                           |
| 223  | `session as any`                                | `SteerToolDeps.steerAgent(session: unknown, …)`                             |
| 232  | `(piArg ?? pi) as any, ctx as any, opts as any` | `AgentMenuManager.spawnAndWait(pi: unknown, ctx: unknown, …, opts: object)` |
| 242  | `registry as any`                               | `AgentMenuDeps.getModelLabel(…, registry?: unknown)`                        |
| 271  | `ctx as any`                                    | `MenuContext` not structurally compatible with `ExtensionCommandContext`    |

### SDK types available

All are exported from `@earendil-works/pi-coding-agent`:

- `ExtensionContext` — tool execute context (has `ui`, `modelRegistry`, `cwd`, etc.)
- `ExtensionCommandContext` — command handler context (extends `ExtensionContext`)
- `ExtensionAPI` — the `pi` object passed to extensions
- `AgentSession` — session handle (has `steer()`, `messages`, etc.)

`ModelRegistry` is already defined locally in `src/model-resolver.ts` and matches the SDK shape.
`SpawnOptions` is defined locally in `src/agent-manager.ts` (not currently exported).

### Relevant AGENTS.md constraints

- "Avoid `any` unless absolutely necessary."
- "Keep Pi SDK imports out of business-logic modules."
  Tool definitions, event handlers, and command handlers are SDK consumers — they may import SDK types directly.
  The restriction targets pure helpers, utilities, and domain modules.
- "When writing event handlers that consume Pi SDK types, prefer lean local payload interfaces over full SDK event types."

The factory modules (`tools/agent-tool.ts`, `tools/get-result-tool.ts`, `tools/steer-tool.ts`, `ui/agent-menu.ts`) are SDK consumers (they define tools and command handlers), so importing SDK types is acceptable.
The notification module (`notification.ts`) is a pure helper — it should use narrow local types rather than SDK imports.

## Design Overview

### Strategy per interface

1. **`NotificationDeps.sendMessage`** — define narrow inline parameter types matching `ExtensionAPI.sendMessage`'s shape.
   No SDK import needed; the notification module stays SDK-independent.

2. **`AgentToolManager`** — import `ExtensionContext` for `ctx`, export + import `SpawnOptions` from `agent-manager.ts` for `opts`.
   The tool module is an SDK consumer, so SDK imports are acceptable.

3. **`AgentToolWidget.setUICtx`** — stays `ctx: unknown` (not `as any`; currently `ctx as UICtx`).
   Out of scope.

4. **`GetResultDeps.getConversation`** — import `AgentSession` for `session`.

5. **`SteerToolDeps.steerAgent`** — import `AgentSession` for `session`.

6. **`AgentMenuManager.spawnAndWait`** — import `ExtensionAPI` for `pi`, `ExtensionContext` for `ctx`, export + import `SpawnOptions` for `opts`.

7. **`AgentMenuDeps.getModelLabel`** — import `ModelRegistry` from `../model-resolver.js` for `registry`.

8. **`MenuContext` structural compatibility** — switch `MenuUI` from property syntax (strict function types) to method syntax (bivariant), and type `modelRegistry` as `ModelRegistry`.
   This makes `ExtensionCommandContext` structurally assignable to `MenuContext`, removing the cast without broadening the handler's dependency on the full SDK type.
   Tests continue using narrow mocks because the handler's parameter is still the narrow `MenuContext`.

### `SpawnOptions` export

`SpawnOptions` in `agent-manager.ts` is currently a private interface.
Exporting it as a named `type` export adds no runtime cost and avoids duplicating the 15-field type in each factory.
Both `tools/agent-tool.ts` and `ui/agent-menu.ts` already import `AgentRecord` from `types.ts`, so an intra-package `import type` from `agent-manager.ts` follows the same pattern.

### Cascading cast resolution

The `createAgentTool({…}) as any` cast on line 208 exists because TypeScript cannot verify the returned object satisfies `ToolDefinition` when inner types are `unknown`/`object`.
Once the inner types are correct, the factory return type matches `ToolDefinition` naturally, and the outer `as any` cast resolves without further changes.

## Module-Level Changes

### `src/agent-manager.ts`

- Export the existing `SpawnOptions` interface (add `export` keyword).

### `src/notification.ts`

- Replace `sendMessage: (msg: unknown, opts: unknown) => void` with narrow inline types:

```typescript
sendMessage: (
  msg: { customType: string; content: string; display?: boolean; details?: unknown },
  opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;
```

### `src/tools/agent-tool.ts`

- Add `import type { ExtensionContext } from "@earendil-works/pi-coding-agent";`
- Add `import type { SpawnOptions } from "../agent-manager.js";`
- `AgentToolManager.spawn`: `ctx: unknown` → `ctx: ExtensionContext`, `opts: object` → `opts: SpawnOptions`
- `AgentToolManager.spawnAndWait`: same changes, opts as `Omit<SpawnOptions, "isBackground">`

### `src/tools/get-result-tool.ts`

- Add `import type { AgentSession } from "@earendil-works/pi-coding-agent";`
- `GetResultDeps.getConversation`: `session: unknown` → `session: AgentSession`

### `src/tools/steer-tool.ts`

- Add `import type { AgentSession } from "@earendil-works/pi-coding-agent";`
- `SteerToolDeps.steerAgent`: `session: unknown` → `session: AgentSession`

### `src/ui/agent-menu.ts`

- Add `import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";`
- Add `import type { SpawnOptions } from "../agent-manager.js";`
- Add `import type { ModelRegistry } from "../model-resolver.js";`
- `AgentMenuManager.spawnAndWait`: `pi: unknown` → `pi: ExtensionAPI | null`, `ctx: unknown` → `ctx: ExtensionContext`, `opts: object` → `opts: Omit<SpawnOptions, "isBackground">`
- `AgentMenuDeps.getModelLabel`: `registry?: unknown` → `registry?: ModelRegistry`
- `MenuUI`: switch from property syntax to method syntax for structural compatibility with `ExtensionUIContext`.
  Update `notify` second parameter from `level: string` to `type?: string` to match SDK.
- `MenuContext.modelRegistry`: `unknown` → `ModelRegistry`

### `src/index.ts`

- Remove all 14 `as any` casts.
- No new imports needed (types already used transitively).

## Test Impact Analysis

1. **No new unit tests needed** — this is a type-only refactoring with no behavioral change.
2. **No existing tests become redundant** — the tests exercise tool execution and menu behavior, not type signatures.
3. **Existing tests must stay as-is** — factory `execute` methods use `ctx: any` or `ctx: unknown`, so `makeCtx()` test helpers remain compatible.
   Test-side `as any` casts (e.g., `handler(ctx as any)` in `agent-menu.test.ts`) are out of scope.

## TDD Order

Since this is a type-only change, each step is verified by `pnpm run check` (tsc) rather than new vitest tests.
The full test suite (`pnpm vitest run`) is run at the end as a regression check.

1. **Export `SpawnOptions`** — add `export` to the existing `interface SpawnOptions` in `agent-manager.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: export SpawnOptions from agent-manager`

2. **Type `NotificationDeps`** — replace `(msg: unknown, opts: unknown)` with narrow inline types in `notification.ts`.
   Remove `msg as any, opts as any` casts (line 59) in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: type NotificationDeps.sendMessage parameters (#66)`

3. **Type `AgentToolManager`** — import `ExtensionContext` and `SpawnOptions`, update `spawn` and `spawnAndWait` signatures in `agent-tool.ts`.
   Remove `ctx as any, opts as any` casts (lines 188–189) and the cascading `}) as any` cast (line 208) in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: type AgentToolManager with ExtensionContext and SpawnOptions (#66)`

4. **Type `GetResultDeps`** — import `AgentSession`, update `getConversation` in `get-result-tool.ts`.
   Remove `session as any` cast (line 215) in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: type GetResultDeps.getConversation with AgentSession (#66)`

5. **Type `SteerToolDeps`** — import `AgentSession`, update `steerAgent` in `steer-tool.ts`.
   Remove `session as any` cast (line 223) in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: type SteerToolDeps.steerAgent with AgentSession (#66)`

6. **Type `AgentMenuManager` + `AgentMenuDeps`** — import `ExtensionAPI`, `ExtensionContext`, `SpawnOptions`, `ModelRegistry`.
   Update `spawnAndWait` and `getModelLabel` signatures in `agent-menu.ts`.
   Remove `(piArg ?? pi) as any, ctx as any, opts as any` (line 232) and `registry as any` (line 242) casts in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: type AgentMenu interfaces with SDK types (#66)`

7. **Align `MenuContext` with `ExtensionCommandContext`** — switch `MenuUI` to method syntax, fix `notify` parameter, type `modelRegistry` as `ModelRegistry`.
   Remove `ctx as any` cast (line 271) in `index.ts`.
   Verify: `pnpm run check`.
   Commit: `refactor: align MenuContext for structural ExtensionCommandContext compat (#66)`

8. **Final verification** — run `pnpm vitest run` for the full test suite.
   Grep `src/index.ts` for remaining `as any` — expect zero.
   Commit: none (verification only).

## Risks and Mitigations

| Risk                                                                                           | Mitigation                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exporting `SpawnOptions` from `agent-manager.ts` couples factory modules to the manager's type | The coupling is type-only (`import type`), adds no runtime dependency, and follows the existing pattern (`AgentRecord` in `types.ts` is already shared).                                |
| `MenuUI` method-syntax change could break structural compatibility with test mocks             | Test mocks use `vi.fn()` which is bivariant; method syntax on the `MenuUI` interface only affects how TypeScript checks assignability from `ExtensionUIContext`, not from mock objects. |
| SDK type exports could change in a future Pi release                                           | The SDK types used (`ExtensionContext`, `AgentSession`, `ExtensionAPI`) are stable public API. `ModelRegistry` is a local interface.                                                    |
| Cascading `as any` on `createAgentTool` may not resolve automatically                          | If TypeScript still cannot infer the return type, add explicit `satisfies ToolDefinition<…>` or a return type annotation. Verified in step 3.                                           |

## Open Questions

- None — the issue's "Proposed change" section is unambiguous and all SDK types are confirmed available.
