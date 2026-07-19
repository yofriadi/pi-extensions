---
issue: 115
issue_title: "refactor(pi-subagents): decompose agent-tool.ts into foreground/background modules"
---

# Decompose agent-tool.ts into foreground/background modules

## Problem Statement

`tools/agent-tool.ts` is the largest file in the package at 579 lines.
The `execute` function handles three distinct execution paths — resume, background spawn, and foreground streaming — each with different dependencies.
Before those paths can be cleanly extracted, two upstream API gaps force the tool to work around the manager:

1. The foreground `onSessionCreated` callback loops through `manager.listAgents()` matching by session object just to discover the agent's ID — because `onSessionCreated` only receives the session, not the record.
2. The background path mutates `record.notification` after spawn — reaching into the record returned by `getRecord()` to attach a `NotificationState` — because the manager has no way to wire notification state at spawn time.

These workarounds would simply move into the extracted modules unchanged.
Fixing the API gaps first makes the extraction clean: each extracted module receives what it actually needs from the manager, without reaching through or reverse-searching.

## Goals

- Widen `onSessionCreated` to `(session, record)` so callers receive the agent ID and record directly.
- Accept `toolCallId` in `AgentSpawnConfig` so the manager wires `record.notification` internally for background agents.
- Extract the foreground execution loop into `tools/foreground-runner.ts`.
- Extract the background spawn path into `tools/background-spawner.ts`.
- Move `getStatusNote` and `buildDetails` to `tools/helpers.ts`.
- Keep `agent-tool.ts` as the orchestrator (~250 lines): tool definition, parameter validation, shared setup, dispatch, resume.
- Preserve all existing behavior.

## Non-Goals

- Extracting the resume path (~27 lines) — too small to warrant a separate file.
- Extracting `renderCall`/`renderResult` — tightly coupled to the tool definition.
- Changing `AgentToolDeps` shape — #114 already narrowed it.
- Removing `onSessionCreated` from `AgentSpawnConfig` entirely — it is still useful for UI observer wiring that the manager should not own.

## Background

### Prerequisite status

| Issue | Title                                      | Status  |
| ----- | ------------------------------------------ | ------- |
| #114  | Narrow `AgentToolDeps` and `AgentMenuDeps` | ✅ Done |

### Current API gaps

#### Gap 1: foreground ID discovery

The foreground path needs the agent ID *during* execution (inside `onSessionCreated`, before `spawnAndWait` resolves) to register the activity tracker in the widget.
The manager's internal `onSessionCreated` handler already has `id` and `record` in scope but passes only `session` to the caller's callback.
The tool works around this by iterating `listAgents()` and matching by session identity:

```typescript
onSessionCreated: (session) => {
  for (const a of deps.manager.listAgents()) {
    if (a.execution?.session === session) {
      fgId = a.id;
      deps.agentActivity.set(a.id, fgState);
      // ...
    }
  }
}
```

This is a violation of Tell-Don't-Ask: the tool asks the manager for data it already has.

#### Gap 2: post-spawn notification mutation

The background path calls `manager.spawn()`, then immediately calls `manager.getRecord(id)` to mutate `record.notification`:

```typescript
const id = deps.manager.spawn(ctx, subagentType, prompt, { ... });
const record = deps.manager.getRecord(id);
if (record) {
  record.notification = new NotificationState(toolCallId);
}
```

This is an output argument — the tool writes back into a record it doesn't own.
The notification could be wired at spawn time if the manager accepted a `toolCallId`.

### Relevant design principles

- **Tell-Don't-Ask** (code-design skill): the `listAgents()` loop asks the manager for data it already has.
- **Output arguments** (code-design skill): writing `record.notification` after spawn mutates an object owned by the manager.
- **SRP**: foreground streaming and background spawning are independent concerns.
- **One concern per file** (AGENTS.md): the file mixes orchestration, streaming, spawning, and formatting.

## Design Overview

### Phase 1: Fix manager API gaps

#### Widen `onSessionCreated` to include record

Change the callback signature in both `AgentSpawnConfig` and the runner's `RunOptions`:

```typescript
// agent-manager.ts — AgentSpawnConfig
onSessionCreated?: (session: AgentSession, record: AgentRecord) => void;
```

The manager's internal handler already has `record` in scope — pass it through:

```typescript
// In startAgent(), existing line:
options.onSessionCreated?.(session);
// Becomes:
options.onSessionCreated?.(session, record);
```

The runner's `onSessionCreated` stays `(session: AgentSession) => void` — it doesn't know about records.
The manager wraps the runner callback and adds `record` before forwarding to the caller.

This lets the foreground tool callback access `record.id` directly, eliminating the `listAgents()` loop.

#### Accept `toolCallId` in `AgentSpawnConfig`

Add an optional `toolCallId` field to `AgentSpawnConfig`:

```typescript
export interface AgentSpawnConfig {
  // ... existing fields ...
  /** Tool call ID for background notification wiring. When set, spawn attaches NotificationState. */
  toolCallId?: string;
}
```

In `AgentManager.spawn()`, after creating the record:

```typescript
if (options.toolCallId) {
  record.notification = new NotificationState(options.toolCallId);
}
```

This moves the notification wiring into the manager, eliminating the post-spawn mutation in the tool.

### Phase 2: Extract modules

With the API gaps fixed, the extracted modules no longer need `listAgents` or `getRecord` or post-spawn record mutation.

#### Foreground runner

After the `onSessionCreated` widening, the foreground callback simplifies to:

```typescript
onSessionCreated: (session, record) => {
  fgState.setSession(session);
  unsubUI = subscribeUIObserver(session, fgState, streamUpdate);
  fgId = record.id;
  deps.agentActivity.set(record.id, fgState);
  deps.widget.ensureTimer();
}
```

The `runForeground` function receives narrow deps:

```typescript
export interface ForegroundDeps {
  manager: { spawnAndWait: AgentToolManager["spawnAndWait"] };
  widget: { ensureTimer(): void; markFinished(id: string): void };
  agentActivity: AgentActivityAccess;
}
```

No `listAgents` needed — the record is delivered by the callback.

#### Background spawner

After the `toolCallId` change, the background path simplifies to:

```typescript
const id = deps.manager.spawn(ctx, subagentType, prompt, {
  ...spawnConfig,
  toolCallId,
});
// No getRecord + mutation needed — notification already wired
```

The `spawnBackground` function receives narrow deps:

```typescript
export interface BackgroundDeps {
  manager: { spawn: AgentToolManager["spawn"]; getRecord: AgentToolManager["getRecord"]; getMaxConcurrent: AgentToolManager["getMaxConcurrent"] };
  widget: { ensureTimer(): void; update(): void };
  agentActivity: AgentActivityAccess;
}
```

`getRecord` is still needed for building the result message (checking `status`, `execution.outputFile`), but not for mutation.

#### What stays in agent-tool.ts

- `AgentToolDeps`, `AgentToolManager`, `AgentToolWidget`, `AgentActivityAccess` interfaces.
- `createAgentTool` factory: tool name/label/description, parameters schema, `renderCall`, `renderResult`.
- Execute's shared setup: registry reload, type resolution, model resolution, config assembly, detail base.
- Resume path (~27 lines).
- Dispatch to `spawnBackground()` or `runForeground()`.

#### Helpers relocation

`getStatusNote` and `buildDetails` move to `tools/helpers.ts`.
Both are pure formatting functions with no dependency on `AgentToolDeps`.

### Post-extraction file sizes (estimated)

| File                    | Lines          |
| ----------------------- | -------------- |
| `agent-tool.ts`         | ~250 (was 579) |
| `foreground-runner.ts`  | ~110           |
| `background-spawner.ts` | ~70            |
| `helpers.ts` additions  | ~50            |

## Module-Level Changes

### Modified files

1. **`src/agent-manager.ts`**
   - Change `onSessionCreated` in `AgentSpawnConfig` to `(session: AgentSession, record: AgentRecord) => void`.
   - Pass `record` as second argument in `startAgent`'s internal `onSessionCreated` call.
   - Add optional `toolCallId?: string` to `AgentSpawnConfig`.
   - Wire `record.notification = new NotificationState(options.toolCallId)` in `spawn()` when present.
   - Add `NotificationState` import.

2. **`src/tools/agent-tool.ts`**
   - Update `onSessionCreated` callbacks to accept `(session, record)`.
   - Remove `listAgents()` loop in foreground callback — use `record.id` directly.
   - Pass `toolCallId` in background spawn config — remove post-spawn `getRecord` + mutation.
   - Remove foreground block → `runForeground()` call.
   - Remove background block → `spawnBackground()` call.
   - Remove `getStatusNote`, `buildDetails` → imported from `helpers.ts`.
   - Remove `listAgents` from `AgentToolManager` interface (no longer needed).
   - Remove unused imports: `NotificationState`, `describeActivity`, `SPINNER`, `formatMs`.

3. **`src/tools/helpers.ts`**
   - Add `getStatusNote()` and `buildDetails()` (relocated from `agent-tool.ts`).

### New files

4. **`src/tools/foreground-runner.ts`**
   - `ForegroundDeps` interface, `runForeground()` function.
   - Owns: spinner interval, `AgentActivityTracker` creation, `subscribeUIObserver`, streaming `onUpdate`, cleanup, result formatting via `buildDetails`/`getStatusNote`.

5. **`src/tools/background-spawner.ts`**
   - `BackgroundDeps` interface, `spawnBackground()` function.
   - Owns: `AgentActivityTracker` creation, `subscribeUIObserver`, activity map registration, widget update, launch message formatting.

### Test files

6. **`test/agent-manager.test.ts`**
   - Update mock runner calls to pass `record` in `onSessionCreated`.
   - Add test: `spawn` wires `NotificationState` when `toolCallId` is provided.
   - Add test: `spawn` does not wire `NotificationState` when `toolCallId` is absent.

7. **`test/tools/agent-tool.test.ts`**
   - Update `onSessionCreated` mock signatures if needed (structural — tests call through `execute`).
   - Existing tests remain as integration tests for the dispatch path.

8. **`test/tools/helpers.test.ts`** (new or extended)
   - Unit tests for `getStatusNote` (all status branches) and `buildDetails`.

9. **`test/tools/foreground-runner.test.ts`** (new)
   - Spinner lifecycle, streaming updates, cleanup on success/error, result formatting, fallback note.

10. **`test/tools/background-spawner.test.ts`** (new)
    - Activity tracker registered, widget updated, queued message, launch message format.

## Test Impact Analysis

1. **New unit tests enabled:**
   - `foreground-runner.test.ts` tests spinner lifecycle and streaming with narrow mocks (no full `AgentToolDeps`).
   - `background-spawner.test.ts` tests activity registration and message formatting in isolation.
   - `helpers.test.ts` tests `getStatusNote` and `buildDetails` as pure functions.
   - `agent-manager.test.ts` tests notification wiring at the manager level — moved from tool-level integration.

2. **Existing tests that simplify:**
   - `agent-tool.test.ts` background tests no longer need to verify notification wiring (now the manager's job).
   - The "registers activity in agentActivity map" test stays but becomes a dispatch-level integration test.

3. **Existing tests that must stay:**
   - All `agent-tool.test.ts` tests exercise the full dispatch path and remain valuable as integration tests.
   - All `agent-manager.test.ts` tests that fire `onSessionCreated` must update the mock signature to `(session, record)`.

## TDD Order

1. **Widen `onSessionCreated` callback to include record.**
   Change `AgentSpawnConfig.onSessionCreated` signature to `(session, record)`.
   Update `startAgent` to pass `record` as second argument.
   Update `agent-tool.ts` foreground callback to use `record.id` instead of `listAgents()` loop.
   Remove `listAgents` from `AgentToolManager` interface.
   Update `agent-manager.test.ts` mock runner calls.
   Test: verify foreground callback receives `record.id` (existing integration tests pass).
   Commit: `refactor: widen onSessionCreated to include record`

2. **Accept `toolCallId` in `AgentSpawnConfig`.**
   Add `toolCallId?: string` to `AgentSpawnConfig`.
   Wire `NotificationState` in `spawn()` when `toolCallId` is provided.
   Update `agent-tool.ts` background path to pass `toolCallId` instead of post-spawn mutation.
   Test: `agent-manager.test.ts` — `spawn` wires notification when `toolCallId` present, skips when absent.
   Commit: `refactor: wire NotificationState at spawn time via toolCallId`

3. **Relocate `getStatusNote` and `buildDetails` to `tools/helpers.ts`.**
   Move both functions.
   Update imports in `agent-tool.ts`.
   Test: unit tests for `getStatusNote` (all branches) and `buildDetails`.
   Commit: `refactor: move getStatusNote and buildDetails to tools/helpers`

4. **Extract `spawnBackground` into `tools/background-spawner.ts`.**
   Define `BackgroundDeps` interface and `spawnBackground()` function.
   Replace background block in `execute` with a call to `spawnBackground()`.
   Remove unused imports from `agent-tool.ts`.
   Test: `background-spawner.test.ts` — activity registration, widget update, launch message.
   Commit: `refactor: extract background spawn to tools/background-spawner`

5. **Extract `runForeground` into `tools/foreground-runner.ts`.**
   Define `ForegroundDeps` interface and `runForeground()` function.
   Replace foreground block in `execute` with a call to `runForeground()`.
   Remove unused imports from `agent-tool.ts`.
   Test: `foreground-runner.test.ts` — spinner lifecycle, streaming, cleanup, result formatting.
   Commit: `refactor: extract foreground execution to tools/foreground-runner`

6. **Verify integration.**
   Run full test suite and `pnpm run check`.
   Commit: `test: verify agent-tool decomposition integration`

## Risks and Mitigations

| Risk                                                                                           | Mitigation                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widening `onSessionCreated` signature is a breaking change to `AgentSpawnConfig`               | `AgentSpawnConfig` is internal (not in package `exports`). The only external caller is `agent-tool.ts`. All test mocks update in the same step.                                                                         |
| `toolCallId` on `AgentSpawnConfig` couples the manager to notification concerns                | The manager already owns the record lifecycle. `NotificationState` is a record collaborator like `execution` and `worktreeState` — the manager already wires those. `toolCallId` is a data-in, not a behavior coupling. |
| Runner's `onSessionCreated` signature stays `(session)` while manager's is `(session, record)` | The manager wraps the runner's callback — the runner never sees the record. No change to runner interface.                                                                                                              |
| Circular imports between new modules and `helpers.ts`                                          | `helpers.ts` is a leaf module. The new modules import from it but it imports nothing from them.                                                                                                                         |

## Open Questions

None — the design is unambiguous after resolving the two API gaps.
