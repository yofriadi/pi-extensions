---
issue: 205
issue_title: "Decompose renderWidgetLines (cognitive 44)"
---

# Decompose `renderWidgetLines`

## Problem Statement

`renderWidgetLines` in `ui/widget-renderer.ts` has cognitive complexity 44 (CRITICAL per fallow health).
It handles agent categorization, per-status line building with tree connectors, non-overflow assembly with last-connector fixup, and overflow-budget assembly — all in a single 106-line function.
This is the highest-complexity function remaining in the codebase (Phase 12, Step 1).

## Goals

- Extract distinct concerns into separate pure functions, each with cognitive complexity < 10.
- Preserve all existing behavior — no visual or behavioral changes.
- Keep all extracted functions in `widget-renderer.ts` (they are private helpers, not a separate module).

## Non-Goals

- Decomposing `showAgentDetail` (#206), `update` (#207), or shared test fixtures (#208) — those are sibling Phase 12 steps.
- Changing the widget's visual output or tree-connector style.
- Modifying `renderFinishedLine` or `renderRunningLines` — those are already single-concern functions.

## Background

`widget-renderer.ts` was extracted from `AgentWidget` in #148.
The per-agent renderers (`renderFinishedLine`, `renderRunningLines`) are already clean single-concern functions.
The remaining complexity lives entirely in `renderWidgetLines`, which orchestrates categorization, section building, and assembly.

The function has five interwoven concerns:

1. **Agent categorization** — filtering into running/queued/finished buckets.
2. **Section building** — rendering each bucket into pre-formatted line arrays with `├─` tree connectors.
3. **Heading construction** — choosing icon/color based on active vs. finished-only.
4. **Non-overflow assembly** — concatenating sections when under `MAX_WIDGET_LINES`, then fixing the last connector (`├─` → `└─`).
5. **Overflow assembly** — budget-based prioritized assembly (running > queued > finished) with an overflow indicator line.

## Design Overview

Extract four helper functions from the body of `renderWidgetLines`:

### `categorizeAgents`

Accepts the agents array and `shouldShowFinished` callback.
Returns `{ running, queued, finished }` arrays.
Pure filter — no rendering.

### `buildSections`

Accepts categorized agents, `activityMap`, `registry`, `spinnerFrame`, `theme`, and a `truncate` function.
Returns `{ finishedLines, runningLines, queuedLine }` — the pre-formatted line arrays with `├─` connectors.
Calls `renderFinishedLine` and `renderRunningLines` internally.

### `assembleWithinBudget`

Accepts `finishedLines`, `runningLines`, `queuedLine`, and the heading line.
Handles the non-overflow path: concatenates sections and fixes the last tree connector (`├─` → `└─`, `│` → space).
Returns the assembled `string[]`.

### `assembleOverflow`

Accepts `finishedLines`, `runningLines`, `queuedLine`, heading line, `maxBody` budget, `truncate`, and `theme`.
Handles the overflow path: budget-based prioritized assembly with an overflow indicator.
Returns the assembled `string[]`.

After extraction, `renderWidgetLines` becomes a thin orchestrator:

```typescript
export function renderWidgetLines(params: { ... }): string[] {
  const { running, queued, finished } = categorizeAgents(agents, shouldShowFinished);
  if (running.length === 0 && queued.length === 0 && finished.length === 0) return [];

  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const heading = buildHeadingLine(running, queued, truncate, theme);
  const sections = buildSections(running, queued, finished, activityMap, registry, spinnerFrame, theme, truncate);
  const totalBody = sections.finishedLines.length + sections.runningLines.length * 2 + (sections.queuedLine ? 1 : 0);

  if (totalBody <= MAX_WIDGET_LINES - 1) {
    return assembleWithinBudget(heading, sections);
  }
  return assembleOverflow(heading, sections, MAX_WIDGET_LINES - 1, truncate, theme);
}
```

Each helper is a pure function with a single concern and low branching.

## Module-Level Changes

### Changed: `src/ui/widget-renderer.ts`

- Add `categorizeAgents` (private) — extracts the three `agents.filter(...)` calls.
- Add `buildSections` (private) — extracts the three section-building loops.
- Add `assembleWithinBudget` (private) — extracts the non-overflow assembly + connector fixup.
- Add `assembleOverflow` (private) — extracts the overflow-budget assembly + indicator line.
- Simplify `renderWidgetLines` to a thin orchestrator calling the four helpers.

No exports are added, removed, or renamed.
No other files change.

## Test Impact Analysis

1. No new unit tests for the extracted helpers are needed — they are private functions tested through `renderWidgetLines`.
   The existing `renderWidgetLines` tests in `test/widget-renderer.test.ts` (8 tests) cover all branches: single running, mixed agents, filtered finished, overflow priority, empty arrays, dim heading.
2. No existing tests become redundant — they all exercise `renderWidgetLines` end-to-end, which is the correct level for assembly logic.
3. All existing tests must stay as-is — the extraction is purely internal.

## TDD Order

1. **Red → Green:** Extract `categorizeAgents` and call it from `renderWidgetLines`.
   All existing tests pass (no behavior change).
   Commit: `refactor: extract categorizeAgents from renderWidgetLines`

2. **Red → Green:** Extract `buildSections` and call it from `renderWidgetLines`.
   All existing tests pass.
   Commit: `refactor: extract buildSections from renderWidgetLines`

3. **Red → Green:** Extract `assembleWithinBudget` and call it from `renderWidgetLines`.
   All existing tests pass.
   Commit: `refactor: extract assembleWithinBudget from renderWidgetLines`

4. **Red → Green:** Extract `assembleOverflow` and call it from `renderWidgetLines`.
   All existing tests pass.
   Commit: `refactor: extract assembleOverflow from renderWidgetLines`

5. **Verify:** Run `pnpm run check` and `pnpm vitest run test/widget-renderer.test.ts` to confirm no regressions.
   Commit: n/a (verification only).

## Risks and Mitigations

| Risk                                                                        | Mitigation                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tree-connector fixup logic is fragile (string replacement on Unicode chars) | Keep the fixup in `assembleWithinBudget` as-is — same logic, just relocated. Existing tests verify exact connector output.             |
| Extracted helpers have many parameters                                      | Accept a `sections` object from `buildSections` to bundle `finishedLines`, `runningLines`, `queuedLine` — avoids long parameter lists. |
| Intermediate commits break tests                                            | Each extraction step is self-contained — the function body moves into a helper and the call site replaces it in the same commit.       |

## Open Questions

None — the decomposition is purely mechanical extraction of existing code into named helpers.
