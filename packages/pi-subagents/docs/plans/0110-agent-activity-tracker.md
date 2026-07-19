---
issue: 110
issue_title: "refactor(pi-subagents): wrap AgentActivity in AgentActivityTracker class"
---

# Wrap AgentActivity in AgentActivityTracker class

## Problem Statement

`AgentActivity` is a 7-field mutable interface (`activeTools`, `toolUses`, `responseText`, `session`, `turnCount`, `maxTurns`, `lifetimeUsage`) shared across 4 modules.
`ui-observer.ts` writes raw fields on it (output arguments), the widget and conversation viewer read them, and the agent-tool creates empty instances and stuffs them into a shared `Map`.
The mutation contract is implicit — callers know which fields to set by convention, not by API.

This is Phase 7, Step A3 in the architecture doc.

## Goals

- Wrap `AgentActivity` in an `AgentActivityTracker` class with explicit transition methods.
- Replace the output-argument writes in `ui-observer.ts` with tracker method calls.
- Expose read-only accessors for the state the widget, notification system, conversation viewer, and agent-tool need.
- Change the shared `Map<string, AgentActivity>` on `SubagentRuntime` to `Map<string, AgentActivityTracker>`.
- Preserve all existing behavior — this is a pure encapsulation refactor.

## Non-Goals

- Splitting `AgentRecord` lifecycle state (#111) — deferred to Step B.
- Replacing `AgentManager` callbacks with an observer (#112) — deferred to Step C.
- Narrowing `AgentToolDeps` or `AgentMenuDeps` further (#114) — deferred to Step D2.
- Changing `createNotificationSystem` from closure to class (#116) — deferred to Step E2.

## Background

### Who writes AgentActivity today

`ui-observer.ts` (`subscribeUIObserver`) is the sole writer.
It subscribes to session events and mutates the state object directly:

- `state.activeTools.set(...)` / `state.activeTools.delete(...)` on tool start/end
- `state.toolUses++` on tool end
- `state.responseText = ""` on message start, `state.responseText += delta` on message update
- `state.turnCount++` on turn end
- `addUsage(state.lifetimeUsage, ...)` on message end with assistant usage

The agent-tool also writes `session` after session creation (`fgState.session = session`, `bgState.session = session`).

### Who reads AgentActivity today

| Consumer                                       | Fields read                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agent-widget.ts` (widget render)              | `activeTools`, `responseText`, `toolUses`, `turnCount`, `maxTurns`, `lifetimeUsage`, `session` |
| `conversation-viewer.ts`                       | `toolUses`, `lifetimeUsage`, `session`, `activeTools`, `responseText`                          |
| `notification.ts` (`buildNotificationDetails`) | `turnCount`, `maxTurns`                                                                        |
| `agent-tool.ts` (foreground streaming)         | `toolUses`, `turnCount`, `maxTurns`, `activeTools`, `responseText`, `lifetimeUsage`            |
| `agent-menu.ts` (conversation viewer launch)   | passes to `ConversationViewer`                                                                 |

### Who creates AgentActivity today

`createAgentActivity()` in `agent-tool.ts` — a factory function that returns a plain object with defaults.

### AGENTS.md constraints

- One concern per file: the tracker gets its own module.
- Avoid `any`: use typed accessors.
- Output arguments: this refactor eliminates them from `ui-observer.ts`.
- Keep modules focused: the tracker owns its mutable state; consumers use read-only accessors.

## Design Overview

### AgentActivityTracker class

New file: `src/ui/agent-activity-tracker.ts`.

The class owns the 7 mutable fields and exposes:

1. Transition methods (the write surface — called by `ui-observer.ts` and agent-tool):

   ```typescript
   onToolStart(toolName: string): void    // adds to activeTools map
   onToolEnd(toolName: string): void      // removes from activeTools, increments toolUses
   onMessageStart(): void                  // resets responseText
   onMessageUpdate(delta: string): void    // appends to responseText
   onTurnEnd(): void                       // increments turnCount
   onUsageUpdate(usage: UsageDelta): void  // accumulates into lifetimeUsage
   setSession(session: SessionLike): void  // one-time session binding
   ```

2. Read-only accessors (the read surface — used by widget, notification, conversation viewer, agent-tool streaming):

   ```typescript
   get activeTools(): ReadonlyMap<string, string>
   get toolUses(): number
   get responseText(): string
   get session(): SessionLike | undefined
   get turnCount(): number
   get maxTurns(): number | undefined
   get lifetimeUsage(): Readonly<LifetimeUsage>
   ```

The constructor accepts `maxTurns?: number` (set at creation time, immutable).

### UsageDelta type

A narrow type for the usage values passed to `onUsageUpdate`:

```typescript
interface UsageDelta { input: number; output: number; cacheWrite: number }
```

This matches the shape `addUsage` already expects and avoids coupling to the full `LifetimeUsage` type name for what is logically a delta.

### activeTools key strategy

The current `activeTools` Map uses `toolName + "_" + Date.now()` as a key to allow multiple concurrent tools with the same name.
`onToolStart` returns `void` and generates the key internally (same `Date.now()` strategy).
`onToolEnd(toolName)` finds and removes the first matching entry (same logic as today).

### subscribeUIObserver changes

`subscribeUIObserver` changes its second parameter from `state: AgentActivity` to `tracker: AgentActivityTracker`.
Instead of writing fields, it calls tracker methods:

```typescript
// Before:
state.activeTools.set(event.toolName + "_" + Date.now(), event.toolName);
// After:
tracker.onToolStart(event.toolName);
```

### Consumer interface

Readers continue to access the same properties but through getters.
Since the tracker exposes matching property names, consumer code like `bg.turnCount` and `bg.toolUses` remains syntactically identical — only the type annotation changes from `AgentActivity` to `AgentActivityTracker`.

The `AgentActivity` interface is removed entirely.
All references migrate to `AgentActivityTracker`.

### Map type change

`SubagentRuntime.agentActivity` changes from `Map<string, AgentActivity>` to `Map<string, AgentActivityTracker>`.
All dependency bags that pass this map (`AgentToolDeps`, `AgentMenuDeps`, `NotificationDeps`, `AgentWidget` constructor) update their type annotations.

### createAgentActivity replacement

The factory function in `agent-tool.ts` is replaced by `new AgentActivityTracker(maxTurns)`.

## Module-Level Changes

### New file

| File                               | What                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `src/ui/agent-activity-tracker.ts` | `AgentActivityTracker` class with transition methods and read-only accessors |

### New test file

| File                                     | What                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `test/ui/agent-activity-tracker.test.ts` | Unit tests for all transition methods and read-only accessors |

### Modified files

| File                            | What changes                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/ui-observer.ts`         | Accept `AgentActivityTracker` instead of `AgentActivity`; call transition methods instead of writing fields                                                                                                    |
| `src/ui/agent-widget.ts`        | Remove `AgentActivity` interface; import `AgentActivityTracker`; update `Map` type and read sites (property names stay the same)                                                                               |
| `src/ui/conversation-viewer.ts` | Import `AgentActivityTracker` instead of `AgentActivity`; update parameter type                                                                                                                                |
| `src/ui/agent-menu.ts`          | Import `AgentActivityTracker` instead of `AgentActivity`; update `Map` type                                                                                                                                    |
| `src/tools/agent-tool.ts`       | Import `AgentActivityTracker`; replace `createAgentActivity()` with `new AgentActivityTracker()`; replace `fgState.session = session` with `fgState.setSession(session)`; update `Map` type in `AgentToolDeps` |
| `src/notification.ts`           | Import `AgentActivityTracker` instead of `AgentActivity`; update `buildNotificationDetails` parameter and `NotificationDeps.agentActivity` Map type                                                            |
| `src/runtime.ts`                | Import `AgentActivityTracker`; change `agentActivity` Map type; update `AgentWidget` import (type only change since `AgentActivity` moves)                                                                     |
| `src/index.ts`                  | No changes (already references `runtime.agentActivity` by reference, the type flows through)                                                                                                                   |

### Modified test files

| File                            | What changes                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/ui/ui-observer.test.ts`   | Replace `makeActivity()` factory with `new AgentActivityTracker()`; access state through getters; assertions on accessor values instead of raw field reads |
| `test/notification.test.ts`     | Replace `as AgentActivity` casts with `new AgentActivityTracker()`; set up tracker state via transition methods                                            |
| `test/tools/agent-tool.test.ts` | Update `Map<string, AgentActivity>` type to `Map<string, AgentActivityTracker>`                                                                            |

### Removed exports

| Symbol                             | Was in                    | Replaced by                                                        |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `AgentActivity` (interface)        | `src/ui/agent-widget.ts`  | `AgentActivityTracker` class in `src/ui/agent-activity-tracker.ts` |
| `createAgentActivity()` (function) | `src/tools/agent-tool.ts` | `new AgentActivityTracker(maxTurns)`                               |

Grep verification: `AgentActivity` is referenced in 7 source files and 3 test files (listed above) — all accounted for in the modified files list.

## Test Impact Analysis

### New unit tests enabled

The `AgentActivityTracker` class enables focused unit tests for each transition method in isolation:

- `onToolStart` / `onToolEnd` — concurrent tool tracking, correct toolUses increment
- `onMessageStart` / `onMessageUpdate` — response text lifecycle
- `onTurnEnd` — turn counting from initial value
- `onUsageUpdate` — accumulation semantics
- `setSession` — one-time binding
- Read-only accessors — verify consumers cannot mutate internal state

These were previously impossible to test without going through `subscribeUIObserver` and a mock session.

### Existing tests that simplify

`test/ui/ui-observer.test.ts` — currently constructs a plain `AgentActivity` object and asserts on raw field mutations.
After the change, it constructs an `AgentActivityTracker` and the assertions read the same properties through accessors.
The `makeActivity()` helper is replaced by `new AgentActivityTracker()`.
The test logic stays the same (event → tracker state check) but the assertions use getter-backed properties.

### Existing tests that stay as-is

`test/notification.test.ts` — the pure helper tests (`escapeXml`, `getStatusLabel`, `formatTaskNotification`, `buildNotificationDetails`) only need their `AgentActivity` type references updated to `AgentActivityTracker`.
The notification system integration tests that cast `{} as AgentActivity` need minimal updates to construct a real tracker instead.

`test/tools/agent-tool.test.ts` — only the `Map` type annotation changes.

## TDD Order

### 1. Red/green: AgentActivityTracker class — transition methods and read-only accessors

Test file: `test/ui/agent-activity-tracker.test.ts`

Tests:

- Constructor sets initial state (`turnCount: 1`, empty `activeTools`, `toolUses: 0`, empty `responseText`, zero `lifetimeUsage`, `maxTurns` from constructor arg, `session` undefined)
- `onToolStart` adds entry to `activeTools`
- `onToolEnd` removes entry and increments `toolUses`
- `onToolEnd` with no matching tool is a no-op (defensive)
- Multiple concurrent tools with same name tracked independently
- `onMessageStart` resets `responseText` to empty
- `onMessageUpdate` appends delta to `responseText`
- `onTurnEnd` increments `turnCount`
- `onUsageUpdate` accumulates into `lifetimeUsage`
- `setSession` stores the session reference
- Read-only: `activeTools` returns `ReadonlyMap`
- Read-only: `lifetimeUsage` returns `Readonly<LifetimeUsage>`

Commit: `feat: add AgentActivityTracker class (#110)`

### 2. Red/green: migrate ui-observer to use AgentActivityTracker

Update `src/ui/ui-observer.ts` to accept `AgentActivityTracker` and call transition methods.
Update `test/ui/ui-observer.test.ts`: replace `makeActivity()` with `new AgentActivityTracker()`, read state through accessors.

All existing test scenarios must pass unchanged (same events → same observable state).

Commit: `refactor: migrate ui-observer to AgentActivityTracker (#110)`

### 3. Migrate agent-widget and conversation-viewer

Update `src/ui/agent-widget.ts`: remove `AgentActivity` interface, import `AgentActivityTracker`, update `Map` type and constructor parameter.
Update `src/ui/conversation-viewer.ts`: import `AgentActivityTracker`, update parameter type.

No test changes needed — widget and conversation viewer are not unit-tested (they render UI).

Commit: `refactor: migrate widget and conversation-viewer to AgentActivityTracker (#110)`

### 4. Migrate agent-tool

Update `src/tools/agent-tool.ts`: import `AgentActivityTracker`, replace `createAgentActivity()` with `new AgentActivityTracker()`, replace `fgState.session = session` with `fgState.setSession(session)`, update `AgentToolDeps` Map type.
Update `test/tools/agent-tool.test.ts`: update Map type.

Commit: `refactor: migrate agent-tool to AgentActivityTracker (#110)`

### 5. Migrate notification and agent-menu

Update `src/notification.ts`: import `AgentActivityTracker`, update `buildNotificationDetails` parameter and `NotificationDeps` Map type.
Update `src/ui/agent-menu.ts`: import `AgentActivityTracker`, update Map type in `AgentMenuDeps`.
Update `test/notification.test.ts`: replace `as AgentActivity` casts with real `AgentActivityTracker` instances.

Commit: `refactor: migrate notification and agent-menu to AgentActivityTracker (#110)`

### 6. Migrate runtime and clean up

Update `src/runtime.ts`: import `AgentActivityTracker`, change `agentActivity` Map type.
Remove any remaining `AgentActivity` references.
Run `pnpm run check` to verify no type errors remain.

Commit: `refactor: complete AgentActivityTracker migration, remove AgentActivity interface (#110)`

## Risks and Mitigations

| Risk                                                                              | Mitigation                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only getters change identity semantics for `activeTools` and `lifetimeUsage` | The `ReadonlyMap` and `Readonly<LifetimeUsage>` types restrict writes at compile time. Consumers already only read these values, so no runtime change. Return the internal mutable reference cast to readonly (no copy overhead). |
| Spreading a class instance loses methods                                          | Grep for `{ ...activity` or `{ ...bg` patterns — none found in current code. The `buildDetails` function spreads `detailBase` (a plain object), not the activity.                                                                 |
| `onToolEnd` matching logic fragility                                              | Port the exact same `for...of` + `break` pattern from `ui-observer.ts`. New unit tests cover this independently.                                                                                                                  |
| `turnCount` initial value of 1 (not 0)                                            | The current `createAgentActivity` sets `turnCount: 1`. The tracker constructor preserves this. A dedicated test asserts the initial value.                                                                                        |
| Test files casting `{} as AgentActivity`                                          | Replace with real `AgentActivityTracker` instances. Where tests only need `turnCount` and `maxTurns` (e.g., `buildNotificationDetails`), construct a tracker and call `onTurnEnd` to set up the desired state.                    |

## Open Questions

- None — the issue and architecture doc are prescriptive about the approach.
  The only design latitude is whether `onToolStart` returns a key (for symmetric `onToolEnd(key)`) or whether `onToolEnd(toolName)` does a lookup.
  The plan uses `onToolEnd(toolName)` with lookup to match the existing pattern and avoid threading a key through the session event handler.
