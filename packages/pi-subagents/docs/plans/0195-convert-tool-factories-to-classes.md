---
issue: 195
issue_title: "Convert tool factories to classes"
---

# Convert tool factories to classes

## Problem Statement

`createAgentTool`, `createGetResultTool`, and `createSteerTool` are closure factories that capture dependencies and return tool definitions.
This pattern hides dependencies in closures, forces `index.ts` to build narrow adapter objects at each call site, and prevents direct structural typing between real objects and tool interfaces.
With #193 (runtime owns queries) and #194 (interfaces aligned) both complete, the conversions are mechanical.

## Goals

- Convert all three tool factories to classes with constructor-injected dependencies.
- Each class exposes a `toToolDefinition()` method that wraps the tool with `defineTool()`.
- `index.ts` passes real objects directly — no adapter closures for tool wiring.
- Eliminate 16+ adapter closures from `index.ts`.

## Non-Goals

- Converting `createAgentRunner` or `createAgentsMenuHandler` — those belong to #196.
- Simplifying `index.ts` beyond tool wiring — that's #196 Layer 4.
- Changing tool behavior or parameters — this is a purely structural refactoring.

## Background

### Dependencies (both closed)

- Issue #193 moved context queries (`buildSnapshot`, `getModelInfo`, `getSessionInfo`) onto `SubagentRuntime`.
- Issue #194 aligned tool interfaces so `AgentManager` and `SubagentRuntime` structurally satisfy the narrow tool interfaces without adapters.

### Existing module layout

The three factory functions live in:

- `src/tools/agent-tool.ts` — `createAgentTool(deps: AgentToolDeps)`
- `src/tools/get-result-tool.ts` — `createGetResultTool(getRecord, cancelNudge, getConversation, registry)`
- `src/tools/steer-tool.ts` — `createSteerTool(getRecord, emitEvent, steerAgent, queueSteer)`

Each returns a plain object with `name`, `label`, `description`, `parameters`, `execute`, and optional render methods.
`index.ts` wraps each in `defineTool()` at registration time.

### Architecture doc reference

Phase 11, Layer 3 in `docs/architecture/architecture.md` (lines 689–709).

## Design Overview

### Class structure

Each class stores constructor-injected dependencies as instance fields and exposes:

1. A `toToolDefinition()` method that calls `defineTool(this.buildToolSpec())` (or similar) — returning the Pi SDK tool registration object.
2. Private methods that correspond to the existing function body sections.

### Constructor signatures

| Class           | Constructor params                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentTool`     | `manager: AgentToolManager`, `runtime: AgentToolRuntime`, `settings: AgentToolSettings`, `registry: AgentTypeRegistry`, `agentDir: string` |
| `GetResultTool` | `manager: GetResultToolManager`, `notifications: GetResultToolNotifications`, `registry: AgentConfigLookup`                                |
| `SteerTool`     | `manager: SteerToolManager`, `events: SteerToolEvents`                                                                                     |

### Narrow interfaces

Each class defines its own narrow interface for the collaborators it uses.
These already exist (e.g., `AgentToolManager`, `BackgroundManagerDeps`) — they stay as-is; the class uses them directly.

#### `AgentTool`

The existing `AgentToolDeps` interface (8 fields) collapses into 5 constructor params.
The `widget`, `agentActivity`, `buildSnapshot`, `getModelInfo`, and `getSessionInfo` fields merge into a single `runtime` param because `SubagentRuntime` structurally satisfies all of them after #193/#194.

New narrow interface for the runtime slice:

```typescript
export interface AgentToolRuntime {
  readonly agentActivity: AgentActivityAccess;
  setUICtx(ctx: UICtx): void;
  ensureTimer(): void;
  update(): void;
  markFinished(id: string): void;
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getModelInfo(): ModelInfo;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}
```

`SubagentRuntime` satisfies this structurally — no adapter needed in `index.ts`.

#### `GetResultTool`

New narrow interfaces:

```typescript
export interface GetResultToolManager {
  getRecord(id: string): AgentRecord | undefined;
}

export interface GetResultToolNotifications {
  cancelNudge(key: string): void;
}
```

`getAgentConversation` is a pure function — imported directly by the class, not injected.

#### `SteerTool`

New narrow interfaces:

```typescript
export interface SteerToolManager {
  getRecord(id: string): AgentRecord | undefined;
  queueSteer(id: string, message: string): boolean;
}

export interface SteerToolEvents {
  emit(name: string, data: unknown): void;
}
```

`steerAgent` is a pure function — imported directly by the class, not injected.

### Call site after conversion

```typescript
const agentTool = new AgentTool(manager, runtime, settings, registry, getAgentDir());
const getResultTool = new GetResultTool(manager, notifications, registry);
const steerTool = new SteerTool(manager, pi.events);
pi.registerTool(agentTool.toToolDefinition());
pi.registerTool(getResultTool.toToolDefinition());
pi.registerTool(steerTool.toToolDefinition());
```

### Design decisions

1. **`toToolDefinition()` on each class** — encapsulates the `defineTool()` call so `index.ts` doesn't import `defineTool` for each tool.
2. **Pure functions imported directly** — `steerAgent` and `getAgentConversation` are pure utilities with no state; injecting them adds indirection without testability benefit.
3. **`agentDir` stays a constructor param** — it's a static string computed once at startup; putting it on the registry would add scope responsibility the registry doesn't need.
4. **Keep existing `AgentToolDeps` temporarily** — remove it in the same PR once the class replaces all usage.

## Module-Level Changes

### `src/tools/agent-tool.ts`

- Add `AgentToolRuntime` interface (narrow runtime slice).
- Add `AgentToolSettings` type alias (existing inline type, extracted for clarity).
- Add `AgentTool` class with constructor storing `manager`, `runtime`, `settings`, `registry`, `agentDir`.
- Move the existing factory body into class methods: `toToolDefinition()`, private `execute()`.
- Remove `createAgentTool` function and `AgentToolDeps` interface.
- Keep `AgentToolManager`, `AgentToolWidget`, `AgentActivityAccess` interfaces (still used by `background-spawner` and `foreground-runner` — though `AgentToolWidget` may be replaceable by `AgentToolRuntime`).

### `src/tools/get-result-tool.ts`

- Add `GetResultToolManager` and `GetResultToolNotifications` interfaces.
- Add `GetResultTool` class with constructor.
- Import `getAgentConversation` directly.
- Move factory body into class method.
- Remove `createGetResultTool` function.

### `src/tools/steer-tool.ts`

- Add `SteerToolManager` and `SteerToolEvents` interfaces.
- Add `SteerTool` class with constructor.
- Import `steerAgent` directly.
- Move factory body into class method.
- Remove `createSteerTool` function.

### `src/tools/background-spawner.ts`

- Update `BackgroundWidgetDeps` to reference `AgentToolRuntime` instead (or keep as-is since `AgentToolRuntime` is a superset).
  Actually no change needed — `spawnBackground` already accepts narrow interfaces; the `AgentTool` class passes `this.runtime` which satisfies `BackgroundWidgetDeps` structurally.

### `src/tools/foreground-runner.ts`

- Same as above — no change needed.
  The `AgentTool` class passes `this.runtime` which satisfies `ForegroundWidgetDeps` structurally.

### `src/index.ts`

- Remove adapter closures for all three tool registrations.
- Replace with class construction + `toToolDefinition()` calls.
- Remove `defineTool` import (moves into tool classes).
- Remove unused imports that were only needed for adapter closures.

### `test/tools/agent-tool.test.ts`

- Replace `createToolDeps()` with class construction in test helpers.
- Update `execute()` helper to instantiate `AgentTool` and call its execute.
- Keep all existing test cases — behavior is unchanged.

### `test/tools/get-result-tool.test.ts`

- Replace positional args with class construction.
- Update `makeDeps` and `execute` helpers.
- Keep all existing test cases.

### `test/tools/steer-tool.test.ts`

- Replace positional args with class construction.
- Update `makeDeps` and `execute` helpers.
- Keep all existing test cases.

### `test/helpers/make-deps.ts`

- Update `createToolDeps` to construct `AgentTool`-compatible deps (or remove if no longer needed).
  Likely transforms into a factory that builds mock `AgentToolRuntime`, `AgentToolManager`, etc.

### `docs/architecture/architecture.md`

- Update the Layer 3 table to mark #195 as done.
- Update the file listing for `src/tools/` to reflect class names (if the listing is that detailed).

## Test Impact Analysis

1. **No new test surfaces** — this is a structural refactoring with identical behavior.
   Existing tests already cover all tool paths.
2. **Test helper changes** — `createToolDeps()` and per-tool `makeDeps()` functions need updating to use class construction instead of function calls, but the mock shapes remain the same.
3. **All existing tests stay** — they exercise the tool execution logic which doesn't change.

## TDD Order

1. **Convert `SteerTool` to class** — smallest tool (fewest deps, no render methods).
   - Update `steer-tool.ts`: add interfaces, add class, remove factory.
   - Update `test/tools/steer-tool.test.ts`: use class construction.
   - Verify: `pnpm vitest run test/tools/steer-tool.test.ts`
   - Commit: `refactor: convert createSteerTool to SteerTool class (#195)`

2. **Convert `GetResultTool` to class** — medium complexity (3 deps, no render methods).
   - Update `get-result-tool.ts`: add interfaces, add class, import `getAgentConversation`, remove factory.
   - Update `test/tools/get-result-tool.test.ts`: use class construction.
   - Verify: `pnpm vitest run test/tools/get-result-tool.test.ts`
   - Commit: `refactor: convert createGetResultTool to GetResultTool class (#195)`

3. **Convert `AgentTool` to class** — largest (5 deps, render methods, delegates to spawner/runner).
   - Add `AgentToolRuntime` and `AgentToolSettings` interfaces.
   - Add `AgentTool` class.
   - Remove `createAgentTool` and `AgentToolDeps`.
   - Update `test/tools/agent-tool.test.ts` and `test/helpers/make-deps.ts`.
   - Verify: `pnpm vitest run test/tools/agent-tool.test.ts`
   - Commit: `refactor: convert createAgentTool to AgentTool class (#195)`

4. **Update `index.ts`** — wire class constructors, remove adapter closures and `defineTool` import.
   - Verify: `pnpm vitest run` (full suite) + `pnpm run check` (type-check).
   - Commit: `refactor: wire tool classes in index.ts, remove adapter closures (#195)`

5. **Update architecture doc** — mark Layer 3 (partial) as complete.
   - Commit: `docs: mark #195 complete in architecture roadmap`

## Risks and Mitigations

| Risk                                                                                                      | Mitigation                                                                                    |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `background-spawner` and `foreground-runner` accept narrow interfaces that differ from `AgentToolRuntime` | `AgentToolRuntime` is a superset — pass `this.runtime` and structural typing handles it.      |
| Test factories import `AgentToolDeps` which will be removed                                               | Step 3 updates all test imports in the same commit.                                           |
| `defineTool` import removed from `index.ts` — must live somewhere                                         | Each class's `toToolDefinition()` imports it internally.                                      |
| Spreading class instances in tests breaks method access                                                   | Tests will construct the class, not spread it. Step 3 uses lift-and-shift for `make-deps.ts`. |

## Open Questions

- Should `AgentToolWidget` interface be removed entirely (replaced by `AgentToolRuntime`)?
  Defer to implementation — if `background-spawner` and `foreground-runner` can accept `AgentToolRuntime` directly, remove it; otherwise keep the narrow subset interfaces.
