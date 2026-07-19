---
issue: 131
issue_title: Consolidate shared test fixtures
---

# Consolidate shared test fixtures

## Problem Statement

Three `mockSession()` factories and three `makeDeps()` factories are duplicated across the test suite.
Each copy drifts independently when production interfaces change, creating maintenance burden and inconsistent mock shapes.
The architecture doc (Phase 8, Step F) identifies this as the first testability improvement before the IO-injection steps (G and H).

## Goals

- Extract `createMockSession()` into `test/helpers/mock-session.ts` — single source of truth for the subscribable session mock.
- Extract `createToolDeps()` into `test/helpers/make-deps.ts` — builds `AgentToolDeps` with sensible defaults and override support.
- Update all six test files to use the shared factories and remove their local copies.
- Keep existing test behavior unchanged — this is a pure refactor with no production code changes.

## Non-Goals

- IO injection into `session-config` (Step G, #132) — deferred.
- SDK boundary injection into `agent-runner` (Step H, #133) — deferred.
- Consolidating `makeCtx()` or `makeParams()` helpers — those are specific to each tool's parameter shape and do not share enough structure to justify extraction.

## Background

### Existing helper

`test/helpers/make-record.ts` exports `createTestRecord()`, which builds an `AgentRecord` with sensible defaults and override support.
It has its own unit test file (`test/helpers/make-record.test.ts`).
The two new factories follow the same pattern.

### `mockSession()` — 3 copies

| File                      | Shape                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `agent-manager.test.ts`   | `subscribe` (vi.fn), `emit`, `dispose` (vi.fn), `steer` (vi.fn), `sessionManager` — cast as `any` |
| `record-observer.test.ts` | `subscribe` (vi.fn), `emit`                                                                       |
| `ui/ui-observer.test.ts`  | `subscribe` (plain fn), `emit`                                                                    |

The common core is `subscribe` + `emit` (the subscribable event bus).
The `agent-manager` copy adds extra properties the other two don't need.

### `makeDeps()` — 3 copies

| File                               | Type             | Manager methods                                          | Widget methods                              | Extra fields                 |
| ---------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `tools/agent-tool.test.ts`         | `AgentToolDeps`  | spawn, spawnAndWait, resume, getRecord, getMaxConcurrent | setUICtx, ensureTimer, update, markFinished | registry, agentDir, settings |
| `tools/background-spawner.test.ts` | `BackgroundDeps` | spawn, getRecord, getMaxConcurrent                       | ensureTimer, update                         | —                            |
| `tools/foreground-runner.test.ts`  | `ForegroundDeps` | spawnAndWait                                             | ensureTimer, markFinished                   | —                            |

`AgentToolDeps` is a structural superset of both `BackgroundDeps` and `ForegroundDeps`.
TypeScript's structural type system allows an `AgentToolDeps` value to be passed where `BackgroundDeps` or `ForegroundDeps` is expected — the narrower interfaces require a strict subset of the methods present on the wider one.

## Design Overview

### `createMockSession(overrides?)`

Returns the subscribable event bus (core shape) merged with optional overrides.
The core shape includes:

```typescript
interface MockSession {
  subscribe: Mock<[fn: (event: any) => void], () => void>;
  emit(event: any): void;       // test-only helper, not on production Session
  dispose: Mock;
  steer: Mock;
  sessionManager: { getSessionFile: Mock };
}
```

All fields are present in every call — callers that don't need `dispose` or `steer` simply ignore them.
This avoids a discriminated "minimal vs. full" shape that would reintroduce the divergence problem.
The `subscribe` spy is wired to a `Set<fn>` internally so `emit()` broadcasts to all subscribers, matching the existing hand-rolled pattern.
The return type is `MockSession & Record<string, unknown>` so call sites can pass it as `any`-typed session parameters without explicit casts.

Override support lets `agent-manager.test.ts` customize `steer` behavior or add fields:

```typescript
const session = createMockSession({ steer: vi.fn().mockRejectedValue(new Error("fail")) });
```

### `createToolDeps(overrides?)`

Builds a full `AgentToolDeps` with mock manager, widget, activity map, registry, agent dir, and settings.
Accepts `Partial<AgentToolDeps>` for overrides, following the same pattern as `createTestRecord()`.

```typescript
function createToolDeps(overrides?: Partial<AgentToolDeps>): AgentToolDeps;
```

Consumer call sites:

```typescript
// agent-tool.test.ts — uses the full type directly
const deps = createToolDeps();
const tool = createAgentTool(deps);

// background-spawner.test.ts — structural typing narrows automatically
const deps = createToolDeps();
spawnBackground(deps, makeParams());

// foreground-runner.test.ts — same structural narrowing
const deps = createToolDeps({ manager: { spawnAndWait: vi.fn().mockResolvedValue(customRecord) } });
await runForeground(deps, makeParams(), undefined, undefined);
```

The background and foreground tests gain unused mock methods on `manager` and `widget`, but this is harmless — the production code's ISP compliance ensures only the narrow interface methods are called.
Tests that assert specific mock interactions (e.g., `expect(deps.manager.spawn).toHaveBeenCalled()`) continue to work because every method is a distinct `vi.fn()`.

When a test needs to override a single manager method, it spreads into the nested object:

```typescript
createToolDeps({
  manager: { ...createToolDeps().manager, spawnAndWait: vi.fn().mockRejectedValue(err) },
});
```

This is slightly more verbose than today's flat override, but it happens rarely and the tradeoff is worthwhile for a single source of truth.

Alternatively, `createToolDeps` can accept a `managerOverrides` shorthand if the nested-spread pattern proves too noisy during implementation.

## Module-Level Changes

### New files

1. `test/helpers/mock-session.ts` — exports `createMockSession(overrides?)`.
2. `test/helpers/mock-session.test.ts` — unit tests for `createMockSession`: verifies event broadcasting, subscribe/unsubscribe, and override merging.
3. `test/helpers/make-deps.ts` — exports `createToolDeps(overrides?)`.
4. `test/helpers/make-deps.test.ts` — unit tests for `createToolDeps`: verifies default shape satisfies `AgentToolDeps`, `BackgroundDeps`, and `ForegroundDeps`; verifies override merging.

### Modified files

1. `test/agent-manager.test.ts` — remove local `mockSession()`, import `createMockSession` from helpers.
2. `test/record-observer.test.ts` — remove local `mockSession()`, import `createMockSession` from helpers.
3. `test/ui/ui-observer.test.ts` — remove local `mockSession()`, import `createMockSession` from helpers.
4. `test/tools/agent-tool.test.ts` — remove local `makeDeps()`, import `createToolDeps` from helpers.
5. `test/tools/background-spawner.test.ts` — remove local `makeDeps()`, import `createToolDeps` from helpers.
6. `test/tools/foreground-runner.test.ts` — remove local `makeDeps()`, import `createToolDeps` from helpers.

## Test Impact Analysis

1. The new factory unit tests (`mock-session.test.ts`, `make-deps.test.ts`) verify the shared fixture behavior that was previously only implicitly tested through the consumer test files.
   This enables targeted debugging when a mock shape drifts from the production interface.
2. No existing tests become redundant — the consumer tests exercise distinct production behavior that the factory tests do not cover.
3. All existing tests stay as-is in terms of assertions.
   Only the setup code (local factory → shared import) changes.

## TDD Order

1. **Red → Green: `createMockSession` factory.**
   Write `test/helpers/mock-session.test.ts` — verify subscribe/emit broadcasting, unsubscribe, dispose/steer are vi.fn stubs, override merging.
   Implement `test/helpers/mock-session.ts`.
   Commit: `test: add createMockSession shared test fixture`

2. **Green: migrate `record-observer.test.ts` to `createMockSession`.**
   Replace local `mockSession()` with import from helpers.
   Run test file — all tests pass unchanged.
   Commit: `test: use createMockSession in record-observer tests`

3. **Green: migrate `ui/ui-observer.test.ts` to `createMockSession`.**
   Replace local `mockSession()` with import from helpers.
   Run test file — all tests pass unchanged.
   Commit: `test: use createMockSession in ui-observer tests`

4. **Green: migrate `agent-manager.test.ts` to `createMockSession`.**
   Replace local `mockSession()` with import from helpers.
   This file uses extra fields (`sessionManager`, `steer`, `dispose`) — verify overrides or defaults cover them.
   Run test file — all tests pass unchanged.
   Commit: `test: use createMockSession in agent-manager tests`

5. **Red → Green: `createToolDeps` factory.**
   Write `test/helpers/make-deps.test.ts` — verify default shape, override merging, structural compatibility with `BackgroundDeps` and `ForegroundDeps`.
   Implement `test/helpers/make-deps.ts`.
   Commit: `test: add createToolDeps shared test fixture`

6. **Green: migrate `tools/agent-tool.test.ts` to `createToolDeps`.**
   Replace local `makeDeps()` with import from helpers.
   Run test file — all tests pass unchanged.
   Commit: `test: use createToolDeps in agent-tool tests`

7. **Green: migrate `tools/background-spawner.test.ts` to `createToolDeps`.**
   Replace local `makeDeps()` with import from helpers.
   Adjust any override patterns for the wider type.
   Run test file — all tests pass unchanged.
   Commit: `test: use createToolDeps in background-spawner tests`

8. **Green: migrate `tools/foreground-runner.test.ts` to `createToolDeps`.**
   Replace local `makeDeps()` with import from helpers.
   Adjust any override patterns for the wider type.
   Run test file — all tests pass unchanged.
   Commit: `test: use createToolDeps in foreground-runner tests`

## Risks and Mitigations

| Risk                                                                                                   | Mitigation                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wider mock shape causes false-positive tests (tests pass even when production code calls wrong method) | The production interfaces are already ISP-narrow; the mock width only affects tests. Existing assertions on specific mock calls catch regressions.                                                                      |
| Override merging doesn't handle nested objects (e.g., overriding a single manager method)              | Factory uses shallow merge for top-level fields; document that nested overrides require spreading the default nested object. Evaluate a `managerOverrides` shorthand during implementation if the pattern is too noisy. |
| `createMockSession` return type is too loose (`any`) and hides type errors in tests                    | Return a named `MockSession` interface rather than `any`. Consumer sites that pass the mock as `any`-typed SDK parameters are already untyped at that boundary.                                                         |

## Open Questions

- Should `createToolDeps` accept a flat `managerOverrides` shorthand or require the caller to spread the nested object?
  Decide during step 5 based on how verbose the migration turns out in steps 6–8.
