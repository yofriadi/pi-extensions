---
issue: 423
issue_title: "pi-subagents: make the agent widget self-drive from lifecycle events"
---

# Make the agent widget self-drive from lifecycle events

## Problem Statement

Today the dependency arrow points the wrong way: the core spawn tools reach into the widget to drive it.
`foreground-runner.ts` calls `widget.ensureTimer()` (inside its `onSessionCreated` callback) and `widget.markFinished(fgId)` after completion; `background-spawner.ts` calls `widget.ensureTimer()` and `widget.update()` after spawn.
For the widget to be a clean reactive consumer of the core — and for the spawn tools to shed their widget dependency — the widget must subscribe to lifecycle signals and manage its own update timer.
This is the fourth step of the Phase 18 spine (widget/tool decoupling track), enabled by Step 3 ([#422]) removing the activity map and the second session subscription.

## Goals

- Make `AgentWidget` a `SubagentManagerObserver`: start its 80 ms update timer in response to `onSubagentStarted` / `onSubagentCreated`, and re-render on `onSubagentCompleted` / `onSubagentCompacted`.
- Wire the widget as a second lifecycle consumer alongside `SubagentEventsObserver` via a new `CompositeSubagentObserver` that fans out manager notifications — keeping `SubagentManager`'s single-observer contract closed for modification.
- Remove all inbound widget calls from the spawn tools (`ensureTimer` / `update` / `markFinished`) and drop the `ForegroundWidgetDeps` / `BackgroundWidgetDeps` parameters from both spawners.
- Narrow `AgentToolWidget` to the single method the tool still uses (`setUICtx`); UICtx capture stays in `ToolStartHandler` and `AgentTool`.
- Delete the now-redundant `AgentWidget.markFinished` (its bookkeeping is already covered by `seedFinishedAgents`) and make `ensureTimer` private.

This is **not** a breaking change.
The widget, the spawn tools, the observer interface, and `AgentToolWidget` are all internal symbols — none appear in the public service surface (`src/service/service.ts`) or the settings entry (`src/layered-settings.ts`).
Observable widget behavior is unchanged (the timer starts when an agent appears, renders, and self-clears when idle); commits use `refactor:` / `docs:`.

## Non-Goals

- Dropping the `widget` constructor param from `AgentTool` entirely and the widget/map stubs from `createToolDeps` — that is Phase 18 Step 5 ([#424]).
  This step only narrows `AgentToolWidget` to `setUICtx`; the param stays.
- Migrating the widget to subscribe to the public `pi.events` (`subagents:*`) broadcast channels instead of the internal observer.
  The event-bus surface is the substitutable-UI direction, but it depends on the public event-contract reconciliation in Step 6 ([#425]) and the UI-distribution decision in Step 8 ([#427]); using it now would front-run an unreconciled contract.
  Option A (the composite observer) keeps a later `pi.events` migration to a localized `index.ts` swap.
- Touching `record-observer.ts`, `SubagentState`, the record getters, or the `SubagentEventsObserver` event/notification dispatch.
- Changing the foreground streaming path: `runForeground`'s `onSessionCreated` keeps binding `recordRef` for the `onUpdate` stream.

## Background

Relevant modules and their current relationships:

- `src/ui/agent-widget.ts` — `AgentWidget` polls `manager.listAgents()` every 80 ms via a `setInterval` started by `ensureTimer()`.
  `update()` is idempotent: it self-seeds any finished agent into `finishedTurnAge` via `seedFinishedAgents()` (added in [#421] / [#422]), renders, and self-clears the timer through `clearWidget()` when no agents are active or lingering.
  `markFinished(id)` and `ensureTimer()` carry `fallow-ignore-next-line unused-class-member` because their only callers are the spawn tools (via narrow interfaces).
- `src/lifecycle/subagent-manager.ts` — exposes a single `observer?: SubagentManagerObserver` slot (four methods: `onSubagentStarted`, `onSubagentCreated`, `onSubagentCompleted`, `onSubagentCompacted`).
  `buildObserver()` adapts it into a per-agent `SubagentLifecycleObserver`.
  `onSubagentStarted` fires for both foreground and background (on `record.start()`); `onSubagentCreated` fires only for background (in `spawn()`); `onSubagentCompleted` fires **only for background** (`onRunFinished` guards on `options.isBackground`).
- `src/observation/subagent-events-observer.ts` — the sole current observer; dispatches `pi.events` lifecycle events, session-entry persistence, and completion notifications.
- `src/tools/foreground-runner.ts` / `src/tools/background-spawner.ts` — drive the widget via `ForegroundWidgetDeps` / `BackgroundWidgetDeps`.
- `src/tools/agent-tool.ts` — holds a 4-method `AgentToolWidget` (`setUICtx`, `ensureTimer`, `update`, `markFinished`), passes the widget into both spawners, and calls `this.widget.setUICtx(ctx.ui)`.
- `src/index.ts` — constructs `observer` (the events observer), passes it to the manager, then constructs `widget` after the manager (the widget needs `manager.listAgents()`).

Key behavioral facts that shape the design:

- **Foreground completion is not observed.**
  The manager never calls `onSubagentCompleted` for foreground agents, so the widget cannot learn of foreground completion through the observer.
  It does not need to: `seedFinishedAgents()` already seeds any agent with `completedAt` on the next poll tick, so `markFinished` is fully redundant and is removed.
- **The widget keeps its `manager` reference.**
  Rendering still reads `manager.listAgents()`; the observer only changes the *trigger* that starts the timer, not the data source.
  Full broadcast-plus-query decoupling is the Step 8 concern, deliberately out of scope here.

AGENTS.md / package constraints that apply:

- pi-subagents is a narrow core that is open for extension, closed for modification — dependency arrows point inward.
  A composite observer in the composition root (`index.ts`) keeps `SubagentManager` untouched, rather than teaching the core to fan out to N consumers.
- Run `pnpm fallow dead-code` before pushing — privatizing `ensureTimer` and deleting `markFinished` change the dead-code surface.

## Design Overview

### CompositeSubagentObserver (new collaborator)

A small fan-out observer lets the manager keep its single-observer contract while several independent consumers subscribe.
It lives next to the existing observer in `src/observation/`.

```typescript
// src/observation/composite-subagent-observer.ts
export class CompositeSubagentObserver implements SubagentManagerObserver {
  private readonly delegates: SubagentManagerObserver[];
  constructor(delegates: SubagentManagerObserver[]) {
    this.delegates = [...delegates];
  }
  /** Register an additional observer (breaks the widget↔manager construction cycle). */
  add(observer: SubagentManagerObserver): void {
    this.delegates.push(observer);
  }
  onSubagentStarted(record: Subagent): void {
    this.forEach((o) => o.onSubagentStarted(record), "onSubagentStarted");
  }
  // …onSubagentCreated / onSubagentCompleted / onSubagentCompacted follow the same shape…
  private forEach(call: (o: SubagentManagerObserver) => void, label: string): void {
    for (const o of this.delegates) {
      try { call(o); } catch (err) { debugLog(`CompositeSubagentObserver.${label}`, err); }
    }
  }
}
```

Each delegate is isolated in a `try`/`catch` so a widget render throw cannot suppress event emission, and vice versa.
The `add` method exists to break the construction cycle (see wiring below), not as speculative flexibility — `index.ts` is its only caller.

### Consumer call site (index.ts wiring)

The widget needs the manager (for `listAgents()`) and the manager needs the observer, so the composite is constructed first, the widget is registered after construction:

```typescript
const eventsObserver = new SubagentEventsObserver({ /* emit, appendEntry, notifications */ });
const observer = new CompositeSubagentObserver([eventsObserver]);
const manager = new SubagentManager({ /* …, */ observer /* , … */ });
// …
const widget = new AgentWidget(manager, registry);
observer.add(widget); // the manager consults `observer` only at spawn time, after this runs
```

The manager reads `this.observer` lazily (only at `spawn` / `spawnAndWait`), so registering the widget after construction is safe — no notification can fire before `observer.add(widget)` executes.

### AgentWidget as a reactive observer

`AgentWidget implements SubagentManagerObserver`.
It ignores the `record` argument (it re-reads `listAgents()`), reacting by intent rather than by payload:

```typescript
// react to lifecycle, self-drive the timer
onSubagentStarted(_record: Subagent): void { this.startLoop(); }
onSubagentCreated(_record: Subagent): void { this.startLoop(); }
onSubagentCompleted(_record: Subagent): void { this.update(); }
onSubagentCompacted(_record: Subagent, _info: CompactionInfo): void { this.update(); }

private startLoop(): void { this.ensureTimer(); this.update(); }
```

`startLoop` (started / created) starts the timer and renders; completed / compacted only `update()` because the timer is already running by then (started fires at spawn, created fires before the queued run).
`update()` self-seeds the finished agent and keeps the timer alive for the linger window, then `clearWidget()` stops it once idle — unchanged from today.
`ensureTimer()` becomes `private` (now called from `startLoop`, so it loses its `fallow-ignore`); `markFinished` is deleted.

This follows the `SubagentEventsObserver` precedent: a class that implements `SubagentManagerObserver` and is invoked polymorphically by the manager counts as used, so the new methods need no `fallow-ignore`.

### Extracted-from / upstream check

This extraction introduces no Tell-Don't-Ask or output-argument violations: the widget reads `listAgents()` (a query it already owns) and mutates only its own `finishedTurnAge` / timer state.
The composite only forwards calls; it holds no state beyond its delegate list and never reaches through a delegate.

## Module-Level Changes

Source:

- `src/observation/composite-subagent-observer.ts` — **new.**
  `CompositeSubagentObserver implements SubagentManagerObserver`; constructor takes a delegate array; `add()` appends; each method fans out through a private `forEach` with per-delegate `try`/`catch` + `debugLog`.
- `src/ui/agent-widget.ts` — add `implements SubagentManagerObserver`; add `onSubagentStarted` / `onSubagentCreated` / `onSubagentCompleted` / `onSubagentCompacted` and the private `startLoop`; make `ensureTimer` `private` and drop its `fallow-ignore`; delete `markFinished` and its `fallow-ignore`; import `SubagentManagerObserver` and `CompactionInfo` types; reword the `seedFinishedAgents` doc comment so it no longer references the removed `markFinished` method.
- `src/index.ts` — rename the events-observer local to `eventsObserver`; construct `const observer = new CompositeSubagentObserver([eventsObserver])` and pass it to the manager; add `observer.add(widget)` after widget construction; import `CompositeSubagentObserver`; update the widget-construction comment to note the post-construction observer registration.
- `src/tools/foreground-runner.ts` — remove the `ForegroundWidgetDeps` interface and the `widget` parameter; remove `widget.ensureTimer()` from `onSessionCreated` (keep the `recordRef` binding) and the `fgId` variable + the post-completion `widget.markFinished(fgId)` block.
- `src/tools/background-spawner.ts` — remove the `BackgroundWidgetDeps` interface and the `widget` parameter; remove the `widget.ensureTimer()` / `widget.update()` calls; trim the doc comment ("Owns: widget update and launch message formatting" → "Owns: launch message formatting").
- `src/tools/agent-tool.ts` — narrow `AgentToolWidget` to `{ setUICtx(ctx: UICtx): void }`; reword its doc comment; drop the `this.widget` argument from the `spawnBackground` / `runForeground` calls; keep `this.widget.setUICtx(ctx.ui)` and the constructor param.

Tests:

- `test/observation/composite-subagent-observer.test.ts` — **new.**
  Fan-out to all delegates in registration order for each of the four methods; `add()` registers a late delegate; a throwing delegate does not suppress the others.
- `test/ui/agent-widget.test.ts` — new `describe` for the observer methods: `onSubagentStarted` / `onSubagentCreated` start the timer and render (advancing fake timers keeps re-rendering); `onSubagentCompleted` / `onSubagentCompacted` trigger a render; the widget self-clears once idle.
- `test/tools/foreground-runner.test.ts` — drop the `widget` arg from every `runForeground(...)` call; remove the "calls runtime.ensureTimer and runtime.markFinished after completion" test and the `spawnAndWaitRegistering` widget-binding framing (keep the streaming-`onUpdate` test).
- `test/tools/background-spawner.test.ts` — drop the `widget` arg from every `spawnBackground(...)` call; remove the "calls runtime.ensureTimer and runtime.update after spawn" test.
- `test/helpers/make-deps.ts` — narrow the `widget` fixture to `{ setUICtx: vi.fn() }`; reword the `AgentToolFixture.widget` doc comment (drop the `BackgroundWidgetDeps` / `ForegroundWidgetDeps` mention).
- `test/helpers/make-deps.test.ts` — rewrite the "all widget methods are vi.fn stubs" test to assert only `setUICtx`; remove the `BackgroundWidgetDeps` / `ForegroundWidgetDeps` structural-compatibility tests and their imports.

Docs:

- `docs/architecture/architecture.md`:
  - File tree (around line 318) — add `composite-subagent-observer.ts` under `observation/` with a one-line description.
  - System diagram (around line 64) — add a `SubagentManager -.->|notifies| Widget` edge (the inverted, reactive direction) alongside the existing `Widget -.->|polls| SubagentManager`.
  - Widget prose (around line 363) — note the 80 ms poll loop is now *started by lifecycle notifications* rather than by spawn-tool calls.
  - Phase 18 roadmap Step 4 entry — mark ✅ with a `Landed:` bullet matching the Steps 1–3 format.
  - Step-dependency Mermaid — `S4` node gets the ✅ marker.
- `.pi/skills/package-pi-subagents/SKILL.md`:
  - Domain table — Observation `5 → 6` modules (add `composite-subagent-observer.ts` to the list); header "seven domains (57 files)" → "(58 files)".
  - Module-dependency-flow block — note the widget is now a lifecycle observer fanned out through the composite alongside `subagent-events-observer`.

Verify the exact current counts with `grep` before editing (the Step 3 sweep set Observation to 5 and the total to 57); the architecture health-metrics snapshot table (`7,751 (62 files)`) is the Phase 18 *findings* snapshot and is left as-is, per the Step 3 precedent.

Historical docs under `docs/plans/`, `docs/retro/`, and `docs/architecture/history/` are records of past work and are **not** edited.

## Test Impact Analysis

1. **New tests enabled.**
   The composite observer becomes unit-testable in isolation (fan-out order, `add`, per-delegate fault isolation) — impossible before, since there was no fan-out unit.
   The widget's timer-start logic becomes directly testable through its observer methods, rather than only indirectly through the spawn tools.
2. **Tests that become redundant.**
   The spawner widget-driving assertions (`foreground-runner.test.ts` "calls … ensureTimer and … markFinished", `background-spawner.test.ts` "calls … ensureTimer and … update") test inbound calls that no longer exist — removed.
   `make-deps.test.ts`'s "all widget methods are vi.fn stubs" shrinks to `setUICtx`; the `BackgroundWidgetDeps` / `ForegroundWidgetDeps` structural-compat tests are removed with their interfaces.
3. **Tests that must stay.**
   The spawner result-text tests (launch message, queued/started, output-file, error), the foreground "calls onUpdate with streaming details while running" test (pins the surviving `recordRef` binding), the `AgentWidget.update` self-seed tests (the mechanism that replaces `markFinished`), and the `agent-tool` `setUICtx` test all exercise behavior that survives this step.

## Invariants at risk

This step touches surfaces refactored by Phase 18 Steps 1–3.
Relevant prior `Landed:` invariants and the tests that pin them:

- "The foreground `observer.onSessionCreated` keeps `recordRef`/`fgId` binding" (Step 3 outcome).
  This step removes `fgId` (only ever used by the deleted `markFinished` call) but **keeps `recordRef`** for the streaming `onUpdate`.
  Pinned by `test/tools/foreground-runner.test.ts` "calls onUpdate with streaming details while running" — must stay green.
- "The widget owns detection of completions via `seedFinishedAgents`" (Steps 1–2 outcome).
  Removing `markFinished` relies on this; pinned by `test/ui/agent-widget.test.ts` "AgentWidget.update self-seeds finished agents" and "does not advance the linger age on repeated update() without a turn".
- "One session subscription per child; runtime holds zero UI state" (Step 3 outcome).
  Unchanged here — the widget subscribes to *manager lifecycle notifications*, not a second *session* subscription.

No new test is required to protect these; the surviving streaming and self-seed tests plus the type checker cover them.

## TDD Order

Non-breaking refactor; every commit keeps `pnpm run check` and the full suite green.
Steps are ordered so the widget is wired as an observer *before* the spawn-tool calls are removed — no commit leaves the widget without a timer-start signal.

1. **Add `CompositeSubagentObserver` (pure addition).**
   Write `test/observation/composite-subagent-observer.test.ts` (red), then `src/observation/composite-subagent-observer.ts` (green): fan-out in registration order, `add()`, per-delegate fault isolation.
   Not yet wired.
   Run `pnpm run check`.
   Commit: `refactor: add CompositeSubagentObserver to fan out lifecycle notifications (#423)`.

2. **Subscribe the widget to lifecycle notifications.**
   Add the four observer methods + `implements SubagentManagerObserver` + `startLoop` to `AgentWidget` (red→green with the new widget observer tests); wire `index.ts` (rename `eventsObserver`, wrap in `CompositeSubagentObserver`, `observer.add(widget)`).
   The spawn tools still call the widget in this commit — the resulting double-drive is idempotent (`ensureTimer` uses `??=`; `update` and finished-seeding are idempotent), so behavior is unchanged.
   The widget's observer methods are now invoked polymorphically by the manager, so they need no `fallow-ignore`.
   Run `pnpm run check` and the full suite.
   Commit: `refactor: subscribe the widget to lifecycle notifications via a composite observer (#423)`.

3. **Stop driving the widget from the spawn tools (atomic removal).**
   Remove the `widget` parameter and `ForegroundWidgetDeps` / `BackgroundWidgetDeps` interfaces from both spawners; drop the `ensureTimer` / `update` / `markFinished` call sites (and the now-orphaned `fgId`); narrow `AgentToolWidget` to `setUICtx` and drop the `this.widget` args from the spawner calls in `AgentTool`; delete `AgentWidget.markFinished` and make `ensureTimer` private.
   Update the spawner tests (drop the `widget` arg, remove the two widget-driving tests), `make-deps.ts` (narrow the fixture), and `make-deps.test.ts` (rewrite the widget test, remove the structural-compat tests).
   Removing the exported interfaces and the `widget` params breaks every call site and test at the type level, so they land together.
   The widget keeps self-driving via the composite wired in Step 2, so there is no behavior gap.
   Run `pnpm run check`, the full suite, and `pnpm fallow dead-code`.
   Commit: `refactor: stop driving the widget from the spawn tools (#423)`.

4. **Update the architecture doc and package skill.**
   Apply the doc edits in Module-Level Changes (file tree, system-diagram edge, widget prose, Step 4 ✅ + `Landed:` bullet, `S4` Mermaid marker; SKILL.md Observation count `5 → 6` and total `57 → 58`, flow block).
   Verify any touched Mermaid renders (load the `mermaid` skill).
   Commit: `docs: mark Phase 18 Step 4 complete and record the widget self-drive (#423)`.

## Risks and Mitigations

- **Behavior gap between commits.**
  Removing the spawn-tool calls before the widget is an observer would leave the widget with no timer-start signal.
  Mitigation: Step 2 wires the composite (widget self-drives, alongside the still-present spawn-tool calls) strictly before Step 3 removes those calls.
- **Construction cycle (widget ↔ manager).**
  The widget needs the manager; the manager needs the observer; the observer includes the widget.
  Mitigation: construct the composite with `[eventsObserver]`, pass it to the manager, then `observer.add(widget)` after the widget is built — the manager consults the observer only at spawn time.
- **Transient double-drive in Step 2.**
  Both the spawn tools and the observer drive the widget in that commit.
  Mitigation: every driven method is idempotent (`ensureTimer` `??=`; `update` re-renders; finished-seeding only seeds when absent), so the doubled calls are harmless.
- **Dead-code surface change.**
  Privatizing `ensureTimer` and deleting `markFinished` alter what `fallow` sees.
  Mitigation: Step 3 runs `pnpm fallow dead-code`; the new observer methods are invoked via the interface (the `SubagentEventsObserver` precedent), so they are not flagged.
- **Foreground completion is unobserved.**
  The manager does not fire `onSubagentCompleted` for foreground agents.
  Mitigation: `seedFinishedAgents` already covers foreground completion through polling — pinned by the existing self-seed tests — so removing `markFinished` is safe.

## Open Questions

None blocking.
Whether the widget should ultimately subscribe to the public `pi.events` (`subagents:*`) broadcast instead of the internal observer — the substitutable-UI direction — is deferred to the public-event-contract reconciliation ([#425]) and the UI-distribution decision ([#427]).
Option A keeps that future migration to a localized `index.ts` swap.

[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#427]: https://github.com/gotgenes/pi-packages/issues/427
