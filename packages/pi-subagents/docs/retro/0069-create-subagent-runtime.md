---
issue: 69
issue_title: "refactor: eliminate module-scope mutable state in pi-subagents — create SubagentRuntime"
---

# Retro: #69 — create SubagentRuntime

## Final Retrospective (2026-05-19T16:47:00Z)

### Session summary

Planned, implemented, and shipped `SubagentRuntime` — a composition-root object that replaces module-scope mutable state in `agent-runner.ts` and closure-scoped state in `index.ts`.
Six TDD steps completed with one deviation: `agent-tool.ts` and `agent-menu.ts` also imported the removed getter/setter exports, requiring unplanned fixes.
Released as `pi-subagents-v5.2.0`.

### Observations

#### What went well

- The lift-and-shift strategy (introduce `RunOptions` fields alongside module-scope fallback, wire consumers, then remove old path) kept the 460-test suite green through every intermediate commit.
  No step broke existing tests.
- `pnpm run check` caught the two missing downstream files (`agent-tool.ts`, `agent-menu.ts`) immediately after the removal step.
  The typecheck-after-removal safety net worked exactly as intended.
- The `pi-permission-system` prior art (`ExtensionRuntime` in #43) provided a clear structural template, reducing design decisions to near zero.

#### What caused friction (agent side)

- `missing-context` — The plan's Module-Level Changes listed `agent-runner.ts`, `agent-manager.ts`, and `index.ts` but missed `src/tools/agent-tool.ts` and `src/ui/agent-menu.ts`, both of which imported `getDefaultMaxTurns`/`setDefaultMaxTurns`/`getGraceTurns`/`setGraceTurns` from `agent-runner.ts`.
  A grep for all importers of the removed symbols during planning would have caught this.
  Impact: 4 extra files touched in step 5 (the two source files + their test helpers); no rework of earlier steps, but the commit scope was wider than planned. (self-identified at `pnpm run check` time)

- `missing-context` — In step 3 (`agent-manager.test.ts`), checked `vi.mocked(runAgent).mock.calls[0]` without clearing the mock first.
  The module-level `vi.mock("../src/agent-runner.js")` is shared across all describe blocks, so `calls[0]` picked up a stale invocation from an earlier test.
  Impact: one debug cycle adding `vi.mocked(runAgent).mockClear()` after `resolvedRun()`. (self-identified)

#### What caused friction (user side)

- Nothing notable.
  The plan was unambiguous, and the session ran without user intervention beyond the initial prompts.

### Changes made

1. `.pi/prompts/plan-issue.md` — added grep-importers rule to the Module-Level Changes bullet: when a step removes or renames an export, grep all `src/` and `test/` files for every removed symbol before finalizing the file list.
