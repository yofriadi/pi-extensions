---
issue: 196
issue_title: "Convert AgentRunner and AgentsMenuHandler to classes, simplify index.ts"
---

# Convert AgentRunner and AgentsMenuHandler to classes, simplify index.ts

## Problem Statement

Two remaining closure factories in pi-subagents mask class-shaped code:

1. `createAgentRunner(runnerIO)` captures `RunnerIO` and returns `{ run, resume }` — the `AgentRunner` interface already exists but lacks a concrete class implementation.
2. `createAgentsMenuHandler({...})` captures an 8-field deps object and returns a handler function.

With #195 (tool factory → class conversions) complete, these are the last two closure factories.
After converting them, `index.ts` can be simplified: adapter closures drop, fan-out decreases, and the composition root becomes pure object construction.

## Goals

- Convert `createAgentRunner` factory to a concrete `ConcreteAgentRunner` class implementing `AgentRunner`.
- Convert `createAgentsMenuHandler` factory to an `AgentsMenuHandler` class.
- Internalize the `getModelLabel` closure from `index.ts` into `AgentsMenuHandler` (it uses `resolveModel` and `getModelLabelFromConfig`, both pure functions the class can import directly).
- Pass `AgentManager` directly as the `manager` param (it structurally satisfies `AgentMenuManager`), eliminating 3 adapter closures.
- Simplify `index.ts` by removing eliminated adapter closures and unused imports.
- Update architecture doc to mark Layer 3 and Layer 4 as done.

## Non-Goals

- Changing `runAgent()` or `resumeAgent()` function signatures — they remain as free functions called by the class.
- Removing the `AgentRunner` interface — it stays as the contract for `AgentManager`.
- Removing `RunnerIO` type — it stays as the IO boundary for `runAgent()`.
- Changing the `AgentMenuManager` interface — it stays as the narrow contract; `AgentManager` satisfies it structurally.
- Removing `AgentMenuDeps` — it is replaced by the class constructor; the type itself is removed.
- Refactoring `NotificationManager`, `SettingsManager`, or `SessionLifecycleHandler` — those are already class-shaped.
- Phase 12 work (decompose `renderWidgetLines`, consolidate test duplication).

## Background

### Phase 11 layer structure

Phase 11 in `docs/architecture/architecture.md` converts closure factories to classes in four layers:

- Layer 0: `SessionContext` interface (#192) ✓
- Layer 1: Runtime owns context queries (#193) ✓
- Layer 2: Align interfaces for structural typing (#194) ✓
- Layer 3: Convert closure factories to classes (#195 tools ✓, #196 runner + menu)
- Layer 4: Simplify `index.ts` (#196)

Issue #196 completes Layer 3 (runner + menu) and Layer 4 (index.ts simplification).

### Current state

`createAgentRunner` (3 lines) wraps `runAgent`/`resumeAgent` in an object literal:

```typescript
export function createAgentRunner(io: RunnerIO): AgentRunner {
  return {
    run: (snapshot, type, prompt, options) => runAgent(snapshot, type, prompt, options, io),
    resume: resumeAgent,
  };
}
```

`createAgentsMenuHandler` (200+ lines) captures 8 deps and returns a handler function.
The deps bag includes `getModelLabel` (a closure built in `index.ts`) and `agentActivity` (a `Map` from runtime).

`index.ts` currently has ~23 arrow closures and 27 imports at 229 lines.

### Structural typing confirmation

`AgentManager` already has `listAgents()`, `getRecord()`, and `spawnAndWait()` methods that structurally satisfy `AgentMenuManager`.
The `spawnAndWait` parameter type (`Omit<AgentSpawnConfig, "isBackground">`) is a superset of the menu's `{ description, maxTurns }`, so structural typing matches.

## Design Overview

### ConcreteAgentRunner

A minimal class that implements `AgentRunner` by delegating to the free functions:

```typescript
export class ConcreteAgentRunner implements AgentRunner {
  constructor(private readonly io: RunnerIO) {}

  async run(snapshot: ParentSnapshot, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult> {
    return runAgent(snapshot, type, prompt, options, this.io);
  }

  async resume(session: AgentSession, prompt: string, options?: ResumeOptions): Promise<string> {
    return resumeAgent(session, prompt, options);
  }
}
```

The factory function `createAgentRunner` is removed.
The free functions `runAgent`, `resumeAgent`, `getAgentConversation`, and `normalizeMaxTurns` remain exported — they are used directly by tests and other modules.

### AgentsMenuHandler

The class replaces `createAgentsMenuHandler` and `AgentMenuDeps`.
Constructor params are the subset of deps that are true collaborators:

```typescript
export class AgentsMenuHandler {
  constructor(
    private readonly manager: AgentMenuManager,
    private readonly registry: AgentTypeRegistry,
    private readonly agentActivity: AgentActivityReader,
    private readonly settings: AgentMenuSettings,
    private readonly fileOps: AgentFileOps,
    private readonly personalAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  async handle(ctx: { ui: MenuUI; modelRegistry: ModelRegistry; parentSnapshot: ParentSnapshot }): Promise<void> { ... }
}
```

Key design decisions:

1. **`agentActivity` stays as a constructor param** — it is a collaborator used in `viewAgentConversation`.
   The issue's proposed signature omits it, but the class needs it at runtime.
2. **`getModelLabel` is internalized** — the class imports `resolveModel` and `getModelLabelFromConfig` directly and computes the label in a private method.
   This eliminates the closure from `index.ts` and removes the `getModelLabel` field from the deps interface.
3. **`AgentMenuDeps` is removed** — the class constructor replaces it.
4. **The `handle` method** replaces the returned function.
   The inner helpers (`showAgentsMenu`, `showAllAgentsList`, etc.) become private methods.

### index.ts simplification

After both conversions:

```typescript
// Before (adapter closures):
const agentsMenuHandler = createAgentsMenuHandler({
  manager: {
    listAgents: () => manager.listAgents(),
    getRecord: (id) => manager.getRecord(id),
    spawnAndWait: (...) => manager.spawnAndWait(...),
  },
  registry,
  agentActivity: runtime.agentActivity,
  getModelLabel: (type, modelRegistry) => { ... },  // 7-line closure
  settings,
  fileOps: new FsAgentFileOps(),
  personalAgentsDir: join(getAgentDir(), 'agents'),
  projectAgentsDir: join(process.cwd(), '.pi', 'agents'),
});

// After:
const agentsMenu = new AgentsMenuHandler(
  manager, registry, runtime.agentActivity,
  settings, new FsAgentFileOps(),
  join(getAgentDir(), 'agents'),
  join(process.cwd(), '.pi', 'agents'),
);
```

Eliminated closures: 4 (3 manager method adapters + 1 getModelLabel closure).
Eliminated imports: `getModelLabelFromConfig`, `resolveModel` (from index.ts), `createAgentRunner`, `type RunnerIO`, `createAgentsMenuHandler`.

Remaining adapter closures in `index.ts` (~15) are necessary: event handler registrations, SDK factory callbacks, `pi.sendMessage`/`pi.exec` adapters.
These are structural — they bridge the Pi SDK's callback-based API to the extension's object-oriented internals.

## Module-Level Changes

### `src/lifecycle/agent-runner.ts`

- Add `ConcreteAgentRunner` class implementing `AgentRunner`.
- Remove `createAgentRunner` factory function.
- Keep all free functions (`runAgent`, `resumeAgent`, `getAgentConversation`, `normalizeMaxTurns`) and all types exported.

### `src/ui/agent-menu.ts`

- Replace `createAgentsMenuHandler` factory with `AgentsMenuHandler` class.
- Remove `AgentMenuDeps` interface.
- Add private `getModelLabel` method (internalizes the closure from `index.ts`).
- Convert inner functions (`showAgentsMenu`, `showAllAgentsList`, `showRunningAgents`, `viewAgentConversation`, `showSettings`) to private methods.
- Add imports: `resolveModel` from `#src/session/model-resolver`, `getModelLabelFromConfig` from `#src/tools/helpers`.
- Keep exported interfaces: `AgentMenuManager`, `AgentMenuSettings`, `AgentActivityReader`, `MenuUI`.

### `src/index.ts`

- Replace `createAgentRunner(runnerIO)` with `new ConcreteAgentRunner(runnerIO)`.
- Replace `createAgentsMenuHandler({...})` with `new AgentsMenuHandler(...)`.
- Replace `agentsMenuHandler({...})` with `agentsMenu.handle({...})`.
- Remove adapter closures for `manager.listAgents`, `manager.getRecord`, `manager.spawnAndWait`, and `getModelLabel`.
- Remove unused imports: `createAgentRunner`, `type RunnerIO` → `ConcreteAgentRunner`; `createAgentsMenuHandler` → `AgentsMenuHandler`; `getModelLabelFromConfig`, `resolveModel`.
- Net effect: ~15 lines removed, 5 imports removed.

### `docs/architecture/architecture.md`

- Mark Layer 3 remaining items (runner, menu) as done.
- Mark Layer 4 as done.
- Update the factory→class table entries for `createAgentRunner` and `createAgentsMenuHandler` with ✓.

## Test Impact Analysis

### `test/lifecycle/agent-runner.test.ts` (and siblings)

No changes needed.
Tests call `runAgent()` and `resumeAgent()` directly — they never use `createAgentRunner`.
The `ConcreteAgentRunner` class is a trivial two-method delegation wrapper tested implicitly through `index.ts` integration and explicitly through one new unit test.

### `test/ui/agent-menu.test.ts`

Tests need updating:

1. Replace `createAgentsMenuHandler(makeDeps())` with `new AgentsMenuHandler(...)`.
2. Replace `handler(params)` with `handler.handle(params)`.
3. Remove `getModelLabel` from `makeDeps()` — it is now an internal method.
4. Remove `AgentMenuDeps` import; update `makeDeps` to construct positional args or a helper that returns a handler directly.

No test logic changes — only call-site updates for the new API shape.

### New tests

One new unit test for `ConcreteAgentRunner`: verify it delegates `run` and `resume` to the underlying functions.

## TDD Order

1. **Add `ConcreteAgentRunner` class alongside factory.**
   Add the class to `agent-runner.ts`, keep `createAgentRunner` temporarily.
   Add a unit test verifying delegation.
   `test: add ConcreteAgentRunner delegation test`

2. **Switch `index.ts` to `ConcreteAgentRunner`, remove factory.**
   Replace `createAgentRunner(runnerIO)` with `new ConcreteAgentRunner(runnerIO)`.
   Remove the `createAgentRunner` factory function.
   Update imports.
   `refactor: replace createAgentRunner with ConcreteAgentRunner class`

3. **Convert `createAgentsMenuHandler` to `AgentsMenuHandler` class.**
   Replace factory function with class.
   Move inner functions to private methods.
   Internalize `getModelLabel` as a private method.
   Remove `AgentMenuDeps` interface.
   `refactor: convert createAgentsMenuHandler to AgentsMenuHandler class`

4. **Update `agent-menu.test.ts` for class API.**
   Replace `createAgentsMenuHandler(makeDeps())` with class construction.
   Replace `handler(params)` with `handler.handle(params)`.
   Remove `getModelLabel` from test deps.
   All existing tests pass with updated call sites.
   `test: update agent-menu tests for AgentsMenuHandler class`

5. **Simplify `index.ts` wiring.**
   Replace `createAgentsMenuHandler({...})` with `new AgentsMenuHandler(...)`.
   Pass `manager` directly (structural typing).
   Remove adapter closures and unused imports.
   `refactor: simplify index.ts wiring for AgentsMenuHandler`

6. **Update architecture doc.**
   Mark Layer 3 remaining items and Layer 4 as done in `docs/architecture/architecture.md`.
   `docs: mark Phase 11 Layer 3 and Layer 4 complete`

## Risks and Mitigations

| Risk                                                             | Mitigation                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AgentManager` might not structurally satisfy `AgentMenuManager` | Confirmed: `listAgents()`, `getRecord()`, `spawnAndWait()` signatures are compatible. `pnpm run check` in step 5 verifies.     |
| Internalized `getModelLabel` might diverge from the closure      | The private method uses the same `resolveModel` and `getModelLabelFromConfig` imports — identical logic, just moved.           |
| Tests that use `AgentMenuDeps` type break when removed           | Step 4 updates all test call sites before step 5 changes production code. The test file is 215 lines — manageable in one step. |
| `agentActivity` missing from constructor                         | Included in the class constructor (diverging from the issue's proposed signature which omits it).                              |

## Open Questions

None — the issue's proposed design is clear and the implementation is mechanical.
The one deviation (keeping `agentActivity` as a constructor param) is necessary and minimal.
