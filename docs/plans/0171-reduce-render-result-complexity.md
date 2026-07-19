---
issue: 171
issue_title: "refactor(pi-subagents): reduce renderResult complexity (cognitive 43)"
---

# Reduce `renderResult` complexity

## Problem Statement

`renderResult` in `tools/agent-tool.ts` has cyclomatic complexity 26 and cognitive complexity 43.
It formats the agent result text returned to the parent LLM, branching on status (completed, error, aborted, stopped, steered) and handling fallback notes, duration, stats, and worktree info.
Fallow ranks this as the #1 refactoring target (score 13.4).

## Goals

- Extract per-status result formatting into standalone pure functions in a new module.
- Extract the inline `stats()` helper as a shared, testable function.
- Reduce `renderResult` to a thin guard (no-details fallback) plus a dispatcher call.
- Make each formatter independently testable with clear input/output.

## Non-Goals

- Changing the visual output or behavior of any status rendering.
- Refactoring `renderCall`, `execute`, or other parts of `createAgentTool`.
- Changing the `AgentDetails` interface shape.
- Modifying the widget renderer (`widget-renderer.ts`) — it has its own rendering pipeline.

## Background

Issue #164 (reorganize source into domain directories) is implemented — files are already in `src/tools/`.

`renderResult` currently handles six concerns in a single method body:

1. **No-details guard** — when `result.details` is absent, fall back to raw text.
2. **Running/partial** — spinner frame + stats + activity line.
3. **Background** — dim "Running in background" message with agent ID.
4. **Completed/steered** — success/warning icon + stats + duration + optional expanded result text (first 50 lines).
5. **Stopped** — dim stop icon + stats + "Stopped" message.
6. **Error/aborted** — error icon + stats + error message or "Aborted (max turns exceeded)".

An inline `stats()` closure builds the "haiku · thinking: high · ⟳5≤30 · 3 tool uses · 33.8k tokens" string used by every branch except no-details and background.

The existing `Theme` type in `display.ts` already captures the `fg()`/`bold()` pattern the formatters need.

The sister module `widget-renderer.ts` in `ui/` demonstrates the established pattern: pure rendering functions that receive data and a theme, returning formatted strings.
The new module follows the same shape.

## Design Overview

### New module: `src/tools/result-renderer.ts`

A new file containing pure functions that convert an `AgentDetails` snapshot into a formatted result string for a specific status.
Each formatter receives `AgentDetails`, a `Theme`, and any status-specific data (result text, expanded flag).
Each returns a `string` — the formatted lines for that status.

```typescript
import type { AgentDetails, Theme } from "#src/ui/display";

/** Build the stats string: "haiku · thinking: high · ⟳5≤30 · 3 tool uses · 33.8k tokens". */
export function renderStats(details: AgentDetails, theme: Theme): string;

/** Render running/partial status: spinner + stats + activity. */
export function renderRunning(details: AgentDetails, theme: Theme): string;

/** Render background launch status. */
export function renderBackground(details: AgentDetails, theme: Theme): string;

/** Render completed or steered status with optional expanded result text. */
export function renderCompleted(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  theme: Theme,
): string;

/** Render stopped status: dim icon + stats. */
export function renderStopped(details: AgentDetails, theme: Theme): string;

/** Render error or aborted status: error icon + stats + message. */
export function renderFailed(details: AgentDetails, theme: Theme): string;

/** Dispatch to the per-status renderer. */
export function renderAgentResult(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
): string;
```

### Grouping decisions

- **Completed + steered** stay in one function — they share 90% of logic, differing only in icon color (`success` vs `warning`) and collapsed text (`"Done"` vs `"Wrapped up (turn limit)"`).
  A discriminator inside the function is justified because both statuses represent the same structural outcome (agent finished with result).
- **Error + aborted** stay in one function — they share icon+stats structure, differing only in the status line.
  Both represent failure-class outcomes.

### Simplified `renderResult`

After extraction, `renderResult` becomes a ~10-line method:

```typescript
renderResult(result: any, { expanded, isPartial }: any, theme: any) {
  const details = result.details as AgentDetails | undefined;
  if (!details) {
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return new Text(text, 0, 0);
  }
  const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
  return new Text(
    renderAgentResult(details, resultText, expanded, isPartial, theme),
    0, 0,
  );
}
```

The no-details guard stays inline because it needs the SDK-specific `Text` constructor and raw `result` content access — extracting it would pull SDK concerns into the pure module.

### Design principles applied

- **SRP**: Each formatter has one reason to change (its status's display rules).
- **ISP**: Formatters use the existing narrow `Theme` interface (2 methods) rather than the full SDK theme object.
- **No output arguments**: Formatters return strings; they don't mutate shared state.
- **Stepdown rule**: `renderAgentResult` dispatcher at the top of the module, per-status formatters below, `renderStats` helper at the bottom.

## Module-Level Changes

### New file: `src/tools/result-renderer.ts`

- `renderStats` — extracted from the inline `stats()` closure.
- `renderRunning` — running/partial branch.
- `renderBackground` — background branch.
- `renderCompleted` — completed/steered branch.
- `renderStopped` — stopped branch.
- `renderFailed` — error/aborted branch.
- `renderAgentResult` — dispatcher function.

### Modified: `src/tools/agent-tool.ts`

- Remove the inline `stats()` closure.
- Remove the five status branches from `renderResult`.
- Import `renderAgentResult` from `result-renderer.ts`.
- Reduce `renderResult` body to guard + dispatcher call.
- The `SPINNER` import is removed (moved to `result-renderer.ts`).
- The `formatMs`, `formatTurns` imports are removed (consumed only by the extracted code).

### New file: `test/tools/result-renderer.test.ts`

- Unit tests for `renderStats`, each per-status renderer, and the `renderAgentResult` dispatcher.

## Test Impact Analysis

1. **New unit tests enabled**: Each formatter can now be tested in isolation — verifying icon selection, stats assembly, expanded-text truncation (50-line limit), activity text, and error message rendering — without constructing a full `createAgentTool` or mocking the Pi SDK `Text` class.
2. **No existing tests become redundant**: The existing `agent-tool.test.ts` tests cover `execute` paths (resume, background, foreground), `renderCall`, and tool definition properties.
   None of them test `renderResult` — there are zero existing `renderResult` tests.
3. **Existing tests stay as-is**: All `agent-tool.test.ts` tests exercise `execute` and tool metadata, orthogonal to the rendering extraction.

## TDD Order

1. **Red → Green**: Add unit tests for `renderStats` — model name, tags, turn count with/without max, tool uses singular/plural, tokens, empty details producing empty string.
   Commit: `test: add renderStats unit tests`

2. **Red → Green**: Add unit tests for `renderRunning` — spinner frame, stats inclusion, activity text, default "thinking…" fallback.
   Commit: `test: add renderRunning unit tests`

3. **Red → Green**: Add unit tests for `renderBackground` — agent ID in output, dim styling.
   Commit: `test: add renderBackground unit tests`

4. **Red → Green**: Add unit tests for `renderCompleted` — completed icon (success), steered icon (warning), duration formatting, expanded view with result text, expanded view truncation at 50 lines, collapsed view "Done" vs "Wrapped up (turn limit)" text.
   Commit: `test: add renderCompleted unit tests`

5. **Red → Green**: Add unit tests for `renderStopped` — dim icon, stats, "Stopped" text.
   Commit: `test: add renderStopped unit tests`

6. **Red → Green**: Add unit tests for `renderFailed` — error status with error message, error with missing message defaulting to "unknown", aborted status with "max turns exceeded" text.
   Commit: `test: add renderFailed unit tests`

7. **Red → Green**: Add unit tests for `renderAgentResult` dispatcher — correct delegation by status (running, background, completed, steered, stopped, error, aborted), `isPartial` triggering running renderer.
   Commit: `test: add renderAgentResult dispatcher tests`

8. **Green → Refactor**: Create `result-renderer.ts` with all renderer functions and the dispatcher, extracted from `renderResult` in `agent-tool.ts`.
   Commit: `refactor: extract result renderers from agent-tool`

9. **Green → Refactor**: Simplify `renderResult` in `agent-tool.ts` to the guard + dispatcher pattern.
   Remove unused imports (`SPINNER`, `formatMs`, `formatTurns`).
   Verify all existing `agent-tool.test.ts` tests still pass.
   Commit: `refactor: simplify renderResult to dispatcher`

## Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatter output differs subtly from inline code (wrong icon, missing newline)     | Steps 1–7 lock in the expected output before extraction; step 9 confirms no regressions via existing tests.                                                   |
| `theme` parameter is `any` in the tool hook — extracted functions use `Theme` type | The `Theme` interface in `display.ts` already matches the runtime shape; existing `widget-renderer.ts` demonstrates this pattern works.                       |
| Future statuses added to `AgentDetails["status"]` need a new formatter             | The dispatcher's fallback branch (currently the error/aborted block) handles unknown statuses; adding a status requires one new function + one dispatch case. |

## Open Questions

- None — the extraction is mechanical and the issue's approach section is unambiguous.
