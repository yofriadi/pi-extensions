---
issue: 76
issue_title: "refactor: inject cwd into AgentManager constructor instead of reading process.cwd() in dispose()"
---

# Inject cwd into AgentManager constructor

## Problem Statement

`AgentManager.dispose()` calls `pruneWorktrees(process.cwd())` directly — the only place in the class that reads a process global instead of accepting `cwd` from the caller.
Every other code path that needs a working directory receives it via the per-spawn invocation context (`ctx.cwd`).
This implicit dependency makes the class harder to test and inconsistent with its own conventions.

## Goals

- Add `cwd: string` as the first parameter of the `AgentManager` constructor and store it as a private field.
- Replace `pruneWorktrees(process.cwd())` in `dispose()` with `pruneWorktrees(this.cwd)`.
- Update the single production call site in `index.ts` to pass `process.cwd()`.
- Update all 18 test-file constructor calls to pass a test directory string.

## Non-Goals

- Removing other `process.cwd()` calls elsewhere in the extension (e.g., `loadCustomAgents` in `index.ts`).
- Changing how per-spawn `ctx.cwd` flows through `agent-runner.ts`.
- Refactoring the constructor's callback-heavy signature into an options object (potential follow-up).

## Background

### Relevant modules

| Module               | Role                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `agent-manager.ts`   | Owns `AgentManager` class; constructor at line 83, `dispose()` at line 479 with the `process.cwd()` call.                     |
| `index.ts`           | Extension entry point; constructs `AgentManager` at line 64. Already calls `process.cwd()` at line 43 for `loadCustomAgents`. |
| `worktree.ts`        | Exports `pruneWorktrees(cwd: string)` consumed by `dispose()`.                                                                |
| `service-adapter.ts` | Depends on `AgentManagerLike` interface, which does not expose the constructor — unaffected.                                  |

### Constraints

From AGENTS.md / code-style skill:

> Do not read `process.env`, `process.cwd()`, or `process.platform` inside library/utility functions — accept the value as a parameter.

This refactoring directly enforces that rule.

`AgentManager` is internal — the public API surface (`exports` in `package.json`) is `service.ts` only, so this is a non-breaking change for consumers.

## Design Overview

The change is mechanical:

1. Prepend `cwd: string` to the constructor parameter list.
2. Store it as `private readonly cwd: string`.
3. Replace `process.cwd()` in `dispose()` with `this.cwd`.
4. At the call site in `index.ts`, pass `process.cwd()` as the first argument.
5. In tests, pass a fixed string like `"/test-cwd"` to every `new AgentManager(...)` call.

No new types, no interface changes, no export changes.

## Module-Level Changes

### `src/agent-manager.ts`

- Add `private readonly cwd: string` field.
- Constructor: add `cwd: string` as the first parameter, assign `this.cwd = cwd`.
- `dispose()`: change `pruneWorktrees(process.cwd())` → `pruneWorktrees(this.cwd)`.
- Remove the `process` global dependency (no more `process.cwd()` import needed in this file).

### `src/index.ts`

- Pass `process.cwd()` as the first argument to `new AgentManager(...)`.

### `test/agent-manager.test.ts`

- All 18 `new AgentManager(...)` calls gain `"/test-cwd"` as the first argument.
- No other test logic changes — `pruneWorktrees` is already mocked.

## Test Impact Analysis

1. No new unit tests are needed — the existing `dispose()` test already exercises `pruneWorktrees` via the mock; it will now verify the injected `cwd` is forwarded instead of the process global.
2. No existing tests become redundant.
3. All 18 constructor calls must be updated with the new first argument, but the test assertions remain valid.

## TDD Order

1. **Red → Green: update constructor and dispose** — change the `AgentManager` constructor to accept `cwd` as the first parameter, store it, and use `this.cwd` in `dispose()`.
   Update all 18 test constructor calls to pass `"/test-cwd"`.
   Update `index.ts` call site to pass `process.cwd()`.
   Commit message: `refactor: inject cwd into AgentManager constructor (#76)`

This is a single-step refactoring — splitting it further would leave the codebase in a broken intermediate state since the constructor signature change must be applied atomically across production code and tests.

## Risks and Mitigations

| Risk                            | Mitigation                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Missing a constructor call site | `grep 'new AgentManager'` across the entire repo confirms only `index.ts` (1 call) and `agent-manager.test.ts` (18 calls).                |
| Accidentally changing behavior  | `pruneWorktrees` is already mocked in tests; production call site passes `process.cwd()` which is the same value `dispose()` read before. |

## Open Questions

None — the issue's proposed change section is unambiguous and the refactoring is mechanical.
