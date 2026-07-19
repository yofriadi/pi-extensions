---
issue: 185
issue_title: "pi-subagents: Remove persistent agent memory feature"
---

# Remove persistent agent memory feature

## Problem Statement

The `memory.ts` module and all supporting code for persistent agent memory (`MEMORY.md`, `agent-memory/` directories) should be removed from `pi-subagents`.
The memory feature invents its own filesystem layout, file format, and security model — all outside the stated scope of `pi-subagents`, which is agent spawning, execution, and result retrieval.
This follows the same scope-reduction rationale as the scheduling subsystem removal (issue #52).

## Goals

- Remove the `memory.ts` module and all memory-related code from the package.
- Remove `MemoryScope` type and `memory` field from `AgentConfig`.
- Remove memory block injection from session assembly.
- Remove memory tool augmentation from agent-types.
- Remove memory parsing from custom agent loading.
- Remove memory display from UI components.
- Extract `isSymlink`, `isUnsafeName`, and `safeReadFile` to a shared utility module — `skill-loader.ts` depends on them independently of memory.
- Update architecture documentation to reflect the removal.

## Non-Goals

- Replacing memory with an alternative persistence mechanism — that is out of scope.
- Changing the `skill-loader.ts` logic beyond updating the import source for the extracted utilities.

## Background

The memory system spans six source modules and two UI modules:

| File                              | Memory surface                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/memory.ts`           | Core module: `buildMemoryBlock`, `buildReadOnlyMemoryBlock`, `resolveMemoryDir`, `ensureMemoryDir`, `readMemoryIndex`, plus shared utilities `isSymlink`, `isUnsafeName`, `safeReadFile` |
| `src/types.ts`                    | `MemoryScope` type, `memory?: MemoryScope` field on `AgentConfig`                                                                                                                        |
| `src/session/session-config.ts`   | `AssemblerIO.buildMemoryBlock` / `buildReadOnlyMemoryBlock` fields, memory logic block (~25 lines), `MemoryScope` import                                                                 |
| `src/config/agent-types.ts`       | `getMemoryToolNames()`, `getReadOnlyMemoryToolNames()`, `MEMORY_TOOL_NAMES`, `READONLY_MEMORY_TOOL_NAMES`                                                                                |
| `src/config/custom-agents.ts`     | `parseMemory()` function, `memory: parseMemory(fm.memory)` assignment                                                                                                                    |
| `src/session/prompts.ts`          | `memoryBlock` field on `PromptExtras`, injection into system prompt                                                                                                                      |
| `src/ui/agent-config-editor.ts`   | `if (cfg.memory) fmFields.push(...)`                                                                                                                                                     |
| `src/ui/agent-creation-wizard.ts` | `memory:` line in frontmatter help text                                                                                                                                                  |
| `src/index.ts`                    | Imports `buildMemoryBlock`, `buildReadOnlyMemoryBlock`; wires them into `assemblerIO`                                                                                                    |

The three utility functions (`isSymlink`, `isUnsafeName`, `safeReadFile`) are imported by `skill-loader.ts` for filesystem safety — they are not memory-specific and must survive the removal.

AGENTS.md constraint: the architecture doc in `docs/architecture/architecture.md` references `memory.ts` in the module listing and domain model diagram — both need updating.

## Design Overview

This is a pure removal with one extraction.
The only design decision is where to place the extracted utilities.

The three functions (`isSymlink`, `isUnsafeName`, `safeReadFile`) are filesystem safety primitives used by `skill-loader.ts`.
They belong in a new `src/session/safe-fs.ts` module in the session domain, co-located with their sole remaining consumer.

The removal works consumers-first, declaration-last:

1. Extract shared utilities to `safe-fs.ts` (additive, no behavior change).
2. Remove all memory consumers — session-config, prompts, agent-types, custom-agents, UI, index wiring.
3. Remove the declarations — `MemoryScope`, `AgentConfig.memory`, `memory.ts`.
4. Update architecture docs.

## Module-Level Changes

### New files

- `src/session/safe-fs.ts` — extracted `isSymlink`, `isUnsafeName`, `safeReadFile`.
- `test/session/safe-fs.test.ts` — tests moved from `memory.test.ts` for these three functions.

### Modified files

- `src/session/skill-loader.ts` — change import from `#src/session/memory` to `#src/session/safe-fs`.
- `src/session/session-config.ts` — remove `buildMemoryBlock` / `buildReadOnlyMemoryBlock` from `AssemblerIO`; remove `MemoryScope` import; remove entire memory logic block (~lines 215–242).
- `src/session/prompts.ts` — remove `memoryBlock` from `PromptExtras` interface; remove `extras?.memoryBlock` injection.
- `src/config/agent-types.ts` — remove `MEMORY_TOOL_NAMES`, `READONLY_MEMORY_TOOL_NAMES`, `getMemoryToolNames()`, `getReadOnlyMemoryToolNames()`.
- `src/config/custom-agents.ts` — remove `MemoryScope` import; remove `memory: parseMemory(fm.memory)` assignment; remove `parseMemory()` function.
- `src/types.ts` — remove `MemoryScope` type; remove `memory?: MemoryScope` from `AgentConfig`; remove associated doc comment.
- `src/ui/agent-config-editor.ts` — remove `if (cfg.memory)` line.
- `src/ui/agent-creation-wizard.ts` — remove `memory:` line from frontmatter help text.
- `src/index.ts` — remove `buildMemoryBlock` / `buildReadOnlyMemoryBlock` import; remove those fields from `assemblerIO` object.
- `docs/architecture/architecture.md` — remove `memory.ts` from module listing; remove Memory node from domain model Mermaid diagram; update session domain description.

### Deleted files

- `src/session/memory.ts` — entire module.
- `test/session/memory.test.ts` — entire test file (tests for `isSymlink`, `isUnsafeName`, `safeReadFile` are moved to `safe-fs.test.ts` first; remaining memory-specific tests are deleted).

### Test files modified

- `test/session/session-config.test.ts` — remove `mockBuildMemoryBlock` / `mockBuildReadOnlyMemoryBlock` mocks from `AssemblerIO` construction; remove "assembleSessionConfig — memory block selection" describe block (~lines 354–427).
- `test/session/prompts.test.ts` — remove "injects memory block in replace mode", "injects memory block in append mode", and "injects both memory and skills" test cases.
- `test/config/agent-types.test.ts` — remove `getMemoryToolNames` / `getReadOnlyMemoryToolNames` imports and test suite (~lines 26–51).
- `test/config/custom-agents.test.ts` — remove memory scope parsing tests (~lines 361–403).

## Test Impact Analysis

1. The extraction of `isSymlink`, `isUnsafeName`, `safeReadFile` to `safe-fs.ts` enables their tests to exist independently of the memory module — currently they are co-located with memory-specific tests in `memory.test.ts`.
2. The memory-specific tests in `memory.test.ts` (`resolveMemoryDir`, `ensureMemoryDir`, `readMemoryIndex`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock`) become redundant and are deleted — the code they test is being removed.
3. The memory block selection tests in `session-config.test.ts` (~70 lines) test the memory branching logic in `assembleSessionConfig` — they are deleted because that logic is removed.
4. The memory injection tests in `prompts.test.ts` test `memoryBlock` injection — deleted because the field and injection code are removed.
5. The memory parsing tests in `custom-agents.test.ts` test `parseMemory` — deleted because the function is removed.
6. The memory tool name helper tests in `agent-types.test.ts` test `getMemoryToolNames` / `getReadOnlyMemoryToolNames` — deleted because the functions are removed.
7. All other tests remain as-is — they do not depend on memory functionality.

## TDD Order

1. **Extract utilities to `safe-fs.ts`.**
   Create `src/session/safe-fs.ts` with `isSymlink`, `isUnsafeName`, `safeReadFile`.
   Create `test/session/safe-fs.test.ts` with tests moved from `memory.test.ts` for these three functions.
   Update `src/session/skill-loader.ts` import to point to `#src/session/safe-fs`.
   Update `src/session/memory.ts` import to point to `#src/session/safe-fs` (temporary — keeps memory working until removal).
   Verify: `pnpm vitest run` and `pnpm run check`.
   Commit: `refactor: extract safe-fs utilities from memory module`

2. **Remove memory from session assembly and config layers.**
   Remove `buildMemoryBlock` / `buildReadOnlyMemoryBlock` from `AssemblerIO` in `session-config.ts`.
   Remove `MemoryScope` import and all memory logic from `session-config.ts`.
   Remove `memoryBlock` from `PromptExtras` in `prompts.ts` and its injection logic.
   Remove `getMemoryToolNames`, `getReadOnlyMemoryToolNames`, `MEMORY_TOOL_NAMES`, `READONLY_MEMORY_TOOL_NAMES` from `agent-types.ts`.
   Remove `getMemoryToolNames` / `getReadOnlyMemoryToolNames` import from `session-config.ts`.
   Remove `buildMemoryBlock` / `buildReadOnlyMemoryBlock` import and `assemblerIO` fields from `index.ts`.
   Update `test/session/session-config.test.ts`: remove memory mocks from IO construction and memory block selection test suite.
   Update `test/session/prompts.test.ts`: remove memory injection tests.
   Update `test/config/agent-types.test.ts`: remove memory tool name helper tests.
   Verify: `pnpm vitest run` and `pnpm run check`.
   Commit: `feat!: remove memory from session assembly and config layers`

3. **Remove memory from types, custom-agents, and UI.**
   Remove `MemoryScope` type and `memory` field from `AgentConfig` in `types.ts`.
   Remove `parseMemory()` function, `MemoryScope` import, and `memory:` assignment from `custom-agents.ts`.
   Remove `if (cfg.memory)` line from `agent-config-editor.ts`.
   Remove `memory:` help text line from `agent-creation-wizard.ts`.
   Update `test/config/custom-agents.test.ts`: remove memory parsing tests.
   Verify: `pnpm vitest run` and `pnpm run check`.
   Commit: `feat!: remove MemoryScope type and memory config field`

4. **Delete `memory.ts` and its test file.**
   Delete `src/session/memory.ts`.
   Delete `test/session/memory.test.ts`.
   Verify: `pnpm vitest run` and `pnpm run check`.
   Commit: `feat!: delete memory module`

5. **Update architecture documentation.**
   Remove Memory node from the domain model Mermaid diagram.
   Remove `memory.ts` from the module listing.
   Update session domain description.
   Commit: `docs: update architecture after memory removal`

## Risks and Mitigations

| Risk                                                                                   | Mitigation                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users with `memory:` in custom agent frontmatter — the field silently becomes a no-op. | `parseMemory` removal means unknown frontmatter keys are ignored by the markdown parser. No error, no crash — just no memory. This is acceptable for a feature removal. |
| `skill-loader.ts` breaks if the utility extraction has a typo or missing re-export.    | Step 1 runs full test suite before proceeding. The skill-loader tests exercise `isUnsafeName` and `safeReadFile` indirectly.                                            |
| Architecture doc Mermaid diagram breaks after node removal.                            | Verify the diagram renders correctly after editing — remove both the node and all edges referencing it.                                                                 |

## Open Questions

None — the issue scope is unambiguous and all affected files have been traced.
