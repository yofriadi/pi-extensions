---
issue: 193
issue_title: "SubagentRuntime owns context queries"
---

# SubagentRuntime owns context queries

## Problem Statement

Three closure queries in `index.ts` reach into `runtime.currentCtx?.ctx` with `as any` casts to extract model, modelRegistry, and sessionManager values.
These closures exist because `SubagentRuntime` stores `unknown` and doesn't provide typed accessors.
The queries belong on the state holder — `SubagentRuntime` owns `currentCtx`, so it should own the queries on that state.

## Goals

- Type `SubagentRuntime.currentCtx` as `SessionContext | undefined` (eliminating the `{ pi: unknown; ctx: unknown }` shape).
- Move the `as SessionContext` cast into `handleSessionStart` — the single SDK boundary.
- Add typed methods on `SubagentRuntime`: `buildSnapshot()`, `getModelInfo()`, `getSessionInfo()`.
- Remove 4 `as any` casts from `index.ts`.
- Remove 3 closure queries from the composition root.
- Update `service-adapter.ts` to delegate to `SubagentRuntime` instead of holding its own `as ExtensionContext` cast.

## Non-Goals

- Converting closure factories to classes (Layer 3, #195/#196).
- Aligning interface names so real objects satisfy tool deps (Layer 2, #194).
- Changing `buildParentContext` in `session/context.ts` (it will continue to accept `ExtensionContext`; `SessionContext` is structurally compatible).

## Background

Issue #192 (closed, shipped as v7.1.0) added the `SessionContext` interface to `src/types.ts`.
This plan builds on that foundation.

The architecture doc (Phase 11, Layer 1) specifies this exact change: "Change `currentCtx` from `{ pi: unknown; ctx: unknown }` to `SessionContext | undefined`."

Key modules:

- `src/runtime.ts` — `SubagentRuntime` class with `currentCtx`, `setSessionContext()`, `clearSessionContext()`
- `src/handlers/lifecycle.ts` — `SessionLifecycleHandler.handleSessionStart()` receives raw SDK `ctx`
- `src/index.ts` — composition root with inline `buildSnapshot`, `getModelInfo`, `getSessionInfo` closures
- `src/service/service-adapter.ts` — `createSubagentsService()` with `getCtx()` and `getModelRegistry()` closures
- `src/lifecycle/parent-snapshot.ts` — `buildParentSnapshot(ctx: ExtensionContext, inheritContext?)` function
- `src/session/context.ts` — `buildParentContext(ctx: ExtensionContext)` function

AGENTS.md constraint: keep modules focused and composable.
The queries belong on the state owner per Law of Demeter (code-design skill).

## Design Overview

### Type change

`SubagentRuntime.currentCtx` becomes `SessionContext | undefined` (previously `{ pi: unknown; ctx: unknown } | undefined`).
The `pi` field is dropped from the stored context — it is only used in `SessionLifecycleHandler` which already stores it as a constructor param.

### Cast boundary

`handleSessionStart` receives `ctx: unknown` from the SDK event.
The single `as SessionContext` cast lives here:

```typescript
handleSessionStart(_event: unknown, ctx: unknown): void {
  this.runtime.setSessionContext(ctx as SessionContext);
  this.manager.clearCompleted();
}
```

### New methods on `SubagentRuntime`

```typescript
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { ModelInfo } from "#src/tools/spawn-config";
import type { SessionContext } from "#src/types";

class SubagentRuntime {
  currentCtx: SessionContext | undefined = undefined;

  setSessionContext(ctx: SessionContext): void {
    this.currentCtx = ctx;
  }

  clearSessionContext(): void {
    this.currentCtx = undefined;
  }

  buildSnapshot(inheritContext: boolean): ParentSnapshot {
    return buildParentSnapshot(this.currentCtx!, inheritContext);
  }

  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model as ModelInfo["parentModel"],
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }

  getSessionInfo(): { parentSessionFile: string; parentSessionId: string } {
    return {
      parentSessionFile: this.currentCtx?.sessionManager?.getSessionFile() ?? "",
      parentSessionId: this.currentCtx?.sessionManager?.getSessionId() ?? "",
    };
  }
}
```

### `buildParentSnapshot` signature change

Change the parameter type from `ExtensionContext` to `SessionContext`:

```typescript
export function buildParentSnapshot(
  ctx: SessionContext,
  inheritContext?: boolean,
): ParentSnapshot { ... }
```

`ExtensionContext` structurally satisfies `SessionContext` (all 5 fields match), so existing callers (the `/agents` command handler) continue to work without change.

Similarly, `buildParentContext` changes from `ExtensionContext` to `SessionContext`.
The `sessionManager.getBranch()` returns `unknown[]` in `SessionContext`, which is what `buildParentContext` already treats the entries as (it accesses `.type`, `.message`, `.summary` via runtime checks without type narrowing).

### `service-adapter.ts` change

The adapter currently receives `getCtx: () => { pi: unknown; ctx: unknown } | undefined`.
After this change, it receives the runtime directly and calls `runtime.buildSnapshot()`:

```typescript
export function createSubagentsService(
  manager: AgentManagerLike,
  resolveModel: (input: string, registry: ModelRegistry) => unknown,
  runtime: ServiceRuntimeLike,
): SubagentsService { ... }
```

Where `ServiceRuntimeLike` is a narrow interface:

```typescript
export interface ServiceRuntimeLike {
  readonly currentCtx: SessionContext | undefined;
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getModelInfo(): { modelRegistry: unknown };
}
```

### Impact on `LifecycleRuntime` interface

The narrow interface in `handlers/lifecycle.ts` changes from:

```typescript
interface LifecycleRuntime {
  setSessionContext(pi: unknown, ctx: unknown): void;
  clearSessionContext(): void;
}
```

to:

```typescript
interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
}
```

## Module-Level Changes

1. `src/runtime.ts` — Change `currentCtx` type, update `setSessionContext()` signature (drop `pi` param), add `buildSnapshot()`, `getModelInfo()`, `getSessionInfo()` methods.
   Add imports for `SessionContext`, `ParentSnapshot`, `ModelInfo`, `buildParentSnapshot`.
2. `src/handlers/lifecycle.ts` — Update `LifecycleRuntime` interface (single `ctx: SessionContext` param).
   Cast `ctx as SessionContext` in `handleSessionStart`.
   Remove `pi` from `setSessionContext` call.
   Import `SessionContext`.
3. `src/lifecycle/parent-snapshot.ts` — Change `buildParentSnapshot` param from `ExtensionContext` to `SessionContext`.
   Update import.
4. `src/session/context.ts` — Change `buildParentContext` param from `ExtensionContext` to `SessionContext`.
   Update import.
5. `src/service/service-adapter.ts` — Replace `getCtx`/`getModelRegistry` closures with a `ServiceRuntimeLike` interface.
   Use `runtime.buildSnapshot()` and `runtime.currentCtx?.modelRegistry`.
   Remove `ExtensionContext` import.
6. `src/index.ts` — Remove inline `buildSnapshot`, `getModelInfo`, `getSessionInfo` closures from `createAgentTool` deps.
   Pass `runtime.buildSnapshot.bind(runtime)`, `runtime.getModelInfo.bind(runtime)`, `runtime.getSessionInfo.bind(runtime)`.
   Update `createSubagentsService` call to pass `runtime` instead of two closures.
   Update `lifecycle.handleSessionStart` call (drop `pi` from `setSessionContext`).
   Remove `as any` eslint-disable for the eliminated casts.
7. `test/runtime.test.ts` — Update session-context method tests (single param).
   Add tests for `buildSnapshot()`, `getModelInfo()`, `getSessionInfo()`.
8. `test/handlers/lifecycle.test.ts` — Update `setSessionContext` mock expectations (single param).
9. `test/service/service-adapter.test.ts` — Update `createSubagentsService` calls to pass a runtime-like mock instead of two closures.
10. `test/helpers/stub-ctx.ts` (or equivalent) — Verify the stub ctx satisfies `SessionContext`.

## Test Impact Analysis

1. **New unit tests enabled:** `SubagentRuntime.buildSnapshot()`, `.getModelInfo()`, `.getSessionInfo()` — previously untestable as anonymous closures.
2. **Existing tests that simplify:** `service-adapter.test.ts` no longer needs to wire `getCtx`/`getModelRegistry` closures; a simple runtime stub replaces them.
3. **Tests that stay as-is:** `agent-tool.test.ts` (via `make-deps.ts`) — the tool deps interface still has `buildSnapshot`, `getModelInfo`, `getSessionInfo` fields; only the wiring in `index.ts` changes.
   The tool tests use mocks and are unaffected.

## TDD Order

1. **Red → Green:** Add `buildSnapshot()`, `getModelInfo()`, `getSessionInfo()` method tests to `runtime.test.ts`.
   Update `setSessionContext` tests to use single param.
   Tests fail because the methods don't exist yet.
   Commit: `test: add SubagentRuntime context-query method tests (#193)`

2. **Green:** Change `SubagentRuntime.currentCtx` type to `SessionContext | undefined`.
   Update `setSessionContext` to single param.
   Add three query methods.
   Update imports.
   Run `pnpm run check` to verify type coherence.
   Commit: `feat: SubagentRuntime stores typed SessionContext and owns context queries (#193)`

3. **Green:** Change `buildParentSnapshot` and `buildParentContext` to accept `SessionContext` instead of `ExtensionContext`.
   Update imports.
   Run `pnpm run check`.
   Commit: `refactor: narrow buildParentSnapshot param to SessionContext (#193)`

4. **Green:** Update `handlers/lifecycle.ts` — change `LifecycleRuntime` interface, cast `ctx as SessionContext` in handler.
   Update lifecycle test expectations.
   Commit: `refactor: move SessionContext cast to handleSessionStart boundary (#193)`

5. **Green:** Update `service-adapter.ts` — introduce `ServiceRuntimeLike`, replace closure params with runtime.
   Update service-adapter tests.
   Commit: `refactor: service-adapter delegates to SubagentRuntime for context (#193)`

6. **Green:** Update `index.ts` — wire `runtime.buildSnapshot.bind(runtime)` etc. into agent tool deps.
   Update `createSubagentsService` call.
   Remove `as any` casts and corresponding eslint-disable comment.
   Clean up unused imports.
   Commit: `refactor: index.ts delegates context queries to SubagentRuntime (#193)`

7. **Verify:** Run full test suite (`pnpm vitest run`) and type check (`pnpm run check`).
   Fix any remaining lint issues.
   Commit: `chore: cleanup lint after SubagentRuntime context migration (#193)` (if needed)

## Risks and Mitigations

| Risk                                                                                                                    | Mitigation                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildParentSnapshot` callers outside this package break when param changes from `ExtensionContext` to `SessionContext` | `ExtensionContext` structurally satisfies `SessionContext` — no source-level changes needed at call sites. The `/agents` command handler passes `ctx` which is still `ExtensionContext` from the SDK. |
| `runtime.currentCtx` is `undefined` when `buildSnapshot()` is called                                                    | Same risk exists today — the closure reads `runtime.currentCtx?.ctx` which may be undefined. The `!` assertion documents the invariant: methods are only called during an active session.             |
| Dropping `pi` from `currentCtx` breaks something that reads it                                                          | Grep confirms `pi` is only stored and never read back from `currentCtx`. `SessionLifecycleHandler` already stores `pi` as its own constructor param.                                                  |
| Test fixture `make-deps.ts` still mocks `buildSnapshot`/`getModelInfo`/`getSessionInfo` on `AgentToolDeps`              | Correct — the tool interface doesn't change in this issue. The closures in `index.ts` are replaced with bound methods, but the deps shape stays the same.                                             |

## Open Questions

- None — the issue's proposed change and the architecture doc's Layer 1 spec are fully aligned.
