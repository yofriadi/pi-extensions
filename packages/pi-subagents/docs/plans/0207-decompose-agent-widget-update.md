---
issue: 207
issue_title: "Decompose update in agent-widget.ts (cognitive 31)"
---

# Decompose `update` in `agent-widget.ts`

## Problem Statement

`update` in `ui/agent-widget.ts` has cognitive complexity 31 (CRITICAL per fallow health).
It mixes agent state categorization, widget teardown, status bar management, and widget registration dispatch in a single 70-line method.
Phase 12, Step 3 targets cognitive complexity < 10 per function.

## Goals

- Extract `assembleWidgetState` as an exported pure function (agent list → lightweight counts/flags) that is directly unit-testable.
- Extract `clearWidget` as a private method encapsulating the "nothing to show" teardown path.
- Extract `updateStatusBar` as a private method encapsulating status text computation and conditional update.
- Simplify `update` to a thin orchestrator: guard → assemble → if idle clear → else update status + register.
- Target: cognitive complexity < 10 for every function in the file.

## Non-Goals

- Decomposing `renderWidgetLines` (#205, done), `showAgentDetail` (#206, done), or shared test fixtures (#208) — sibling Phase 12 steps.
- Extracting a separate timer-manager class — the timer lifecycle (`ensureTimer` + `clearWidget`) is two lines of `setInterval`/`clearInterval`.
- Changing the widget's visual output, status bar format, registration timing, or timer interval.
- Narrowing the `AgentManager` dependency to an interface — tracked separately.
- Adding end-to-end tests for `AgentWidget` — the widget depends on the Pi TUI context.
- Changing `dispose` behavior — it remains a shutdown-only teardown path.

## Background

`agent-widget.ts` was substantially decomposed in #148 (Phase 9, Step P), which extracted pure rendering into `widget-renderer.ts`.
The widget shrank from 374 to ~198 lines.
`update` remained as a 70-line orchestrator with five interwoven concerns:

1. **Guard** — early return when `uiCtx` is not yet set.
2. **Agent state categorization** — counting running/queued/finished agents from `listAgents()`.
3. **Clear path** — unregistering widget, clearing status, stopping timer, cleaning stale `finishedTurnAge` entries.
4. **Status bar update** — computing status text from running/queued counts, conditionally calling `setStatus`.
5. **Widget lifecycle** — incrementing `widgetFrame`, registering the widget factory on first use, calling `requestRender()` on subsequent ticks.

Concerns 3–4 consume counts from concern 2 but each has a distinct responsibility.

`categorizeAgents` in `widget-renderer.ts` performs a similar filter but returns full `WidgetAgent[]` arrays for rendering.
`assembleWidgetState` returns lightweight counts for lifecycle decisions — different outputs for different consumers, not duplication.

No existing tests cover `AgentWidget` methods — `test/widget-renderer.test.ts` covers the rendering layer.

### Complexity sources in `update` (cognitive 31)

1. Agent counting loop with 3-branch if/else (`status` checks + `shouldShowFinished`) — contributes ~6.
2. Conditional widget clear path: nested checks for `widgetRegistered`, `lastStatusText`, `widgetInterval`, plus a `for`-loop with nested `if` for stale-entry cleanup — contributes ~12.
3. Status text computation with conditional `if (hasActive)` and nested `if`/push branches — contributes ~5.
4. Conditional status update (`newStatusText !== this.lastStatusText`) — contributes ~2.
5. Widget registration dispatch (`if (!widgetRegistered) ... else ...`) — contributes ~4.

### `dispose` is not a duplication target

`dispose` (10 lines, cognitive ~2) and `update`'s idle path share *some* statements — `clearInterval`, `setWidget(undefined)`, `setStatus(undefined)`, flag resets — but differ in two ways:

- **Guards:** `update`'s idle path guards each call (`if (widgetRegistered)`, `if (lastStatusText !== undefined)`) to avoid redundant SDK calls during repeated timer ticks.
  `dispose` unconditionally calls `setWidget`/`setStatus` (when `uiCtx` exists) as a correctness guarantee during shutdown.
- **Stale-entry cleanup:** `update`'s idle path cleans `finishedTurnAge` entries for agents no longer in `listAgents()`.
  `dispose` skips this — the Map is about to be garbage collected.

Per the code-design skill ("duplication is far cheaper than the wrong abstraction" — verify structural context before extracting), these are different lifecycle semantics.
`dispose` stays as-is; `clearWidget` is extracted only from `update`'s idle path.

## Design Overview

### `assembleWidgetState` (exported, pure)

```typescript
/** Minimal agent shape needed for widget lifecycle decisions. */
interface AgentSummary {
  readonly id: string;
  readonly status: string;
  readonly completedAt?: number;
}

export interface WidgetState {
  readonly runningCount: number;
  readonly queuedCount: number;
  readonly hasFinished: boolean;
  readonly hasActive: boolean;
}

export function assembleWidgetState(
  agents: readonly AgentSummary[],
  shouldShowFinished: (agentId: string, status: string) => boolean,
): WidgetState
```

The input uses a local `AgentSummary` interface (3 fields) rather than `WidgetAgent` (10+ fields).
This follows ISP — `assembleWidgetState` only reads `id`, `status`, and `completedAt`.
Tests can pass plain objects without constructing full agent fixtures.
`AgentRecord` satisfies `AgentSummary` structurally, so no adapter is needed at the call site.

`hasActive` is derived from the counts (`runningCount > 0 || queuedCount > 0`) but included for call-site readability.
Only `assembleWidgetState` constructs `WidgetState`, so consistency is guaranteed.

### `clearWidget` (private method)

Encapsulates `update`'s "nothing to show" teardown path:

- Unregister widget via `setWidget("agents", undefined)` if `widgetRegistered`.
- Clear status via `setStatus("subagents", undefined)` if `lastStatusText` is set.
- Stop timer via `clearInterval` if `widgetInterval` is running.
- Reset lifecycle flags (`widgetRegistered`, `tui`, `lastStatusText`, `widgetInterval`).
- Clean stale `finishedTurnAge` entries (agents no longer in `allAgents`).

Accepts `allAgents` as a parameter for the stale-entry cleanup.

```typescript
private clearWidget(allAgents: readonly AgentSummary[]): void
```

`dispose` does **not** delegate to `clearWidget` — see "dispose is not a duplication target" above.

### `updateStatusBar` (private method)

Encapsulates the status text concern:

- Compute status text from `runningCount` / `queuedCount` (undefined when `!hasActive`).
- Call `setStatus("subagents", text)` only when text differs from `lastStatusText`.
- Cache the new value in `lastStatusText`.

```typescript
private updateStatusBar(state: WidgetState): void
```

### After refactoring

```typescript
update() {
  if (!this.uiCtx) return;

  const allAgents = this.manager.listAgents();
  const state = assembleWidgetState(allAgents, (id, status) => this.shouldShowFinished(id, status));

  if (!state.hasActive && !state.hasFinished) {
    this.clearWidget(allAgents);
    return;
  }

  this.updateStatusBar(state);
  this.widgetFrame++;

  if (!this.widgetRegistered) {
    this.uiCtx.setWidget("agents", (tui, theme) => {
      this.tui = tui;
      return {
        render: () => this.renderWidget(tui, theme),
        invalidate: () => {
          this.widgetRegistered = false;
          this.tui = undefined;
        },
      };
    }, { placement: "aboveEditor" });
    this.widgetRegistered = true;
  } else {
    this.tui?.requestRender();
  }
}
```

Cognitive complexity: ~4 (one guard early return + one if/else branch + flat registration dispatch).

### Complexity budget

| Function              | Estimated cognitive complexity                  |
| --------------------- | ----------------------------------------------- |
| `assembleWidgetState` | ~3 (flat loop with 3 branches)                  |
| `clearWidget`         | ~6 (4 guards + loop with if)                    |
| `updateStatusBar`     | ~4 (hasActive check + diff check)               |
| `update` (after)      | ~4 (guard + idle check + registration dispatch) |
| `dispose` (unchanged) | ~2                                              |

All under 10.

## Module-Level Changes

### Changed: `src/ui/agent-widget.ts`

- Add local `AgentSummary` interface (3 fields: `id`, `status`, `completedAt?`).
- Add exported `WidgetState` interface.
- Add exported `assembleWidgetState(agents, shouldShowFinished)` pure function.
- Add private `clearWidget(allAgents)` method — extracted from `update`'s idle path.
- Add private `updateStatusBar(state)` method — extracted from `update`'s status bar logic.
- Simplify `update` to orchestrate: guard → assemble → if idle clear → else update status + register.
- `dispose` is unchanged.

No exports are removed or renamed.
The public API (`AgentWidget` class with `setUICtx`, `onTurnStart`, `ensureTimer`, `markFinished`, `update`, `dispose`) is unchanged.
`UICtx` type stays exported.

### Unchanged: `test/widget-renderer.test.ts`

No changes — this file covers `widget-renderer.ts` functions, not `agent-widget.ts`.

### Changed: `docs/architecture/architecture.md`

- Update the complexity hotspots table: remove `update` row (no longer ≥ 21 cyclomatic).
- Also remove the `renderWidgetLines` row if #205 is already implemented (it is — closed).

## Test Impact Analysis

1. **New tests enabled:** Direct unit tests for `assembleWidgetState` — a pure function accepting plain objects.
   Tests cover: empty list, running-only, queued-only, finished-only, mixed states, `shouldShowFinished` filtering, agents without `completedAt` excluded from finished.
   The narrow `AgentSummary` input type means test fixtures are 3-field objects — no need for full agent records.
2. **No existing tests become redundant** — there are currently no tests for `AgentWidget`.
3. **No existing tests must change** — `test/widget-renderer.test.ts` (23 tests) exercises the renderer layer and is unaffected.

## TDD Order

1. **Red → Green:** Write unit tests for `assembleWidgetState` covering all agent status combinations.
   Add the `AgentSummary` interface, `WidgetState` interface, and `assembleWidgetState` function as exported module-level items.
   Implement to make tests pass.
   Commit: `feat: extract assembleWidgetState from agent-widget update`

2. **Refactor:** Wire `update` to use `assembleWidgetState`.
   Extract `clearWidget(allAgents)` method from the idle path.
   Extract `updateStatusBar(state)` method from the status bar logic.
   All existing tests pass (no behavior change, no export changes, `dispose` unchanged).
   Commit: `refactor: decompose update into clearWidget and updateStatusBar`

3. **Docs:** Update the complexity hotspots table in `docs/architecture/architecture.md`.
   Remove both `renderWidgetLines` (done in #205) and `update` rows.
   Commit: `docs: update complexity hotspots after widget decomposition`

## Risks and Mitigations

| Risk                                                                                                            | Mitigation                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assembleWidgetState` has overlapping categorization with `categorizeAgents` in `widget-renderer.ts`            | Different outputs for different consumers: counts+flags for lifecycle vs. full arrays for rendering. Not duplication.                                                                  |
| No existing tests for `AgentWidget` — refactoring risks are higher for `clearWidget`/`updateStatusBar`          | The pure function `assembleWidgetState` is tested directly. The method extractions are mechanical code moves with no semantic change — the type checker verifies structural integrity. |
| `clearWidget` guards redundant SDK calls (`if (widgetRegistered)`) — caller might expect unconditional teardown | Only `update`'s idle path calls `clearWidget`. `dispose` stays as-is with its own unconditional teardown semantics.                                                                    |

## Open Questions

None — the decomposition is a mechanical extraction of existing code into named functions and methods, following the pattern established by Phase 12 Steps 1 and 2.
