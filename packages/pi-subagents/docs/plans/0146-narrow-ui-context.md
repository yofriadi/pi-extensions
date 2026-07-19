---
issue: 146
issue_title: "Narrow UI context for menu handlers (Phase 9, Step N)"
---

# Narrow UI context for menu handlers

## Problem Statement

Menu handler functions (`showAgentsMenu`, `showAgentDetail`, `showCreateWizard`, etc.) declare `ctx: ExtensionContext` but only call `ctx.ui.select/confirm/input/notify/editor/custom` and `ctx.modelRegistry`.
This forces 42 `ctx as any` casts across 3 test files (`agent-menu.test.ts`: 8, `agent-config-editor.test.ts`: 20, `agent-creation-wizard.test.ts`: 14) because tests cannot construct a full `ExtensionContext`.

## Goals

- Define a `MenuUI` interface with the subset of `ctx.ui` methods that menu handlers actually use (`select`, `confirm`, `input`, `notify`, `editor`, `custom`).
- Menu handler functions accept `MenuUI` (plus `modelRegistry` passed separately) instead of `ExtensionContext`.
- `index.ts` handler registration extracts `ctx.ui` and `ctx.modelRegistry` from the SDK `ExtensionContext`.
- Change `WizardManager.spawnAndWait` to accept `ParentSnapshot` (introduced by #145) instead of `ExtensionContext`.
- Apply dependency bag convention: dissolve ≤4-field deps into plain parameters; keep ≥5-field interfaces but destructure in signature.
- Eliminate all 42 `ctx as any` casts from menu, editor, and wizard test files.

## Non-Goals

- Changing the behavior of `ctx.ui.custom` — pass-through only.
- Narrowing `ExtensionContext` usage in `index.ts` closures (the `as any` casts for `runtime.currentCtx?.ctx` are addressed separately).
- Injecting `modelRegistry` further (already a narrow interface from `model-resolver.ts`).

## Background

### Dependency: #145 (Step M) — Decompose execute

Issue #145 is **closed/implemented**.
`buildParentSnapshot(ctx)` converts `ExtensionContext` → `ParentSnapshot` at the call site.
This enables `WizardManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.

### Existing modules

- `agent-menu.ts` (296 lines) — menu handler factory, 8-field `AgentMenuDeps`, all inner functions take `ctx: ExtensionContext`
- `agent-config-editor.ts` (202 lines) — `AgentConfigEditorDeps` (4 fields), `showAgentDetail` takes `ctx: ExtensionContext`
- `agent-creation-wizard.ts` (246 lines) — `AgentCreationWizardDeps` (5 fields), `WizardManager.spawnAndWait` takes `ctx: ExtensionContext`
- `tools/get-result-tool.ts` — `GetResultDeps` (4 fields)
- `tools/steer-tool.ts` — `SteerToolDeps` (4 fields)
- `index.ts` — wires everything, handler registration extracts `ctx.ui` and passes `ExtensionContext`

### ExtensionContext usage in menu handlers

Every `ctx` reference in the three menu UI modules maps to exactly one of:

- `ctx.ui.select(...)` — 9 call sites
- `ctx.ui.confirm(...)` — 5 call sites
- `ctx.ui.input(...)` — 7 call sites
- `ctx.ui.notify(...)` — 15 call sites
- `ctx.ui.editor(...)` — 2 call sites
- `ctx.ui.custom(...)` — 1 call site (conversation viewer overlay)
- `ctx.modelRegistry` — 1 call site (model label resolution in `showAllAgentsList`)

No other `ExtensionContext` properties (session, tools, hooks, etc.) are accessed.

## Design Overview

### MenuUI interface

A narrow interface capturing only the `ctx.ui` methods used by menu handlers:

```typescript
export interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  editor(title: string, content: string): Promise<string | undefined>;
  custom<R>(component: any, options?: any): Promise<R>;
}
```

`select` uses a plain `string` return (not a generic `<T extends string>`) to match the SDK's structural signature.

`modelRegistry` is not included in `MenuUI` — it is not a UI concern.
Instead, the handler registration in `index.ts` passes it separately.

### Handler signature change

The menu handler currently receives `ExtensionContext` directly:

```typescript
// index.ts — before
handler: async (_args, ctx) => { await agentsMenuHandler(ctx); },
```

After this change, `index.ts` destructures what each handler needs:

```typescript
// index.ts — after
handler: async (_args, ctx) => {
  await agentsMenuHandler({
    ui: ctx.ui,
    modelRegistry: ctx.modelRegistry,
    parentSnapshot: buildParentSnapshot(ctx),
  });
},
```

In `agent-menu.ts`, the return type changes from `(ctx: ExtensionContext) => Promise<void>` to a function that accepts `{ ui: MenuUI; modelRegistry: ModelRegistry; parentSnapshot: ParentSnapshot }`.
The `ExtensionContext` import is removed from `agent-menu.ts`, `agent-config-editor.ts`, and `agent-creation-wizard.ts`.

`modelRegistry` is threaded from the handler through `showAgentsMenu` → `showAllAgentsList` (the only consumer).
`parentSnapshot` is threaded from the handler through `showAgentsMenu` → `wizard.showCreateWizard` → `showGenerateWizard` (the only consumer).

### Wizard spawnAndWait — drop ctx parameter

`WizardManager.spawnAndWait` currently takes `ctx: ExtensionContext` as its first parameter and passes it to `deps.manager.spawnAndWait(ctx, ...)`.
Once the menu handler no longer receives `ExtensionContext`, the wizard has no `ctx` to pass.

Thread `parentSnapshot` as a parameter from the handler through the wizard, keeping `AgentMenuManager.spawnAndWait` accepting `ParentSnapshot` as its first parameter (consistent with `AgentManager.spawnAndWait`).
The wizard's `showGenerateWizard` receives `parentSnapshot` and passes it to `deps.manager.spawnAndWait(parentSnapshot, ...)`.

```typescript
// agent-creation-wizard.ts — after
async function showGenerateWizard(
  ui: MenuUI,
  parentSnapshot: ParentSnapshot,
  targetDir: string,
) {
  // ...
  const record = await deps.manager.spawnAndWait(
    parentSnapshot, "general-purpose", generatePrompt, { ... },
  );
}
```

The creation wizard no longer imports `ExtensionContext`.

### Dependency bag convention

Per `docs/architecture/architecture.md` § Dependency bag convention:

- **≤4 fields** → dissolve the interface, accept as plain parameters.
- **≥5 fields** → keep the interface but destructure in the function signature.

#### Dissolve (≤4 fields)

`AgentConfigEditorDeps` (4 fields: `fileOps`, `registry`, `personalAgentsDir`, `projectAgentsDir`) → plain parameters on `createAgentConfigEditor`.

`GetResultDeps` (4 fields: `getRecord`, `cancelNudge`, `getConversation`, `registry`) → plain parameters on `createGetResultTool`.

`SteerToolDeps` (4 fields: `getRecord`, `emitEvent`, `steerAgent`, `queueSteer`) → plain parameters on `createSteerTool`.

#### Keep + destructure (≥5 fields)

`AgentMenuDeps` (8 fields) — keep the interface, destructure in `createAgentsMenuHandler({ manager, registry, ... })`.

`AgentCreationWizardDeps` (5 fields) — keep the interface, destructure in `createAgentCreationWizard({ fileOps, manager, ... })`.

### Consumer call-site sketch (menu handler registration)

```typescript
// index.ts
pi.registerCommand('agents', {
  description: 'Manage agents',
  handler: async (_args, ctx) => {
    await agentsMenuHandler({
      ui: ctx.ui,
      modelRegistry: ctx.modelRegistry,
      parentSnapshot: buildParentSnapshot(ctx),
    });
  },
});
```

### Extracted module interaction sketch (agent-config-editor)

```typescript
// agent-config-editor.ts — after dissolving deps
export function createAgentConfigEditor(
  fileOps: AgentFileOps,
  registry: AgentTypeRegistry,
  personalAgentsDir: string,
  projectAgentsDir: string,
) {
  // ... closures capture these directly; no deps.foo indirection
}
```

No Tell-Don't-Ask violations — each parameter is a primitive or injectable collaborator.
No output-argument mutations — pure closure capture.

## Module-Level Changes

### New file: none

All changes are modifications to existing files.

### Modified: `src/ui/agent-menu.ts`

- Add `MenuUI` interface export (the new narrow type).
- Import `ModelRegistry` from `model-resolver.js`.
- Remove `ExtensionContext` import.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Replace `ctx.modelRegistry` → parameter `modelRegistry` threaded to `showAllAgentsList`.
- Change `AgentMenuDeps` usage: destructure in `createAgentsMenuHandler` signature.
- Change return type from `(ctx: ExtensionContext) => Promise<void>` to `(params: { ui: MenuUI; modelRegistry: ModelRegistry; parentSnapshot: ParentSnapshot }) => Promise<void>`.
- Thread `modelRegistry` from handler through `showAgentsMenu` → `showAllAgentsList`.
- Thread `parentSnapshot` from handler through `showAgentsMenu` → `wizard.showCreateWizard` → `showGenerateWizard`.
- Update `AgentMenuManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.
- Remove `Omit<AgentSpawnConfig, "isBackground">` in favor of plain inline type.

### Modified: `src/ui/agent-config-editor.ts`

- Remove `ExtensionContext` import.
- Add `MenuUI` import from `agent-menu.js`.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Dissolve `AgentConfigEditorDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/ui/agent-creation-wizard.ts`

- Remove `ExtensionContext` import.
- Add `MenuUI` import from `agent-menu.js`.
- Add `ParentSnapshot` import from `parent-snapshot.js`.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Change `WizardManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.
- Thread `parentSnapshot` as a parameter from `showCreateWizard(ui, parentSnapshot)` → `showGenerateWizard(ui, parentSnapshot, targetDir)`.
- Destructure `AgentCreationWizardDeps` in signature.

### Modified: `src/tools/get-result-tool.ts`

- Dissolve `GetResultDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/tools/steer-tool.ts`

- Dissolve `SteerToolDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/index.ts`

- Update `createAgentConfigEditor` call: pass 4 plain args instead of `AgentConfigEditorDeps`.
- Update `createAgentCreationWizard` call: pass 4 plain args instead of `AgentCreationWizardDeps` (registry is the `WizardRegistry`, not the full `AgentTypeRegistry` — pass `{ reload: () => registry.reload() }`).
- Update `createGetResultTool` call: pass 4 plain args instead of `GetResultDeps`.
- Update `createSteerTool` call: pass 4 plain args instead of `SteerToolDeps`.
- Update `spawnAndWait` in menu handler deps: keep `ParentSnapshot` as first parameter.
- Update `/agents` command handler to destructure `ctx.ui`, `ctx.modelRegistry`, and `buildParentSnapshot(ctx)`.

### Modified: test files

- `test/ui/agent-menu.test.ts` — remove `ctx as any` casts; pass `{ ui: { ... }, modelRegistry: {}, parentSnapshot: {} }`.
- `test/ui/agent-config-editor.test.ts` — remove `ctx as any` casts; pass `MenuUI` objects directly.
- `test/ui/agent-creation-wizard.test.ts` — remove `ctx as any` casts; pass `MenuUI` and stub `ParentSnapshot`.
- `test/tools/get-result-tool.test.ts` — update `makeDeps` and `execute` helpers for dissolved parameters.
- `test/tools/steer-tool.test.ts` — update `makeDeps` and `execute` helpers for dissolved parameters.

### Unchanged

- `src/ui/conversation-viewer.ts` — unrelated; uses its own deps.
- `src/ui/agent-widget.ts` — already narrow (no `ExtensionContext`).
- `src/agent-manager.ts` — already accepts `ParentSnapshot` from #145.
- `src/parent-snapshot.ts` — unchanged.

## Test Impact Analysis

1. **New unit tests enabled:** None — this is a signature change, not an extraction.
   The existing test coverage already exercises menu navigation, editing, creation, and tool operations.

2. **Existing tests that simplify:** All 42 `ctx as any` casts are removed from the three test files.
   `makeCtx()` returns a plain `MenuUI`-shaped object (already structurally compatible).
   The `makeCtx` helper in `agent-menu.test.ts` already returns the right shape — it just needs the cast removed and the handler-call interface updated.

3. **Tests that must stay:** All existing test assertions stay — only the method of constructing the handler input changes.
   `get-result-tool.test.ts` and `steer-tool.test.ts` may need minor updates if the deps dissolve changes the factory call signature, but no assertion changes.

## TDD Order

Each step must leave `pnpm run check` green.
When a step changes a factory signature, it must also update the corresponding `index.ts` call site in the same commit.

1. **Refactor:** Define and export `MenuUI` interface in `agent-menu.ts`.
   No other changes — just add the interface alongside the existing code.
   Commit: `refactor: add MenuUI interface (#146)`

2. **Refactor:** Update `agent-config-editor.ts` — dissolve `AgentConfigEditorDeps` into 4 plain parameters; change `showAgentDetail(ctx)` to `showAgentDetail(ui: MenuUI)`; replace `ctx.ui.xxx` → `ui.xxx`.
   Update `agent-config-editor.test.ts` — remove `ctx as any` casts, pass `MenuUI` objects directly.
   Update `index.ts` — update `createAgentConfigEditor` call to pass 4 plain args.
   Commit: `refactor: dissolve AgentConfigEditorDeps and narrow to MenuUI (#146)`

3. **Refactor:** Update `agent-creation-wizard.ts` — destructure `AgentCreationWizardDeps`; change `showCreateWizard(ctx)` to `showCreateWizard(ui: MenuUI, parentSnapshot: ParentSnapshot)`; thread `parentSnapshot` to `showGenerateWizard`; change `WizardManager.spawnAndWait` to accept `ParentSnapshot`; replace `ctx.ui.xxx` → `ui.xxx`.
   Update `agent-creation-wizard.test.ts` — remove `ctx as any` casts, pass `MenuUI` and stub `ParentSnapshot`.
   Update `index.ts` — update `createAgentCreationWizard` call for destructured params.
   Commit: `refactor: narrow creation wizard to MenuUI and ParentSnapshot (#146)`

4. **Refactor:** Update `agent-menu.ts` — destructure `AgentMenuDeps`; change handler return type to accept `{ ui: MenuUI; modelRegistry: ModelRegistry; parentSnapshot: ParentSnapshot }`; thread `modelRegistry` to `showAllAgentsList`; thread `parentSnapshot` to `wizard.showCreateWizard`; update `AgentMenuManager.spawnAndWait` to accept `ParentSnapshot`; replace `ctx.ui.xxx` → `ui.xxx`.
   Update `agent-menu.test.ts` — remove `ctx as any` casts, pass `{ ui, modelRegistry, parentSnapshot }`.
   Update `index.ts` — update `/agents` handler to destructure `ctx.ui`, `ctx.modelRegistry`, and `buildParentSnapshot(ctx)`.
   Commit: `refactor: narrow agent menu to MenuUI interface (#146)`

5. **Refactor:** Update `get-result-tool.ts` — dissolve `GetResultDeps` into 4 plain parameters.
   Update `test/tools/get-result-tool.test.ts` — update `makeDeps` and `execute` helpers.
   Update `index.ts` — update `createGetResultTool` call to pass 4 plain args.
   Commit: `refactor: dissolve GetResultDeps into plain parameters (#146)`

6. **Refactor:** Update `steer-tool.ts` — dissolve `SteerToolDeps` into 4 plain parameters.
   Update `test/tools/steer-tool.test.ts` — update `makeDeps` and `execute` helpers.
   Update `index.ts` — update `createSteerTool` call to pass 4 plain args.
   Commit: `refactor: dissolve SteerToolDeps into plain parameters (#146)`

7. **Verify:** Run full test suite (`pnpm vitest run`) and type check (`pnpm run check`).
   Confirm zero `ctx as any` in the three menu test files.
   Commit: none (verification only).

## Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.ui.custom` signature mismatch between `MenuUI` and real `ExtensionContext.ui` | `MenuUI.custom` uses `any` for the component and options parameters since these are opaque TUI types internal to the SDK. This matches the existing usage where `ctx.ui.custom<undefined>(...)` passes a TUI component constructor.                                                                                          |
| `ParentSnapshot` threading through menu → wizard call chain                        | The handler receives `parentSnapshot` from `index.ts` and threads it through `showAgentsMenu` → `showCreateWizard` → `showGenerateWizard`. Only `showGenerateWizard` uses it; the other functions relay it. This is acceptable since the parameter follows the existing `targetDir` threading pattern already in the wizard. |
| Deps dissolution breaks `index.ts` type check mid-sequence                         | Each TDD step updates the factory, its test file, AND the `index.ts` call site together, keeping `pnpm run check` green after every commit.                                                                                                                                                                                  |

## Open Questions

- None — the design follows the architecture doc's Step N specification and the dependency (#145) is already implemented.
