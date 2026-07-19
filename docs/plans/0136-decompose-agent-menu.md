---
issue: 136
issue_title: "Decompose `agent-menu.ts`"
---

# Decompose agent-menu into config editor, creation wizard, and file-ops abstraction

## Problem Statement

`agent-menu.ts` (668 lines) has 8 distinct responsibilities: menu FSM orchestration, agent listing, config editing, agent ejection, two creation wizards, running-agent viewer, and settings form.
Filesystem operations (`readFileSync`, `writeFileSync`, `unlinkSync`, `existsSync`, `mkdirSync`) are scattered across 10+ call sites with no abstraction layer, forcing tests to use `vi.mock("node:fs")` rather than injecting stubs.

## Goals

- Extract an `AgentFileOps` interface abstracting all filesystem calls, with a production `FsAgentFileOps` implementation.
- Extract `ui/agent-config-editor.ts` (~170 lines) containing `showAgentDetail` with eject/disable/enable/edit/delete/reset transitions.
- Extract `ui/agent-creation-wizard.ts` (~200 lines) containing both the AI-generation and manual-form creation paths.
- Leave menu FSM, agent listing, running-agent viewer, and settings form in `agent-menu.ts` (~280 lines).
- Each extracted module receives dependencies via injection — no direct `node:fs` imports outside `FsAgentFileOps`.
- Enable unit testing of config editor and creation wizard without `vi.mock("node:fs")`.

## Non-Goals

- Refactoring the settings form or running-agent viewer — they stay in `agent-menu.ts`.
- Changing any user-facing behavior or menu flow.
- Extracting `showAllAgentsList` — it is menu orchestration (presents the list, delegates to editor for detail).
- Deduplicating the YAML frontmatter builders in eject and manual wizard (structurally different content shapes).

## Background

### Prerequisite

Issue #135 (extract display helpers) is **implemented** — `ui/display.ts` exists and provides `formatDuration`, `getDisplayName`, and other formatters.
Extracted menu sub-modules can import display helpers without pulling in the widget.

### Existing IO-injection convention

The codebase uses injectable IO interfaces to decouple domain logic from `node:fs` and the Pi SDK:

- `AssemblerIO` in `session-config.ts` — 4 methods for prompt assembly IO.
- `RunnerIO` in `agent-runner.ts` — 7 methods for session creation IO.

Both follow the same pattern: interface defined in the module that uses it, production implementation wired at the edge (`index.ts`), test stubs injected directly.

### Current fs call inventory in agent-menu.ts

| Function                         | fs calls                                                      |
| -------------------------------- | ------------------------------------------------------------- |
| `findAgentFile`                  | `existsSync` ×2                                               |
| `showAgentDetail` (edit)         | `readFileSync`, `writeFileSync`                               |
| `showAgentDetail` (delete/reset) | `unlinkSync`                                                  |
| `ejectAgent`                     | `mkdirSync`, `existsSync`, `writeFileSync`                    |
| `disableAgent`                   | `readFileSync`, `writeFileSync`, `mkdirSync`, `writeFileSync` |
| `enableAgent`                    | `readFileSync`, `writeFileSync`, `unlinkSync`                 |
| `showGenerateWizard`             | `mkdirSync`, `existsSync` ×2                                  |
| `showManualWizard`               | `mkdirSync`, `existsSync`, `writeFileSync`                    |

### Current test file

`agent-menu.test.ts` (212 lines) uses `vi.mock("node:fs")` with `vi.hoisted` stubs.
Only 7 tests exist — they cover the top-level menu, agent listing, projectAgentsDir injection, and settings delegation.
No tests exercise config-editor transitions (edit/delete/eject/disable/enable) or creation wizards.

## Design Overview

### AgentFileOps interface

A narrow interface abstracting all agent `.md` file operations:

```typescript
interface AgentFileOps {
  exists(filePath: string): boolean;
  read(filePath: string): string | undefined;
  write(filePath: string, content: string): void;
  remove(filePath: string): void;
  ensureDir(dirPath: string): void;
  findAgentFile(name: string, dirs: string[]): string | undefined;
}
```

Design notes:

- `read` returns `undefined` when the file does not exist (wraps `readFileSync` with a try/catch).
- `write` ensures parent directories exist before writing (internalizes `mkdirSync`).
- `ensureDir` is needed separately because `showGenerateWizard` creates the directory before spawning an agent that writes via Pi's tool (not via `AgentFileOps.write`).
- `findAgentFile` takes an ordered list of directories and returns the first matching path.
  The current code returns `{ path, location }` but only `showAgentDetail` uses `location` (for a confirmation dialog) — the full path already conveys the location to the user, so a plain `string | undefined` return suffices.

### FsAgentFileOps production implementation

Thin wrapper over `node:fs` synchronous APIs:

```typescript
class FsAgentFileOps implements AgentFileOps {
  exists(filePath: string): boolean {
    return existsSync(filePath);
  }
  read(filePath: string): string | undefined {
    try { return readFileSync(filePath, "utf-8"); }
    catch { return undefined; }
  }
  write(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }
  remove(filePath: string): void {
    unlinkSync(filePath);
  }
  ensureDir(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
  }
  findAgentFile(name: string, dirs: string[]): string | undefined {
    for (const dir of dirs) {
      const p = join(dir, `${name}.md`);
      if (existsSync(p)) return p;
    }
    return undefined;
  }
}
```

### Extracted module patterns

Both extracted modules follow the existing factory-function pattern (`createAgentsMenuHandler(deps)`) with narrow deps interfaces per ISP:

Config editor call-site sketch (from orchestrator):

```typescript
const editor = createAgentConfigEditor({
  fileOps: deps.fileOps,
  registry: deps.registry,
  personalAgentsDir: deps.personalAgentsDir,
  projectAgentsDir: deps.projectAgentsDir,
});
// ...
await editor.showAgentDetail(ctx, agentName);
```

Creation wizard call-site sketch (from orchestrator):

```typescript
const wizard = createAgentCreationWizard({
  fileOps: deps.fileOps,
  manager: deps.manager,
  registry: deps.registry,
  personalAgentsDir: deps.personalAgentsDir,
  projectAgentsDir: deps.projectAgentsDir,
});
// ...
await wizard.showCreateWizard(ctx);
```

### Deps interfaces (ISP-compliant)

```typescript
// agent-config-editor.ts
interface AgentConfigEditorDeps {
  fileOps: AgentFileOps;
  registry: AgentTypeRegistry;
  personalAgentsDir: string;
  projectAgentsDir: string;
}

// agent-creation-wizard.ts
interface AgentCreationWizardDeps {
  fileOps: AgentFileOps;
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  personalAgentsDir: string;
  projectAgentsDir: string;
}
```

The config editor does not need `manager` (no agent spawning).
The creation wizard does not need `agentActivity`, `getModelLabel`, or `settings`.

### Updated AgentMenuDeps

```typescript
interface AgentMenuDeps {
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  agentActivity: AgentActivityReader;
  getModelLabel: (type: string, registry?: ModelRegistry) => string;
  settings: AgentMenuSettings;
  fileOps: AgentFileOps;          // ← new
  personalAgentsDir: string;
  projectAgentsDir: string;
}
```

The single new field (`fileOps`) replaces all direct `node:fs` imports.

## Module-Level Changes

### New files

1. `src/ui/agent-file-ops.ts` — `AgentFileOps` interface + `FsAgentFileOps` class.
2. `src/ui/agent-config-editor.ts` — `AgentConfigEditorDeps` interface, `createAgentConfigEditor` factory.
   Moves in: `showAgentDetail`, `ejectAgent`, `disableAgent`, `enableAgent`.
3. `src/ui/agent-creation-wizard.ts` — `AgentCreationWizardDeps` interface, `createAgentCreationWizard` factory.
   Moves in: `showCreateWizard`, `showGenerateWizard`, `showManualWizard`.
4. `test/ui/agent-file-ops.test.ts` — unit tests for `FsAgentFileOps`.
5. `test/ui/agent-config-editor.test.ts` — unit tests for config editor transitions with injected `AgentFileOps` stubs.
6. `test/ui/agent-creation-wizard.test.ts` — unit tests for wizard paths with injected stubs.

### Modified files

1. `src/ui/agent-menu.ts`:
   - Remove `import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"`.
   - Remove `findAgentFile`, `showAgentDetail`, `ejectAgent`, `disableAgent`, `enableAgent`, `showCreateWizard`, `showGenerateWizard`, `showManualWizard` (~375 lines removed).
   - Add `fileOps: AgentFileOps` to `AgentMenuDeps`.
   - Import and instantiate `createAgentConfigEditor` and `createAgentCreationWizard`.
   - Update `showAllAgentsList` to call `editor.showAgentDetail(ctx, agentName)`.
   - Update `showAgentsMenu` to call `wizard.showCreateWizard(ctx)`.
   - Re-export `AgentMenuManager` (still needed by the wizard deps).
   - Net result: ~280 lines (orchestration, listing, running agents, settings).
2. `src/index.ts`:
   - Import `FsAgentFileOps` from `./ui/agent-file-ops.js`.
   - Construct `new FsAgentFileOps()` and pass as `fileOps` in the `createAgentsMenuHandler` call.
3. `test/ui/agent-menu.test.ts`:
   - Remove `vi.mock("node:fs")` and `vi.hoisted` stubs entirely.
   - Add `fileOps` stub to `makeDeps` factory.
   - Rewrite the "projectAgentsDir injection" test to verify that the orchestrator delegates to the editor (or move to `agent-config-editor.test.ts`).

### Removed symbols

Grep confirms these functions are only referenced within `agent-menu.ts` (closures inside `createAgentsMenuHandler`) — no external consumers:

- `findAgentFile` — moves to `agent-config-editor.ts` (reimplemented via `AgentFileOps.findAgentFile`).
- `showAgentDetail`, `ejectAgent`, `disableAgent`, `enableAgent` — move to `agent-config-editor.ts`.
- `showCreateWizard`, `showGenerateWizard`, `showManualWizard` — move to `agent-creation-wizard.ts`.

## Test Impact Analysis

### New unit tests enabled by extraction

1. **Config editor transitions** — `showAgentDetail` has 6 menu paths (edit, delete, reset, eject, disable, enable) with sub-branches (confirm/cancel, file exists/not-exists, default/custom agent).
   Currently untestable in isolation because the functions are closures inside `createAgentsMenuHandler`.
   After extraction, each transition is testable with injected `AgentFileOps` stubs — no `vi.mock("node:fs")` needed.
2. **Creation wizard flows** — generate wizard (spawn + check result) and manual wizard (multi-step form → write file) are currently untested.
   After extraction, both are testable with injected stubs for `AgentFileOps` and `AgentMenuManager.spawnAndWait`.
3. **FsAgentFileOps** — thin tests verifying the production fs wrapper (read returns undefined on missing file, write ensures parent dirs, findAgentFile checks directories in order).

### Existing tests that become redundant

The "projectAgentsDir injection" test (`agent-menu.test.ts`) navigates through the main menu → agent types → agent detail, then asserts `mockExistsSync` was called with the correct path.
After extraction, this end-to-end path tests orchestration + editor together; a focused test in `agent-config-editor.test.ts` replaces it.
The orchestrator test can be simplified to verify it delegates to the editor.

### Existing tests that stay as-is

- Menu structure tests (shows options, reload, running agents) — these test the orchestrator directly.
- Settings delegation tests — these test code that remains in `agent-menu.ts`.

## TDD Order

### Cycle 1: AgentFileOps interface and FsAgentFileOps

1. `test:` write `test/ui/agent-file-ops.test.ts` — tests for `read` (existing file, missing file), `write` (ensures parent dir), `remove`, `exists`, `ensureDir`, `findAgentFile` (first-match ordering, no match).
2. `feat:` implement `src/ui/agent-file-ops.ts` — interface + `FsAgentFileOps` class.
3. Commit: `feat: add AgentFileOps interface and FsAgentFileOps (#136)`.

### Cycle 2: Extract agent-config-editor

1. `test:` write `test/ui/agent-config-editor.test.ts` — tests for `showAgentDetail` transitions: edit (save/cancel), delete (confirm/cancel), reset-to-default (confirm/cancel), eject (project/personal location, overwrite check), disable (existing file toggle, new disable-only file), enable (remove enabled:false line, remove empty override file).
   All tests inject stub `AgentFileOps` — no `vi.mock`.
2. `refactor:` create `src/ui/agent-config-editor.ts` — move `showAgentDetail`, `ejectAgent`, `disableAgent`, `enableAgent` from `agent-menu.ts`.
   Replace direct fs calls with `deps.fileOps.*` calls.
   Replace the closure `findAgentFile` with `deps.fileOps.findAgentFile(name, [deps.projectAgentsDir, deps.personalAgentsDir])`.
3. `refactor:` update `src/ui/agent-menu.ts` — add `fileOps` to `AgentMenuDeps`, import `createAgentConfigEditor`, wire into `showAllAgentsList`.
4. `refactor:` update `src/index.ts` — import `FsAgentFileOps`, pass `fileOps: new FsAgentFileOps()` in deps.
5. `test:` update `test/ui/agent-menu.test.ts` — add `fileOps` stub to `makeDeps`, rewrite the "projectAgentsDir injection" test to verify orchestrator→editor delegation.
6. Run `pnpm run check` (interface change).
7. Commit: `refactor: extract agent-config-editor from agent-menu (#136)`.

### Cycle 3: Extract agent-creation-wizard

1. `test:` write `test/ui/agent-creation-wizard.test.ts` — tests for `showCreateWizard` (location + method selection), `showGenerateWizard` (spawn success, spawn error, overwrite check), `showManualWizard` (full form flow, overwrite check, tool/model/thinking selections).
   All tests inject stub `AgentFileOps` + `AgentMenuManager` — no `vi.mock`.
2. `refactor:` create `src/ui/agent-creation-wizard.ts` — move `showCreateWizard`, `showGenerateWizard`, `showManualWizard` from `agent-menu.ts`.
   Replace direct fs calls with `deps.fileOps.*` calls.
3. `refactor:` update `src/ui/agent-menu.ts` — import `createAgentCreationWizard`, wire into `showAgentsMenu`.
   Remove the `import { ... } from "node:fs"` line (no longer needed).
4. `test:` remove `vi.mock("node:fs")` and `vi.hoisted` stubs from `test/ui/agent-menu.test.ts` entirely.
5. Run `pnpm run check`.
6. Commit: `refactor: extract agent-creation-wizard from agent-menu (#136)`.

## Risks and Mitigations

| Risk                                                                                                      | Mitigation                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Circular dependency between orchestrator and editor (editor calling back to menu)                         | The editor's `showAgentDetail` does not recurse to the agent list — the orchestrator does (`showAllAgentsList` calls editor then recurses itself). No circular dependency.                            |
| `FsAgentFileOps.write` silently creates parent directories when callers expect the directory to not exist | `write` mirrors current behavior — every call site already calls `mkdirSync` before `writeFileSync`. The consolidation only changes where the `mkdirSync` happens, not whether it runs.               |
| Adding `fileOps` to `AgentMenuDeps` breaks existing test factory                                          | Cycle 2 updates `makeDeps` in the same commit — the interface change and call-site update land together per the testing skill's single-call-site rule.                                                |
| Generate wizard spawns an agent that writes via Pi tools, not via `AgentFileOps.write`                    | The wizard uses `fileOps.ensureDir` for directory creation and `fileOps.exists` for the post-spawn success check. The spawned agent's file write is outside the menu's control and is not abstracted. |

## Open Questions

- None — the issue's proposed changes section is unambiguous and the prerequisite (#135) is already implemented.
