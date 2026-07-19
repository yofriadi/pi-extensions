---
issue: 102
issue_title: "Consolidate test AgentRecord construction into a shared factory"
---

# Consolidate test AgentRecord construction into a shared factory

## Problem Statement

Eight test files independently construct `AgentRecord` objects using three different patterns: copy-pasted `makeRecord()`/`mockRecord()` factory functions (5 files), inline `const baseRecord: AgentRecord = { ... }` literals (2 files), and `as AgentRecord` casts.
When issue #98 converts `AgentRecord` from an interface to a class, every object-literal construction site breaks.
A shared factory confines that future breakage to a single file.

## Goals

- Create a shared `createTestRecord()` factory in `test/helpers/make-record.ts`.
- Migrate all 7 affected test files to import the shared factory.
- No production code changes.
- No behavior changes — purely mechanical.

## Non-Goals

- Converting `AgentRecord` to a class — that is issue #98, which depends on this change.
- Adding new test coverage — this is a refactoring of test infrastructure only.
- Touching `test/agent-manager.test.ts` — it constructs records via `manager.spawn()`, not literals.
- Consolidating other test helpers (mock sessions, mock TUI, etc.).

## Background

### Relevant modules

| Module                               | Role                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                       | Defines the `AgentRecord` interface (20+ fields)                                                               |
| `test/tools/agent-tool.test.ts`      | `makeRecord()` factory — 12 default fields, status "completed"                                                 |
| `test/tools/get-result-tool.test.ts` | `makeRecord()` factory — 10 default fields, status "completed"                                                 |
| `test/tools/steer-tool.test.ts`      | `makeRecord()` factory — 9 default fields, status "running", includes mock session, uses `as AgentRecord` cast |
| `test/ui/agent-menu.test.ts`         | `makeRecord()` factory — 10 default fields, status "completed"                                                 |
| `test/conversation-viewer.test.ts`   | `mockRecord()` factory — 6 default fields, status "running", uses `as AgentRecord` cast                        |
| `test/notification.test.ts`          | 4 inline `baseRecord` literals, status "completed"                                                             |
| `test/service-adapter.test.ts`       | 4 inline `baseRecord` / `minimal` literals, mixed statuses                                                     |

### Convention from sibling packages

`packages/pi-autoformat/test/helpers/rpc.ts` is the only existing shared test helper in the monorepo.
The pattern is a plain module under `test/helpers/` with named exports — no class, no framework.

### Relationship to issue #98

Issue #98 plans to extract `MutableAgentRecord` as a class implementing the `AgentRecord` interface.
That plan explicitly notes: "All test files that construct `AgentRecord` literals — they create interface-compatible objects, not class instances" and lists them as unchanged.
Once this consolidation lands, issue #98's "unchanged" assumption becomes trivially true: only the shared factory needs updating if the construction API changes.

## Design Overview

### Shared factory: `createTestRecord()`

A single function in `test/helpers/make-record.ts` with the `Partial<AgentRecord>` override pattern already used by 5 of the 7 files:

```typescript
import type { AgentRecord } from "../../src/types.js";

export function createTestRecord(
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "Test task",
    status: "completed",
    result: "All done.",
    toolUses: 3,
    startedAt: 1000,
    completedAt: 2000,
    compactionCount: 0,
    lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 },
    ...overrides,
  };
}
```

### Default-value decisions

The defaults match the majority pattern (6 of 7 files default to a "completed" record).
The two files that need "running" records (`steer-tool`, `conversation-viewer`) pass `{ status: "running" }` as overrides — a one-field change.

The `as AgentRecord` cast used by `steer-tool.test.ts` and `conversation-viewer.test.ts` is no longer needed: the shared factory returns a full `AgentRecord` with all required fields populated, so TypeScript is satisfied without casting.

### Migration strategy for inline-literal files

`notification.test.ts` and `service-adapter.test.ts` construct multiple distinct inline literals — they don't have a single factory.
Each inline literal becomes a `createTestRecord({ ...specific overrides })` call.
The `baseRecord` variable declared in each `describe` block is replaced with a call to `createTestRecord()`.

For `service-adapter.test.ts`, the top-level `baseRecord` with custom values (`id: "abc-123"`, `type: "Explore"`, etc.) becomes `createTestRecord({ id: "abc-123", type: "Explore", ... })`.

## Module-Level Changes

### New files

1. `test/helpers/make-record.ts` — exports `createTestRecord()`.

### Changed files

1. `test/tools/agent-tool.test.ts` — remove local `makeRecord()`, import `createTestRecord` from helpers.
2. `test/tools/get-result-tool.test.ts` — remove local `makeRecord()`, import `createTestRecord` from helpers.
3. `test/tools/steer-tool.test.ts` — remove local `makeRecord()`, import `createTestRecord` from helpers.
   Replace default `status: "running"` and `session` with overrides in each call site.
4. `test/ui/agent-menu.test.ts` — remove local `makeRecord()`, import `createTestRecord` from helpers.
5. `test/conversation-viewer.test.ts` — remove local `mockRecord()`, import `createTestRecord` from helpers.
   Replace default `status: "running"` and `startedAt: Date.now()` with overrides in each call site.
6. `test/notification.test.ts` — replace 4 inline `baseRecord` literals with `createTestRecord()` calls.
7. `test/service-adapter.test.ts` — replace inline `baseRecord` / `minimal` / per-test literals with `createTestRecord()` calls.

### Unchanged files

1. `test/agent-manager.test.ts` — constructs records via `manager.spawn()`, not literals.
2. All production source files — no changes.

## Test Impact Analysis

### New tests enabled

1. A small sanity test in `test/helpers/make-record.test.ts` verifying that `createTestRecord()` returns a valid `AgentRecord` with expected defaults and that overrides are applied.
   This is optional — the factory is exercised transitively by every consumer — but it documents the contract for future maintainers (especially when #98 changes construction).

### Existing tests that become redundant

None.
This is a pure refactoring of test infrastructure; no production behavior changes.

### Existing tests that stay as-is

All existing test assertions stay unchanged.
Only the construction of `AgentRecord` objects in test setup code changes; the assertions that read those records are untouched.

## TDD Order

1. **Create shared factory and its test.**
   Add `test/helpers/make-record.ts` with `createTestRecord()`.
   Add `test/helpers/make-record.test.ts` verifying defaults and override behavior.
   Commit: `test: add shared createTestRecord factory (#102)`

2. **Migrate tool test files.**
   Update `agent-tool.test.ts`, `get-result-tool.test.ts`, `steer-tool.test.ts` to import `createTestRecord` and remove local `makeRecord()` functions.
   Run `pnpm vitest run test/tools/agent-tool.test.ts test/tools/get-result-tool.test.ts test/tools/steer-tool.test.ts` to verify.
   Commit: `test: migrate tool tests to shared createTestRecord (#102)`

3. **Migrate UI test files.**
   Update `agent-menu.test.ts` and `conversation-viewer.test.ts` to import `createTestRecord` and remove local `makeRecord()`/`mockRecord()` functions.
   Run `pnpm vitest run test/ui/agent-menu.test.ts test/conversation-viewer.test.ts` to verify.
   Commit: `test: migrate UI tests to shared createTestRecord (#102)`

4. **Migrate notification and service-adapter tests.**
   Update `notification.test.ts` and `service-adapter.test.ts` to replace inline literals with `createTestRecord()` calls.
   Run `pnpm vitest run test/notification.test.ts test/service-adapter.test.ts` to verify.
   Commit: `test: migrate notification and service-adapter tests to shared createTestRecord (#102)`

5. **Final verification.**
   Run full test suite (`pnpm vitest run`) and type check (`pnpm run check`) to confirm no regressions.
   Commit: not needed if steps 2–4 are clean; otherwise a fix-up commit.

## Risks and Mitigations

| Risk                                                                                                                   | Mitigation                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Shared defaults don't match a test's assumptions, causing silent false-passes                                          | Each migration step runs the affected test file immediately; review each test's overrides to ensure they still express the test's intent |
| `steer-tool.test.ts` relies on `session: { fake: true }` in its factory default, which the shared factory omits        | Pass `session` as an override at each call site; the mock session is test-specific and doesn't belong in shared defaults                 |
| `conversation-viewer.test.ts` uses `startedAt: Date.now()` which the shared factory replaces with `1000`               | Replace with `createTestRecord({ status: "running" })`; `startedAt` value is not asserted in any conversation-viewer test                |
| `service-adapter.test.ts` uses custom `id`, `type`, `description` values that carry semantic meaning in its assertions | Pass those values explicitly as overrides to `createTestRecord()`                                                                        |
| The `as AgentRecord` cast removal changes type-checking strictness                                                     | The shared factory returns a complete object satisfying all required fields, so removing the cast is strictly safer                      |

## Open Questions

- The factory name `createTestRecord` vs `makeRecord` vs `makeAgentRecord`: the plan uses `createTestRecord` to distinguish it from the production `AgentRecord` constructor that #98 will introduce.
  If #98 names its constructor differently, this can be revisited.
