---
issue: 206
issue_title: "Decompose showAgentDetail (cognitive 33)"
---

# Decompose `showAgentDetail`

## Problem Statement

`showAgentDetail` in `ui/agent-config-editor.ts` has cognitive complexity 33 (CRITICAL per fallow health).
It interleaves menu-option computation, user-choice dispatch, and three inline action handlers (edit, delete, reset) in a single 67-line function.
`ejectAgent` in the same file has cognitive complexity 20 from its 14-branch frontmatter builder.
Phase 12, Step 2 targets cognitive complexity < 10 per function.

## Goals

- Extract menu-option computation and inline action handlers into separate functions, each with cognitive complexity < 10.
- Extract frontmatter building from `ejectAgent` into a pure function.
- Preserve all existing behavior — no user-visible or API changes.
- Add unit tests for the two new exported pure functions.

## Non-Goals

- Decomposing `renderWidgetLines` (#205), `update` (#207), or shared test fixtures (#208) — sibling Phase 12 steps.
- Changing the menu structure, option labels, or action semantics.
- Decomposing `disableAgent` or `enableAgent` — their cognitive complexity is already manageable (< 15).

## Background

`agent-config-editor.ts` was extracted from `agent-menu.ts` in Phase 8 (#136).
The file exposes a single factory `createAgentConfigEditor` that returns `{ showAgentDetail }`.
Internally the factory closes over `fileOps`, `registry`, `personalAgentsDir`, and `projectAgentsDir`.

Three action handlers already exist as closure-level functions: `ejectAgent`, `disableAgent`, `enableAgent`.
The remaining three actions — Edit, Delete, and Reset to default — are inlined in `showAgentDetail`'s if/else dispatch chain.

The existing test suite (`test/ui/agent-config-editor.test.ts`, 18 tests) covers all menu-option combinations and action branches through the public `showAgentDetail` entry point.

### Complexity sources

`showAgentDetail` (cognitive 33):

1. Menu-option building — 4-branch if/else chain with 3 boolean conditions (`disabled`, `isDefault`, `file`).
2. Action dispatch — 6-branch if/else chain based on `choice`.
3. Inline Edit handler — 3 nested `if` guards (`file`, `content`, `edited !== content`).
4. Inline Delete handler — nested `if (file)` + `if (confirmed)`.
5. Inline Reset handler — nested `if (file)` + `if (confirmed)`.

`ejectAgent` (cognitive 20):

1. Location selection + overwrite check — 2 early returns with nested ifs.
2. Frontmatter field building — 14 conditional `if`/`else if` branches.

## Design Overview

### Extracted from `showAgentDetail`

#### `buildMenuOptions` (exported, pure)

```typescript
export function buildMenuOptions(
  cfg: { isDefault?: boolean; enabled?: boolean },
  file: string | undefined,
): string[]
```

Accepts the minimal config shape and file path.
Returns the menu option array.
Pure computation — no IO, no side effects.
Exported for direct unit testing.

#### `handleEdit` (closure-internal)

Handles the Edit action: reads the file, opens the editor, writes if changed.
Signature: `(ui: MenuUI, name: string, file: string) => Promise<void>`.
Called only when `file` is defined (guaranteed by menu-option construction).

#### `handleDelete` (closure-internal)

Handles the Delete action: confirms with user, removes file, reloads registry.
Signature: `(ui: MenuUI, name: string, file: string) => Promise<void>`.

#### `handleReset` (closure-internal)

Handles the Reset to default action: confirms, removes override file, reloads registry.
Signature: `(ui: MenuUI, name: string, file: string) => Promise<void>`.

### Extracted from `ejectAgent`

#### `buildEjectContent` (exported, pure)

```typescript
export function buildEjectContent(cfg: AgentConfig): string
```

Builds the full `.md` file content (frontmatter + system prompt) for an ejected agent.
Pure function — no IO.
Exported for direct unit testing.

### After refactoring

`showAgentDetail` becomes a thin orchestrator (~15 lines):

```typescript
async function showAgentDetail(ui: MenuUI, name: string) {
  if (registry.resolveType(name) == null) {
    ui.notify(`Agent config not found for "${name}".`, "warning");
    return;
  }
  const cfg = registry.resolveAgentConfig(name);
  const file = fileOps.findAgentFile(name, agentDirs());

  const choice = await ui.select(name, buildMenuOptions(cfg, file));
  if (!choice || choice === "Back") return;

  if (choice === "Edit" && file) await handleEdit(ui, name, file);
  else if (choice === "Delete" && file) await handleDelete(ui, name, file);
  else if (choice === "Reset to default" && file) await handleReset(ui, name, file);
  else if (choice.startsWith("Eject")) await ejectAgent(ui, name, cfg);
  else if (choice === "Disable") await disableAgent(ui, name);
  else if (choice === "Enable") await enableAgent(ui, name);
}
```

Cognitive complexity: ~5 (one null-check early return + flat dispatch chain with no nesting).

`ejectAgent` becomes:

```typescript
async function ejectAgent(ui: MenuUI, name: string, cfg: AgentConfig) {
  const location = await ui.select("Choose location", [...]);
  if (!location) return;
  const targetDir = location.startsWith("Project") ? projectAgentsDir : personalAgentsDir;
  const targetPath = join(targetDir, `${name}.md`);
  if (fileOps.exists(targetPath)) {
    const overwrite = await ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }
  fileOps.write(targetPath, buildEjectContent(cfg));
  registry.reload();
  ui.notify(`Ejected ${name} to ${targetPath}`, "info");
}
```

Cognitive complexity: ~6 (two early returns, one ternary, one nested if).

## Module-Level Changes

### Changed: `src/ui/agent-config-editor.ts`

- Add exported `buildMenuOptions(cfg, file)` — pure function extracted from `showAgentDetail`.
- Add exported `buildEjectContent(cfg)` — pure function extracted from `ejectAgent`.
- Add closure-internal `handleEdit(ui, name, file)` — extracted from `showAgentDetail` inline logic.
- Add closure-internal `handleDelete(ui, name, file)` — extracted from `showAgentDetail` inline logic.
- Add closure-internal `handleReset(ui, name, file)` — extracted from `showAgentDetail` inline logic.
- Simplify `showAgentDetail` to orchestrate: resolve → build menu → select → dispatch.
- Simplify `ejectAgent` to delegate frontmatter building to `buildEjectContent`.

No exports are removed or renamed.
The public API (`createAgentConfigEditor` returning `{ showAgentDetail }`) is unchanged.

### Changed: `test/ui/agent-config-editor.test.ts`

- Add `describe("buildMenuOptions")` with tests for each menu-option combination (5 cases from existing tests, restructured as direct function calls).
- Add `describe("buildEjectContent")` with tests for minimal config and config with all optional fields.
- Existing `showAgentDetail` tests remain unchanged as integration coverage.

### Changed: `docs/architecture/architecture.md`

- Update the complexity hotspots table: `showAgentDetail` drops from 25/33 to ~5/5; `ejectAgent` drops from 21/20 to ~6/6.

## Test Impact Analysis

1. **New tests enabled:** Direct unit tests for `buildMenuOptions` (pure function with 5 state combinations) and `buildEjectContent` (pure function with many optional fields).
   These were previously impossible to test in isolation because the logic was embedded in async UI flows.
2. **Existing tests that stay:** All 18 `showAgentDetail` tests remain as integration coverage — they exercise the full resolve → menu → dispatch → action pipeline.
3. **No tests become redundant:** The existing menu-option-structure tests (5 tests) overlap with `buildMenuOptions` unit tests, but they remain valuable as integration tests verifying the full flow produces the correct menu.

## TDD Order

1. **Red → Green:** Add `buildMenuOptions` unit tests (5 cases: default no-file, default with-file, custom with-file, disabled-default with-file, disabled-custom with-file).
   Export `buildMenuOptions` as a pure function.
   Extract the menu-option computation from `showAgentDetail` into it.
   Verify all existing tests pass.
   Commit: `refactor: extract buildMenuOptions from showAgentDetail`

2. **Red → Green:** Extract `handleEdit`, `handleDelete`, `handleReset` as closure-internal functions.
   Simplify `showAgentDetail` dispatch to a flat if/else chain calling named handlers.
   Verify all existing tests pass.
   Commit: `refactor: extract inline handlers from showAgentDetail`

3. **Red → Green:** Add `buildEjectContent` unit tests (minimal config, config with all optional fields, config with array extensions/skills).
   Export `buildEjectContent` as a pure function.
   Extract the frontmatter-building logic from `ejectAgent` into it.
   Verify all existing tests pass.
   Commit: `refactor: extract buildEjectContent from ejectAgent`

4. **Docs:** Update the complexity hotspots table in `docs/architecture/architecture.md`.
   Commit: `docs: update complexity table after showAgentDetail decomposition`

## Risks and Mitigations

| Risk                                                                           | Mitigation                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `buildMenuOptions` return order must match existing select mock expectations   | Unit tests verify exact array equality; integration tests remain as safety net.                                |
| `buildEjectContent` frontmatter field ordering is load-bearing for eject tests | Unit tests verify the full content string; existing eject integration test uses `stringContaining` (flexible). |
| Closure-internal handlers share mutable `fileOps`/`registry` references        | No change from current behavior — they already close over these references.                                    |

## Open Questions

None — the decomposition is mechanical extraction of existing code into named functions.
