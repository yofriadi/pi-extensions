---
issue: 116
issue_title: "refactor(pi-subagents): type housekeeping and small structural cleanups"
---

# Type housekeeping and small structural cleanups

## Problem Statement

`types.ts` is a type dumping ground — it collects types that don't have a natural home because the module that should own them didn't exist yet.
With foundation extractions (#108 registry, `parent-snapshot.ts`, `env.ts`, `notification.ts`) now in place, most of these types have a natural home.
Several other small housekeeping items share the same "polish" character: a closure-bag factory that is a class in disguise, a positional constructor that creates test friction, and a 22-field `AgentConfig` interface consumed by modules that touch 2–4 of its fields.

## Goals

- Move `NotificationDetails` to `notification.ts`, `ParentSnapshot` to `parent-snapshot.ts`, and `EnvInfo` to `env.ts`.
- Convert `createNotificationSystem` closure to a `NotificationManager` class.
- Convert `ConversationViewer` constructor from 7 positional parameters to an options bag.
- Define narrow `AgentConfig` subset interfaces for consumers that use only a few fields.
- Leave `types.ts` containing only genuinely cross-cutting types: `SubagentType`, `MemoryScope`, `IsolationMode`, `AgentConfig`, `AgentInvocation`, `ShellExec`, and re-exports (`AgentRecord`, `ThinkingLevel`).

## Non-Goals

- Refactoring `AgentConfig` itself (field additions, removals, renames).
- Changing the `NotificationDeps` interface shape.
- Modifying `agent-menu.ts` to use narrow subsets — it legitimately reads most `AgentConfig` fields as a config editor/viewer.
- Touching `invocation-config.ts` — it already receives `AgentConfig | undefined` and only reads invocation-default fields; narrowing its parameter is a separate concern.

## Background

### Prerequisite status

| Issue | Title                             | Status  |
| ----- | --------------------------------- | ------- |
| #108  | Extract `AgentTypeRegistry` class | ✅ Done |

`DEFAULT_AGENT_NAMES` was already moved to `AgentTypeRegistry.DEFAULT_AGENT_NAMES` as part of #108.
The remaining work from the issue's checklist is type relocations, two structural conversions, and narrow subset interfaces.

### Current `types.ts` exports

| Export                                             | Kind      | Should stay?                    |
| -------------------------------------------------- | --------- | ------------------------------- |
| `AgentRecord` (re-export)                          | class     | ✅ Cross-cutting                |
| `AgentRecordInit`, `AgentRecordStatus` (re-export) | type      | ✅ Cross-cutting                |
| `ThinkingLevel` (re-export)                        | type      | ✅ Cross-cutting                |
| `SubagentType`                                     | type      | ✅ Cross-cutting                |
| `MemoryScope`                                      | type      | ✅ Cross-cutting                |
| `IsolationMode`                                    | type      | ✅ Cross-cutting                |
| `AgentConfig`                                      | interface | ✅ Cross-cutting                |
| `AgentInvocation`                                  | interface | ✅ Cross-cutting                |
| `ShellExec`                                        | type      | ✅ Cross-cutting                |
| `NotificationDetails`                              | interface | ❌ Move to `notification.ts`    |
| `ParentSnapshot`                                   | interface | ❌ Move to `parent-snapshot.ts` |
| `EnvInfo`                                          | interface | ❌ Move to `env.ts`             |

### `createNotificationSystem` closure analysis

The factory in `notification.ts` shares `pendingNudges` (a `Map`) and timer state across 4 inner functions (`cancelNudge`, `scheduleNudge`, `sendCompletion`, `cleanupCompleted`, `dispose`).
This is a class in disguise — mutable state + methods that read/write it.
Converting to a `NotificationManager` class makes the state explicit and lets tests use instance methods directly.

### `ConversationViewer` constructor

The constructor takes 7 positional parameters:

```typescript
constructor(tui, session, record, activity, theme, done, registry)
```

Every test must reconstruct all 7 in order.
An options bag reduces friction and is resilient to new parameters.

### `AgentConfig` field usage by consumer

| Consumer                                                   | Fields used                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `agent-widget.ts` (`getDisplayName`, `getPromptModeLabel`) | `name`, `displayName`, `promptMode`                                                          |
| `tools/helpers.ts` (`formatAgentList`)                     | `name`, `description`, `model`                                                               |
| `prompts.ts` (`buildAgentPrompt`)                          | `name`, `promptMode`, `systemPrompt`                                                         |
| `session-config.ts` (`assembleSessionConfig`)              | `name`, `model`, `thinking`, `maxTurns`, `extensions`, `skills`, `memory`, `disallowedTools` |
| `agent-menu.ts`                                            | Nearly all fields (config viewer/editor)                                                     |

Natural clusters for narrow interfaces:

- **`AgentIdentity`**: `name`, `displayName`, `description`, `promptMode` — UI display and agent listing.
- **`AgentPromptConfig`**: `name`, `promptMode`, `systemPrompt` — prompt assembly.

`session-config.ts` uses 8 fields; narrowing it yields limited value vs. complexity.
`invocation-config.ts` receives `AgentConfig | undefined` and reads invocation-default fields; this is a separate concern.

## Design Overview

### Type relocations

Move each type to its natural home module and re-export from `types.ts` during an interim step.
After updating all importers to point at the new home, remove the re-export.
This two-phase approach (move + re-export, then update importers + remove re-export) avoids a big-bang commit.

However, since importers are few (2–4 each) and the types are only used internally, a single step per type is simpler: move the type, update all importers in the same commit.

### `NotificationManager` class

Replace the `createNotificationSystem` factory with a class that owns its state:

```typescript
export class NotificationManager {
  private pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: NotificationDeps) {}

  cancelNudge(key: string): void { /* ... */ }
  sendCompletion(record: AgentRecord): void { /* ... */ }
  cleanupCompleted(id: string): void { /* ... */ }
  dispose(): void { /* ... */ }

  // private helpers
  private scheduleNudge(key: string, send: () => void, delay?: number): void { /* ... */ }
  private emitIndividualNudge(record: AgentRecord): void { /* ... */ }
}
```

The `NotificationSystem` interface stays as-is — `NotificationManager implements NotificationSystem`.
The `NotificationDeps` interface is unchanged.
Callers in `index.ts` switch from `createNotificationSystem(deps)` to `new NotificationManager(deps)`.

Consumer call site (index.ts):

```typescript
const notifications = new NotificationManager({
  sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
  agentActivity: runtime.agentActivity,
  markFinished: (id) => runtime.markFinished(id),
  updateWidget: () => runtime.updateWidget(),
});
```

### `ConversationViewer` options bag

Replace positional parameters with a named options interface:

```typescript
export interface ConversationViewerOptions {
  tui: TUI;
  session: AgentSession;
  record: AgentRecord;
  activity: AgentActivityTracker | undefined;
  theme: Theme;
  done: (result: undefined) => void;
  registry: AgentConfigLookup;
}

export class ConversationViewer {
  constructor(private options: ConversationViewerOptions) {
    // destructure into private fields or use options.field access
  }
}
```

The existing private fields (`tui`, `session`, `record`, etc.) become reads from `this.options.*` or are destructured in the constructor to named private fields.
The constructor body (session subscription) is unchanged.

### Narrow `AgentConfig` subset interfaces

Define two narrow interfaces in `types.ts` and make `AgentConfig` extend them:

```typescript
/** UI display and agent listing — name, display name, description, prompt mode. */
export interface AgentIdentity {
  name: string;
  displayName?: string;
  description: string;
  promptMode: "replace" | "append";
}

/** Prompt assembly — name, prompt mode, system prompt. */
export interface AgentPromptConfig {
  name: string;
  promptMode: "replace" | "append";
  systemPrompt: string;
}

export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  // remaining fields unchanged
}
```

Then update consumers to accept the narrow interface:

- `agent-widget.ts`: `getDisplayName(type, registry)` and `getPromptModeLabel(type, registry)` — these go through `AgentConfigLookup.resolveAgentConfig()`, which returns `AgentConfig`.
  The narrowing applies to the *return type usage*, not the function signature.
  No change needed here — the function already destructures only `displayName`, `name`, `promptMode`.
- `tools/helpers.ts`: `formatAgentList` reads `description`, `model` — these are not in `AgentIdentity`.
  `model` is session-config territory.
  Leave as-is.
- `prompts.ts`: `buildAgentPrompt(config: AgentPromptConfig, ...)` — narrow the parameter type.
- `AgentConfigLookup.resolveAgentConfig()` return type stays `AgentConfig` — the registry always has the full config.

Since `AgentConfig extends AgentIdentity, AgentPromptConfig`, any code passing an `AgentConfig` to a function expecting the narrow type works without casts.

## Module-Level Changes

### Modified files

1. **`src/types.ts`**
   - Remove `NotificationDetails`, `ParentSnapshot`, `EnvInfo` interface definitions.
   - Add `AgentIdentity` and `AgentPromptConfig` interfaces.
   - Make `AgentConfig` extend `AgentIdentity` and `AgentPromptConfig`.
   - Remove fields from `AgentConfig` body that are now inherited (`name`, `displayName`, `description`, `promptMode`, `systemPrompt`).

2. **`src/notification.ts`**
   - Add `NotificationDetails` interface (moved from `types.ts`).
   - Replace `createNotificationSystem` factory with `NotificationManager` class implementing `NotificationSystem`.
   - Export `NotificationManager` (named export) and keep `NotificationSystem` interface export.
   - Remove `createNotificationSystem` export.

3. **`src/parent-snapshot.ts`**
   - Add `ParentSnapshot` interface (moved from `types.ts`).

4. **`src/env.ts`**
   - Add `EnvInfo` interface (moved from `types.ts`).

5. **`src/prompts.ts`**
   - Change `config` parameter type from `AgentConfig` to `AgentPromptConfig`.
   - Update import to use `AgentPromptConfig` from `./types.js`.

6. **`src/index.ts`**
   - Update `NotificationDetails` import from `./types.js` to `./notification.js`.
   - Replace `createNotificationSystem(deps)` with `new NotificationManager(deps)`.
   - Update import: `NotificationManager` from `./notification.js`.

7. **`src/renderer.ts`**
   - Update `NotificationDetails` import from `./types.js` to `./notification.js`.

8. **`src/agent-runner.ts`**
   - Update `ParentSnapshot` import from `./types.js` to `./parent-snapshot.js`.

9. **`src/agent-manager.ts`**
   - Update `ParentSnapshot` import from `./types.js` to `./parent-snapshot.js`.

10. **`src/session-config.ts`**
    - Update `EnvInfo` import from `./types.js` to `./env.js`.

11. **`src/ui/conversation-viewer.ts`**
    - Define `ConversationViewerOptions` interface.
    - Replace 7 positional constructor parameters with single `options: ConversationViewerOptions` parameter.
    - Assign private fields from `options` in constructor body.

### Unchanged files

- `src/agent-types.ts` — `DEFAULT_AGENT_NAMES` already moved in #108.
- `src/invocation-config.ts` — narrowing is a separate concern.
- `src/ui/agent-menu.ts` — legitimately uses most `AgentConfig` fields.

### Test files

12. **`test/notification.test.ts`**
    - Replace `createNotificationSystem(deps)` calls with `new NotificationManager(deps)`.
    - Update import.
    - All existing assertions stay — the public API is identical.

13. **`test/conversation-viewer.test.ts`**
    - Replace positional `new ConversationViewer(tui, session, record, activity, theme, done, registry)` calls with `new ConversationViewer({ tui, session, record, activity, theme, done, registry })`.
    - All existing assertions stay.

14. **`test/prompts.test.ts`**
    - Verify existing test fixtures satisfy `AgentPromptConfig` (they should — tests already pass `name`, `promptMode`, `systemPrompt`).
    - May need to narrow mock type annotations.

15. **Other test files importing relocated types** (`test/parent-snapshot.test.ts`, `test/renderer.test.ts`)
    - Update import paths if they import directly from `types.ts` (most import from the source module already).

## Test Impact Analysis

1. **New unit tests enabled:**
   - `NotificationManager` as a class can be tested with standard `new` + method calls — no factory indirection.
     However, the existing factory tests are already clean and simply switch to `new NotificationManager(deps)`.
     No fundamentally new test capabilities.

2. **Existing tests that simplify:**
   - `conversation-viewer.test.ts` — the options bag makes test construction more readable and resilient to parameter additions.
     Each test only needs to specify the fields it cares about (with a helper providing defaults).
   - `prompts.test.ts` — narrower `AgentPromptConfig` parameter means test fixtures can omit 19 irrelevant `AgentConfig` fields.

3. **Existing tests that must stay as-is:**
   - `notification.test.ts` — all factory tests stay, just switch constructor syntax.
   - `conversation-viewer.test.ts` — all render and input tests stay, just switch constructor syntax.
   - `parent-snapshot.test.ts`, `env.test.ts`, `renderer.test.ts` — behavior unchanged.

## TDD Order

1. **Move `NotificationDetails` from `types.ts` to `notification.ts`.**
   Cut the interface from `types.ts`, paste into `notification.ts`.
   Update importers: `index.ts`, `renderer.ts` (change import from `./types.js` to `./notification.js`).
   `notification.ts` already imports from `./types.js` for `AgentRecord` — no circular dependency.
   Run `pnpm run check`.
   Commit: `refactor: move NotificationDetails to notification.ts`

2. **Move `ParentSnapshot` from `types.ts` to `parent-snapshot.ts`.**
   Cut the interface from `types.ts`, paste into `parent-snapshot.ts`.
   Update importers: `agent-manager.ts`, `agent-runner.ts` (change import from `./types.js` to `./parent-snapshot.js`).
   Run `pnpm run check`.
   Commit: `refactor: move ParentSnapshot to parent-snapshot.ts`

3. **Move `EnvInfo` from `types.ts` to `env.ts`.**
   Cut the interface from `types.ts`, paste into `env.ts`.
   Update importers: `session-config.ts`, `prompts.ts` (change import from `./types.js` to `./env.js`).
   `env.ts` already imports `ShellExec` from `./types.js` — no circular dependency.
   Run `pnpm run check`.
   Commit: `refactor: move EnvInfo to env.ts`

4. **Convert `createNotificationSystem` to `NotificationManager` class.**
   Replace the factory with a class implementing `NotificationSystem`.
   Move `pendingNudges` and timer logic to private instance state.
   Convert inner functions to methods.
   Keep `NotificationSystem` interface, `NotificationDeps` interface, and `NUDGE_HOLD_MS` constant unchanged.
   Remove `createNotificationSystem` export, add `NotificationManager` export.
   Update `index.ts`: `new NotificationManager(deps)` instead of `createNotificationSystem(deps)`.
   Update `test/notification.test.ts`: `new NotificationManager(deps)` instead of `createNotificationSystem(deps)`, update import.
   Run `pnpm vitest run test/notification.test.ts`.
   Commit: `refactor: convert createNotificationSystem to NotificationManager class`

5. **Convert `ConversationViewer` constructor to options bag.**
   Define `ConversationViewerOptions` interface.
   Replace 7 positional parameters with `options: ConversationViewerOptions`.
   Assign private fields from options in constructor body.
   Update all call sites in `test/conversation-viewer.test.ts` and `src/index.ts` (or wherever `new ConversationViewer(...)` is called).
   Run `pnpm vitest run test/conversation-viewer.test.ts`.
   Commit: `refactor: convert ConversationViewer to options bag constructor`

6. **Define narrow `AgentIdentity` and `AgentPromptConfig` interfaces.**
   Add interfaces to `types.ts`.
   Make `AgentConfig` extend both; remove inherited fields from `AgentConfig` body.
   Narrow `prompts.ts` `buildAgentPrompt` parameter from `AgentConfig` to `AgentPromptConfig`.
   Update `test/prompts.test.ts` type annotations if needed.
   Run `pnpm run check` and `pnpm vitest run`.
   Commit: `refactor: define AgentIdentity and AgentPromptConfig subset interfaces`

## Risks and Mitigations

| Risk                                                                                    | Mitigation                                                                                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Moving types breaks import paths in files not caught by grep                            | Run `pnpm run check` (full `tsc --noEmit`) after each type relocation step.                                                                   |
| `NotificationManager` class changes test mock patterns (e.g., spreading instances)      | Tests already use the factory return as an opaque object — switching to `new` is mechanical. No spread patterns in notification tests.        |
| `ConversationViewer` options bag breaks all test call sites at once                     | All 314 lines of tests use the same 7-arg pattern. A search-and-replace handles it. The options bag is a single-step change.                  |
| `AgentConfig extends AgentIdentity, AgentPromptConfig` changes structural compatibility | `extends` is purely additive — existing code passing `AgentConfig` anywhere still works. Narrowed consumers gain type safety, nothing breaks. |
| `prompts.ts` parameter narrowing breaks callers passing `AgentConfig`                   | `AgentConfig extends AgentPromptConfig`, so all existing call sites are compatible without changes.                                           |

## Open Questions

- Whether to define an `AgentSessionConfig` subset for `session-config.ts` (8 fields) — deferred because the narrowing ratio (8 of 22) yields less clarity benefit than `AgentIdentity` (4 of 22) or `AgentPromptConfig` (3 of 22).
