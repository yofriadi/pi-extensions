---
issue: 217
issue_title: "Extract overwrite guard from UI (Phase 13, Step 4)"
---

# Extract overwrite guard from UI

## Problem Statement

The overwrite-guard + write + reload + notify pattern is duplicated between `AgentConfigEditor.ejectAgent` and `AgentCreationWizard.showManualWizard`.
Both sites check file existence, prompt for overwrite confirmation, write the file, reload the agent registry, and notify the user — identical logic with only the content and notification label differing.
This is the last remaining production clone group in the package.

## Goals

- Extract a shared `writeAgentFile` function into a new `src/ui/agent-file-writer.ts` module.
- Replace both call sites (`ejectAgent`, `showManualWizard`) with calls to the shared function.
- Achieve 0 production clone groups.
- Unit-test the extracted function in isolation.

## Non-Goals

- Extracting the partial overwrite guard in `showGenerateWizard` — that flow has different lifecycle semantics (the spawned agent does the write, and the post-write check is conditional on file existence).
  The guard-only overlap is 5 lines, not worth a separate abstraction.
- Reducing test duplication in `agent-config-editor.test.ts` or `agent-creation-wizard.test.ts` — tracked in #219 (Phase 13, Step 6).
- Changing the `disableAgent` write path — it has no overwrite guard and different notification semantics.

## Background

### Existing modules

| Module                            | Role                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `src/ui/agent-config-editor.ts`   | Agent detail view with edit/delete/eject/disable/enable transitions |
| `src/ui/agent-creation-wizard.ts` | AI-generation and manual-form agent creation flows                  |
| `src/ui/agent-file-ops.ts`        | Filesystem abstraction (`AgentFileOps` interface + production impl) |
| `src/ui/agent-menu.ts`            | `/agents` slash command menu; defines `MenuUI` interface            |

### Duplicated pattern

Both sites execute this sequence:

```typescript
if (this.fileOps.exists(targetPath)) {
  const overwrite = await ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
  if (!overwrite) return;
}
this.fileOps.write(targetPath, content);
this.registry.reload();
ui.notify(`${label} ${targetPath}`, "info");
```

The only differences are the `content` argument and the notification `label`.

### Dependency

Issue #214 (closure-to-class conversion) is closed — both consumer files are already class-based.

## Design Overview

### Extracted function

`writeAgentFile` is a free async function — not a class method — because both consumers are classes with different constructor signatures and no shared base.
The function takes narrow interface parameters following ISP: each parameter type declares only the methods the function calls.

```typescript
/** Minimal file operations for the overwrite-guard-and-write pattern. */
interface FileWriter {
  exists(filePath: string): boolean;
  write(filePath: string, content: string): void;
}

/** Minimal UI for the overwrite-guard-and-write pattern. */
interface WriterUI {
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Registry that can be reloaded after file changes. */
interface Reloadable {
  reload(): void;
}

/**
 * Write an agent file with an overwrite guard.
 *
 * Returns true if the file was written, false if the user declined to overwrite.
 */
export async function writeAgentFile(
  fileOps: FileWriter,
  ui: WriterUI,
  registry: Reloadable,
  targetPath: string,
  content: string,
  label: string,
): Promise<boolean>;
```

### Consumer call sites

In `AgentConfigEditor.ejectAgent`:

```typescript
await writeAgentFile(this.fileOps, ui, this.registry, targetPath, buildEjectContent(cfg), `Ejected ${name} to`);
```

In `AgentCreationWizard.showManualWizard`:

```typescript
await writeAgentFile(this.fileOps, ui, this.registry, targetPath, content, "Created");
```

Both callers already hold `this.fileOps` and `this.registry` as private fields, and receive `ui` as a method parameter — no wiring changes needed.

### ISP verification

The `FileWriter` interface uses 2 of `AgentFileOps`'s 6 methods (`exists`, `write`).
The `WriterUI` interface uses 2 of `MenuUI`'s 6 methods (`confirm`, `notify`).
The `Reloadable` interface uses 1 method (`reload`).
All three are structurally satisfied by the existing types without adapter code.

## Module-Level Changes

1. **New `src/ui/agent-file-writer.ts`** — exports `writeAgentFile` function and the three narrow interfaces (`FileWriter`, `WriterUI`, `Reloadable`).
2. **`src/ui/agent-config-editor.ts`** — `ejectAgent` method: replace the inline overwrite-guard + write + reload + notify block with a call to `writeAgentFile`.
   The `join(targetDir, ...)` and `buildEjectContent(cfg)` calls remain in the caller.
3. **`src/ui/agent-creation-wizard.ts`** — `showManualWizard` method: replace the inline overwrite-guard + write + reload + notify block with a call to `writeAgentFile`.
   The `join(targetDir, ...)` and content-assembly calls remain in the caller.
4. **New `test/ui/agent-file-writer.test.ts`** — unit tests for `writeAgentFile`.
5. **`docs/architecture/architecture.md`** — add `agent-file-writer.ts` to the `ui/` layout listing and update the production-duplication section to mark the clone group as resolved.

## Test Impact Analysis

1. The new `agent-file-writer.test.ts` enables focused unit tests for the overwrite-guard + write + reload + notify sequence — previously this logic was only testable through the higher-level `ejectAgent` and `showManualWizard` flows.
2. Existing tests in `agent-config-editor.test.ts` (eject overwrite prompt, eject write) and `agent-creation-wizard.test.ts` (manual wizard overwrite prompt, manual wizard write) remain as integration-level tests that verify the full flow still works end-to-end.
   They should not be removed — they test the caller's orchestration, not just the write logic.
3. No existing tests become redundant with this extraction.

## TDD Order

1. **Red → Green: `writeAgentFile` writes when target does not exist**
   - New `test/ui/agent-file-writer.test.ts` with tests: writes file, reloads registry, notifies user, returns `true`.
   - New `src/ui/agent-file-writer.ts` with the extracted function.
   - Commit: `feat: extract writeAgentFile overwrite-guard function (#217)`

2. **Red → Green: `writeAgentFile` overwrite guard**
   - Add tests: prompts for overwrite when file exists; writes and returns `true` when confirmed; does not write and returns `false` when declined.
   - Implementation should already pass (the guard is part of the function body from step 1).
   - Commit: `test: add overwrite-guard tests for writeAgentFile (#217)`

3. **Refactor: wire `ejectAgent` to use `writeAgentFile`**
   - Replace the inline overwrite-guard block in `AgentConfigEditor.ejectAgent` with a call to `writeAgentFile`.
   - Existing tests in `agent-config-editor.test.ts` must continue to pass.
   - Commit: `refactor: use writeAgentFile in AgentConfigEditor.ejectAgent (#217)`

4. **Refactor: wire `showManualWizard` to use `writeAgentFile`**
   - Replace the inline overwrite-guard block in `AgentCreationWizard.showManualWizard` with a call to `writeAgentFile`.
   - Existing tests in `agent-creation-wizard.test.ts` must continue to pass.
   - Commit: `refactor: use writeAgentFile in AgentCreationWizard.showManualWizard (#217)`

5. **Docs: update architecture**
   - Add `agent-file-writer.ts` to the `ui/` layout listing in `docs/architecture/architecture.md`.
   - Update the production-duplication section to mark the clone group as resolved.
   - Commit: `docs: update architecture for writeAgentFile extraction (#217)`

## Risks and Mitigations

1. **Notification message format drift** — The extracted function uses `${label} ${targetPath}` for the notification.
   Both current callers produce messages matching this pattern (`"Ejected ${name} to ${targetPath}"` and `"Created ${targetPath}"`).
   The label parameter gives callers full control over the prefix, so no format is baked in.
2. **Existing test fragility** — Tests use `expect.stringContaining("already exists")` for the overwrite prompt, which is stable across the extraction.
   No test rewrites needed.

## Open Questions

None — the issue's proposed change section is unambiguous and the dependency (#214) is resolved.
