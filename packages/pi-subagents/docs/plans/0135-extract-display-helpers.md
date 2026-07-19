---
issue: 135
issue_title: "Extract display helpers from `agent-widget.ts`"
---

# Extract display helpers from agent-widget.ts

## Problem Statement

`agent-widget.ts` (522 lines) exports 11 helper functions and constants that are general-purpose display utilities with no dependency on the widget's lifecycle or state.
Six other source modules (`agent-menu.ts`, `conversation-viewer.ts`, `renderer.ts`, `agent-tool.ts`, `foreground-runner.ts`, `get-result-tool.ts`) and two tool support modules (`helpers.ts`, `background-spawner.ts`) import formatting functions or display types from the widget — creating a false dependency on a lifecycle-heavy UI module.

This is Phase 8, Step J of the architecture plan.

## Goals

- Extract pure formatters, display helpers, constants, and associated types into `ui/display.ts`.
- Update all import sites to import from `ui/display.ts` instead of `ui/agent-widget.ts`.
- Reduce `agent-widget.ts` to only the `AgentWidget` class and its immediate dependencies (`UICtx`, private helpers).
- Unblock Step K (menu decomposition, #136) — extracted menu sub-modules will import display helpers without pulling in the widget.

## Non-Goals

- Decomposing `agent-menu.ts` — deferred to #136 (Step K).
- Changing any runtime behavior or public API.
- Extracting `UICtx` — it is a widget-lifecycle type used only by `AgentWidget`, `runtime.ts`, and `index.ts`.

## Background

The architecture doc (Phase 8 roadmap, Step J) prescribes exactly which symbols to extract.
The `code-design` skill's "Helpers stay in the file" rule applies: these helpers have accumulated to the point where they warrant their own module and tests.
AGENTS.md's "one concern per file" constraint also supports the extraction.

### Symbols to extract

#### Pure formatters (zero runtime dependencies)

1. `formatTokens(count)` — compact token count ("33.8k token").
2. `formatSessionTokens(tokens, percent, theme, compactions)` — annotated token string with threshold colors.
3. `formatTurns(turnCount, maxTurns)` — turn counter with optional limit.
4. `formatMs(ms)` — milliseconds → "1.2s".
5. `formatDuration(startedAt, completedAt)` — timestamp pair → human duration.

#### Display helpers (registry lookup only)

6. `getDisplayName(type, registry)` — resolved display name for an agent type.
7. `getPromptModeLabel(type, registry)` — "twin" for append mode, undefined otherwise.
8. `buildInvocationTags(invocation)` — config tags array from invocation options.
9. `describeActivity(activeTools, responseText)` — human-readable activity string.

#### Constants

10. `SPINNER` — braille spinner frames.
11. `ERROR_STATUSES` — set of error/non-success status strings.
12. `TOOL_DISPLAY` — tool name → action verb mapping (private, moves with `describeActivity`).

#### Types

13. `Theme` — used in `formatSessionTokens` signature; must co-locate.
14. `AgentDetails` — display metadata interface used by tools; no widget dependency.

`UICtx` stays in `agent-widget.ts` — it defines the widget's host contract and is only consumed by the widget class, `runtime.ts`, and `index.ts`.

### Current import graph (agent-widget.ts consumers)

| Consumer                           | Symbols imported                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ui/conversation-viewer.ts`        | `buildInvocationTags`, `describeActivity`, `formatDuration`, `formatSessionTokens`, `getDisplayName`, `getPromptModeLabel`, `Theme` |
| `ui/agent-menu.ts`                 | `formatDuration`, `getDisplayName`                                                                                                  |
| `tools/agent-tool.ts`              | `AgentDetails`, `buildInvocationTags`, `formatMs`, `formatTurns`, `getDisplayName`, `getPromptModeLabel`, `SPINNER`, `UICtx`        |
| `tools/foreground-runner.ts`       | `AgentDetails`, `describeActivity`, `formatMs`, `SPINNER`                                                                           |
| `tools/get-result-tool.ts`         | `formatDuration`, `getDisplayName`                                                                                                  |
| `tools/helpers.ts`                 | `AgentDetails`, `formatTokens`                                                                                                      |
| `tools/background-spawner.ts`      | `AgentDetails`                                                                                                                      |
| `renderer.ts`                      | `formatMs`, `formatTokens`, `formatTurns`                                                                                           |
| `runtime.ts`                       | `UICtx`                                                                                                                             |
| `index.ts`                         | `AgentWidget`, `UICtx`                                                                                                              |
| `test/agent-widget.test.ts`        | `formatSessionTokens`, `getDisplayName`, `getPromptModeLabel`                                                                       |
| `test/conversation-viewer.test.ts` | `Theme`                                                                                                                             |

### Post-extraction import graph

After extraction, `ui/agent-widget.ts` imports `display.ts` for the symbols it still uses internally (e.g., `getDisplayName`, `formatMs`, `formatTurns`, `formatSessionTokens`, `ERROR_STATUSES`, `SPINNER`, `describeActivity`).
All other consumers switch their imports from `./agent-widget.js` to `./display.js` (or `../ui/display.js` for `tools/` and `renderer.ts`).

Only `index.ts` and `runtime.ts` continue to import from `agent-widget.ts` (for `AgentWidget` class and `UICtx` type).
`tools/agent-tool.ts` splits its import: `UICtx` from `agent-widget.ts`, everything else from `display.ts`.

## Design Overview

This is a pure code-motion refactoring — no behavior changes.

### New module: `ui/display.ts`

Contains all 12 exported symbols (5 formatters, 4 display helpers, 3 constants) plus 2 types (`Theme`, `AgentDetails`) and 1 private helper (`truncateLine`, used by `describeActivity`).

The module's only imports are:

- `AgentConfigLookup` from `../agent-types.js` (type-only, for `getDisplayName`/`getPromptModeLabel`).
- `SubagentType`, `AgentInvocation` from `../types.js` (type-only).

No SDK imports, no runtime dependencies — exactly the kind of pure utility module the code-design skill prescribes.

### Residual `agent-widget.ts`

After extraction, `agent-widget.ts` contains:

- `UICtx` type (widget host contract).
- `AgentWidget` class (~340 lines) with its private helpers.
- Imports from `./display.js` for the format/display functions used in rendering.

## Module-Level Changes

### New files

| File                | Contents                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/display.ts` | All extracted symbols: `Theme`, `AgentDetails`, `SPINNER`, `ERROR_STATUSES`, `TOOL_DISPLAY`, `formatTokens`, `formatSessionTokens`, `formatTurns`, `formatMs`, `formatDuration`, `getDisplayName`, `getPromptModeLabel`, `buildInvocationTags`, `describeActivity`, private `truncateLine`. |

### Modified files

| File                               | Change                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/agent-widget.ts`           | Remove all extracted symbols. Add `import` from `./display.js` for symbols `AgentWidget` still uses internally. Keep `UICtx`, `AgentWidget` class, private widget helpers. |
| `src/ui/conversation-viewer.ts`    | Change import path from `./agent-widget.js` to `./display.js`.                                                                                                             |
| `src/ui/agent-menu.ts`             | Change import path from `./agent-widget.js` to `./display.js`.                                                                                                             |
| `src/tools/agent-tool.ts`          | Split import: `UICtx` from `../ui/agent-widget.js`; all others from `../ui/display.js`.                                                                                    |
| `src/tools/foreground-runner.ts`   | Change import path from `../ui/agent-widget.js` to `../ui/display.js`.                                                                                                     |
| `src/tools/get-result-tool.ts`     | Change import path from `../ui/agent-widget.js` to `../ui/display.js`.                                                                                                     |
| `src/tools/helpers.ts`             | Change import path from `../ui/agent-widget.js` to `../ui/display.js`.                                                                                                     |
| `src/tools/background-spawner.ts`  | Change import path from `../ui/agent-widget.js` to `../ui/display.js`.                                                                                                     |
| `src/renderer.ts`                  | Change import path from `./ui/agent-widget.js` to `./ui/display.js`.                                                                                                       |
| `test/agent-widget.test.ts`        | Change import path to `../src/ui/display.js`. Rename file to `test/display.test.ts` since it tests extracted functions.                                                    |
| `test/conversation-viewer.test.ts` | Change `Theme` import from `../src/ui/agent-widget.js` to `../src/ui/display.js`.                                                                                          |

### Unchanged files

| File             | Reason                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `src/runtime.ts` | Imports only `UICtx` — stays in `agent-widget.ts`.                  |
| `src/index.ts`   | Imports `AgentWidget` and `UICtx` — both stay in `agent-widget.ts`. |

## Test Impact Analysis

1. The extraction enables dedicated `display.test.ts` that tests formatting functions in isolation without any widget class ceremony.
   The existing `agent-widget.test.ts` already tests only extracted functions (`formatSessionTokens`, `getDisplayName`, `getPromptModeLabel`) — it becomes `display.test.ts` with no assertion changes, just a file rename and import path update.
2. No existing tests become redundant — the current test file already exercises the extracted layer exclusively.
3. No existing tests need assertion changes — this is a pure code-motion refactoring with no behavior change.

## TDD Order

1. **Create `ui/display.ts` with all extracted symbols; update `agent-widget.ts` to import from it.**
   Move the 12 exported symbols, 2 types, and 1 private helper to `ui/display.ts`.
   Remove them from `agent-widget.ts` and add imports from `./display.js` for symbols the `AgentWidget` class still references.
   Commit: `refactor: extract display helpers into ui/display.ts (#135)`

2. **Update all consumer imports to point at `ui/display.ts`.**
   Update the 8 source files (`conversation-viewer.ts`, `agent-menu.ts`, `agent-tool.ts`, `foreground-runner.ts`, `get-result-tool.ts`, `helpers.ts`, `background-spawner.ts`, `renderer.ts`) to import from the new module.
   Commit: `refactor: update imports to use ui/display.ts (#135)`

3. **Rename test file and update test imports.**
   Rename `test/agent-widget.test.ts` → `test/display.test.ts`.
   Update import path to `../src/ui/display.js`.
   Update `Theme` import in `test/conversation-viewer.test.ts`.
   Commit: `test: rename agent-widget test to display test (#135)`

4. **Verify: run `pnpm run check` and `pnpm vitest run`.**
   Confirm type-checking and all tests pass.
   No commit needed — validation step.

## Risks and Mitigations

| Risk                                                 | Mitigation                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Missed import site causes runtime `undefined` import | Grep confirmed all 10 source consumers and 2 test consumers above. Step 4 validates with type-check + full test suite. |
| `TOOL_DISPLAY` made public unintentionally           | Keep it non-exported in `display.ts` (only `describeActivity` uses it).                                                |
| Circular dependency `display.ts` ↔ `agent-widget.ts` | `display.ts` has no imports from `agent-widget.ts`. `agent-widget.ts` imports from `display.ts` — one-directional.     |
| Re-export churn for downstream consumers             | No downstream consumers — these are all internal module imports, not public API.                                       |

## Open Questions

None — the architecture doc and issue specify the exact extraction set and target module.
