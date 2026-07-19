---
issue: 54
issue_title: "refactor: decompose src/index.ts into tool + menu modules"
---

# Decompose index.ts into tool and menu modules

## Problem Statement

`src/index.ts` is 1,619 lines — the single largest file in the codebase.
It currently holds the extension entrypoint, all three tool definitions (with full execute callbacks and render functions), the custom message renderer, the entire `/agents` interactive menu with all sub-menus, the notification/nudge system, widget and lifecycle wiring, and ~130 lines of helper functions.
None of this code is independently testable — it is all nested inside a single default export closure.

## Goals

- Extract each tool definition into its own module under `src/tools/`.
- Extract the `/agents` menu and all sub-handlers into `src/ui/agent-menu.ts`.
- Extract the notification message renderer into `src/renderer.ts`.
- Extract the completion notification system into `src/notification.ts`.
- Extract shared pure helpers into `src/tools/helpers.ts`.
- Reduce `index.ts` to a thin wire-up (~120–150 lines) that imports and assembles pieces.
- Enable unit testing of each extracted module via narrow dependency interfaces.
- No behavior change — pure extraction refactoring.

## Non-Goals

- Refactoring `agent-manager.ts`, `agent-runner.ts`, or other already-separate modules.
- Adding new features or changing tool behavior.
- Writing exhaustive test suites for every extracted module — establish foundational coverage, not completeness.
- Changing any public API surface (`service.ts` exports, `SubagentsService` interface).

## Background

### Current structure

Everything lives inside one `export default function (pi: ExtensionAPI)` closure.
State (`agentActivity`, `pendingNudges`, `widget`, `manager`, `currentCtx`) is declared as closure variables.
Helper functions, tool definitions, menu handlers, and lifecycle hooks are all defined in the same scope.
The only existing test files cover modules that were already separate (`agent-manager.test.ts`, `agent-runner.test.ts`, etc.) — there is no `index.test.ts`.

### Architecture reference

The SKILL's module dependency graph already shows `tools` and `ui/` as conceptual sub-trees under `index.ts`:

```text
index.ts ──wires──> agent-manager.ts
    ├── tools (Agent, get_subagent_result, steer_subagent)
    ├── ui/
    │   ├── agent-widget.ts
    │   └── conversation-viewer.ts
    └── ...
```

This plan makes that conceptual structure physical.

### Relevant constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Prefer small, reversible changes.
- Keep Pi SDK imports out of business-logic modules — tool modules are at the SDK boundary and may import SDK types; pure helpers must not.
- Narrow interfaces per consumer — do not pass a shared dependency bag when a function only uses a subset.

### Helper usage trace

Traced every helper function in `index.ts` to determine where it belongs:

| Helper                     | Used by                                                   | Destination           |
| -------------------------- | --------------------------------------------------------- | --------------------- |
| `textResult`               | All three tools                                           | `tools/helpers.ts`    |
| `formatLifetimeTokens`     | All three tools + completion callback                     | `tools/helpers.ts`    |
| `getModelLabelFromConfig`  | `buildTypeListText` (agent tool) + `getModelLabel` (menu) | `tools/helpers.ts`    |
| `createActivityTracker`    | Agent tool execute (foreground + background)              | `tools/agent-tool.ts` |
| `buildDetails`             | Agent tool execute                                        | `tools/agent-tool.ts` |
| `getStatusNote`            | Agent tool execute                                        | `tools/agent-tool.ts` |
| `escapeXml`                | `formatTaskNotification`                                  | `notification.ts`     |
| `getStatusLabel`           | `formatTaskNotification`                                  | `notification.ts`     |
| `formatTaskNotification`   | `emitIndividualNudge`                                     | `notification.ts`     |
| `buildNotificationDetails` | `emitIndividualNudge`                                     | `notification.ts`     |
| `buildEventData`           | Completion callback                                       | `notification.ts`     |

## Design Overview

### Extraction strategy

Each module exports a **factory function** that receives narrow dependencies and returns the tool definition, handler, or system object.
This follows the established pattern in the codebase (`createSubagentsService` in `service-adapter.ts` already uses this approach).
Factory functions keep state scoped to the instance (matching the current closure scope) and make dependencies explicit for testing.

### New module tree

```text
src/
├── index.ts               ← thin wire-up (~120-150 lines)
├── renderer.ts            ← notification message renderer
├── notification.ts        ← completion notification system
├── tools/
│   ├── helpers.ts         ← shared pure helpers (textResult, formatLifetimeTokens, etc.)
│   ├── agent-tool.ts      ← Agent tool definition + agent-specific helpers
│   ├── get-result-tool.ts ← get_subagent_result tool definition
│   └── steer-tool.ts      ← steer_subagent tool definition
├── ui/
│   ├── agent-menu.ts      ← /agents menu + all sub-handlers (NEW)
│   ├── agent-widget.ts    (existing, unchanged)
│   └── conversation-viewer.ts  (existing, unchanged)
└── ... (other existing modules unchanged)
```

### Dependency design

Each factory receives only the methods it calls — not the full `AgentManager`, `AgentWidget`, or `ExtensionAPI`.
Example narrow interface for the get-result tool:

```typescript
interface GetResultDeps {
  getRecord: (id: string) => AgentRecord | undefined;
  cancelNudge: (key: string) => void;
  agentActivity: ReadonlyMap<string, AgentActivity>;
}
```

The Agent tool has more dependencies but they remain enumerable — each one maps to a specific method or value the execute callback calls.

### Notification system

The nudge/notification helpers (`scheduleNudge`, `cancelNudge`, `emitIndividualNudge`, `sendIndividualNudge`) and their associated formatters (`formatTaskNotification`, `buildNotificationDetails`, `buildEventData`, `escapeXml`, `getStatusLabel`) form a cohesive unit.
They move to `notification.ts` as a factory:

```typescript
export function createNotificationSystem(deps: NotificationDeps): NotificationSystem;

interface NotificationSystem {
  cancelNudge: (key: string) => void;
  sendCompletion: (record: AgentRecord) => void;
  cleanupCompleted: (id: string) => void;
  buildEventData: (record: AgentRecord) => object;
  dispose: () => void;
}
```

The completion callback in `index.ts` becomes a thin orchestrator (~15 lines) that calls `notifications.buildEventData()`, emits lifecycle events, persists the record, and delegates to `notifications.sendCompletion()`.

### What remains in index.ts

After all extractions, `index.ts` retains only:

1. Imports and default export declaration.
2. `reloadCustomAgents` helper and initial load call.
3. `agentActivity` map creation.
4. `createNotificationSystem()` call.
5. `AgentManager` construction with completion/started/compacted callbacks (~20 lines).
6. Service creation and publishing.
7. Lifecycle hooks (`session_start`, `session_before_switch`, `session_shutdown`).
8. Widget creation and `tool_execution_start` handler.
9. `buildTypeListText` computation.
10. Settings application.
11. Three `pi.registerTool()` calls (importing factories).
12. `pi.registerCommand("agents", ...)` call.

## Module-Level Changes

### `src/tools/helpers.ts` (new)

- `textResult(msg, details?)` — tool execute return value builder.
- `formatLifetimeTokens(record)` — format lifetime token total.
- `getModelLabelFromConfig(model)` — strip provider prefix and date suffix from model string.

### `src/renderer.ts` (new)

- `registerNotificationRenderer(registerFn)` — accepts `pi.registerMessageRenderer` and registers the `"subagent-notification"` renderer.
- Contains the full `renderOne` formatting logic currently inline in the `registerMessageRenderer` callback.

### `src/notification.ts` (new)

- `createNotificationSystem(deps)` factory — returns `NotificationSystem`.
- Contains: `scheduleNudge`, `cancelNudge`, `emitIndividualNudge`, `sendIndividualNudge`, `formatTaskNotification`, `buildNotificationDetails`, `buildEventData`, `escapeXml`, `getStatusLabel`.
- Deps interface: narrow accessors for `sendMessage`, `agentActivity`, `widget.markFinished`, `widget.update`.

### `src/tools/agent-tool.ts` (new)

- `createAgentTool(deps)` factory — returns the tool definition config object.
- Contains: `renderCall`, `renderResult`, `execute`, plus agent-tool-specific helpers (`createActivityTracker`, `buildDetails`, `getStatusNote`).
- Deps interface: narrow accessors for manager spawn/wait, widget lifecycle, activity map, event emission, output file wiring, type list text, and `reloadCustomAgents`.

### `src/tools/get-result-tool.ts` (new)

- `createGetResultTool(deps)` factory — returns the tool definition config object.
- Deps: `getRecord`, `cancelNudge`, `agentActivity`.

### `src/tools/steer-tool.ts` (new)

- `createSteerTool(deps)` factory — returns the tool definition config object.
- Deps: `getRecord`, `emitEvent`.

### `src/ui/agent-menu.ts` (new)

- `createAgentsMenuHandler(deps)` factory — returns the `/agents` command handler.
- Contains all menu functions: `showAgentsMenu`, `showAllAgentsList`, `showRunningAgents`, `viewAgentConversation`, `showAgentDetail`, `ejectAgent`, `disableAgent`, `enableAgent`, `showCreateWizard`, `showGenerateWizard`, `showManualWizard`, `showSettings`, `notifyApplied`, `findAgentFile`, `getModelLabel`.
- Deps: manager list/get methods, `reloadCustomAgents`, `agentActivity`, settings snapshot/save functions, event emission, and `pi` (for generate wizard spawning).

### `src/index.ts` (modified — shrinks from ~1,619 to ~120–150 lines)

- Remove all helper function definitions.
- Remove all tool definitions.
- Remove all menu handler functions.
- Remove renderer registration logic.
- Remove nudge/notification helpers.
- Add imports from new modules.
- Wire everything together: create deps, call factories, register tools/commands/lifecycle hooks.

## Test Impact Analysis

### New unit tests enabled by extraction

The decomposition enables direct testing of code that was previously locked inside the closure:

- `test/tools/helpers.test.ts` — `textResult`, `formatLifetimeTokens`, `getModelLabelFromConfig` with edge cases (zero tokens, empty model strings).
- `test/renderer.test.ts` — notification renderer formatting for each status (completed, error, stopped, steered, aborted) in collapsed and expanded modes.
- `test/notification.test.ts` — nudge scheduling/cancellation timing, `buildEventData` shape, `formatTaskNotification` XML output, `buildNotificationDetails` field mapping.
- `test/tools/get-result-tool.test.ts` — execute paths: agent not found, wait-for-completion, result-consumed suppression, verbose conversation inclusion.
- `test/tools/steer-tool.test.ts` — execute paths: agent not found, not running, session not ready (queued steer), successful steer.
- `test/tools/agent-tool.test.ts` — execute paths: foreground completion, background launch, resume, unknown type fallback, model resolution error.
- `test/ui/agent-menu.test.ts` — menu navigation, settings mutation, eject/disable/enable flows with mock UI context.

### Existing tests that become redundant

None.
There are no existing tests for `index.ts` — the extraction creates test coverage where none existed.

### Existing tests that stay as-is

All 21 existing test files are unaffected.
They test modules (`agent-manager`, `agent-runner`, `model-resolver`, `invocation-config`, `service-adapter`, etc.) that are not touched by this refactoring.

## TDD Order

Each step is a self-contained extraction + test cycle.
The existing test suite (362+ tests) runs after each step as a regression safety net.

1. **Extract `src/tools/helpers.ts` — shared pure helpers.**
   Move `textResult`, `formatLifetimeTokens`, `getModelLabelFromConfig` to new module.
   Update `index.ts` imports.
   Write `test/tools/helpers.test.ts` covering each function.
   Commit: `refactor: extract shared tool helpers to tools/helpers`

2. **Extract `src/renderer.ts` — notification message renderer.**
   Move renderer callback to `registerNotificationRenderer` export.
   Update `index.ts` to call the new function.
   Write `test/renderer.test.ts` covering status-dependent formatting.
   Commit: `refactor: extract notification renderer to renderer module`

3. **Extract `src/notification.ts` — completion notification system.**
   Move nudge system + formatters to `createNotificationSystem` factory.
   Update `index.ts` completion callback to use the notification system.
   Write `test/notification.test.ts` covering nudge timing and event data.
   Commit: `refactor: extract notification system to notification module`

4. **Extract `src/tools/get-result-tool.ts` — get_subagent_result tool.**
   Move tool definition to `createGetResultTool` factory with narrow deps.
   Update `index.ts` to call factory and register.
   Write `test/tools/get-result-tool.test.ts` covering execute paths.
   Commit: `refactor: extract get_subagent_result tool`

5. **Extract `src/tools/steer-tool.ts` — steer_subagent tool.**
   Move tool definition to `createSteerTool` factory with narrow deps.
   Update `index.ts`.
   Write `test/tools/steer-tool.test.ts` covering execute paths.
   Commit: `refactor: extract steer_subagent tool`

6. **Extract `src/tools/agent-tool.ts` — Agent tool.**
   Move tool definition + agent-specific helpers (`createActivityTracker`, `buildDetails`, `getStatusNote`) to `createAgentTool` factory.
   Update `index.ts`.
   Write `test/tools/agent-tool.test.ts` covering foreground, background, resume, and error paths.
   Commit: `refactor: extract Agent tool`

7. **Extract `src/ui/agent-menu.ts` — /agents menu handlers.**
   Move all menu functions to `createAgentsMenuHandler` factory.
   Update `index.ts` to register command with factory result.
   Write `test/ui/agent-menu.test.ts` covering key menu navigation flows.
   Commit: `refactor: extract /agents menu handlers`

8. **Final index.ts cleanup.**
   Remove any dead imports or vestigial code.
   Verify index.ts is ~120–150 lines of pure wire-up.
   Run `pnpm run check` (typecheck) and full test suite.
   Commit: `refactor: slim index.ts to wire-up entrypoint (#54)`

## Risks and Mitigations

| Risk                                                                                                                          | Mitigation                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closure variable access breaks after extraction — helpers currently close over shared maps (`agentActivity`, `pendingNudges`) | Factory pattern replaces closure access with explicit dependency injection; each factory's deps interface enumerates exactly what it needs.                                                                                                   |
| Narrow dep interfaces diverge from the real objects — test mocks pass but runtime breaks                                      | Run `pnpm run check` (typecheck) after each extraction step; the factory call sites in `index.ts` provide real objects whose types must satisfy the narrow interfaces.                                                                        |
| Large number of extraction steps creates merge-conflict risk with parallel PRs                                                | Steps are ordered leaf-first so earlier commits don't touch files later steps modify. Each step is independently committable and revertable.                                                                                                  |
| Agent tool factory has many deps (~8–10) — risks becoming a dependency bag                                                    | Deps are individual functions and values, not a monolithic object. Each dep maps to exactly one method call in execute. If the count feels excessive during implementation, group by concern (spawn, widget, events) into 2–3 sub-interfaces. |
| `buildTypeListText` is called at init time and captures agent types — extraction might change when it runs                    | `buildTypeListText` stays in `index.ts` as wire-up code (called once, result passed to agent tool factory). Timing is unchanged.                                                                                                              |

## Open Questions

- Should the notification module also own the lifecycle event emission (`subagents:completed`, `subagents:failed`, `subagents:started`, `subagents:compacted`), or should those stay in the completion callback in `index.ts`?
  Defer until step 3 — the answer depends on whether the completion callback shrinks enough to justify the move.
- Should `buildTypeListText` move into `agent-tool.ts` or stay as wire-up in `index.ts`?
  Defer until step 6 — evaluate once the agent tool factory interface is concrete.
