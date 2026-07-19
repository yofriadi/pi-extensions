---
issue: 148
issue_title: "Split AgentWidget rendering from lifecycle (Phase 9, Step P)"
---

# Split AgentWidget rendering from lifecycle

## Problem Statement

`AgentWidget` (374 lines) mixes rendering, lifecycle management, spinner animation, state filtering, and status bar management in a single class.
`renderWidget` alone is ~109 lines, and `renderFinishedLine` adds another ~40.
The constructor takes 3 concrete collaborators (`AgentManager`, `Map<string, AgentActivityTracker>`, `AgentTypeRegistry`) with no interface extraction.
Rendering logic cannot be unit-tested without instantiating the full widget with its lifecycle machinery.

## Goals

- Extract pure rendering functions from `AgentWidget` into `ui/widget-renderer.ts`.
- Make `AgentWidget` a thin lifecycle/polling wrapper that delegates to pure render functions.
- Enable direct unit testing of rendering logic with plain data — no widget lifecycle, no mocks for `setInterval`/`setWidget`/`requestRender`.

## Non-Goals

- Changing the visual output of the widget (this is a pure refactor).
- Extracting the status bar logic into a separate module (could follow up).
- Narrowing the `AgentManager` dependency to an interface (tracked separately in the architecture doc).
- Injecting `truncateToWidth` (tracked as #147, Step O — an independent track).

## Background

### Dependency: #144 (Step L) — Consolidate observation model

Issue #144 is **closed/implemented**.
The renderer now reads stats (`toolUses`, `lifetimeUsage`, `compactionCount`) from `AgentRecord` and live UI state (`activeTools`, `responseText`, `turnCount`, `maxTurns`) from `AgentActivityTracker`.
No dual-counting fallback exists.

### Existing pure helpers

`ui/display.ts` already contains stateless formatting functions (`formatMs`, `formatTurns`, `formatSessionTokens`, `describeActivity`, `getDisplayName`, `getPromptModeLabel`, `SPINNER`, `ERROR_STATUSES`, `Theme`).
The new `widget-renderer.ts` will consume these — it does not duplicate them.

### Rendering data flow

The widget's `renderWidget` currently:

1. Calls `this.manager.listAgents()` to get `AgentRecord[]`.
2. Categorizes into running/queued/finished.
3. Filters finished agents via `this.shouldShowFinished()`.
4. Looks up `this.agentActivity.get(a.id)` for live stats.
5. Calls `this.registry` for display names.
6. Reads `this.widgetFrame` for spinner animation.
7. Assembles tree-style lines with overflow logic.

Steps 3–7 are pure given the right inputs.
Steps 1–2 are also pure categorization.

## Design Overview

### Separation of concerns

The rendering extraction splits the widget into two layers:

1. **`widget-renderer.ts`** — Pure functions that accept data and return `string[]`.
   No `this`, no timers, no SDK types, no side effects.
2. **`agent-widget.ts`** — Thin lifecycle wrapper that owns timers, UICtx, finished-turn aging, and calls the renderer with live data.

### Renderer input shape

Rather than passing the full `AgentRecord` class (which carries mutation methods and phase collaborators), the renderer receives a plain data slice:

```typescript
/** Minimal agent snapshot for rendering — no class methods, no mutation surface. */
export interface WidgetAgent {
  readonly id: string;
  readonly type: SubagentType;
  readonly status: string;
  readonly description: string;
  readonly toolUses: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly lifetimeUsage?: Readonly<LifetimeUsage>;
  readonly compactionCount: number;
}
```

This is structurally compatible with `AgentRecord` (the class satisfies it), so no mapping code is needed at the call site — `listAgents()` returns `AgentRecord[]` which satisfies `WidgetAgent[]`.

### Renderer input for activity

Activity state is read from `AgentActivityTracker`.
The renderer needs a read-only view per agent:

```typescript
/** Read-only activity snapshot for widget rendering. */
export interface WidgetActivity {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly turnCount: number;
  readonly maxTurns?: number;
  readonly session?: SessionLike;
}
```

`AgentActivityTracker` already satisfies this structurally (it exposes these as getters).

### Agent config lookup

The renderer needs `getDisplayName` and `getPromptModeLabel`, which take a `SubagentType` and an `AgentConfigLookup`.
The renderer accepts `AgentConfigLookup` (the existing interface from `agent-types.ts`) — not the concrete `AgentTypeRegistry` class.

### Renderer API

```typescript
/** Pure rendering of the widget body. Returns lines to display. */
export function renderWidgetLines(params: {
  agents: readonly WidgetAgent[];
  activityMap: ReadonlyMap<string, WidgetActivity>;
  registry: AgentConfigLookup;
  spinnerFrame: number;
  terminalWidth: number;
  shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[];

/** Pure rendering of a single finished agent line (no tree connector prefix). */
export function renderFinishedLine(
  agent: WidgetAgent,
  activity: WidgetActivity | undefined,
  registry: AgentConfigLookup,
  theme: Theme,
): string;

/** Pure rendering of a single running agent (header + activity lines, no tree connector prefix). */
export function renderRunningLines(
  agent: WidgetAgent,
  activity: WidgetActivity | undefined,
  registry: AgentConfigLookup,
  spinnerFrame: number,
  theme: Theme,
): [header: string, activity: string];
```

The top-level `renderWidgetLines` encapsulates the full categorization, overflow logic, and tree-connector fixup.
The per-agent functions are exported for fine-grained testing.

The `shouldShowFinished` callback is injected rather than re-implementing the aging logic inside the renderer, keeping the renderer pure and the aging state in the widget.

### Call site in AgentWidget

```typescript
// Inside renderWidget(tui, theme):
const w = tui.terminal.columns;
return renderWidgetLines({
  agents: this.manager.listAgents(),
  activityMap: this.agentActivity,
  registry: this.registry,
  spinnerFrame: this.widgetFrame,
  terminalWidth: w,
  shouldShowFinished: (id, status) => this.shouldShowFinished(id, status),
});
```

The widget's `renderWidget` method shrinks to ~5 lines.

### Tell-Don't-Ask verification

The renderer receives pre-collected data and returns formatted strings.
It does not reach through collaborators — it reads flat fields from `WidgetAgent` and `WidgetActivity`.
The widget tells the renderer "render this data"; the renderer returns lines.
No Law of Demeter violations.

## Module-Level Changes

### New file: `src/ui/widget-renderer.ts`

- `WidgetAgent` interface (structural subset of `AgentRecord`).
- `WidgetActivity` interface (structural subset of `AgentActivityTracker`).
- `renderWidgetLines()` — top-level rendering with categorization, overflow, tree connectors.
- `renderFinishedLine()` — single finished-agent line.
- `renderRunningLines()` — single running-agent header + activity pair.
- Imports from `display.ts` (`SPINNER`, `ERROR_STATUSES`, `formatMs`, `formatTurns`, `formatSessionTokens`, `describeActivity`, `getDisplayName`, `getPromptModeLabel`, `Theme`), from `usage.ts` (`getLifetimeTotal`, `getSessionContextPercent`, `LifetimeUsage`, `SessionLike`), and from `@earendil-works/pi-tui` (`truncateToWidth`).

### Modified: `src/ui/agent-widget.ts`

- Remove `renderWidget()` method body — replace with call to `renderWidgetLines()`.
- Remove `renderFinishedLine()` method entirely.
- Remove direct imports of display helpers and usage helpers that are now only consumed by `widget-renderer.ts`.
- Keep: constructor, `setUICtx`, `onTurnStart`, `ensureTimer`, `shouldShowFinished`, `markFinished`, `update`, `dispose`, `UICtx` type, `MAX_WIDGET_LINES`.
- The inline type on `renderFinishedLine`'s parameter `a` is replaced by the `WidgetAgent` import.

### New file: `test/widget-renderer.test.ts`

- Unit tests for `renderWidgetLines`, `renderFinishedLine`, `renderRunningLines`.
- Uses plain data objects (no mocks for `AgentManager`, `setInterval`, or SDK).
- Stub `Theme` matching the pattern in `test/renderer.test.ts`.

### No changes to

- `src/index.ts` — the widget is constructed the same way; renderer is internal to the widget module.
- `src/ui/display.ts` — unchanged; consumed by the new renderer.
- `src/usage.ts` — unchanged.

## Test Impact Analysis

1. The extraction enables direct unit testing of widget rendering that was previously impossible — testing `renderWidget` required constructing a full `AgentWidget` with mocked `AgentManager`, fake timers, and a stubbed UICtx.
   The new tests cover: finished-agent line formatting (all status variants), running-agent header/activity rendering, overflow logic, tree-connector fixup, empty-state handling, and `shouldShowFinished` filtering.
2. No existing tests become redundant — there are currently **no** unit tests for `AgentWidget` rendering.
   The existing `display.test.ts` tests lower-level formatters and remains as-is.
3. `renderer.test.ts` tests the notification renderer — unrelated, stays as-is.

## TDD Order

1. **Red → Green:** Test `renderFinishedLine` for a completed agent (success icon, stats, duration).
   Commit: `test: add renderFinishedLine tests for completed status`

2. **Red → Green:** Test `renderFinishedLine` for error/aborted/steered/stopped statuses (icon and status text variations).
   Commit: `test: renderFinishedLine error and terminal status variants`

3. **Red → Green:** Test `renderRunningLines` (spinner frame, stats, activity description, token display).
   Commit: `test: add renderRunningLines tests`

4. **Red → Green:** Test `renderWidgetLines` — basic case with one running agent (heading, tree connectors).
   Commit: `test: renderWidgetLines single running agent`

5. **Red → Green:** Test `renderWidgetLines` — mixed running + finished + queued, verifying categorization and ordering.
   Commit: `test: renderWidgetLines mixed agent states`

6. **Red → Green:** Test `renderWidgetLines` — overflow cap with many agents, verifying the priority (running > queued > finished) and overflow summary line.
   Commit: `test: renderWidgetLines overflow behavior`

7. **Red → Green:** Test `renderWidgetLines` — empty state returns `[]`; finished-only state uses dim heading.
   Commit: `test: renderWidgetLines empty and finished-only states`

8. **Green → Refactor:** Extract `renderFinishedLine`, `renderRunningLines`, and `renderWidgetLines` into `src/ui/widget-renderer.ts`.
   All tests pass against the extracted module.
   Commit: `refactor: extract widget rendering into widget-renderer`

9. **Green → Refactor:** Wire `AgentWidget.renderWidget()` to delegate to `renderWidgetLines()`.
   Remove the inlined rendering logic from `agent-widget.ts`.
   Remove unused imports.
   Commit: `refactor: AgentWidget delegates rendering to widget-renderer`

10. **Verify:** Run full test suite (`pnpm vitest run`) and type check (`pnpm run check`).
    Commit: none (verification only).

## Risks and Mitigations

| Risk                                                                                                           | Mitigation                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural compatibility between `AgentRecord` and `WidgetAgent` could drift if `AgentRecord` renames a field. | TypeScript's structural checking catches this at the call site in `agent-widget.ts` — `listAgents()` returns `AgentRecord[]` which must satisfy `readonly WidgetAgent[]`. |
| `truncateToWidth` is an external dependency (`@earendil-works/pi-tui`) in the renderer.                        | Step O (#147) will inject it; for now, the renderer imports it directly, matching the current widget behavior.                                                            |
| Overflow logic is complex and hand-tested — extraction could introduce subtle line-count bugs.                 | TDD steps 4–7 exercise overflow edge cases before the extraction step. The extraction is a mechanical move with tests already passing.                                    |

## Open Questions

- None — the design follows the architecture doc's Step P specification and the dependency (#144) is already implemented.
