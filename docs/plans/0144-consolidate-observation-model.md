---
issue: 144
issue_title: "Consolidate observation model (Phase 9, Step L)"
---

# Consolidate observation model

## Problem Statement

`record-observer.ts` and `ui-observer.ts` independently count tool uses and accumulate lifetime usage from the same session events.
`AgentRecord` owns `_toolUses` and `_lifetimeUsage` (accumulated by the record observer), while `AgentActivityTracker` maintains its own `_toolUses` and `_lifetimeUsage` (accumulated by the UI observer).
Consumers use `activity?.toolUses ?? record.toolUses` fallbacks to paper over the ambiguity.

Separately, 15+ callsites navigate `record.execution?.session` and `record.execution?.outputFile`, leaking the `ExecutionState` structure to every consumer.

Finally, `NotificationDeps` (4 fields) is a dependency bag on a class where every method uses every field — plain constructor parameters are simpler.

## Goals

- Remove `_toolUses` and `_lifetimeUsage` from `AgentActivityTracker` so stats have a single source of truth on `AgentRecord`.
- Update UI consumers (widget, conversation viewer, notification, foreground runner) to read stats from `AgentRecord` instead of the tracker.
- Remove the `onToolEnd` counter and `onUsageUpdate` accumulator from `AgentActivityTracker`, keeping only live UI state (active tools, response text, turn count).
- Stop the UI observer from duplicating `tool_execution_end` counting and `message_end` usage accumulation.
- Add `session` and `outputFile` convenience getters on `AgentRecord` to hide the `execution?.` traversal.
- Replace `NotificationDeps` interface with plain parameters on `NotificationManager` constructor.

## Non-Goals

- Splitting `AgentWidget` rendering into pure functions (Step P / #148 — depends on this work).
- Narrowing `ExtensionContext` for menu handlers (Step N / #146 — independent track).
- Injecting text wrapping into `ConversationViewer` (Step O / #147 — independent track).

## Background

### Dual counting

Both observers subscribe to the same session events:

| Event                 | `record-observer.ts`         | `ui-observer.ts`                      |
| --------------------- | ---------------------------- | ------------------------------------- |
| `tool_execution_end`  | `record.incrementToolUses()` | `tracker.onToolEnd()` → `_toolUses++` |
| `message_end` (usage) | `record.addUsage(delta)`     | `tracker.onUsageUpdate(delta)`        |

The widget reads `bg?.toolUses ?? a.toolUses` and the conversation viewer reads `this.activity?.toolUses ?? this.record.toolUses`, preferring the tracker when alive and falling back to the record.
After this change, there is one source: `AgentRecord`.

### `execution?.` traversal

`ExecutionState` holds `session` and `outputFile`.
These are set once when the agent session is created (`agent-manager.ts` line 276).
Consumers reach through `record.execution?.session` and `record.execution?.outputFile` in 12 distinct locations across 7 files.
Convenience getters on `AgentRecord` eliminate the traversal and hide the `ExecutionState` structure.

### `NotificationDeps` bag

`NotificationManager` receives 4 fields via `NotificationDeps`: `sendMessage`, `agentActivity`, `markFinished`, `updateWidget`.
Every method on the class uses every field.
Per code-design convention (dependency width), a 4-field interface where every consumer uses every field is fine as a bag, but the architecture doc explicitly calls for plain parameters here.
This is a mechanical change.

## Design Overview

### AgentActivityTracker changes

Remove `_toolUses`, `_lifetimeUsage`, `onToolEnd`, `onUsageUpdate`, `toolUses` getter, and `lifetimeUsage` getter.
Retain: `_activeTools`, `_toolKeySeq`, `_responseText`, `_session`, `_turnCount`, `_maxTurns`, and their associated transition methods and getters.

`onToolStart` stays (tracks active tools for the widget spinner).
A new `onToolDone(toolName)` method replaces `onToolEnd` — it removes the tool from `_activeTools` without incrementing any counter.
This rename clarifies that the method only manages the active-tool display set.

### UI observer changes

The UI observer stops calling counter/accumulator methods:

- `tool_execution_end` handler: calls `tracker.onToolDone(name)` (active-tool tracking only).
- `message_end` handler: removed entirely (no more usage accumulation).
  The `onUpdate?.()` call for usage re-render moves to the record observer path via the existing widget update flow.

### AgentRecord convenience getters

```typescript
get session(): AgentSession | undefined {
  return this.execution?.session;
}

get outputFile(): string | undefined {
  return this.execution?.outputFile;
}
```

Callers change from `record.execution?.session` to `record.session`.
The `execution` field remains writable (set by `AgentManager`), but consumers no longer need to know about `ExecutionState`.

### Consumer migration

| File                       | Before                                             | After                                            |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `agent-widget.ts`          | `bg?.toolUses ?? a.toolUses`                       | `a.toolUses`                                     |
| `agent-widget.ts`          | `getLifetimeTotal(bg?.lifetimeUsage)`              | `getLifetimeTotal(a.lifetimeUsage)`              |
| `agent-widget.ts`          | `getSessionContextPercent(bg?.session)`            | `getSessionContextPercent(a.session)`            |
| `conversation-viewer.ts`   | `this.activity?.toolUses ?? this.record.toolUses`  | `this.record.toolUses`                           |
| `conversation-viewer.ts`   | `getLifetimeTotal(this.activity?.lifetimeUsage)`   | `getLifetimeTotal(this.record.lifetimeUsage)`    |
| `conversation-viewer.ts`   | `getSessionContextPercent(this.activity?.session)` | `getSessionContextPercent(this.record.session)`  |
| `notification.ts`          | `record.execution?.session`                        | `record.session`                                 |
| `notification.ts`          | `record.execution?.outputFile`                     | `record.outputFile`                              |
| `tools/get-result-tool.ts` | `record.execution?.session`                        | `record.session`                                 |
| `tools/steer-tool.ts`      | `record.execution?.session`                        | `record.session`                                 |
| `agent-menu.ts`            | `record.execution?.session`                        | `record.session`                                 |
| `service-adapter.ts`       | `record.execution?.session`                        | `record.session`                                 |
| `agent-manager.ts`         | `record.execution?.session`                        | `record.session` (in dispose paths)              |
| `foreground-runner.ts`     | `fgState.toolUses`                                 | `record.toolUses` (in final result)              |
| `foreground-runner.ts`     | `formatLifetimeTokens(fgState)`                    | `formatLifetimeTokens(record)` (in final result) |

### NotificationManager refactoring

Replace:

```typescript
export interface NotificationDeps { … }
constructor(private deps: NotificationDeps) {}
```

With:

```typescript
constructor(
  private sendMessage: NotificationDeps["sendMessage"],
  private agentActivity: Map<string, AgentActivityTracker>,
  private markFinished: (id: string) => void,
  private updateWidget: () => void,
) {}
```

Internal references change from `this.deps.sendMessage(…)` to `this.sendMessage(…)`.
The `NotificationDeps` interface is removed.

### Foreground runner streaming

During foreground execution, `streamUpdate` reads `fgState.toolUses` and `formatLifetimeTokens(fgState)` for live spinner updates.
After removing these from the tracker, `streamUpdate` must read from the record instead.
The record is available only after `spawnAndWait` returns the record reference via `onSessionCreated`.
Before that callback fires, tool uses and usage are both zero — the tracker never had meaningful data at that point either.
`streamUpdate` will capture a `let recordRef: AgentRecord | undefined` and read `recordRef?.toolUses ?? 0` during the spinner phase.
After `onSessionCreated`, `recordRef` is set and subsequent spinner ticks read live values from the record.

## Module-Level Changes

### Modified files

1. `src/ui/agent-activity-tracker.ts` — Remove `_toolUses`, `_lifetimeUsage`, `onToolEnd`, `onUsageUpdate`, `toolUses` getter, `lifetimeUsage` getter.
   Rename remaining tool-end logic to `onToolDone`.
   Remove `addUsage` and `UsageDelta` imports.
2. `src/ui/ui-observer.ts` — Call `tracker.onToolDone` instead of `tracker.onToolEnd`.
   Remove `message_end` usage accumulation block.
3. `src/agent-record.ts` — Add `get session()` and `get outputFile()` convenience getters.
   Import `AgentSession` type for the return type.
4. `src/notification.ts` — Remove `NotificationDeps` interface.
   Change `NotificationManager` constructor to plain parameters.
   Replace `this.deps.*` with `this.*`.
   Change `record.execution?.session` → `record.session`, `record.execution?.outputFile` → `record.outputFile`.
5. `src/ui/agent-widget.ts` — Read `a.toolUses`, `a.lifetimeUsage`, `a.session` instead of `bg?.toolUses ?? a.toolUses` etc.
6. `src/ui/conversation-viewer.ts` — Read `this.record.toolUses`, `this.record.lifetimeUsage`, `this.record.session` instead of fallback pattern.
7. `src/tools/get-result-tool.ts` — `record.execution?.session` → `record.session`.
8. `src/tools/steer-tool.ts` — `record.execution?.session` → `record.session`.
9. `src/ui/agent-menu.ts` — `record.execution?.session` → `record.session`.
10. `src/service-adapter.ts` — `record.execution?.session` → `record.session`.
11. `src/agent-manager.ts` — `record.execution?.session` → `record.session` in dispose paths.
    Keep the `record.execution = { session, outputFile }` assignment unchanged (that's the write path).
12. `src/tools/foreground-runner.ts` — Read `record.toolUses` and `formatLifetimeTokens(record)` for final result.
    Capture `recordRef` for streaming phase.
13. `src/tools/helpers.ts` — `buildDetails`: read `record.toolUses` and `record.lifetimeUsage` (already does); remove optional `activity` parameter's usage of `toolUses`/`lifetimeUsage` if present (verify).
14. `src/index.ts` — Update `NotificationManager` construction from bag to plain parameters.
15. `src/tools/background-spawner.ts` — `record?.execution?.outputFile` → `record?.outputFile`.

### Test files modified

1. `test/ui/agent-activity-tracker.test.ts` — Remove tests for `toolUses`, `lifetimeUsage`, `onToolEnd`, `onUsageUpdate`.
   Add tests for `onToolDone` (active-tool removal without counting).
2. `test/ui/ui-observer.test.ts` — Update `tool_execution_end` expectations (calls `onToolDone` not `onToolEnd`).
   Remove `message_end` usage accumulation tests.
3. `test/notification.test.ts` — Update `makeDeps()` factory to use plain parameters.
   Or update `NotificationManager` construction call to match new signature.
4. `test/agent-record.test.ts` — Add tests for `session` and `outputFile` getters.
5. `test/conversation-viewer.test.ts` — Remove mock activity tracker usage for stats; tests use record stats directly.

## Test Impact Analysis

### New unit tests enabled

1. `AgentRecord.session` and `AgentRecord.outputFile` getters — straightforward getter tests on the record class.
2. `AgentActivityTracker.onToolDone` — verifies active-tool removal without side effects on a counter.

### Existing tests that become simpler

1. `agent-activity-tracker.test.ts` — 4 test blocks for `toolUses`, `lifetimeUsage`, `onToolEnd`, `onUsageUpdate` can be removed.
   The `onToolDone` replacement needs fewer assertions (no counter check).
2. `ui-observer.test.ts` — The `message_end` usage accumulation tests can be removed.
   The `tool_execution_end` test simplifies (verifies active-tool removal only).
3. `notification.test.ts` — The `makeDeps()` helper changes shape but stays the same size.
4. `conversation-viewer.test.ts` — Tests that mock `activity.toolUses` and `activity.lifetimeUsage` can simplify to reading from the record.

### Existing tests that must stay

1. `record-observer.test.ts` — All tests remain as-is.
   The record observer is the sole source of `incrementToolUses` and `addUsage` calls now.
2. `agent-record.test.ts` — All existing tests for `incrementToolUses`, `addUsage`, `incrementCompactions` remain.
3. `notification.test.ts` — Pure helper tests (`escapeXml`, `getStatusLabel`, `formatTaskNotification`, `buildNotificationDetails`, `buildEventData`) remain unchanged.

## TDD Order

1. **Red→Green: `AgentRecord` convenience getters.**
   Add tests for `record.session` and `record.outputFile` (returns `undefined` when no execution, delegates when set).
   Implement the getters.
   Commit: `feat: add session and outputFile convenience getters to AgentRecord (#144)`

2. **Green→Green: Migrate callsites from `execution?.` to convenience getters.**
   Update all 12 callsites across 7 files (`notification.ts`, `agent-widget.ts`, `agent-menu.ts`, `get-result-tool.ts`, `steer-tool.ts`, `service-adapter.ts`, `agent-manager.ts`, `background-spawner.ts`).
   No test changes needed — existing tests pass.
   Run `pnpm run check` to verify.
   Commit: `refactor: use AgentRecord.session and .outputFile convenience getters (#144)`

3. **Red→Green: Rename `onToolEnd` to `onToolDone` and remove counter.**
   Update `agent-activity-tracker.test.ts`: remove `onToolEnd` counter tests, add `onToolDone` tests (active-tool removal only, no `toolUses` assertion).
   Implement: rename method, remove `_toolUses++`.
   Update `ui-observer.ts` to call `onToolDone`.
   Update `ui-observer.test.ts` expectations.
   Commit: `refactor: rename AgentActivityTracker.onToolEnd to onToolDone (#144)`

4. **Red→Green: Remove `_toolUses` and `_lifetimeUsage` from tracker.**
   Update `agent-activity-tracker.test.ts`: remove `toolUses` getter, `lifetimeUsage` getter, and `onUsageUpdate` test blocks.
   Implement: remove `_toolUses`, `_lifetimeUsage`, `toolUses` getter, `lifetimeUsage` getter, `onUsageUpdate` method, `UsageDelta` type, `addUsage` import.
   Update `ui-observer.ts`: remove `message_end` usage accumulation block.
   Update `ui-observer.test.ts`: remove `message_end` usage tests.
   Run `pnpm run check` to catch any remaining references.
   Commit: `refactor: remove duplicate stats from AgentActivityTracker (#144)`

5. **Green→Green: Migrate UI consumers to read stats from `AgentRecord`.**
   Update `agent-widget.ts`: replace `bg?.toolUses ?? a.toolUses` → `a.toolUses`, `bg?.lifetimeUsage` → `a.lifetimeUsage`, `bg?.session` → `a.session`.
   Update `conversation-viewer.ts`: replace `activity?.toolUses ?? record.toolUses` → `record.toolUses`, `activity?.lifetimeUsage` → `record.lifetimeUsage`, `activity?.session` → `record.session`.
   Update `foreground-runner.ts`: read stats from record instead of tracker for final result.
   Capture `recordRef` for streaming phase.
   Update `conversation-viewer.test.ts` if any tests mock activity stats.
   Commit: `refactor: read stats from AgentRecord in UI consumers (#144)`

6. **Red→Green: Replace `NotificationDeps` with plain parameters.**
   Update `notification.test.ts`: change `makeDeps()` → individual parameters in `NotificationManager` constructor calls.
   Implement: remove `NotificationDeps` interface, change constructor to plain parameters, replace `this.deps.*` with `this.*`.
   Update `index.ts`: change `NotificationManager` construction to pass individual arguments.
   Commit: `refactor: dissolve NotificationDeps into plain constructor parameters (#144)`

## Risks and Mitigations

| Risk                                                                                              | Mitigation                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground streaming reads stale `recordRef` before `onSessionCreated` fires                      | Before `onSessionCreated`, both tracker and record have zero stats — behavior is unchanged.  Capture `recordRef` as `undefined` initially and guard with `??`.                                                                                              |
| Widget reads `a.toolUses` but `a` is the snapshot from `listAgents()` — might be stale            | `listAgents()` returns live `AgentRecord` references (not copies), so `a.toolUses` reflects the latest record-observer increment.                                                                                                                           |
| Removing `lifetimeUsage` from tracker breaks `formatLifetimeTokens(fgState)` in foreground runner | Step 5 explicitly migrates this callsite to `formatLifetimeTokens(record)`.  The TDD order places the removal (step 4) before the migration (step 5), but step 4's `pnpm run check` will catch the type error and both steps can be merged if needed.       |
| `buildDetails` in `helpers.ts` accepts an `activity` parameter for `turnCount`/`maxTurns`         | `turnCount` and `maxTurns` remain on the tracker — only `toolUses` and `lifetimeUsage` are removed.  `buildDetails` reads `record.toolUses` and `record.lifetimeUsage` already; it reads `activity?.turnCount` and `activity?.maxTurns` which remain valid. |

## Open Questions

- None — the architecture doc prescribes the exact changes and the design is straightforward.
