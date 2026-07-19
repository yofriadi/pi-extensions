---
issue: 123
issue_title: "refactor(pi-subagents): remove vi.fn() cast smell from test helpers"
---

# Remove vi.fn() cast smell from test helpers

## Problem Statement

Several test files construct mock objects typed to narrow interfaces (`AgentManagerLike`, `LifecycleRuntime`, `LifecycleManager`, `ToolStartRuntime`).
Because the returned objects are typed to the interface — not to Vitest's mock types — tests that need to configure individual method stubs are forced to cast:

```typescript
(deps.manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
(deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(record);
```

This silences TypeScript without constraining the call's return type — if `getRecord`'s return type changes, the cast won't catch it.
Nine occurrences exist across three test files.

## Goals

- Eliminate all `as ReturnType<typeof vi.fn>` casts from the test suite.
- Preserve type safety: mock configuration calls should be checked against the real method signatures.
- Keep the change minimal — this is a test hygiene fix, not a structural redesign.

## Non-Goals

- Changing `AgentManagerLike`, `LifecycleRuntime`, `LifecycleManager`, `ToolStartRuntime`, or any production code.
- Restructuring test layout or merging describe blocks.

## Background

The cast pattern was noted during #111 implementation and preserved to keep scope tight.
Issue #111 (split `AgentRecord` lifecycle state) is now closed and implemented.

### Affected files

| File                               | Occurrences | Interface                              |
| ---------------------------------- | ----------- | -------------------------------------- |
| `test/service-adapter.test.ts`     | 5           | `AgentManagerLike`                     |
| `test/handlers/lifecycle.test.ts`  | 2           | `LifecycleRuntime`, `LifecycleManager` |
| `test/handlers/tool-start.test.ts` | 2           | `ToolStartRuntime`                     |

### Cast sites by file

`service-adapter.test.ts` — the "steer, abort, waitForAll, hasRunning" block's `createDeps` returns `AdapterDeps` directly.
Five casts reconfigure `getRecord`, `abort`, or `queueSteer` after construction:

1. `(deps.manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false)`
2. `(deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({...})` (×4)

`lifecycle.test.ts` — mock objects are assigned to `let` variables in `beforeEach`, typed to `LifecycleRuntime` and `LifecycleManager`.
Two casts reconfigure methods to track call order:

1. `(runtime.setSessionContext as ReturnType<typeof vi.fn>).mockImplementation(...)`
2. `(manager.clearCompleted as ReturnType<typeof vi.fn>).mockImplementation(...)`

Note: the same file already uses `vi.mocked()` in the shutdown-order test — both patterns coexist, which is itself a consistency smell.

`tool-start.test.ts` — mock object assigned to a `let` variable typed to `ToolStartRuntime`.
Two casts reconfigure methods to track call order:

1. `(runtime.setUICtx as ReturnType<typeof vi.fn>).mockImplementation(...)`
2. `(runtime.onTurnStart as ReturnType<typeof vi.fn>).mockImplementation(...)`

### Approach: named-variable extraction

Extract individual `vi.fn()` stubs into named variables.
This is the approach the issue recommends and it aligns with the testing skill's guidance on extractable stubs.

The alternative — `vi.mocked()` — is already used in `lifecycle.test.ts` for the shutdown-order test and works for hand-built mocks, but is semantically less clean: `vi.mocked()` asserts that a value is already a mock, which is true here but opaque to readers.
Named variables make the mock-ness explicit at the construction site.

For `lifecycle.test.ts`, the named-variable approach also eliminates the inconsistency between the two ordering tests — one currently uses `vi.mocked()` and the other uses casts.
After this change both will use named stubs.

## Design Overview

### service-adapter.test.ts

Refactor the "steer, abort, waitForAll, hasRunning" block's `createDeps` to return named stubs:

```typescript
function createDeps(overrides: Partial<AdapterDeps> = {}) {
  const mockGetRecord = vi.fn<AgentManagerLike["getRecord"]>();
  const mockAbort = vi.fn<AgentManagerLike["abort"]>(() => true);
  const mockQueueSteer = vi.fn<AgentManagerLike["queueSteer"]>(() => true);

  const deps: AdapterDeps = {
    manager: {
      spawn: vi.fn(() => "id"),
      getRecord: mockGetRecord,
      listAgents: vi.fn(() => []),
      abort: mockAbort,
      waitForAll: vi.fn(async () => {}),
      hasRunning: vi.fn(() => true),
      queueSteer: mockQueueSteer,
    },
    resolveModel: vi.fn(),
    getCtx: () => ({ pi: {}, ctx: {} }),
    getModelRegistry: () => ({ find: () => null, getAll: () => [] }),
    ...overrides,
  };

  return { deps, mockGetRecord, mockAbort, mockQueueSteer };
}
```

Callers destructure what they need:

```typescript
const { deps, mockAbort } = createDeps();
mockAbort.mockReturnValue(false);  // ← type-checked, no cast
```

### lifecycle.test.ts

Promote the `beforeEach`-scoped `runtime` and `manager` mock construction to use named stubs.
The stubs that need reconfiguration (`setSessionContext`, `clearCompleted`) become named `let` variables alongside the existing `runtime`/`manager` lets, reset in `beforeEach`:

```typescript
let mockSetSessionContext: MockInstance<LifecycleRuntime["setSessionContext"]>;
let mockClearCompleted: MockInstance<LifecycleManager["clearCompleted"]>;
// ...assigned in beforeEach when building runtime/manager
```

Also convert the shutdown-order test's `vi.mocked()` calls to the same pattern for consistency — `unpublishService`, `clearSessionContext`, `abortAll`, `disposeNotifications`, `dispose` all become named stubs.

### tool-start.test.ts

Same pattern: promote `setUICtx` and `onTurnStart` to named `let` variables:

```typescript
let mockSetUICtx: MockInstance<ToolStartRuntime["setUICtx"]>;
let mockOnTurnStart: MockInstance<ToolStartRuntime["onTurnStart"]>;
```

## Module-Level Changes

| File                               | Change                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/service-adapter.test.ts`     | Refactor `createDeps` in the "steer, abort, waitForAll, hasRunning" block to return named mock stubs alongside `deps`. Update all 5 cast sites to use named stubs.                                    |
| `test/handlers/lifecycle.test.ts`  | Extract `mockSetSessionContext`, `mockClearCompleted`, `mockAbortAll`, `mockDispose`, `mockClearSessionContext` as named `let` variables. Replace 2 casts and 5 `vi.mocked()` calls with named stubs. |
| `test/handlers/tool-start.test.ts` | Extract `mockSetUICtx` and `mockOnTurnStart` as named `let` variables. Replace 2 casts with named stubs.                                                                                              |

No production files are changed.

## Test Impact Analysis

1. No new tests are added — this is a refactoring of existing test infrastructure.
2. No tests become redundant — every existing assertion stays.
3. All existing tests must pass unchanged; only the mock-wiring changes.

## TDD Order

1. **Commit:** Refactor `createDeps` in `service-adapter.test.ts` to return named stubs; update all 5 cast sites.
   All tests pass before and after.
   Commit: `test: remove vi.fn() cast smell from service-adapter tests (#123)`
2. **Commit:** Extract named stubs in `lifecycle.test.ts`; replace 2 casts and 5 `vi.mocked()` calls.
   All tests pass.
   Commit: `test: remove vi.fn() cast smell from lifecycle tests (#123)`
3. **Commit:** Extract named stubs in `tool-start.test.ts`; replace 2 casts.
   All tests pass.
   Commit: `test: remove vi.fn() cast smell from tool-start tests (#123)`

Each step is an independent file — order doesn't matter, but one-file-per-commit keeps diffs reviewable.

## Risks and Mitigations

| Risk                                                                                                                          | Mitigation                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Overrides via `...overrides` in `service-adapter.test.ts` could replace a manager method, leaving the named stub disconnected | Only `manager`-level overrides are spread; individual method overrides aren't used in this block.       |
| Named stubs add return-surface to helpers                                                                                     | Each helper is test-local and the extra names are self-documenting. The alternative (casting) is worse. |
| Converting `vi.mocked()` in `lifecycle.test.ts` shutdown test expands scope slightly beyond the cast pattern                  | Worth it for consistency — mixing `vi.mocked()` and named stubs in the same file is a different smell.  |

## Open Questions

None — the issue is fully scoped and the approach is established in the codebase.
