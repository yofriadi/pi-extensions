---
issue: 100
issue_title: "Replace callback threading with direct session-event subscription"
---

# Replace callback threading with direct session-event subscription

## Problem Statement

`SpawnOptions` carries 6 `on*` callback fields that thread through three layers: `agent-tool.ts` creates activity-tracking callbacks → `AgentManager.startAgent()` wraps each to update the record, then forwards → `runner.run()` subscribes to session events and translates them into callback invocations.
The session already emits all of these events via `session.subscribe()`.
Three layers reimplement what two independent subscriptions could provide.

The same pattern repeats in `resume()`, which hand-rolls 3 of the 4 callback wrappers.

## Goals

- Replace the 3-layer callback chain with two direct session subscribers: a **record observer** (AgentManager, updates record stats) and a **UI observer** (agent-tool, streams widget state).
- Drop 5 `on*` callback fields from `SpawnOptions` (keep `onSessionCreated` as the session-delivery mechanism).
- Drop 5 `on*` callback fields from `RunOptions`.
- Drop 3 `on*` callback fields from `ResumeOptions`.
- Simplify `startAgent()` from ~80 lines of callback wiring to ~20 lines of observer setup.
- Eliminate duplicated callback wiring between `startAgent()` and `resume()`.

## Non-Goals

- Extracting turn-limit enforcement from the runner — it stays as the runner's own subscription, just simplified.
  A follow-up could extract it into a `turn-limiter.ts` module.
- Changing the public `SubagentsService` API in `service.ts` — the public `SpawnOptions` type is unaffected.
- Removing `onSessionCreated` — it remains as the session-delivery bridge between the runner and external subscribers.
- Changing `collectResponseText` or `forwardAbortSignal` in the runner — those are the runner's own concerns.

## Background

### Prerequisite status

- Issue #98 (AgentRecord state machine) — **done**.
  `AgentRecord` is a class with encapsulated transition methods (`markRunning`, `markCompleted`, `markError`, etc.).
  The record observer uses public mutable fields (`toolUses`, `lifetimeUsage`, `compactionCount`) and the `addUsage` helper.
- Issue #99 (ParentSnapshot) — **done**.
  `runner.run()` accepts `ParentSnapshot`, `SpawnArgs` stores a snapshot, `AgentManager` has `exec: ShellExec` injected.

### Current callback threading

In `startAgent()`, AgentManager wraps 4 of the 6 callbacks to interleave record mutations:

| Callback           | Record mutation                                               | Forwarding                            |
| ------------------ | ------------------------------------------------------------- | ------------------------------------- |
| `onToolActivity`   | `record.toolUses++` on end                                    | Forward to `options.onToolActivity`   |
| `onAssistantUsage` | `addUsage(record.lifetimeUsage, …)`                           | Forward to `options.onAssistantUsage` |
| `onCompaction`     | `record.compactionCount++` + `this.onCompact?.(record, info)` | Forward to `options.onCompaction`     |
| `onSessionCreated` | Store session, capture file, flush steers                     | Forward to `options.onSessionCreated` |
| `onTextDelta`      | None                                                          | Pass-through                          |
| `onTurnEnd`        | None                                                          | Pass-through                          |

In `resume()`, 3 callbacks are wired manually (onToolActivity, onAssistantUsage, onCompaction) with no forwarding — only record mutations.

The runner's big `session.subscribe()` block (lines 323–370 of `agent-runner.ts`) mixes turn-limit enforcement with event→callback translation for all 6 callback types.

### Code-design constraints

- **Parameter relay** (code-design skill): the 5 UI callbacks thread through `SpawnOptions` → `startAgent()` wrapping → `RunOptions` → runner subscription.
  The intermediary (`startAgent`) only uses them to interleave record mutations.
- **Scattered resets** (design-review): `resume()` hand-rolls 3 of the same 4 callback wrappers from `startAgent()`.

### Relevant modules

| Module                    | Role in this change                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `src/agent-manager.ts`    | Owns `SpawnOptions`, `startAgent()`, `resume()` — primary target     |
| `src/agent-runner.ts`     | Owns `RunOptions`, `ResumeOptions`, runner subscription — simplifies |
| `src/tools/agent-tool.ts` | Owns `createActivityTracker()` — replaced by UI observer             |
| `src/ui/agent-widget.ts`  | Defines `AgentActivity` interface — unchanged                        |
| `src/agent-record.ts`     | `AgentRecord` class — unchanged (observer writes to public fields)   |
| `src/usage.ts`            | `addUsage` helper — unchanged, used by record observer               |

## Design Overview

### Two independent observers

```text
                     session.subscribe()
                            │
              ┌─────────────┼─────────────┐
              │                           │
       Record observer              UI observer
  (accumulates stats on record)   (updates widget state)
  managed by AgentManager         managed by agent-tool
  subscribes in onSessionCreated  subscribes in onSessionCreated
  unsubscribes in .then/.catch    unsubscribes on completion
```

Both subscribe to the same session but update independent state.
Neither wraps or forwards the other's events.

### Record observer

New module `src/record-observer.ts`:

```typescript
export interface RecordObserverOptions {
  onCompact?: (record: AgentRecord, info: CompactionInfo) => void;
}

export function subscribeRecordObserver(
  session: AgentSession,
  record: AgentRecord,
  options?: RecordObserverOptions,
): () => void;
```

Handles three event types:

| Session event                               | Record mutation                                      |
| ------------------------------------------- | ---------------------------------------------------- |
| `tool_execution_end`                        | `record.toolUses++`                                  |
| `message_end` (assistant, with usage)       | `addUsage(record.lifetimeUsage, usage)`              |
| `compaction_end` (not aborted, with result) | `record.compactionCount++`, call `options.onCompact` |

These are the exact mutations currently scattered across `startAgent()` and `resume()` callback wrappers.

The returned function unsubscribes from the session.

### UI observer

New module `src/ui/ui-observer.ts`:

```typescript
export function subscribeUIObserver(
  session: AgentSession,
  state: AgentActivity,
  onUpdate?: () => void,
): () => void;
```

Handles six event types — the same events currently translated by `createActivityTracker`'s callbacks:

| Session event                         | State mutation                                      |
| ------------------------------------- | --------------------------------------------------- |
| `tool_execution_start`                | Add to `state.activeTools`                          |
| `tool_execution_end`                  | Remove from `state.activeTools`, `state.toolUses++` |
| `message_start`                       | Reset `state.responseText`                          |
| `message_update` (text_delta)         | Append to `state.responseText`                      |
| `turn_end`                            | `state.turnCount++`                                 |
| `message_end` (assistant, with usage) | `addUsage(state.lifetimeUsage, usage)`              |

Calls `onUpdate?.()` after each mutation (matching current `onStreamUpdate` behavior for foreground rendering).

The returned function unsubscribes from the session.

### SpawnOptions after the change

```typescript
export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  parentSessionFile?: string;
  parentSessionId?: string;
  /** Called when the session is created — the one remaining callback. */
  onSessionCreated?: (session: AgentSession) => void;
}
```

Drops: `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onAssistantUsage`, `onCompaction`.

### RunOptions after the change

```typescript
export interface RunOptions {
  exec: ShellExec;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
  parentSessionFile?: string;
  parentSessionId?: string;
  defaultMaxTurns?: number;
  graceTurns?: number;
  /** Called once after session creation — session delivery mechanism. */
  onSessionCreated?: (session: AgentSession) => void;
}
```

Drops: `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onAssistantUsage`, `onCompaction`.

### ResumeOptions after the change

```typescript
export interface ResumeOptions {
  signal?: AbortSignal;
}
```

Drops: `onToolActivity`, `onAssistantUsage`, `onCompaction`.

### Runner simplification

The runner's big `session.subscribe()` block in `runAgent()` (currently ~50 lines mixing turn-limit enforcement with callback forwarding) simplifies to turn-limit enforcement only (~15 lines):

```typescript
const unsubTurns = session.subscribe((event) => {
  if (event.type === "turn_end") {
    turnCount++;
    if (maxTurns != null) {
      if (!softLimitReached && turnCount >= maxTurns) {
        softLimitReached = true;
        session.steer("...");
      } else if (softLimitReached && turnCount >= maxTurns + grace) {
        aborted = true;
        session.abort();
      }
    }
  }
});
```

`collectResponseText(session)` and `forwardAbortSignal(session, signal)` remain unchanged — they are the runner's own concerns.

`resumeAgent()` drops its conditional event subscription entirely — only `collectResponseText` and `forwardAbortSignal` remain.

### Unsubscription strategy

| Observer            | Subscribe point            | Unsubscribe point            |
| ------------------- | -------------------------- | ---------------------------- |
| Record (startAgent) | `onSessionCreated` handler | `.then()` and `.catch()`     |
| Record (resume)     | Before `runner.resume()`   | `finally` block              |
| UI (foreground)     | `onSessionCreated` handler | After `spawnAndWait` returns |
| UI (background)     | `onSessionCreated` handler | Session disposal on cleanup  |

### createActivityTracker replacement

`createActivityTracker()` in `agent-tool.ts` is replaced by:

1. Inline `AgentActivity` state construction (the state object is simple enough).
2. In the `onSessionCreated` callback: `subscribeUIObserver(session, state, onStreamUpdate)`.

The `callbacks` spread pattern (`...bgCallbacks` / `...fgCallbacks`) disappears entirely.

## Module-Level Changes

### New files

1. `src/record-observer.ts` — `subscribeRecordObserver()` function.
2. `test/record-observer.test.ts` — unit tests with mock session.
3. `src/ui/ui-observer.ts` — `subscribeUIObserver()` function.
4. `test/ui/ui-observer.test.ts` — unit tests with mock session.

### Changed files (source)

1. `src/agent-manager.ts` — Wire record observer in `onSessionCreated`; simplify callback wrappers to pass-through (cycle 3); drop 5 `on*` fields from `SpawnOptions` (cycle 4).
2. `src/tools/agent-tool.ts` — Replace `createActivityTracker` with inline state + `subscribeUIObserver`; drop callback spread from spawn calls (cycle 4).
3. `src/agent-runner.ts` — Drop 5 `on*` fields from `RunOptions`; drop 3 `on*` fields from `ResumeOptions`; simplify `runAgent()` subscription to turn-limit only; remove conditional subscription from `resumeAgent()` (cycle 5).

### Changed files (tests)

1. `test/agent-manager.test.ts` — Upgrade `mockSession()` to support `subscribe()`; update 3 stat-verification tests to emit events through mock session instead of calling callbacks on `RunOptions` (cycle 3).
2. `test/agent-runner.test.ts` — Drop tests for callback forwarding (`onAssistantUsage` wiring, `onCompaction` forwarding); runner tests focus on turn-limit enforcement and session creation (cycle 5).
3. `test/agent-runner-extension-tools.test.ts` — Drop callback-related fields from `RunOptions` mock construction (cycle 5).

### Unchanged files

- `src/service.ts` — public API unchanged (its `SpawnOptions` is a separate type).
- `src/agent-record.ts` — public mutable fields used by observer, no changes needed.
- `src/usage.ts` — `addUsage` helper used by observer, unchanged.
- `src/ui/agent-widget.ts` — `AgentActivity` interface unchanged; widget reads state as before.
- `src/session-config.ts`, `src/context.ts`, `src/env.ts` — unrelated.
- `src/service-adapter.ts` — `AgentManagerLike.spawn` signature unchanged (onSessionCreated is already optional on SpawnOptions).
- `test/tools/agent-tool.test.ts` — tests use mocked `deps.manager` and don't exercise callback wiring; spawn mock shape doesn't change.
- `test/service-adapter.test.ts` — tests mock `AgentManagerLike`, unaffected by internal SpawnOptions changes.

## Test Impact Analysis

### New tests enabled by the extraction

1. `subscribeRecordObserver` tested in isolation with a mock session and real `AgentRecord`.
   Previously impossible — record stat updates were interleaved with callback wrapping inside `startAgent()`.
2. `subscribeUIObserver` tested in isolation with a mock session and `AgentActivity` state object.
   Previously impossible — UI state updates were buried in `createActivityTracker` closures that required a full spawn flow to exercise.

### Existing tests that simplify

1. `agent-manager.test.ts` stat tests — currently simulate callbacks by having the mock runner call `opts.onAssistantUsage?.(...)`.
   After the change, mock runners call `opts.onSessionCreated?.(session)` and tests emit events through the mock session.
   The pattern is more realistic (events drive state, not callbacks).
2. `agent-runner.test.ts` — callback forwarding tests (`onAssistantUsage wiring`, `onCompaction forwarding`) become unnecessary since the runner no longer translates events to callbacks.
   Turn-limit tests remain and simplify (no callback interleaving).

### Existing tests that stay as-is

1. All `agent-manager.test.ts` lifecycle tests (spawn, abort, queue drain, worktree, resume flow) — they verify AgentManager behavior and don't depend on callback wiring.
   Only the mock construction (`mockSession`) gains a `subscribe` method.
2. `agent-record.test.ts` — state-machine transitions are unrelated.
3. `agent-runner-extension-tools.test.ts` — tool filtering tests are unrelated to callbacks.
4. `test/tools/agent-tool.test.ts` — tests mock the manager; spawn/spawnAndWait call shapes don't change from the test's perspective.

## TDD Order

### Phase 1: Extract observers (additive, no breaking changes)

#### Cycle 1: Record observer module

Test surface: `test/record-observer.test.ts` (new).

Tests:

- `tool_execution_end` event increments `record.toolUses`.
- `message_end` (assistant, with usage) accumulates into `record.lifetimeUsage`.
- `compaction_end` (not aborted) increments `record.compactionCount` and calls `onCompact`.
- `compaction_end` with `aborted: true` is ignored.
- Returned function unsubscribes from session.

Source changes:

- `src/record-observer.ts`: `subscribeRecordObserver()` function.

Commit: `feat: add record observer for direct session subscription (#100)`

#### Cycle 2: UI observer module

Test surface: `test/ui/ui-observer.test.ts` (new).

Tests:

- `tool_execution_start` adds to `state.activeTools`, calls `onUpdate`.
- `tool_execution_end` removes from `state.activeTools`, increments `state.toolUses`, calls `onUpdate`.
- `message_start` resets `state.responseText`.
- `message_update` (text_delta) appends to `state.responseText`, calls `onUpdate`.
- `turn_end` increments `state.turnCount`, calls `onUpdate`.
- `message_end` (assistant, with usage) accumulates into `state.lifetimeUsage`, calls `onUpdate`.
- Returned function unsubscribes from session.

Source changes:

- `src/ui/ui-observer.ts`: `subscribeUIObserver()` function.

Commit: `feat: add UI observer for direct session subscription (#100)`

### Phase 2: AgentManager uses record observer

#### Cycle 3: Wire record observer into startAgent and resume

Test surface: `test/agent-manager.test.ts` (updated).

This cycle replaces the record-mutation logic in `startAgent()` and `resume()` callback wrappers with `subscribeRecordObserver`.
The 5 UI callbacks (`onToolActivity` through `onCompaction`) are still accepted on `SpawnOptions` and forwarded to `RunOptions` as pass-through (no wrapping).
They are removed in cycle 4.

Source changes:

- `src/agent-manager.ts`:
  - Import `subscribeRecordObserver`.
  - In `startAgent()`: subscribe record observer inside `onSessionCreated` handler; remove `record.toolUses++` from `onToolActivity` wrapper (pass through `options.onToolActivity`); remove `addUsage` from `onAssistantUsage` wrapper (pass through); remove `record.compactionCount++` from `onCompaction` wrapper (pass through, `this.onCompact` moves to observer's `onCompact` option); capture unsubscribe function, call in `.then()` and `.catch()`.
  - In `resume()`: subscribe record observer to `record.session` before calling `runner.resume()`; drop `onToolActivity`, `onAssistantUsage`, `onCompaction` args from `runner.resume()` call; unsubscribe in `finally` block.

Test changes:

- `test/agent-manager.test.ts`:
  - Upgrade `mockSession()` to support `subscribe()` and provide a test helper `emit()` method.
  - Update the `onAssistantUsage` test: mock runner calls `opts.onSessionCreated?.(session)`, then emits `message_end` events through the mock session.
  - Update the `onCompaction` test: same pattern — emit `compaction_end` events through mock session.
  - Update the `resume()` accumulation test: mock session emits events during `runner.resume()`.

Run: full test suite + `pnpm run check`.

Commit: `refactor: AgentManager subscribes record observer directly (#100)`

### Phase 3: Agent-tool uses UI observer

#### Cycle 4: Replace createActivityTracker with UI observer, drop SpawnOptions callbacks

Test surface: `test/tools/agent-tool.test.ts` (verified unchanged), `test/agent-manager.test.ts` (verified compatible).

This cycle replaces `createActivityTracker` with inline `AgentActivity` state construction and `subscribeUIObserver` subscription via `onSessionCreated`.
`SpawnOptions` drops 5 `on*` fields.

Source changes:

- `src/tools/agent-tool.ts`:
  - Import `subscribeUIObserver` from `../ui/ui-observer.js`.
  - Remove `createActivityTracker` function.
  - Background path: construct `AgentActivity` state inline; pass `onSessionCreated` callback that subscribes UI observer; remove `...bgCallbacks` spread.
  - Foreground path: construct `AgentActivity` state inline; pass `onSessionCreated` callback that subscribes UI observer, registers activity in widget, and captures unsubscribe; remove `...fgCallbacks` spread; call UI unsubscribe after `spawnAndWait` returns.
- `src/agent-manager.ts`:
  - `SpawnOptions`: remove `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onAssistantUsage`, `onCompaction` fields.
  - `startAgent()`: remove pass-through forwarding of the 5 dropped callbacks to `RunOptions`.

Run: full test suite + `pnpm run check`.

Commit: `refactor: agent-tool subscribes UI observer, drop SpawnOptions callbacks (#100)`

### Phase 4: Runner drops callback forwarding

#### Cycle 5: RunOptions and ResumeOptions drop callback fields, runner simplifies

Test surface: `test/agent-runner.test.ts` (updated), `test/agent-runner-extension-tools.test.ts` (updated).

Source changes:

- `src/agent-runner.ts`:
  - `RunOptions`: remove `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onAssistantUsage`, `onCompaction` fields.
  - `ResumeOptions`: remove `onToolActivity`, `onAssistantUsage`, `onCompaction` fields (keep `signal`).
  - `runAgent()`: simplify the big `session.subscribe()` block to turn-limit enforcement only (turn_end → count, steer, abort).
    Remove message_start/message_update/tool_execution_start/tool_execution_end/message_end/compaction_end handling.
  - `resumeAgent()`: remove the conditional `session.subscribe()` block entirely (no callbacks to forward).
    Keep `collectResponseText` and `forwardAbortSignal`.
  - Remove `ToolActivity` export if no longer needed externally (check consumers).

Test changes:

- `test/agent-runner.test.ts`:
  - Remove or simplify callback forwarding tests (onAssistantUsage wiring, onCompaction forwarding, tool activity forwarding).
  - Turn-limit tests remain, with simplified setup (no callback expectations).
  - `runAgent()` call sites drop the 5 callback fields.
- `test/agent-runner-extension-tools.test.ts`:
  - Drop callback-related fields from `runAgent()` call construction.

Run: full test suite + `pnpm run check`.

Commit: `refactor: RunOptions and ResumeOptions drop callback fields (#100)`

## Risks and Mitigations

| Risk                                                                                | Mitigation                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Double-counting during transition (old callbacks + new observer both update record) | Cycle 3 replaces record mutations atomically — old wrappers become pass-through in the same commit that adds the observer |
| Mock session complexity increases (need `subscribe` + `emit` helper)                | One-time investment; upgrade `mockSession()` once, reused across all tests; more realistic than simulating callbacks      |
| Event ordering between record observer and UI observer                              | Observers update independent state (record vs AgentActivity); no cross-dependency, ordering irrelevant                    |
| `ToolActivity` type used outside this package                                       | Grep before removing; if used, keep the export and add a deprecation note                                                 |
| `createActivityTracker` exported but unused externally                              | Verified: only used within `agent-tool.ts`; safe to remove                                                                |
| Turn-limit enforcement mixed with callback subscription in runner                   | Cycle 5 extracts turn-limit into its own subscription cleanly; `collectResponseText` stays separate                       |
| Unsubscription missed on error paths                                                | Record observer unsubscribe captured in closure, called in both `.then()` and `.catch()`; resume uses `finally`           |

## Open Questions

- Whether to extract turn-limit enforcement from the runner into a separate `turn-limiter.ts` module.
  This would improve testability but is orthogonal to callback elimination.
  Deferred — the runner's subscription simplifies enough in cycle 5.
- Whether `ResumeOptions` should be renamed or inlined since it reduces to `{ signal?: AbortSignal }`.
  Keeping it as a named type is fine for extensibility.
  Deferred — cosmetic, can be done anytime.
- Whether to introduce a `SessionLike` interface for the mock session pattern used in `record-observer.test.ts` and `ui-observer.test.ts`.
  Both tests need a minimal session with `subscribe()`.
  If the pattern proves reusable, extract it; otherwise keep the inline mock.
