---
issue: 421
issue_title: "pi-subagents: migrate activity-tracker readers to the record getters"
---

# Migrate activity-tracker readers to the record getters

## Problem Statement

Phase 18 Step 1 ([#420]) folded the live-activity fields (`turnCount`, `activeTools`, `responseText`, `maxTurns`) onto the single owned run-state value object and exposed them as read-only getters on `Subagent`, but nothing reads them yet.
Five consumers still reach into a separate UI `AgentActivityTracker` for data the record now exposes directly — a Law-of-Demeter coupling that keeps the activity tier entangled with the core.
This step switches each reader from the tracker to the record getters so that no reader reads activity off `AgentActivityTracker`, unblocking the tracker's deletion in Step 3 ([#422]).

This is Phase 18 Step 2 of the architecture roadmap (`docs/architecture/architecture.md`).
It is a reader migration: the producer plumbing that still constructs trackers, subscribes `ui-observer`, and populates the runtime activity map (`foreground-runner`, `background-spawner`, `runtime.ts`, `ui-observer.ts`) is left in place and removed in Step 3.
The reader-held map dependencies in `notification`, `agent-widget`, and `agent-menu` — files Step 3 does not touch — are removed here.

## Goals

- Switch `widget-renderer` to read live activity off the `Subagent` records returned by `listAgents()` rather than a parallel `activityMap`, folding the `WidgetActivity` interface into `WidgetAgent`.
- Drop the `activity` constructor param from `ConversationViewer`; read `activeTools` / `responseText` off `this.record`.
- Drop the `AgentActivityReader` dependency from `AgentsMenuHandler`.
- Migrate `runForeground` and `buildDetails` to read streaming state (`turnCount`, `maxTurns`, `activeTools`, `responseText`) off the `Subagent` they already hold.
- Migrate `buildNotificationDetails` to read `turnCount` / `maxTurns` off the record, and drop the `agentActivity` map dependency (and the now-vestigial `cleanupCompleted` method) from `NotificationManager`.
- Project each `Subagent` into a pure-data `WidgetAgent` snapshot inside `AgentWidget` (with a `contextPercent` field), keeping `widget-renderer` a pure function of plain data.

This change is **not breaking**.
The published service surface (`src/service/service.ts`) exposes `SubagentRecord` / `SubagentStatus`, neither of which changes.
There is one accepted observable behavior change in the widget (below), but no API, config, or default changes on upgrade without a user edit.

### Accepted behavior change

Today the widget shows **no** turn count on finished-agent lines because the activity tracker is deleted on completion (foreground deletes it after `spawnAndWait`; `NotificationManager.sendCompletion` deletes it for background agents).
The record's `turnCount` getter persists, so once `widget-renderer` reads off `listAgents()` records, finished lines will show `⟳N`.
This is **accepted** (confirmed with the operator): the deletion-on-completion behavior was a UI-state artifact, and showing the turn count consistently is the more correct outcome.
Preserving the old behavior would require the widget to track which finished agents were "cleaned up" — reintroducing exactly the coupling this phase removes.

## Non-Goals

- Deleting `AgentActivityTracker` / `ui-observer`, or removing the producer plumbing in `foreground-runner` / `background-spawner` / `runtime.ts` that still constructs trackers, subscribes, and populates the activity map — Step 3 ([#422]).
- Dropping the `widget` and `agentActivity` constructor params from `AgentTool` — Step 5 ([#424]).
- Making the widget self-drive its timer from lifecycle events instead of spawn-tool calls — Step 4 ([#423]).
- Reconciling the public event contract (`SUBAGENT_EVENTS.ACTIVITY`) — Step 6 ([#425]).
- Changing `SubagentState`, `record-observer`, or the getters themselves — landed in Step 1 ([#420]).

## Background

Relevant modules and how they relate:

- `src/lifecycle/subagent.ts` — exposes the four read-only getters added in Step 1: `turnCount` and `activeTools` and `responseText` delegate to the owned `SubagentState`; `maxTurns` returns `this.execution.maxTurns`.
  Also exposes `getContextPercent(): number | null` (delegates to `subagentSession.getContextPercent()`), the live context-window utilization.
- `src/ui/widget-renderer.ts` — pure rendering functions.
  `renderFinishedLine` / `renderRunningLines` take a `WidgetAgent` plus a `WidgetActivity | undefined`; `renderWidgetLines` takes an `activityMap: ReadonlyMap<string, WidgetActivity>`.
  `renderRunningLines` computes the context percent via `activity?.session ? getSessionContextPercent(activity.session) : null` — a reach into session stats from a module documented as taking no SDK types.
- `src/ui/agent-widget.ts` — `AgentWidget` holds the `agentActivity` map and passes `manager.listAgents()` (Subagents, structurally accepted as `WidgetAgent`) plus the map to `renderWidgetLines`.
- `src/ui/conversation-viewer.ts` — `ConversationViewer` takes an `activity: AgentActivityTracker | undefined`; reads `activity.activeTools` / `activity.responseText` in `buildContentLines` for the running streaming indicator.
- `src/ui/agent-menu.ts` — defines `AgentActivityReader` (`get(id): AgentActivityTracker | undefined`), takes it as a constructor param, and reads `this.agentActivity.get(record.id)` in `viewAgentConversation` to pass to `ConversationViewer`.
- `src/tools/foreground-runner.ts` — constructs `fgState = new AgentActivityTracker(...)`, subscribes `ui-observer`, populates the activity map, and reads `fgState.turnCount` / `fgState.maxTurns` / `fgState.activeTools` / `fgState.responseText` in `streamUpdate`; passes `fgState` to `buildDetails`.
- `src/tools/helpers.ts` — `buildDetails(base, record, activity?, overrides?)` reads `activity?.turnCount` and `activity?.maxTurns`.
  Two call sites: `runForeground` (passes `fgState`) and `AgentTool` resume (no activity arg).
- `src/observation/notification.ts` — `buildNotificationDetails(record, resultMaxLen, activity?)` reads `activity?.turnCount` / `activity?.maxTurns`.
  `NotificationManager` holds the `agentActivity` map and deletes from it in `sendCompletion` and `cleanupCompleted`.
- `src/observation/subagent-events-observer.ts` — `onSubagentCompleted` calls `notifications.cleanupCompleted(record.id)` when `record.notification?.resultConsumed`, else `notifications.sendCompletion(record)`.
- `src/index.ts` — constructs `NotificationManager`, `AgentWidget`, and `AgentsMenuHandler`, each currently passed `runtime.agentActivity`.

AGENTS.md / code-design constraints that apply:

- `widget-renderer.ts` is a pure rendering module ("stateless: they receive data and return formatted strings.
  No timers, no SDK types, no side effects").
  The migration keeps it pure and **narrows** it: the precomputed `contextPercent` field lets it drop the `SessionLike` / `getSessionContextPercent` imports, removing the session reach-through.
- `AgentWidget` is the adapter between the live manager/records and the pure renderer; the explicit `Subagent` → `WidgetAgent` projection belongs there (DIP, narrow data boundary).
- `getSessionContextPercent` and `SessionLike` stay in `usage.ts` — still used by `subagent-session.ts` and `getSessionTokens`, so removing the widget-renderer import creates no dead code.

## Design Overview

### `WidgetAgent` absorbs the activity fields (widget-renderer)

`WidgetActivity` is removed; its fields move onto `WidgetAgent` as plain data, plus a precomputed context percent:

```typescript
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
	// Folded-in live activity (was WidgetActivity)
	readonly turnCount: number;
	readonly maxTurns?: number;
	readonly activeTools: ReadonlyMap<string, string>;
	readonly responseText: string;
	readonly contextPercent: number | null;
}
```

`renderFinishedLine(agent, registry, theme)` and `renderRunningLines(agent, registry, spinnerFrame, theme)` drop the `WidgetActivity | undefined` parameter and read `agent.turnCount` / `agent.maxTurns` / `agent.activeTools` / `agent.responseText` directly.
`renderRunningLines` uses `agent.contextPercent` in place of `activity?.session ? getSessionContextPercent(activity.session) : null`.
`renderWidgetLines` and `buildSections` drop the `activityMap` parameter.
Because every `WidgetAgent` now carries activity, the old "no activity provided → omit turn count / show `thinking…`" branch is gone — `describeActivity(emptyMap, "")` already returns the `thinking…` string for an idle running agent, so the running-line text is preserved.

### `AgentWidget` projects records into snapshots

`AgentWidget` drops its `agentActivity` constructor param and field.
`renderWidget` maps each record through a local projection before handing the array to the pure renderer:

```typescript
private toWidgetAgent(record: Subagent): WidgetAgent {
	return {
		id: record.id,
		type: record.type,
		status: record.status,
		description: record.description,
		toolUses: record.toolUses,
		startedAt: record.startedAt,
		completedAt: record.completedAt,
		error: record.error,
		lifetimeUsage: record.lifetimeUsage,
		compactionCount: record.compactionCount,
		turnCount: record.turnCount,
		maxTurns: record.maxTurns,
		activeTools: record.activeTools,
		responseText: record.responseText,
		contextPercent: record.getContextPercent(),
	};
}
```

`renderWidget` then calls `renderWidgetLines({ agents: this.manager.listAgents().map(r => this.toWidgetAgent(r)), registry, … })` with no `activityMap`.
`assembleWidgetState` keeps consuming raw records via its `AgentSummary` shape (id / status / completedAt) — unchanged.
This makes the snapshot boundary explicit: the renderer depends only on plain data; `AgentWidget` owns the projection (Tell-Don't-Ask — it asks each record once and hands forward a value).

### `ConversationViewer` reads off the record

The `activity` constructor param and field are removed.
`buildContentLines` reads the streaming indicator inputs off the record it already holds:

```typescript
if (this.record.status === "running") {
	lines.push(...formatStreamingIndicator(
		this.record.activeTools,
		this.record.responseText,
		width,
		th,
	));
}
```

The `&& this.activity` guard is dropped — a running record always exposes `activeTools` / `responseText` (empty / `""` when idle), and `describeActivity` renders the idle case as `thinking…`, matching the prior no-tracker fallback.

### `AgentsMenuHandler` drops the reader

The `AgentActivityReader` interface and the `agentActivity` constructor param are removed.
`viewAgentConversation` no longer looks up a tracker; it constructs `ConversationViewer` without an `activity` field.

### `buildDetails` / `runForeground` read off the record

`buildDetails` drops its `activity?: AgentActivityTracker` parameter; the structural `record` param gains `turnCount?: number` and `maxTurns?: number`, and the body reads `record.turnCount` / `record.maxTurns`:

```typescript
export function buildDetails(
	base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
	record: {
		toolUses: number; startedAt: number; completedAt?: number; status: string;
		error?: string; id?: string; lifetimeUsage: LifetimeUsage;
		turnCount?: number; maxTurns?: number;
	},
	overrides?: Partial<AgentDetails>,
): AgentDetails { … turnCount: record.turnCount, maxTurns: record.maxTurns … }
```

`Subagent` satisfies this structurally (the getters supply `turnCount` / `maxTurns`).
In `runForeground`, `streamUpdate` reads `recordRef?.turnCount ?? 1`, `recordRef?.activeTools ?? new Map()`, `recordRef?.responseText ?? ""`, and `execution.effectiveMaxTurns` for `maxTurns` (the runner already holds this constant; `recordRef` is undefined until `onSessionCreated`).
The final `buildDetails(presentation.detailBase, record, fgState, { tokens })` becomes `buildDetails(presentation.detailBase, record, { tokens })`.
The `fgState` tracker, its `subscribeUIObserver` subscription, and the `agentActivity.set` / `delete` calls remain (producer plumbing removed in Step 3) but are no longer read.

### `buildNotificationDetails` / `NotificationManager`

`buildNotificationDetails(record, resultMaxLen)` drops the `activity?` param and reads `record.turnCount` / `record.maxTurns`.
`NotificationManager` drops the `agentActivity` constructor param and field; `sendCompletion` keeps only the nudge scheduling.
`cleanupCompleted` only ever deleted a map entry, so it becomes vestigial and is **removed** from both `NotificationSystem` and `NotificationManager`.
`SubagentEventsObserver.onSubagentCompleted` updates its `resultConsumed` branch to simply `return` (skip the nudge) instead of calling `cleanupCompleted`.

### Consumer call-site check (index.ts)

```typescript
const notifications = new NotificationManager((msg, opts) => pi.sendMessage(msg, opts));
const widget = new AgentWidget(manager, registry);
const agentsMenu = new AgentsMenuHandler(manager, registry, settings, new FsAgentFileOps(), …);
```

All three constructions drop the `runtime.agentActivity` argument.
`runtime.agentActivity` itself stays (still written by the spawn tools; removed in Step 3).

## Module-Level Changes

- `src/ui/widget-renderer.ts` — remove the `WidgetActivity` interface; fold its fields plus `contextPercent` into `WidgetAgent`; drop the `WidgetActivity | undefined` param from `renderFinishedLine` / `renderRunningLines`; drop `activityMap` from `buildSections` / `renderWidgetLines`; remove the `SessionLike` and `getSessionContextPercent` imports (keep `getLifetimeTotal`).
- `src/ui/agent-widget.ts` — drop the `agentActivity` constructor param and field; add the `toWidgetAgent` projection; map `listAgents()` through it in `renderWidget`; drop the `AgentActivityTracker` import.
- `src/ui/conversation-viewer.ts` — drop the `activity` field and `ConversationViewerOptions.activity`; read `activeTools` / `responseText` off `this.record`; drop the `AgentActivityTracker` import.
- `src/ui/agent-menu.ts` — remove the `AgentActivityReader` interface and the `agentActivity` constructor param; drop the tracker lookup in `viewAgentConversation`; drop the `AgentActivityTracker` import.
- `src/tools/helpers.ts` — `buildDetails` drops the `activity?` param and reads `record.turnCount` / `record.maxTurns` (param type gains the two optional fields); drop the `AgentActivityTracker` import.
- `src/tools/foreground-runner.ts` — `streamUpdate` and the final `buildDetails` call read off `recordRef` / `record`; the `fgState` construction, `subscribeUIObserver`, and map writes stay (Step 3).
- `src/observation/notification.ts` — `buildNotificationDetails` drops the `activity?` param and reads off the record; `NotificationManager` drops the `agentActivity` param/field and the `delete` calls; remove `cleanupCompleted` from `NotificationSystem` and the class; drop the `AgentActivityTracker` import.
- `src/observation/subagent-events-observer.ts` — `onSubagentCompleted` `resultConsumed` branch returns without calling `cleanupCompleted`.
- `src/index.ts` — drop `runtime.agentActivity` from the `NotificationManager`, `AgentWidget`, and `AgentsMenuHandler` constructions.
- `.pi/skills/package-pi-subagents/SKILL.md` — update the module-dependency-flow line `widget ─polls─→ AgentActivityTracker map` to reflect that the widget now polls `listAgents()` records.
- `docs/architecture/architecture.md` — add a `Landed:` line to the Phase 18 Step 2 entry during implementation (the entry text already describes the work).

Test files (see TDD Order for which step each lands in):

- `test/helpers/make-subagent.ts` — add `turnCount` / `activeTools` / `responseText` / `maxTurns` shorthands to `createTestSubagent` so reader tests can seed activity on records.
- `test/widget-renderer.test.ts` — remove `WidgetActivity` / `makeActivity`; fold activity defaults into `makeAgent` (`turnCount`, `maxTurns`, `activeTools`, `responseText`, `contextPercent`); drop the `activity` arg from render calls and `activityMap` from `renderWidgetLines` calls; update the former "omit turn count when no activity" cases to assert the turn count now renders; convert the session-stats context test to a `contextPercent` field.
- `test/ui/agent-widget.test.ts` — drop the `agentActivity` arg from `new AgentWidget(...)`; add a projection test asserting `renderWidget` reads activity off records.
- `test/conversation-viewer.test.ts` — drop `activity` from `TestViewerOptions` / `createTestViewer`; seed the running-indicator test's `activeTools` / `responseText` via `createTestSubagent`; drop the `AgentActivityTracker` import.
- `test/ui/agent-menu.test.ts` — drop the `agentActivity` arg from `new AgentsMenuHandler(...)`.
- `test/tools/helpers.test.ts` — drop the `activity` arg from `buildDetails` calls; seed `turnCount` / `maxTurns` via `createTestSubagent`; drop the `AgentActivityTracker` import.
- `test/tools/foreground-runner.test.ts` — adjust any `details.turnCount` assertions to the record's value (turn count `1` default matches the prior tracker default, so most cases are unchanged); the activity-map registration test stays (producer plumbing remains).
- `test/observation/notification.test.ts` — drop `agentActivity` from `makeArgs` and `new NotificationManager(...)`; drop the `activity` arg from `buildNotificationDetails` calls and seed `turnCount` / `maxTurns` via `createTestSubagent`; remove the two map-cleanup assertions and the `cleanupCompleted` test.
- `test/observation/subagent-events-observer.test.ts` — update any assertion that `cleanupCompleted` is called on `resultConsumed` to assert no nudge is sent instead.

`test/runtime.test.ts` and `test/helpers/make-deps.ts` keep their `AgentActivityTracker` map usage — the runtime map and the `AgentTool` `agentActivity` access survive this step (removed in Steps 3 / 5).
Completed historical plans under `docs/plans/` are point-in-time records and are not edited.

## Test Impact Analysis

1. **New unit tests enabled.**
   `agent-widget.test.ts` can now assert the projection directly — that `renderWidget` surfaces a record's `turnCount` / `activeTools` / `contextPercent` without any external map — because activity lives on the record the manager stub returns.
   `widget-renderer.test.ts` tests get simpler: a single `makeAgent` carries everything, removing the two-object (`WidgetAgent` + `WidgetActivity`) arrangement.
2. **Tests that become redundant / simplified.**
   The `widget-renderer` "omits turn count when no activity provided" cases lose their premise (there is no activity-absent path); they convert to asserting the turn count renders.
   The `notification` "sendCompletion cleans up activity" and "cleanupCompleted removes activity" cases lose their subject (the map is gone) and are removed.
   `ui-observer.test.ts` and `agent-activity-tracker.test.ts` stay — they pin the producer behavior still wired until Step 3.
3. **Tests that must stay as-is.**
   `foreground-runner.test.ts`'s activity-map registration test (the tracker is still constructed and registered), and `runtime.test.ts`'s `agentActivity` map presence test, genuinely exercise the producer plumbing this step does not remove.

## Invariants at risk

- **Step 1 ([#420]) outcome — `Subagent` is the single home for run state; getters available for migration.**
  This step is the consumer of that outcome; the getters' parity with the old tracker (turn count starts at `1`, `name_seq` active-tool keying, reset-then-append response text) is what makes the swap behavior-preserving for running agents.
  Pinned by the existing `subagent-state.test.ts` / `record-observer.test.ts` cases from Step 1 plus the reader tests migrated here.
- **`widget-renderer` purity — pure functions, plain data, no SDK types** (established when the renderer was split out, plan 0148).
  The migration preserves and strengthens it: the `contextPercent` field removes the `getSessionContextPercent(session)` reach-through, so the renderer no longer touches session stats.
  Pinned by `widget-renderer.test.ts` constructing plain `WidgetAgent` objects (no class instances).
- **`NotificationManager` construction graph stays a cycle-free DAG with no widget dependency** (index.ts comment).
  Dropping the `agentActivity` map narrows its deps further; no new dependency is added.

No earlier phase step's documented `Outcome:` is regressed — the producer plumbing Step 1's tidy-first overlap left in place is untouched here.

## TDD Order

1. **Preparatory: seed activity on test records.**
   Surface: `test/helpers/make-subagent.ts` (+ a focused assertion in `test/helpers/make-deps.test.ts` or `make-subagent` coverage if one exists).
   Add `turnCount` / `activeTools` / `responseText` / `maxTurns` shorthands to `createTestSubagent` (drive `state.incrementTurnCount` / `addActiveTool` / `appendResponseText`; thread `maxTurns` into `makeStubExecution`).
   Pure test-helper addition — no production change; makes the reader-migration steps easy ("make the change that makes the change easy").
   Commit: `test: seed live-activity on createTestSubagent (#421)`.
2. **Migrate the widget reader.**
   Surface: `test/widget-renderer.test.ts`, `test/ui/agent-widget.test.ts`.
   Red→green: update `makeAgent` to carry activity, drop the `activity` arg / `activityMap`, assert finished lines now render the turn count, assert the `AgentWidget` projection.
   Implement the `WidgetAgent` fold + `contextPercent`, the render-signature changes, and the `AgentWidget.toWidgetAgent` projection; update the `new AgentWidget(...)` call in `index.ts` and the SKILL.md flow line.
   This step lands the accepted behavior change (finished-agent turn count), so the commit is `feat:`, not `refactor:`.
   Run `pnpm run check` after this commit — `renderWidgetLines` is the shared signature changed.
   Commit: `feat: read widget activity off subagent records (#421)`.
3. **Migrate the conversation viewer and `/agents` menu.**
   Surface: `test/conversation-viewer.test.ts`, `test/ui/agent-menu.test.ts`.
   Red→green: drop `activity` from the viewer factory and seed the running-indicator inputs on the record; drop the `agentActivity` arg from the menu handler construction.
   Implement: drop `ConversationViewer.activity`; read off `this.record`; remove `AgentActivityReader` and the `viewAgentConversation` lookup; update the `new AgentsMenuHandler(...)` call in `index.ts`.
   The viewer constructor signature and the menu constructor signature both change with their sole call sites in the same commit.
   Commit: `refactor: read conversation-viewer activity off the record (#421)`.
4. **Migrate `buildDetails` and the foreground runner.**
   Surface: `test/tools/helpers.test.ts`, `test/tools/foreground-runner.test.ts`.
   Red→green: drop the `activity` arg from `buildDetails` calls and seed `turnCount` / `maxTurns` on the record; confirm the foreground `details` still report the record's turn count.
   Implement: `buildDetails` param/body change (both call sites — `runForeground` and the `AgentTool` resume path — compile in the same commit), and `runForeground`'s `streamUpdate` / final `buildDetails` reads.
   Commit: `refactor: build agent details from the record, not the tracker (#421)`.
5. **Migrate notifications and drop the activity map there.**
   Surface: `test/observation/notification.test.ts`, `test/observation/subagent-events-observer.test.ts`.
   Red→green: drop `agentActivity` from the notification fixtures and the `activity` arg from `buildNotificationDetails`; remove the map-cleanup and `cleanupCompleted` cases; assert the observer's `resultConsumed` branch sends no nudge.
   Implement: `buildNotificationDetails` reads off the record; `NotificationManager` drops the map param/field and `cleanupCompleted`; `NotificationSystem` drops `cleanupCompleted`; `SubagentEventsObserver` returns in the `resultConsumed` branch; update the `new NotificationManager(...)` call in `index.ts`.
   Run `pnpm run check` after this commit — `NotificationSystem` is a shared interface and `index.ts` is its construction site.
   Commit: `refactor: build notification details from the record (#421)`.

After Step 5, no reader reads activity off `AgentActivityTracker`; the tracker, `ui-observer`, and the runtime map remain only as inert producer plumbing for Step 3 ([#422]).

## Risks and Mitigations

- **Risk: the running-line idle text changes.**
  Once `activeTools` / `responseText` always come off the record, an idle running agent renders via `describeActivity(new Map(), "")` instead of the old no-tracker `thinking…` fallback.
  Mitigation: `describeActivity` already returns `thinking…` for an empty map and blank text, so the output is preserved; the migrated `widget-renderer` test pins it.
- **Risk: transient background-tracker map leak between Steps 2 and 3.**
  `NotificationManager` no longer deletes finished agents' trackers from the runtime map, and background agents are no longer cleaned up by anyone until the map is removed.
  Mitigation: after this step the map is write-only and read by nobody, so the leak is inert and short-lived; Step 3 ([#422]) removes the map entirely.
- **Risk: `streamUpdate` runs before `recordRef` is set (foreground).**
  The initial `streamUpdate()` and the first spinner ticks fire before `onSessionCreated` assigns `recordRef`.
  Mitigation: read with defaults that match the tracker's initial values (`turnCount ?? 1`, empty `activeTools`, `"" `responseText, `execution.effectiveMaxTurns` for `maxTurns`).
- **Risk: removing `cleanupCompleted` changes the observer's consumed-result path.**
  Mitigation: the method only deleted a map entry; the observer's intent (skip the nudge when the result was already consumed) is preserved by an early `return`, pinned by the updated observer test.

## Open Questions

- Whether the `NotificationSystem` interface should be narrowed further (e.g. to a two-method completion notifier) now that `cleanupCompleted` is gone is deferred — it is orthogonal to this step and best judged once Steps 3–5 settle the surrounding wiring.

[#420]: https://github.com/gotgenes/pi-packages/issues/420
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
