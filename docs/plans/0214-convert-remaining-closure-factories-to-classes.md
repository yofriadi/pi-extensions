---
issue: 214
issue_title: "Convert remaining closure factories to classes (Phase 13, Step 1)"
---

# Convert remaining closure factories to classes

## Problem Statement

Three closure factories survived Phase 11 — each captures dependencies in closure scope and returns a method bag, the exact pattern Phase 11 eliminated elsewhere.
Converting them to classes makes dependencies explicit as constructor parameters and aligns with the class-based pattern established in Phase 11.

## Goals

- Convert `createAgentConfigEditor()` to an `AgentConfigEditor` class.
- Convert `createAgentCreationWizard()` to an `AgentCreationWizard` class.
- Convert `createSubagentsService()` to a `SubagentsServiceAdapter` class implementing `SubagentsService`.
- Remove the `AgentCreationWizardDeps` interface (the class constructor replaces it).
- Update `AgentsMenuHandler` to store typed class instances instead of `ReturnType<typeof ...>`.
- Update `index.ts` to construct `SubagentsServiceAdapter` with `new`.
- 0 remaining closure factories (excluding pure-function factories like `createNotificationRenderer`).

## Non-Goals

- Changing any behavior — all conversions are purely structural.
- Extracting the shared overwrite guard between `AgentConfigEditor` and `AgentCreationWizard` — that is #218.
- Reducing test duplication in `agent-config-editor.test.ts` — that is #219.
- Decomposing `buildParentContext` or `startAgent` — those are #215 and #216.
- Modifying `createNotificationRenderer()` — it returns a pure render function with no captured state.

## Background

### Phase 11 precedent

Phase 11 converted all closure factories in tools, runner, and menu layers to classes.
Issues #195 and #196 established the pattern:

- Closure-captured deps become constructor parameters stored as `private readonly` fields.
- Nested functions become private methods.
- Consumer call sites change from `createFoo(deps)` to `new Foo(deps)`.
- Tests update `makeXxx()` helpers to use `new` instead of calling the factory.

### Current state

| Factory                       | File                          | Captures                                 | Returns                                     |
| ----------------------------- | ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| `createAgentConfigEditor()`   | `ui/agent-config-editor.ts`   | `fileOps`, `registry`, 2 dirs            | `{ showAgentDetail }` (7 nested async fns)  |
| `createAgentCreationWizard()` | `ui/agent-creation-wizard.ts` | `fileOps`, `manager`, `registry`, 2 dirs | `{ showCreateWizard }` (3 nested async fns) |
| `createSubagentsService()`    | `service/service-adapter.ts`  | `manager`, `resolveModel`, `runtime`     | 7-method `SubagentsService`                 |

### Consumer sites

- `AgentsMenuHandler` (in `agent-menu.ts`) constructs both UI factories in its constructor and stores them as `private readonly` fields typed as `ReturnType<typeof createAgentConfigEditor>` and `ReturnType<typeof createAgentCreationWizard>`.
- `index.ts` calls `createSubagentsService(manager, resolveModel, runtime)` and passes the result to `publishSubagentsService`.

### Structural typing

`AgentCreationWizardDeps` is only used within `agent-creation-wizard.ts` — no external imports.
The class constructor replaces the deps interface entirely.

## Design Overview

### AgentConfigEditor

Deps become positional constructor parameters (matching the factory's positional signature):

```typescript
export class AgentConfigEditor {
  constructor(
    private readonly fileOps: AgentFileOps,
    private readonly registry: AgentTypeRegistry,
    private readonly personalAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  private agentDirs(): string[] { ... }
  async showAgentDetail(ui: MenuUI, name: string): Promise<void> { ... }
  private async handleEdit(ui: MenuUI, name: string, file: string): Promise<void> { ... }
  private async handleDelete(ui: MenuUI, name: string, file: string): Promise<void> { ... }
  private async handleReset(ui: MenuUI, name: string, file: string): Promise<void> { ... }
  private async ejectAgent(ui: MenuUI, name: string, cfg: AgentConfig): Promise<void> { ... }
  private async disableAgent(ui: MenuUI, name: string): Promise<void> { ... }
  private async enableAgent(ui: MenuUI, name: string): Promise<void> { ... }
}
```

The pure helper functions `buildMenuOptions` and `buildEjectContent` remain as exported free functions — they have no captured state and their tests exercise them independently.

### AgentCreationWizard

Deps become positional constructor parameters (dissolving `AgentCreationWizardDeps`):

```typescript
export class AgentCreationWizard {
  constructor(
    private readonly fileOps: AgentFileOps,
    private readonly manager: WizardManager,
    private readonly registry: WizardRegistry,
    private readonly personalAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  async showCreateWizard(ui: MenuUI, parentSnapshot: ParentSnapshot): Promise<void> { ... }
  private async showGenerateWizard(ui: MenuUI, parentSnapshot: ParentSnapshot, targetDir: string): Promise<void> { ... }
  private async showManualWizard(ui: MenuUI, targetDir: string): Promise<void> { ... }
}
```

`WizardManager` and `WizardRegistry` interfaces remain exported — they define the narrow contracts for the class's collaborators.

### SubagentsServiceAdapter

The class implements `SubagentsService` directly:

```typescript
export class SubagentsServiceAdapter implements SubagentsService {
  constructor(
    private readonly manager: AgentManagerLike,
    private readonly resolveModel: (input: string, registry: ModelRegistry) => unknown,
    private readonly runtime: ServiceRuntimeLike,
  ) {}

  spawn(type: string, prompt: string, options?: SpawnOptions): string { ... }
  getRecord(id: string): SubagentRecord | undefined { ... }
  listAgents(): SubagentRecord[] { ... }
  abort(id: string): boolean { ... }
  async steer(id: string, message: string): Promise<boolean> { ... }
  async waitForAll(): Promise<void> { ... }
  hasRunning(): boolean { ... }
}
```

`AgentManagerLike` and `ServiceRuntimeLike` interfaces remain exported — they define the narrow contracts.
The `toSubagentRecord` helper remains an exported free function — it is pure and tested independently.

### AgentsMenuHandler updates

The `editor` and `wizard` fields change from `ReturnType<typeof ...>` to the concrete class types:

```typescript
private readonly editor: AgentConfigEditor;
private readonly wizard: AgentCreationWizard;
```

Construction changes from `createAgentConfigEditor(...)` to `new AgentConfigEditor(...)` and from `createAgentCreationWizard({...})` to `new AgentCreationWizard(...)`.

## Module-Level Changes

### `src/ui/agent-config-editor.ts`

- Replace `createAgentConfigEditor` factory function with `AgentConfigEditor` class.
- `agentDirs()` becomes a private method.
- `showAgentDetail`, `handleEdit`, `handleDelete`, `handleReset`, `ejectAgent`, `disableAgent`, `enableAgent` become class methods (`showAgentDetail` is public, rest are private).
- `buildMenuOptions` and `buildEjectContent` remain as exported free functions.

### `src/ui/agent-creation-wizard.ts`

- Replace `createAgentCreationWizard` factory function with `AgentCreationWizard` class.
- Remove `AgentCreationWizardDeps` interface.
- `showCreateWizard` becomes a public method; `showGenerateWizard` and `showManualWizard` become private methods.
- `WizardManager` and `WizardRegistry` interfaces remain exported.

### `src/service/service-adapter.ts`

- Replace `createSubagentsService` factory function with `SubagentsServiceAdapter` class implementing `SubagentsService`.
- `AgentManagerLike` and `ServiceRuntimeLike` interfaces remain exported.
- `toSubagentRecord` remains an exported free function.
- Add import for `SpawnOptions` from `#src/service/service` (needed for the `spawn` method signature).

### `src/ui/agent-menu.ts`

- Replace `ReturnType<typeof createAgentConfigEditor>` with `AgentConfigEditor`.
- Replace `ReturnType<typeof createAgentCreationWizard>` with `AgentCreationWizard`.
- Update constructor body: `new AgentConfigEditor(...)` instead of `createAgentConfigEditor(...)`.
- Update constructor body: `new AgentCreationWizard(...)` instead of `createAgentCreationWizard({...})`.
- Update imports: `AgentConfigEditor` instead of `createAgentConfigEditor`, `AgentCreationWizard` instead of `createAgentCreationWizard`.

### `src/index.ts`

- Replace `createSubagentsService(manager, resolveModel, runtime)` with `new SubagentsServiceAdapter(manager, resolveModel, runtime)`.
- Update import: `SubagentsServiceAdapter` instead of `createSubagentsService`.

### `docs/architecture/architecture.md`

- Mark Step 1 of Phase 13 as complete.
- Update the factory table to show conversions done.

## Test Impact Analysis

### `test/ui/agent-config-editor.test.ts`

- Update `makeEditor()` helper: replace `createAgentConfigEditor(...)` with `new AgentConfigEditor(...)`.
- Update import: `AgentConfigEditor` instead of `createAgentConfigEditor`.
- No test logic changes — all existing assertions remain valid.
- The `makeEditor()` helper centralizes the factory call, so only 1 line changes.

### `test/ui/agent-creation-wizard.test.ts`

- Replace all `createAgentCreationWizard(deps)` calls with `new AgentCreationWizard(deps.fileOps, deps.manager, deps.registry, deps.personalAgentsDir, deps.projectAgentsDir)`.
- Update import: `AgentCreationWizard` instead of `createAgentCreationWizard`.
- This file has ~18 call sites that each construct the wizard inline; each changes from `createAgentCreationWizard(deps)` to `new AgentCreationWizard(deps.fileOps, deps.manager, deps.registry, deps.personalAgentsDir, deps.projectAgentsDir)`.
- Alternatively, add a `makeWizard(deps)` helper to centralize construction, then each call site becomes `makeWizard(deps)`.
- No test logic changes.

### `test/service/service-adapter.test.ts`

- Replace all `createSubagentsService(manager, resolveModel, runtime)` calls with `new SubagentsServiceAdapter(manager, resolveModel, runtime)`.
- Update import: `SubagentsServiceAdapter` instead of `createSubagentsService`.
- ~12 call sites change; each is a mechanical find-and-replace.
- Update `describe` block names from `createSubagentsService —` to `SubagentsServiceAdapter —`.
- No test logic changes.

### No new tests needed

The conversions are structural — existing tests fully cover all behavior.
Adding "verify it's a class" tests would test the language, not the code.

## TDD Order

1. **Convert `createAgentConfigEditor` to `AgentConfigEditor` class.**
   Replace factory with class in `agent-config-editor.ts`.
   Update `makeEditor()` in `agent-config-editor.test.ts`.
   Update `agent-menu.ts` field types and constructor.
   Remove factory function.
   Verify: `pnpm vitest run test/ui/agent-config-editor.test.ts` and `pnpm run check`.
   `refactor: convert createAgentConfigEditor to AgentConfigEditor class`

2. **Convert `createAgentCreationWizard` to `AgentCreationWizard` class.**
   Replace factory with class in `agent-creation-wizard.ts`.
   Remove `AgentCreationWizardDeps` interface.
   Update all call sites in `agent-creation-wizard.test.ts` (add `makeWizard` helper to centralize construction).
   Update `agent-menu.ts` field type and constructor.
   Remove factory function.
   Verify: `pnpm vitest run test/ui/agent-creation-wizard.test.ts` and `pnpm run check`.
   `refactor: convert createAgentCreationWizard to AgentCreationWizard class`

3. **Convert `createSubagentsService` to `SubagentsServiceAdapter` class.**
   Replace factory with class in `service-adapter.ts`.
   Update all call sites in `service-adapter.test.ts`.
   Update `describe` block names.
   Update `index.ts` import and construction.
   Remove factory function.
   Verify: `pnpm vitest run test/service/service-adapter.test.ts` and `pnpm run check`.
   `refactor: convert createSubagentsService to SubagentsServiceAdapter class`

4. **Update architecture doc.**
   Mark Phase 13 Step 1 as complete in `docs/architecture/architecture.md`.
   `docs: mark Phase 13 Step 1 complete`

## Risks and Mitigations

| Risk                                                                           | Mitigation                                                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `AgentCreationWizard` test has ~18 inline factory calls that all need updating | Add a `makeWizard(deps)` test helper to centralize construction — same pattern used in `agent-config-editor.test.ts`. |
| `SubagentsServiceAdapter` class might not satisfy `SubagentsService` interface | The class uses `implements SubagentsService`, so `pnpm run check` catches any mismatches at compile time.             |
| Spreading a class instance in tests produces a plain object lacking methods    | Not applicable — none of the test files spread factory results. Tests call methods directly on the returned object.   |
| `AgentCreationWizardDeps` removal might break external consumers               | Verified: the interface is only used within `agent-creation-wizard.ts` itself. No external imports.                   |

## Open Questions

None — the conversions are mechanical and follow the established Phase 11 pattern.
