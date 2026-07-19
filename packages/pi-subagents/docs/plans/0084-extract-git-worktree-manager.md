---
issue: 84
issue_title: "refactor: extract GitWorktreeManager class from worktree.ts free functions"
---

# Extract GitWorktreeManager class

## Problem Statement

`worktree.ts` exports three free functions — `createWorktree(cwd, id)`, `cleanupWorktree(cwd, wt, desc)`, and `pruneWorktrees(cwd)` — that all operate on git worktrees relative to a repository root.
Every caller threads `cwd` as the first argument.
These functions form a cohesive unit with natural shared state (the repo root), but today there is no object to capture it.

Issue #72 (dependency-inject `AgentManager`'s collaborators) needs a `WorktreeManager` interface to inject.
Extracting the class first keeps #72 a clean DI + constructor refactor instead of mixing object extraction with dependency injection.

## Goals

- Define a `WorktreeManager` interface in `worktree.ts` with three methods: `create(id)`, `cleanup(wt, desc)`, `prune()` — no `cwd` parameter.
- Add a `GitWorktreeManager` class that captures `cwd` at construction and delegates to the existing free functions.
- Export both the interface and the class.
- Existing free functions stay exported and unchanged.
- No behavior change.

## Non-Goals

- Changing `AgentManager` to use the new class (that is #72).
- Refactoring the internal implementation of `createWorktree`, `cleanupWorktree`, or `pruneWorktrees`.
- Publishing `WorktreeManager` as a cross-extension API via `Symbol.for()` — it is internal to this package.

## Background

### Prerequisites

None — this is the first step in the #72 dependency chain.

### Relevant modules

| Module                  | Role                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `src/worktree.ts`       | Free functions for git worktree create/cleanup/prune       |
| `test/worktree.test.ts` | Integration tests that create real git repos and worktrees |
| `src/agent-manager.ts`  | Only consumer of the three free functions (6 call sites)   |

### Constraints from AGENTS.md / code-style

- Keep modules focused and composable (one concern per file).
- When a shared interface references a collaborator, use a narrow interface type — not the concrete class.
- Business logic should be pure functions wherever possible — keep IO at the edges.

The free functions are IO (they shell out to `git`), so wrapping them in a class that captures `cwd` is the right level of abstraction — the class is a thin adapter, not business logic.

## Design Overview

### Interface and class

Added at the bottom of `worktree.ts`, after the existing free functions:

```typescript
export interface WorktreeManager {
  create(id: string): WorktreeInfo | undefined;
  cleanup(wt: WorktreeInfo, description: string): WorktreeCleanupResult;
  prune(): void;
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly cwd: string) {}

  create(id: string): WorktreeInfo | undefined {
    return createWorktree(this.cwd, id);
  }

  cleanup(wt: WorktreeInfo, description: string): WorktreeCleanupResult {
    return cleanupWorktree(this.cwd, wt, description);
  }

  prune(): void {
    pruneWorktrees(this.cwd);
  }
}
```

### Why the interface lives in `worktree.ts`

The `WorktreeManager` interface references `WorktreeInfo` and `WorktreeCleanupResult`, which are already defined in `worktree.ts`.
Co-locating avoids a separate file for a 5-line interface.
This matches the #72 plan's expectation: `import type { WorktreeManager } from "./worktree.js"`.

### No changes to callers

`agent-manager.ts` continues importing and calling the free functions directly.
Issue #72 handles the migration to the injected `WorktreeManager`.

## Module-Level Changes

### `src/worktree.ts` (modified)

- Add `WorktreeManager` interface (3 methods).
- Add `GitWorktreeManager` class implementing the interface.
- Existing free functions, types, and imports unchanged.

### `test/worktree.test.ts` (modified)

- Add a new `describe("GitWorktreeManager")` block with tests for the class.
- Existing free-function tests stay as-is.

## Test Impact Analysis

### New unit tests enabled

1. `GitWorktreeManager.create` — delegates to `createWorktree` with the captured `cwd`.
2. `GitWorktreeManager.cleanup` — delegates to `cleanupWorktree` with the captured `cwd`.
3. `GitWorktreeManager.prune` — delegates to `pruneWorktrees` with the captured `cwd`.

These are thin delegation tests that verify the class wires `cwd` correctly.
They reuse the same real-git-repo test infrastructure already in `worktree.test.ts`.

### Existing tests

All existing tests in `worktree.test.ts` stay unchanged — they test the free functions directly.

## TDD Order

1. **RED:** Add `describe("GitWorktreeManager")` with tests for `create`, `cleanup`, and `prune`.
   Tests import `GitWorktreeManager` which does not exist yet — compilation fails.
   Commit: `test: add GitWorktreeManager tests`

2. **GREEN:** Add `WorktreeManager` interface and `GitWorktreeManager` class to `worktree.ts`.
   All tests pass.
   Run `pnpm run check` to verify types.
   Commit: `feat: extract WorktreeManager interface and GitWorktreeManager class (#84)`

## Risks and Mitigations

| Risk                                                                      | Mitigation                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Class delegation tests are slow because they create real git repos        | The existing test suite already does this; the new tests reuse the same `initGitRepo()` helper and add ~3 test cases to an already-fast suite. |
| Future callers bypass the interface and use `GitWorktreeManager` directly | The #72 plan types `AgentManager`'s constructor parameter as `WorktreeManager` (the interface), not the class. Code review enforces this.      |

## Open Questions

None — the interface shape is specified by the issue and matches the #72 plan exactly.
