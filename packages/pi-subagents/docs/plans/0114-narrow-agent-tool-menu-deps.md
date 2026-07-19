---
issue: 114
issue_title: "refactor(pi-subagents): narrow AgentToolDeps and AgentMenuDeps"
---

# Narrow AgentToolDeps and AgentMenuDeps

## Problem Statement

With the foundational extractions complete — `AgentTypeRegistry` (#108), `SettingsManager` (#109), `AgentActivityTracker` (#110), and `AgentManagerObserver` (#112) — the two widest dependency bags in the extension still carry fields that belong on their collaborators.

`AgentToolDeps` has 9 fields: 3 are description-text strings derivable from the registry, 1 is a raw `emitEvent` callback that the observer should own, and the `agentActivity` Map is passed as raw mutable state.
`AgentMenuDeps` has 8 fields: `emitEvent` is defined but never referenced in the module (dead field).

Each excess field inflates test mock construction and obscures the real dependency surface.

## Goals

- Remove `emitEvent` from both `AgentToolDeps` and `AgentMenuDeps`.
- Remove `typeListText` and `availableTypesText` from `AgentToolDeps` — derive them from `registry` inside `createAgentTool`.
- Add `onAgentCreated` to `AgentManagerObserver` so the `subagents:created` event is emitted by the observer, not the tool.
- Narrow `agentActivity` in both interfaces to a typed read/write interface instead of raw `Map`.
- Final counts: `AgentToolDeps` 9 → 6, `AgentMenuDeps` 8 → 7.

## Non-Goals

- Removing `agentDir` from `AgentToolDeps` — it is not derivable from the registry (it comes from the Pi SDK's `getAgentDir()`).
- Adding presentation methods to `AgentTypeRegistry` — that would mix SRP concerns.
- Splitting `agent-tool.ts` foreground/background (tracked in #115).
- Removing `personalAgentsDir` / `projectAgentsDir` from `AgentMenuDeps` — they are genuine menu-level concerns (file management UI).

## Background

### Prerequisite status

All prerequisites are implemented and merged:

| Issue | Title                                          | Status  |
| ----- | ---------------------------------------------- | ------- |
| #108  | Extract `AgentTypeRegistry`                    | ✅ Done |
| #109  | Extract `SettingsManager`                      | ✅ Done |
| #110  | `AgentActivityTracker`                         | ✅ Done |
| #112  | Replace `AgentManager` callbacks with observer | ✅ Done |
| #113  | Disambiguate `SpawnOptions`                    | ✅ Done |
| #118  | `SettingsManager` apply methods                | ✅ Done |

### Current interfaces

```typescript
// tools/agent-tool.ts — 9 fields
interface AgentToolDeps {
  manager: AgentToolManager;
  widget: AgentToolWidget;
  agentActivity: Map<string, AgentActivityTracker>;
  emitEvent: (name: string, data: unknown) => void;
  registry: AgentTypeRegistry;
  typeListText: string;
  availableTypesText: string;
  agentDir: string;
  settings: { readonly defaultMaxTurns: number | undefined };
}

// ui/agent-menu.ts — 8 fields
interface AgentMenuDeps {
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  agentActivity: Map<string, AgentActivityTracker>;
  getModelLabel: (type: string, registry?: ModelRegistry) => string;
  settings: AgentMenuSettings;
  emitEvent: (name: string, data: unknown) => void;   // ← dead field
  personalAgentsDir: string;
  projectAgentsDir: string;
}
```

### Relevant design principles

- **Dependency width** (code-design skill): do not pass a shared bag to functions that only use a subset.
- **Output arguments**: `agentActivity` is a raw `Map` mutated via `.set()` and `.delete()` — encapsulate behind methods.
- **ISP**: consumers should depend on the narrowest interface they need.

## Design Overview

### 1. Move `subagents:created` to observer

The `AgentManagerObserver` interface gains an `onAgentCreated` method.
`AgentManager.spawn()` calls `observer.onAgentCreated(record)` after creating the record.
The observer implementation in `index.ts` emits `pi.events.emit("subagents:created", ...)`.
The tool no longer calls `deps.emitEvent(...)`.

The event payload includes `id`, `type`, `description`, and `isBackground`.
Since `isBackground` is known at spawn-time (it's part of the spawn config), the observer has all needed data.

```typescript
interface AgentManagerObserver {
  onAgentStarted(record: AgentRecord): void;
  onAgentCompleted(record: AgentRecord): void;
  onAgentCompacted(record: AgentRecord, info: CompactionInfo): void;
  onAgentCreated(record: AgentRecord): void;  // ← new
}
```

### 2. Derive description text from registry

Move `buildTypeListText()` from `index.ts` to `tools/helpers.ts` as a pure function that accepts the registry and `agentDir`:

```typescript
function buildTypeListText(
  registry: AgentConfigLookup & { getDefaultAgentNames(): string[]; getUserAgentNames(): string[] },
  agentDir: string,
): string;
```

Inside `createAgentTool`, compute both strings from `deps.registry` and `deps.agentDir`:

```typescript
const typeListText = buildTypeListText(deps.registry, deps.agentDir);
const availableTypesText = deps.registry.getAvailableTypes().join(", ");
```

This removes `typeListText` and `availableTypesText` from the interface.
The helper requires `getModelLabelFromConfig`, which already lives in `tools/helpers.ts`.

### 3. Narrow agentActivity to a typed interface

Instead of `Map<string, AgentActivityTracker>`, both interfaces accept a narrow typed interface matching their actual usage:

```typescript
/** Read/write interface for agent-tool's activity tracking needs. */
interface AgentActivityAccess {
  get(id: string): AgentActivityTracker | undefined;
  set(id: string, tracker: AgentActivityTracker): void;
  delete(id: string): void;
}
```

The `AgentMenuDeps` only reads (`.get()`), so it gets a narrower read-only type:

```typescript
/** Read-only interface for menu's conversation viewer. */
interface AgentActivityReader {
  get(id: string): AgentActivityTracker | undefined;
}
```

The runtime's `Map<string, AgentActivityTracker>` satisfies both interfaces structurally.
No wrapper class is needed — `Map` already implements `get/set/delete`.
The benefit is that the type signature communicates the actual usage pattern.

### 4. Remove dead `emitEvent` from `AgentMenuDeps`

This field is defined in the interface but never referenced inside `agent-menu.ts`.
Remove it from the interface and from the construction site in `index.ts`.

### Final interfaces

```typescript
// tools/agent-tool.ts — 6 fields (was 9)
interface AgentToolDeps {
  manager: AgentToolManager;
  widget: AgentToolWidget;
  agentActivity: AgentActivityAccess;
  registry: AgentTypeRegistry;
  agentDir: string;
  settings: { readonly defaultMaxTurns: number | undefined };
}

// ui/agent-menu.ts — 7 fields (was 8)
interface AgentMenuDeps {
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  agentActivity: AgentActivityReader;
  getModelLabel: (type: string, registry?: ModelRegistry) => string;
  settings: AgentMenuSettings;
  personalAgentsDir: string;
  projectAgentsDir: string;
}
```

## Module-Level Changes

### Modified files

1. **`src/agent-manager.ts`** — Call `observer.onAgentCreated(record)` in `spawn()` after creating the record.
   Update `AgentManagerObserver` interface to include `onAgentCreated`.

2. **`src/tools/agent-tool.ts`** — Remove `emitEvent`, `typeListText`, `availableTypesText` from `AgentToolDeps`.
   Add `AgentActivityAccess` interface.
   Derive description text from `registry` + `agentDir` inside `createAgentTool`.
   Remove `deps.emitEvent(...)` call.
   Replace `Map<string, AgentActivityTracker>` with `AgentActivityAccess`.

3. **`src/tools/helpers.ts`** — Add `buildTypeListText(registry, agentDir)` extracted from `index.ts`.

4. **`src/ui/agent-menu.ts`** — Remove `emitEvent` from `AgentMenuDeps`.
   Add `AgentActivityReader` interface.
   Replace `Map<string, AgentActivityTracker>` with `AgentActivityReader`.

5. **`src/index.ts`** — Remove `buildTypeListText` closure.
   Remove `typeListText`, `availableTypesText`, `emitEvent` from the `AgentToolDeps` construction.
   Remove `emitEvent` from the `AgentMenuDeps` construction.
   Add `onAgentCreated` to the observer object.

6. **`test/tools/agent-tool.test.ts`** — Update `makeDeps` factory: remove `emitEvent`, `typeListText`, `availableTypesText`.
   Update assertions that check `emitEvent` was called.

7. **`test/ui/agent-menu.test.ts`** — Update `makeDeps` factory: remove `emitEvent`.

8. **`test/agent-manager.test.ts`** — Add test for `observer.onAgentCreated` being called during spawn.

## Test Impact Analysis

1. **New tests enabled**: `observer.onAgentCreated` can be tested in `agent-manager.test.ts` — verify it fires during `spawn()` with the correct record.

2. **Tests that simplify**: `agent-tool.test.ts` mock factory drops 3 fields (`emitEvent`, `typeListText`, `availableTypesText`).
   Tests asserting `deps.emitEvent` was called become assertions that the observer was invoked (tested at the manager level instead).
   `agent-menu.test.ts` mock factory drops 1 field (`emitEvent`).

3. **Tests that stay**: all tool-behavior tests (spawn paths, resume, error handling) remain — they test the tool's own logic, not the narrowed plumbing.

## TDD Order

1. **Add `onAgentCreated` to observer interface and manager.**
   Add the method to `AgentManagerObserver`.
   Call it in `AgentManager.spawn()`.
   Test: verify `observer.onAgentCreated` fires with the created record.
   Commit: `feat: add onAgentCreated to AgentManagerObserver`

2. **Extract `buildTypeListText` to helpers.**
   Move the function from `index.ts` to `tools/helpers.ts` as a pure function.
   Test: unit test `buildTypeListText` with a mock registry.
   Update `index.ts` to import and call the extracted helper.
   Commit: `refactor: extract buildTypeListText to tools/helpers`

3. **Derive description text inside `createAgentTool`.**
   Remove `typeListText` and `availableTypesText` from `AgentToolDeps`.
   Compute them from `deps.registry` + `deps.agentDir` inside `createAgentTool`.
   Update `index.ts` construction site.
   Update `agent-tool.test.ts` mock factory.
   Test: verify tool description still contains expected text.
   Commit: `refactor: derive description text from registry in createAgentTool`

4. **Remove `emitEvent` from `AgentToolDeps`.**
   Remove the field from the interface.
   Remove the `deps.emitEvent(...)` call in the background spawn path.
   Wire `onAgentCreated` in the `index.ts` observer to emit `subagents:created`.
   Update `agent-tool.test.ts` (remove `emitEvent` from factory, remove/update related assertions).
   Commit: `refactor: remove emitEvent from AgentToolDeps`

5. **Remove dead `emitEvent` from `AgentMenuDeps`.**
   Remove the field from the interface.
   Remove from `index.ts` construction site.
   Update `agent-menu.test.ts` mock factory.
   Commit: `refactor: remove dead emitEvent from AgentMenuDeps`

6. **Narrow `agentActivity` to typed interfaces.**
   Add `AgentActivityAccess` interface to `agent-tool.ts`.
   Add `AgentActivityReader` interface to `agent-menu.ts`.
   Replace `Map<string, AgentActivityTracker>` with the narrow type in both interfaces.
   Update test factories (no functional change — `Map` satisfies both interfaces).
   Commit: `refactor: narrow agentActivity to typed interfaces`

## Risks and Mitigations

| Risk                                                                                    | Mitigation                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents:created` event data changes shape when moved to observer                     | Observer receives the full `AgentRecord` which contains `id`, `type`, `description`. `isBackground` must be derivable from the record or spawn config — verify the record carries this at spawn time. |
| `buildTypeListText` depends on `getModelLabelFromConfig` which is in `tools/helpers.ts` | This is already the target file — no circular dependency risk.                                                                                                                                        |
| Third-party consumers rely on `emitEvent` presence in `AgentToolDeps`                   | `AgentToolDeps` is not in the public `exports` — it's internal. No external API breakage.                                                                                                             |
| `AgentActivityAccess` interface is structurally identical to a subset of `Map`          | This is intentional — the `Map` satisfies it without a wrapper. If a non-Map implementation is needed later, the interface is already in place.                                                       |

## Open Questions

1. Should `onAgentCreated` receive the full `AgentRecord` or a narrow payload?
   The other observer methods receive `AgentRecord` — consistency suggests the same.
   The `isBackground` flag is needed for the event payload; verify it's available on the record at creation time (it should be, since background is set at spawn).
2. Should `steer-tool.ts`'s `emitEvent` (emits `subagents:steered`) also move to the observer?
   It's a separate concern (tool-level steering) and a different event.
   Defer to a follow-up if desired.
