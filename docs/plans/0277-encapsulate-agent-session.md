---
issue: 277
issue_title: "Encapsulate AgentSession behind SubagentSession; retire the remaining agent.session reach-throughs"
---

# Encapsulate AgentSession behind SubagentSession

## Problem Statement

Callers outside the `lifecycle/` domain reach through `Agent.session` (which returns the raw SDK `AgentSession` via `this.subagentSession?.session`) and operate on the session object directly.
This violates Law of Demeter and Tell-Don't-Ask — the missing abstractions are intent-revealing methods on `Agent` and `SubagentSession` that delegate internally.

Issue #265 introduced `SubagentSession` and routed the run/resume/dispose path through it.
The remaining consumer-facing reach-throughs were deferred to this issue.

## Goals

- Add intent-revealing methods to `Agent` and `SubagentSession` that replace every raw `AgentSession` access outside `lifecycle/`.
- Collapse the duplicated steer buffer-or-deliver logic into a single `Agent.steer()` method.
- Narrow the `onSessionCreated` observer callback to stop delivering the raw `AgentSession` to spawners.
- Remove the `Agent.session` getter.
- After this change, no production module outside `lifecycle/` references the raw `AgentSession`.

## Non-Goals

- The `Agent` → `Subagent` class rename — independent of this issue, can land in either order.
- Changing the public `SubagentsService` API surface in `service/service.ts` — it already uses `SubagentRecord` (no live session objects).
- Refactoring the conversation viewer's rich-rendering internals — only its session reference changes.
- Architecture doc updates for the file-layout listing — `SubagentSession` and `Agent` files are not being added, moved, or removed.

## Background

### Affected reach-through sites

Every site reaches the raw `AgentSession` exposed by the `Agent.session` getter.

| Reach-through                          | Production files                                                                                                           | Current pattern                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Steer buffer-or-deliver (duplicated)   | `service/service-adapter.ts:93`, `tools/steer-tool.ts:43`                                                                  | `record.session` → `session.steer()` or `record.queueSteer()`                                                 |
| Context-percent stats                  | `tools/get-result-tool.ts:56`, `tools/steer-tool.ts:57`, `observation/notification.ts:49`, `ui/conversation-viewer.ts:145` | `getSessionContextPercent(record.session)`                                                                    |
| Conversation viewing                   | `tools/get-result-tool.ts:83-84`, `ui/agent-menu.ts:255`, `ui/conversation-viewer.ts:63,223`                               | `getAgentConversation(record.session)` / `session.messages`                                                   |
| Session-readiness guard                | `tools/agent-tool.ts:111`, `lifecycle/agent-manager.ts:205`                                                                | `!record.session` / `!agent?.session`                                                                         |
| Observer callback delivers raw session | `tools/background-spawner.ts:56`, `tools/foreground-runner.ts:111`                                                         | `onSessionCreated(_agent, session)` → `tracker.setSession(session)` + `subscribeUIObserver(session, tracker)` |
| Activity-tracker session stats         | `ui/widget-renderer.ts:106`                                                                                                | `activity?.session` → `getSessionContextPercent(activity.session)` (via `AgentActivityTracker.session`)       |

### Existing delegate methods

`SubagentSession` already has `steer(message)`, `runTurnLoop()`, `resumeTurnLoop()`, and `dispose()`.
The `session` getter is marked "retired by #277" in its JSDoc.

`subscribeAgentObserver` in `observation/record-observer.ts` already accepts `SubscribableSession` (not `AgentSession`), so it can accept `SubagentSession` directly once `SubagentSession` implements the `subscribe()` delegate.

### Public API surface

The public API (`SubagentsService` + `SubagentRecord` in `service/service.ts`) does not expose `Agent` or `AgentSession`.
Removing `Agent.session` is not a breaking change for cross-extension consumers.

## Design Overview

### New delegate methods on `SubagentSession`

```typescript
// Delegates to getAgentConversation(this._session)
getConversation(): string

// Delegates to getSessionContextPercent(this._session)
getContextPercent(): number | null

// Delegates to this._session.subscribe(fn) — satisfies SubscribableSession
subscribe(fn: (event: AgentSessionEvent) => void): () => void

// Delegates to this._session.getSessionStats() — satisfies SessionLike
getSessionStats(): SessionStatsLike

// Delegates to this._session.messages
get messages(): readonly unknown[]
```

With `subscribe()` and `getSessionStats()`, `SubagentSession` structurally satisfies both `SubscribableSession` and `SessionLike`.
This lets spawners pass a `SubagentSession` directly to `subscribeUIObserver()` and `tracker.setSession()` without exposing the raw `AgentSession`.

### New intent-revealing methods on `Agent`

```typescript
// Buffer-or-deliver: returns true if delivered, false if buffered
async steer(message: string): Promise<boolean>

// Returns true when a SubagentSession is available
isSessionReady(): boolean

// Delegates to SubagentSession.getConversation(), returns undefined if no session
getConversation(): string | undefined

// Delegates to SubagentSession.getContextPercent(), returns null if no session
getContextPercent(): number | null

// Delegates to SubagentSession.subscribe() for conversation-viewer live updates
subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined

// Delegates to SubagentSession.messages for conversation-viewer rendering
get messages(): readonly unknown[]
```

The `steer()` method replaces the duplicated buffer-or-deliver logic:

```typescript
async steer(message: string): Promise<boolean> {
  if (!this.subagentSession) {
    this.queueSteer(message);
    return false;
  }
  await this.subagentSession.steer(message);
  return true;
}
```

### Observer callback narrowing

`AgentLifecycleObserver.onSessionCreated` changes from `(agent: Agent, session: AgentSession)` to `(agent: Agent)`.
Spawners access `agent.subagentSession!` (already public) which satisfies `SubscribableSession & SessionLike`:

```typescript
// tools/background-spawner.ts — after
onSessionCreated: (agent) => {
  const sub = agent.subagentSession!;
  bgState.setSession(sub);         // SubagentSession satisfies SessionLike
  subscribeUIObserver(sub, bgState); // SubagentSession satisfies SubscribableSession
},
```

### Internal lifecycle wiring

`Agent.run()` already passes the session to `subscribeAgentObserver()`, which accepts `SubscribableSession`.
After the change, it passes `this.subagentSession` directly instead of `this.subagentSession.session`:

```typescript
// lifecycle/agent.ts — Agent.run(), after
this.attachObserver(subscribeAgentObserver(this.subagentSession, this, { ... }));
this.observer?.onSessionCreated?.(this);
```

### Removals

- `Agent.session` getter — removed entirely.
- `SubagentSession.session` getter — marked `@internal`, kept for lifecycle-internal uses (the `getLastAssistantText()` private helper reads `this._session.messages`).
- `Agent.queueSteer()` — becomes private (called only from `Agent.steer()` and `Agent.flushPendingSteers()`).
- `Agent.flushPendingSteers()` — becomes private (called only from `Agent.run()`).

## Module-Level Changes

### `src/lifecycle/subagent-session.ts`

- Add `getConversation()`, `getContextPercent()`, `subscribe()`, `getSessionStats()`, `messages` getter.
- Import `getAgentConversation` from `#src/session/conversation` and `getSessionContextPercent`, `SessionStatsLike` from `#src/lifecycle/usage`.
- Mark the `session` getter with `@internal` JSDoc.

### `src/lifecycle/agent.ts`

- Add `steer()`, `isSessionReady()`, `getConversation()`, `getContextPercent()`, `subscribeToUpdates()`, `messages` getter.
- Remove the `session` getter.
- Make `queueSteer()` and `flushPendingSteers()` private.
- In `run()`: pass `this.subagentSession` (not `this.subagentSession.session`) to `subscribeAgentObserver()` and fire `onSessionCreated(this)` without the session param.
- In `resume()`: pass `subagentSession` (not `subagentSession.session`) to `subscribeAgentObserver()`.
- Remove the `AgentSession` import.
- Update `AgentLifecycleObserver.onSessionCreated` to `(agent: Agent)` — no session param.

### `src/service/service-adapter.ts`

- Replace the 6-line steer reach-through with `await record.steer(message)`.
- Remove the `!session` guard — `Agent.steer()` owns it.

### `src/tools/steer-tool.ts`

- Replace the buffer-or-deliver dance with `const delivered = await record.steer(message)`.
- Use `record.getContextPercent()` instead of `getSessionContextPercent(session)`.
- Remove the `getSessionContextPercent` import.

### `src/tools/get-result-tool.ts`

- Use `record.getContextPercent()` instead of `getSessionContextPercent(record.session)`.
- Use `record.getConversation()` instead of `getAgentConversation(record.session)`.
- Remove the `getSessionContextPercent` and `getAgentConversation` imports.

### `src/tools/agent-tool.ts`

- Use `existing.isSessionReady()` instead of `!existing.session`.

### `src/lifecycle/agent-manager.ts`

- Use `agent.isSessionReady()` instead of `agent?.session`.
- Update the `onSessionCreated` relay to `(agent) => options.observer!.onSessionCreated!(agent)` — no session param.

### `src/observation/notification.ts`

- Use `record.getContextPercent()` instead of `getSessionContextPercent(record.session)`.
- Remove the `getSessionContextPercent` import.

### `src/ui/conversation-viewer.ts`

- Remove `session: AgentSession` from `ConversationViewerOptions`.
- Remove the `private session: AgentSession` field.
- Use `this.record.subscribeToUpdates(() => ...)` instead of `session.subscribe(...)`.
- Use `this.record.messages` instead of `this.session.messages`.
- Use `this.record.getContextPercent()` instead of `getSessionContextPercent(this.record.session)`.
- Remove the `AgentSession` and `getSessionContextPercent` imports.

### `src/ui/agent-menu.ts`

- Use `record.isSessionReady()` instead of `record.session` check.
- Remove the `session` variable and stop passing it to `ConversationViewer`.

### `src/tools/background-spawner.ts`

- Update `onSessionCreated` callback: `(agent) => { const sub = agent.subagentSession!; ... }`.
- Pass `sub` instead of `session` to `bgState.setSession()` and `subscribeUIObserver()`.

### `src/tools/foreground-runner.ts`

- Same pattern as `background-spawner.ts`.

### `test/helpers/mock-session.ts`

- Update `createSubagentSessionStub` to include the new delegate methods (`getConversation`, `getContextPercent`, `subscribe`, `getSessionStats`, `messages`).
- The stub's `subscribe` can delegate to the underlying mock session's `subscribe`.

### Test files requiring updates

- `test/lifecycle/subagent-session.test.ts` — add tests for new delegate methods.
- `test/lifecycle/agent.test.ts` — add tests for `steer()`, `isSessionReady()`, `getConversation()`, `getContextPercent()`; update `queueSteer` and `flushPendingSteers` tests (now private, tested through `steer()`); update `session` getter tests to `isSessionReady()`.
- `test/service/service-adapter.test.ts` — update steer tests (no more session reach-through).
- `test/tools/steer-tool.test.ts` — update to use `Agent.steer()` semantics.
- `test/tools/get-result-tool.test.ts` — update context-percent and conversation assertions.
- `test/tools/agent-tool.test.ts` — update resume guard to use `isSessionReady()`.
- `test/tools/background-spawner.test.ts` — update `onSessionCreated` callback assertions.
- `test/tools/foreground-runner.test.ts` — update `onSessionCreated` callback assertions.
- `test/observation/notification.test.ts` — update context-percent assertions.
- `test/conversation-viewer.test.ts` — remove `session` from viewer options, update to use `record` methods.
- `test/ui/agent-menu.test.ts` — update session guard assertions.
- `test/lifecycle/agent-manager.test.ts` — update resume guard + observer relay tests.

## Test Impact Analysis

1. **New unit tests enabled:** Direct testing of `SubagentSession.getConversation()`, `getContextPercent()`, `subscribe()`, `getSessionStats()`, `messages` — these were previously only testable by reaching through the raw session.
   Direct testing of `Agent.steer()` buffer-or-deliver logic — previously scattered across consumer tests.
2. **Existing tests that become simpler:** `steer-tool.test.ts` and `service-adapter.test.ts` no longer need to set up the session-present/session-absent dance — they test through `Agent.steer()`.
   `get-result-tool.test.ts` no longer needs mock sessions for context-percent assertions.
3. **Existing tests that stay as-is:** `SubagentSession.runTurnLoop()` and `resumeTurnLoop()` tests — they exercise turn driving, which is unrelated.
   `Agent.run()` integration tests — they verify the full lifecycle including observer wiring.

## TDD Order

1. Add delegate methods to `SubagentSession` (`getConversation`, `getContextPercent`, `subscribe`, `getSessionStats`, `messages`).
   Update `createSubagentSessionStub` test helper to include the new methods.
   Test: unit tests for each delegate method in `subagent-session.test.ts`.
   Commit: `feat: add delegate methods to SubagentSession for session encapsulation (#277)`.

2. Add intent-revealing methods to `Agent` (`steer`, `isSessionReady`, `getConversation`, `getContextPercent`, `subscribeToUpdates`, `messages`).
   Test: unit tests for each method in `agent.test.ts`.
   Commit: `feat: add session-encapsulation methods to Agent (#277)`.

3. Migrate steer callers: replace the buffer-or-deliver reach-through in `service-adapter.ts` and `steer-tool.ts` with `record.steer()`.
   Replace `getSessionContextPercent(session)` in `steer-tool.ts` with `record.getContextPercent()`.
   Make `queueSteer()` and `flushPendingSteers()` private on `Agent`.
   Update tests in `service-adapter.test.ts`, `steer-tool.test.ts`, `agent.test.ts` (the `queueSteer`/`flushPendingSteers` tests become tests for `Agent.steer()`; existing tests from step 2 may cover this).
   Commit: `refactor: use Agent.steer for buffer-or-deliver (#277)`.

4. Migrate context-percent, conversation, and readiness callers: `get-result-tool.ts`, `agent-tool.ts`, `agent-manager.ts`, `notification.ts`.
   Update corresponding test files.
   Commit: `refactor: replace session reach-throughs in tools and observation (#277)`.

5. Refactor conversation viewer and agent-menu: remove `session: AgentSession` from `ConversationViewerOptions`, use `record` methods for subscribe/messages/contextPercent.
   Update `conversation-viewer.test.ts` and `agent-menu.test.ts`.
   Commit: `refactor: remove raw session from conversation viewer (#277)`.

6. Narrow `onSessionCreated` callback: change `AgentLifecycleObserver.onSessionCreated` to `(agent: Agent)` — no session param.
   Update `Agent.run()` and `Agent.resume()` to pass `SubagentSession` (not raw session) to `subscribeAgentObserver`.
   Update spawners (`background-spawner.ts`, `foreground-runner.ts`) and `agent-manager.ts` relay.
   Update corresponding test files.
   Commit: `refactor: narrow onSessionCreated to hide raw AgentSession (#277)`.

7. Remove `Agent.session` getter.
   Mark `SubagentSession.session` getter as `@internal`.
   Remove `AgentSession` import from `agent.ts`.
   Update any remaining tests that reference `Agent.session` (use `agent.isSessionReady()` or `agent.subagentSession`).
   Verify with `pnpm run check` and `pnpm -r run test`.
   Commit: `refactor: remove Agent.session getter (#277)`.

8. Update the architecture doc's "Session encapsulation debt" section to reflect completion.
   Commit: `docs: mark session encapsulation debt resolved (#277)`.

## Risks and Mitigations

| Risk                                                                                          | Mitigation                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubagentSession` might not structurally satisfy `SubscribableSession` or `SessionLike`       | Verify with `pnpm run check` after step 1 — the delegate methods must match the expected signatures exactly.                                                               |
| Making `queueSteer`/`flushPendingSteers` private breaks tests                                 | Step 3 explicitly migrates those tests to exercise `Agent.steer()` instead.                                                                                                |
| The conversation viewer's `messages` accessor returns `readonly unknown[]` which loses typing | The viewer already casts messages to `{ role: string; [key: string]: unknown }` — the cast is unchanged, and the viewer's rendering is unaffected.                         |
| Narrowing `onSessionCreated` could break the `agent-manager.ts` relay's non-null assertion    | The relay checks `options.observer?.onSessionCreated` before wiring — the narrowed signature is structurally compatible; the only change is dropping the second parameter. |
| Large number of test files to update                                                          | Steps 3–6 group migrations by concern (steer, stats/conversation/readiness, viewer, observer) so each commit is self-contained and reviewable.                             |

## Open Questions

- None — the issue's proposed methods are unambiguous and the acceptance criteria are clear.
  The only design addition beyond the issue is narrowing `onSessionCreated` and adding `messages`/`subscribeToUpdates` for the conversation viewer, both of which are required to satisfy the "no production module outside lifecycle/ references AgentSession" acceptance criterion.
