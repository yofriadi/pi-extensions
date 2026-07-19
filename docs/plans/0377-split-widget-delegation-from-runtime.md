---
issue: 377
issue_title: "Split widget delegation out of SubagentRuntime"
---

# Split widget delegation out of SubagentRuntime

## Problem Statement

`SubagentRuntime.widget` is assigned after construction (`runtime.widget = new AgentWidget(...)` in `index.ts`), violating construct-complete (principle 8).
The runtime then carries five relay-only delegation methods — `setUICtx`, `onTurnStart`, `markFinished`, `update`, `ensureTimer` — that do nothing but forward to `this.widget?`.
That is a relay-only dependency (design-review check 5): the runtime holds the widget purely to hand it to others, and the coupling leaks into tests, where the `AgentToolRuntime` fixture stubs all five widget methods on the runtime mock.

The issue's "Proposed change" — construct the widget before its consumers and pass the `WidgetLike` handle directly to the tool deps and `NotificationManager` — is the right intent but is **not directly feasible** as stated.
`NotificationManager` is not just a consumer of the widget; it is a transitive *dependency* of the widget.
The construction graph contains a genuine cycle:

```text
NotificationManager → widget → manager → observer (SubagentEventsObserver) → NotificationManager
```

The widget needs the manager (`listAgents()`); the manager needs the observer; the observer needs the `NotificationSystem`; and `NotificationManager` needs the widget (`markFinished`/`update`).
The current `runtime.widget` lazy field exists precisely to break this cycle.
Removing it forces the single unavoidable late seam to move — and the operator's design principles (no setters, instantiate ready-to-work, constructor DI) rule out relocating it to a setter or a forward-referenced `let`.

The cycle has exactly one weak edge: `NotificationManager → widget`.
Dissolving that edge collapses the cycle entirely, after which the remaining relay removal is mechanical.

## Goals

- Remove the `widget` field and the five relay methods (`setUICtx`, `onTurnStart`, `markFinished`, `update`, `ensureTimer`) from `SubagentRuntime`.
- Eliminate the post-construction `runtime.widget =` write from `index.ts`.
- Inject the `AgentWidget` handle directly into its real consumers (`AgentTool`, `ToolStartHandler`) via constructor DI.
- Dissolve `NotificationManager`'s widget dependency so the construction graph is a clean linear DAG (`notifications → observer → manager → widget → tool/handler`) with no cycle, no setter, and no forward-referenced `let`.
- Narrow `AgentToolRuntime` to drop the four widget methods it currently declares.
- Behavior-preserving: no observable change to widget rendering, the finished-agent linger countdown, or completion notifications.

This change is **not breaking** — it is an internal refactor.
`SubagentRuntime` is not part of the published service surface (`src/service/service.ts`); no exported API, event channel, or config default changes.

## Non-Goals

- Reworking how the widget is rendered, the `/agents` menu, the conversation viewer, or any first-principles UI reconsideration — that is Phase 18.
- Replacing the widget's poll-based refresh with an event-subscription model — heavier machinery, deferred.
- Changing `NotificationManager`'s nudge scheduling, `sendMessage` wiring, or `agentActivity` ownership.
- Touching the foreground-runner / background-spawner direct widget calls (they are already clean consumers that receive the widget from `AgentTool`) beyond the type of the handle they accept.
- Phase 17 Steps 7–9 (test-fixture consolidation, settings-loader duplication).

## Background

Relevant modules and their current widget coupling:

| Module                            | Current widget coupling                                                                                                                                                      | Disposition                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/runtime.ts`                  | `WidgetLike` interface, `widget` field, 5 relay methods                                                                                                                      | Remove all widget knowledge                                       |
| `src/index.ts`                    | `runtime.widget = new AgentWidget(...)` post-construction; wires `runtime.markFinished`/`runtime.update` into `NotificationManager`                                          | Construct widget as a `const`; inject directly; reorder           |
| `src/observation/notification.ts` | `NotificationManager` ctor takes `markFinished` + `updateWidget` callbacks; `sendCompletion`/`cleanupCompleted` call them                                                    | Drop both callbacks; keep `agentActivity.delete` + nudge          |
| `src/ui/agent-widget.ts`          | `AgentWidget(manager, agentActivity, registry)`; `markFinished(id)` seeds `finishedTurnAge`; `update()` renders                                                              | Self-seed `finishedTurnAge` from `listAgents()` during `update()` |
| `src/tools/agent-tool.ts`         | `AgentToolRuntime` declares `setUICtx`/`ensureTimer`/`update`/`markFinished`; `execute` calls `this.runtime.setUICtx`; passes `this.runtime` as the widget to runner/spawner | Add a `widget` ctor param; narrow `AgentToolRuntime`              |
| `src/handlers/tool-start.ts`      | `ToolStartRuntime` declares `setUICtx`/`onTurnStart`; calls them on `this.runtime`                                                                                           | Accept a widget instead of the runtime                            |
| `src/tools/foreground-runner.ts`  | `ForegroundWidgetDeps { ensureTimer, markFinished }`                                                                                                                         | Unchanged interface; receives the real widget                     |
| `src/tools/background-spawner.ts` | `BackgroundWidgetDeps { ensureTimer, update }`                                                                                                                               | Unchanged interface; receives the real widget                     |

Key facts establishing behavior preservation for the dissolve:

- The widget timer (`ensureTimer()` → `setInterval(update, 80)`) runs while any agent is active or lingering, and is cleared only on `update()`'s idle path (`!hasActive && !hasFinished`).
  A background agent is **active at the moment it completes**, so the timer is always running then, and `hasFinished` keeps it running through the linger window.
- The linger countdown is **turn-based**: `markFinished` seeds `finishedTurnAge[id] = 0`, `onTurnStart` ages every entry by 1, and `shouldShowFinished` hides an agent once its age reaches `maxAge` (1 for completed, 2 for error/aborted).
  Seeding ≤80ms later (on the next timer tick) lands in the same turn, so the expiry behavior is identical.
- `NotificationManager.sendCompletion`/`cleanupCompleted` only deletes the live `AgentActivityTracker` (running-display state) — finished agents render from `listAgents()` + `finishedTurnAge`, so the deletion is orthogonal to linger.

AGENTS.md / architecture constraints that apply:

- Principle 8 (construct complete; no post-construction field writes from external code) is the motivating rule — the fix must not relocate the smell to a setter or forward-ref `let` (operator steer).
- Phase 17 Step 1 deleted a `prefer-const` eslint-disable dance; reintroducing a forward-referenced `let widget` (which trips `prefer-const`, per the `code-design` skill) would regress that and is explicitly avoided.
- `src/runtime.ts` is **not** in the rolled public type bundle (`exports` points at `src/service/service.ts`), so this change does not require `pnpm run verify:public-types`.

`AgentWidget`, `NotificationManager`, and the runtime are all internal; the published `SubagentsService` (via `service-adapter.ts`, which consumes the runtime's `currentCtx`/`buildSnapshot` only) is untouched.

## Design Overview

### Decision: dissolve the cycle, don't relocate the seam

Three candidate seam placements were considered (recorded for the retro):

1. **Late-bind notifications into the observer via a setter** — rejected: violates the no-setters principle; leaves a post-construction write.
2. **Forward-referenced `let widget` + closures into `NotificationManager`** — rejected: trips `prefer-const` → eslint-disable, reintroducing the exact smell Phase 17 Step 1 removed; not "ready-to-work."
3. **Dissolve `NotificationManager`'s widget dependency (chosen)** — the widget owns its own finished-agent detection; `NotificationManager` no longer references the widget; the cycle disappears and every object is constructible ready-to-work in a single linear pass.

### Tidy-first sequencing

Per "make the change that makes the change easy, then make the easy change," the work splits into a hard preparatory refactor and a mechanical follow-up:

- **Prep (Step 1, the hard part):** make the widget self-sufficient and remove the widget callbacks from `NotificationManager`.
  This breaks the cycle while `SubagentRuntime` still carries its relay methods (so `AgentTool`/`ToolStartHandler` are untouched and the repo stays green).
- **Easy (Step 2):** with the cycle gone, the widget becomes a `const` injected directly into `AgentTool` and `ToolStartHandler`; the five relay methods, the `widget` field, and the post-construction write delete cleanly.

### Widget self-seeding

Add a private helper invoked at the top of `update()`, before state assembly:

```ts
/** Seed linger tracking for any newly-observed finished agent (replaces external markFinished). */
private seedFinishedAgents(agents: readonly AgentSummary[]): void {
  for (const a of agents) {
    if (a.completedAt && !this.finishedTurnAge.has(a.id)) {
      this.finishedTurnAge.set(a.id, 0);
    }
  }
}
```

`update()` calls `this.seedFinishedAgents(allAgents)` immediately after `const allAgents = this.manager.listAgents()`.
The existing public `markFinished(id)` stays (foreground-runner still calls it directly for immediacy, and it remains idempotent — `seedFinishedAgents` only seeds when absent).

### NotificationManager after the dissolve

Constructor drops the last two params:

```ts
constructor(
  private sendMessage: (msg: {...}, opts?: {...}) => void,
  private agentActivity: Map<string, AgentActivityTracker>,
) {}
```

`sendCompletion(record)` → `agentActivity.delete(record.id)`; `scheduleNudge(...)` (drop `markFinished` + `updateWidget`).
`cleanupCompleted(id)` → `agentActivity.delete(id)` (drop `markFinished` + `updateWidget`).
The `NotificationSystem` interface is unchanged (method signatures identical).

### Consumer interfaces after the easy change (ISP — narrow per consumer)

Drop the shared 5-method `WidgetLike` from `runtime.ts`.
Each consumer declares only what it uses; `AgentWidget` satisfies all structurally:

```ts
// agent-tool.ts — the slice AgentTool + its runner/spawner need
export interface AgentToolWidget {
  setUICtx(ctx: UICtx): void;
  ensureTimer(): void;
  markFinished(id: string): void;
  update(): void;
}

// tool-start.ts — the slice the turn handler needs
export interface ToolStartWidget {
  setUICtx(ctx: unknown): void;
  onTurnStart(): void;
}
```

`AgentTool` gains a `widget: AgentToolWidget` constructor param; `execute` calls `this.widget.setUICtx(...)` and passes `this.widget` to `runForeground`/`spawnBackground` (which already accept the narrow `ForegroundWidgetDeps`/`BackgroundWidgetDeps`).
`ToolStartHandler` accepts a `ToolStartWidget` instead of `ToolStartRuntime` (rename).
`AgentToolRuntime` loses `setUICtx`, `ensureTimer`, `update`, `markFinished` — keeping `agentActivity`, `buildSnapshot`, `getModelInfo`, `getSessionInfo`.

### Final construction order in `index.ts`

```text
registry → runtime → notifications(sendMessage, agentActivity)
        → settings → observer(notifications) → limiter → manager(observer)
        → service → lifecycle(runtime) → session handlers
        → const widget = new AgentWidget(manager, agentActivity, registry)
        → toolStart = new ToolStartHandler(widget)
        → AgentTool(manager, runtime, widget, settings, registry, agentDir)
        → GetResultTool / SteerTool / agentsMenu
```

No object is mutated after construction; the widget is a `const`.
`service-adapter.ts` and `lifecycle.ts` keep consuming `runtime` for `currentCtx`/`buildSnapshot`/`setSessionContext` — none of which involve the widget.

## Module-Level Changes

- `src/observation/notification.ts` — remove `markFinished` and `updateWidget` constructor params; drop their calls in `sendCompletion`/`cleanupCompleted`.
  `NotificationSystem` interface unchanged.
- `src/ui/agent-widget.ts` — add private `seedFinishedAgents(agents)`; call it at the top of `update()` after `listAgents()`.
  `markFinished` retained (idempotent).
- `src/runtime.ts` — delete the `WidgetLike` interface, the `widget` field, and the five relay methods (`setUICtx`, `onTurnStart`, `markFinished`, `update`, `ensureTimer`); remove the now-unused `UICtx` import.
  Update the class/file doc comment to drop "Persistent widget reference" / "Widget delegation methods."
- `src/tools/agent-tool.ts` — add `AgentToolWidget` interface; add `widget` constructor param; `execute` uses `this.widget` for `setUICtx` and passes it to runner/spawner; narrow `AgentToolRuntime` (drop 4 widget methods); remove now-unused `WidgetLike`-related imports if any.
- `src/handlers/tool-start.ts` — rename `ToolStartRuntime` → `ToolStartWidget`; constructor takes the widget; `handleToolExecutionStart` calls `this.widget.setUICtx`/`this.widget.onTurnStart`.
- `src/index.ts` — construct `NotificationManager` with two args; construct `const widget = new AgentWidget(...)` after the manager; pass `widget` to `new ToolStartHandler(...)` and `new AgentTool(...)`; remove the `runtime.widget =` line and the stale comment block above the `NotificationManager` construction.
- `test/observation/notification.test.ts` — drop the `markFinished`/`updateWidget` stub fields and the two `toHaveBeenCalled` assertions; assert `agentActivity.delete` + nudge behavior instead.
- `test/ui/agent-widget.test.ts` — add coverage: `update()` self-seeds `finishedTurnAge` for a completed agent in `listAgents()`; the agent then expires after `maxAge` turns via `onTurnStart`; an already-seeded agent is not re-seeded.
- `test/runtime.test.ts` — remove the "widget delegation methods" describe block, the "widget field accepts a `WidgetLike` stub" test, the `runtime.widget` default assertion, the `WidgetLike` import, and the `createWidgetStub` helper.
- `test/helpers/make-deps.ts` — add a `widget` field (stub satisfying `AgentToolWidget`) to `AgentToolFixture`; narrow the `runtime` stub (drop `setUICtx`/`ensureTimer`/`update`/`markFinished`); update the doc comment that claims the runtime "also satisfies `BackgroundWidgetDeps`/`ForegroundWidgetDeps`."
- `test/tools/agent-tool.test.ts` — `makeTool` passes `deps.widget`; the "sets UI context on runtime" test asserts on `deps.widget.setUICtx`.
- `test/handlers/tool-start.test.ts` — construct `ToolStartHandler` with a widget stub; assert on `widget.setUICtx`/`widget.onTurnStart`.
- `docs/architecture/architecture.md` — rewrite the Step 6 `- Change:` / `- Outcome:` bullets to the dissolve approach; add a `- Landed:` bullet and mark the heading `✅ Complete`.
  The findings-summary line (~915) describing the smell stays accurate and is left unchanged.

No `.pi/skills/package-pi-subagents/SKILL.md` references to `runtime.widget`, `WidgetLike`, or the relay methods exist (grep-verified), so no skill update is required.

## Test Impact Analysis

1. **New tests enabled by the extraction.**
   Widget self-seeding (`seedFinishedAgents`) becomes directly unit-testable on `AgentWidget` via a stub manager whose `listAgents()` returns a completed record — previously the seeding path was only reachable through `NotificationManager.markFinished`.
   `NotificationManager` becomes testable without any widget stub at all.
2. **Tests simplified / made redundant.**
   The two `NotificationManager` assertions on `markFinished`/`updateWidget` are deleted (the behavior moved to the widget).
   The entire `SubagentRuntime` "widget delegation methods" describe block (5 trivial pass-through tests) and the `WidgetLike` stub plumbing are removed — pure relay tests with no remaining subject.
3. **Tests that must stay as-is.**
   The widget's render/linger/timer tests in `agent-widget.test.ts` (turn-aging via `onTurnStart`, `shouldShowFinished` thresholds, idle-path `clearWidget`) genuinely exercise the layer and are unchanged — the new self-seed test sits alongside them.
   `NotificationManager`'s nudge-scheduling and `sendMessage` tests are unchanged.

## Invariants at risk

This step touches surfaces refactored by earlier Phase 17 steps; their documented outcomes must not regress:

- **Step 1 (`#381`) — "every spawned agent has a `promise` at spawn; no forward-ref `prefer-const` eslint-disable."**
  Pinned by the limiter/manager tests in `test/lifecycle/`.
  Reintroducing a forward-ref `let widget` would regress this spirit — the chosen dissolve approach specifically avoids it.
- **Step 5 (`#376`) — "`index.ts` < 170 lines; observer's three concerns unit-tested directly."**
  This step removes lines from `index.ts` (relay wiring + `runtime.widget =`), so the line budget is preserved or improved; `SubagentEventsObserver` is untouched.
  No new behavior is added to `index.ts`.
- **Construct-complete (principle 8), the roadmap-wide Category-B/C invariant.**
  Pinned after this change by the absence of any `runtime.widget =` (grep-verifiable) and by `test/runtime.test.ts` no longer constructing a widget — add the grep check to the acceptance criteria.

## TDD Order

1. **Widget self-detects finished agents (prep — make it easy).**
   - Red: in `test/ui/agent-widget.test.ts`, assert `update()` seeds `finishedTurnAge` for a completed agent returned by `listAgents()` (rendered as finished), that it expires after `maxAge` turns via `onTurnStart`, and that an already-tracked agent is not re-seeded.
   - Green: add `private seedFinishedAgents(agents)` and call it at the top of `update()`.
   - Commit: `test:` then `feat:` — or a single `feat: self-seed finished agents in AgentWidget.update (#377)`.
2. **Drop widget callbacks from NotificationManager (prep — breaks the cycle).**
   - Red/Green: update `test/observation/notification.test.ts` to construct `NotificationManager` with two args and assert `agentActivity.delete` + nudge (drop the `markFinished`/`updateWidget` assertions); remove the two callbacks from the constructor and from `sendCompletion`/`cleanupCompleted`; update the `index.ts` construction site in the same commit (sole call site — the type checker requires it atomic).
   - Commit: `refactor: dissolve NotificationManager widget dependency (#377)`.
   - Outcome: the construction cycle is gone; `SubagentRuntime` still carries its relay methods (repo green).
3. **Inject the widget directly; remove relay methods and the widget field from SubagentRuntime (the easy change).**
   - This is one atomic commit: removing the `widget` field, the five relay methods, and narrowing `AgentToolRuntime` breaks `AgentTool`, `ToolStartHandler`, `index.ts`, and their tests at the type level simultaneously (export/field removal — per the workflow rule, fold all consumer and consumer-test updates into one step).
   - Changes: add `AgentToolWidget` + `widget` param to `AgentTool`; rename `ToolStartRuntime` → `ToolStartWidget` and accept the widget in `ToolStartHandler`; delete `WidgetLike` + `widget` + 5 relay methods from `runtime.ts`; construct `const widget` and reorder `index.ts` (remove the `runtime.widget =` write); update `make-deps.ts` (add `widget` stub, narrow `runtime`), `agent-tool.test.ts`, `tool-start.test.ts`, and `runtime.test.ts` (delete the delegation describe block + `WidgetLike` plumbing).
   - Commit: `refactor: inject widget directly, remove relay methods from SubagentRuntime (#377)`.
   - Acceptance: `rg 'runtime\.widget|\.widget =' src/` returns nothing; `rg 'WidgetLike' src/ test/` returns nothing; `pnpm run check && pnpm run lint && pnpm -r run test && pnpm fallow dead-code` clean.
4. **Update the architecture roadmap.**
   - Rewrite Step 6 `- Change:`/`- Outcome:` to the dissolve approach, add `- Landed:`, mark `✅ Complete`.
   - Commit: `docs: record Phase 17 Step 6 widget-delegation split (#377)`.

## Risks and Mitigations

- **Risk: self-seed timing differs from the old immediate `markFinished`/`update`.**
  Mitigation: the timer is always running at a background completion (the agent was active); the seed lands ≤80ms later within the same turn; linger expiry is turn-based, so the rendered outcome is identical.
  The new widget test pins the seed-then-expire behavior.
- **Risk: a completed agent never expires if it is never seeded.**
  Mitigation: `seedFinishedAgents` runs on every `update()` tick while the widget is live; the idle-path `clearWidget` only fires once nothing is active or finished, so a finished agent is always seeded before the widget can go idle.
- **Risk: removing exports/fields breaks consumers mid-refactor.**
  Mitigation: Step 2 breaks the cycle while leaving the relay methods in place (repo green); Step 3 folds the export/field removal and all consumers + tests into one atomic commit.
- **Risk: regressing an earlier Phase 17 invariant (forward-ref dance, `index.ts` budget).**
  Mitigation: the dissolve approach introduces no `let widget` and only removes lines from `index.ts`; the Invariants-at-risk grep checks are in the Step 3 acceptance criteria.

## Open Questions

- Should `AgentTool` receive one `AgentToolWidget` and forward it, or should it receive the narrower `ForegroundWidgetDeps`/`BackgroundWidgetDeps` separately?
  Plan assumes a single `AgentToolWidget` superset (it also calls `setUICtx` itself) forwarded to the runner/spawner — revisit only if ISP pressure appears during implementation.
- Whether foreground-runner's explicit `markFinished(fgId)` is now redundant given widget self-seeding.
  Plan keeps it (immediacy; idempotent) to hold scope tight; a follow-up could remove it if the self-seed proves sufficient.
