---
issue: 132
issue_title: "Inject IO collaborators into `assembleSessionConfig`"
---

# Inject IO collaborators into session-config

## Problem Statement

`assembleSessionConfig` is described as a pure configuration assembler, but it directly imports three IO-touching functions (`preloadSkills`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock`) and one pure function (`buildAgentPrompt`).
This forces `session-config.test.ts` to use 4 `vi.mock()` calls, 8 hoisted mock functions, and assertions that verify internal call sequences rather than output properties.
The result is fragile tests that break on any internal restructuring even when observable behavior is unchanged.

## Goals

- Define an `AssemblerIO` interface bundling the four collaborators.
- Add `io: AssemblerIO` as a parameter to `assembleSessionConfig()`.
- Replace direct imports of the four functions with calls through `io`.
- Update the single production call site in `agent-runner.ts` to pass real implementations.
- Eliminate all 4 `vi.mock()` calls in `session-config.test.ts`.
- Shift test assertions toward output-property verification.

## Non-Goals

- SDK boundary injection into `agent-runner` (Step H, #133) — depends on this change but is deferred to its own issue.
- Consolidating shared test fixtures (#131) — independent refactor that can land before or after.
- Changing the behavior of `assembleSessionConfig` — this is a pure structural refactor.
- Injecting `getMemoryToolNames` / `getReadOnlyMemoryToolNames` — these are pure utility functions with no IO; they stay as direct imports.

## Background

### Current state

`session-config.ts` imports four functions used during assembly:

| Function                   | Module            | IO?                            | Purpose in assembler                    |
| -------------------------- | ----------------- | ------------------------------ | --------------------------------------- |
| `preloadSkills`            | `skill-loader.ts` | Yes (reads `.pi/skills` files) | Loads skill content into prompt extras  |
| `buildMemoryBlock`         | `memory.ts`       | Yes (reads `MEMORY.md`)        | Builds read-write memory prompt section |
| `buildReadOnlyMemoryBlock` | `memory.ts`       | Yes (reads `MEMORY.md`)        | Builds read-only memory prompt section  |
| `buildAgentPrompt`         | `prompts.ts`      | No (pure)                      | Assembles final system prompt string    |

The test file mocks all four via `vi.mock()` plus mocks `getMemoryToolNames` and `getReadOnlyMemoryToolNames` from `agent-types.ts` (pure functions that are mocked only for call-argument verification).

### Established DI pattern

`AgentManager` already injects `AgentRunner` via its constructor options — the same tell-don't-ask pattern used here.
`assembleSessionConfig` already receives an `AgentConfigLookup` registry by parameter (migrated in #80/#108), demonstrating the incremental injection approach.

### Architecture reference

Phase 8, Step G in `docs/architecture/architecture.md`.

### Constraints from AGENTS.md

- Keep scope tight; prefer small, reversible changes.
- Prefer explicit configuration over hidden behavior.
- Business logic should be pure functions — keep IO at the edges.

## Design Overview

### `AssemblerIO` interface

Defined in `session-config.ts` alongside the existing assembler types:

```typescript
export interface AssemblerIO {
  preloadSkills: (skills: string[], cwd: string) => PreloadedSkill[];
  buildMemoryBlock: (
    name: string,
    scope: MemoryScope,
    cwd: string,
  ) => string;
  buildReadOnlyMemoryBlock: (
    name: string,
    scope: MemoryScope,
    cwd: string,
  ) => string;
  buildAgentPrompt: (
    config: AgentPromptConfig,
    cwd: string,
    env: EnvInfo,
    parentPrompt?: string,
    extras?: PromptExtras,
  ) => string;
}
```

The interface uses the same parameter types as the real functions.
The assembler calls `io.preloadSkills(...)` etc. instead of the direct imports.

### Call site in `agent-runner.ts`

```typescript
import { preloadSkills } from "./skill-loader.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt } from "./prompts.js";

const io: AssemblerIO = {
  preloadSkills,
  buildMemoryBlock,
  buildReadOnlyMemoryBlock,
  buildAgentPrompt,
};

const cfg = assembleSessionConfig(type, ctx, options, env, registry, io);
```

The runner constructs the real IO object once and passes it through.
This keeps IO at the edge (runner) and makes the assembler a genuine pure function.

### Test-side stubs

Tests create a plain object with `vi.fn()` stubs satisfying `AssemblerIO`:

```typescript
const io: AssemblerIO = {
  preloadSkills: vi.fn(() => []),
  buildMemoryBlock: vi.fn(() => "memory block"),
  buildReadOnlyMemoryBlock: vi.fn(() => "read-only memory block"),
  buildAgentPrompt: vi.fn(() => "assembled system prompt"),
};
```

This replaces all four `vi.mock()` calls and the hoisted mocks for those modules.

### Pure utility functions stay as direct imports

`getMemoryToolNames` and `getReadOnlyMemoryToolNames` from `agent-types.ts` are pure functions (no IO, no filesystem access).
After the IO injection, the test's `vi.mock("../src/agent-types.js", ...)` can be removed and real implementations used.
Tests that previously controlled these mocks to verify call arguments will instead set up input tool names to produce the desired output from the real functions, then assert on the returned `SessionConfig.toolNames`.

## Module-Level Changes

### Modified files

1. `src/session-config.ts`
   - Add `AssemblerIO` interface export.
   - Add `io: AssemblerIO` parameter to `assembleSessionConfig()` (after `registry`).
   - Replace `preloadSkills(...)` with `io.preloadSkills(...)`.
   - Replace `buildMemoryBlock(...)` with `io.buildMemoryBlock(...)`.
   - Replace `buildReadOnlyMemoryBlock(...)` with `io.buildReadOnlyMemoryBlock(...)`.
   - Replace `buildAgentPrompt(...)` with `io.buildAgentPrompt(...)`.
   - Remove imports of `preloadSkills`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock`, `buildAgentPrompt`.
   - Keep imports of `getMemoryToolNames`, `getReadOnlyMemoryToolNames` (pure, no change).

2. `src/agent-runner.ts`
   - Add imports for `preloadSkills`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock`, `buildAgentPrompt`.
   - Import `AssemblerIO` type from `session-config.ts`.
   - Construct `AssemblerIO` object from real implementations.
   - Pass `io` to `assembleSessionConfig()`.

3. `test/session-config.test.ts`
   - Remove all 4 `vi.mock()` calls and the corresponding hoisted mocks.
   - Create `io` stub object with `vi.fn()` implementations.
   - Pass `io` to every `assembleSessionConfig()` call.
   - Update memory-section tests to use real `getMemoryToolNames` / `getReadOnlyMemoryToolNames`.
   - Migrate mock-call assertions to output-property assertions where the output already captures the information.

## Test Impact Analysis

1. The IO injection enables testing `assembleSessionConfig` without any module mocking.
   Tests can choose to inject real implementations with controlled inputs (integration-style) or stubs (unit-style).
   Previously this was impossible without `vi.mock()`.

2. Several existing tests that only verified mock-call arguments become redundant once we verify the same information through output properties (e.g., "calls buildAgentPrompt with env, cwd, parentSystemPrompt, and extras" is redundant if we verify `result.systemPrompt` reflects those inputs).
   These can be simplified or removed.

3. Tests for model resolution, isolated mode, thinking level, and unknown-type fallback stay as-is — they already assert output properties and are unaffected by the IO injection.

## TDD Order

1. **Define `AssemblerIO` and inject into `assembleSessionConfig`.**
   Add the `AssemblerIO` interface to `session-config.ts`.
   Add `io: AssemblerIO` as a required parameter.
   Replace the 4 direct function calls with `io.*` calls.
   Remove the 4 function imports from `session-config.ts`.
   Add the 4 imports to `agent-runner.ts` and construct the `io` object at the call site.
   Run `pnpm run check` to verify types compile.
   Commit: `feat: inject IO collaborators into assembleSessionConfig (#132)`

2. **Migrate test file to use injected IO stubs.**
   Create an `io` stub object with `vi.fn()` stubs matching the existing hoisted mocks' default return values.
   Pass `io` to all `assembleSessionConfig()` calls.
   Remove the 3 `vi.mock()` calls for `prompts.js`, `memory.js`, and `skill-loader.js`.
   Remove the corresponding hoisted mock variables (`mockBuildAgentPrompt`, `mockBuildMemoryBlock`, `mockBuildReadOnlyMemoryBlock`, `mockPreloadSkills`).
   Update `beforeEach` to reset the `io` stubs instead.
   All existing tests pass with the same assertions (io stubs replace module mocks).
   Commit: `test: replace vi.mock with injected IO stubs in session-config tests`

3. **Drop the `agent-types.js` mock; use real pure functions.**
   Remove the `vi.mock("../src/agent-types.js", ...)` call and the `importOriginal` pattern.
   Remove hoisted `mockGetMemoryToolNames` and `mockGetReadOnlyMemoryToolNames`.
   Update memory-section tests to set up `mockGetToolNamesForType` return values that produce the desired output from the real `getMemoryToolNames` / `getReadOnlyMemoryToolNames`.
   Assertions shift from "mock was called with Set" to "result.toolNames contains expected names".
   Commit: `test: use real getMemoryToolNames in session-config tests`

4. **Shift remaining mock-call assertions to output-property checks.**
   Replace `expect(io.buildAgentPrompt).toHaveBeenCalledWith(...)` with assertions on `result.systemPrompt` (requires io.buildAgentPrompt stub to echo identifying values).
   Replace `expect(io.preloadSkills).toHaveBeenCalledWith(skillList, "/tmp")` with `result.extras.skillBlocks` checks (already partially present).
   Remove test cases that are now fully redundant with output-based tests in the same describe block.
   Clean up any unused imports and variables.
   Commit: `test: verify output properties in session-config tests (#132)`

## Risks and Mitigations

| Risk                                                                                                      | Mitigation                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a parameter to `assembleSessionConfig` breaks the `agent-runner.ts` call site                      | Only one production call site exists; updated in the same commit (step 1). `pnpm run check` verifies.                                                                                   |
| Removing `vi.mock()` causes tests to accidentally call real IO functions                                  | The real functions are no longer imported by `session-config.ts` after step 1. The module simply doesn't reach them. Vitest will error if any unmocked import is called.                |
| Using real `getMemoryToolNames` / `getReadOnlyMemoryToolNames` makes tests depend on their implementation | These are pure, stable utility functions (return tool names from a set). Their behavior is well-defined and unlikely to change. Using real implementations is more robust than mocking. |
| Step 2 touches 40+ call sites in the test file                                                            | All changes are mechanical (add `, io` argument). A find-and-replace handles it. Each call already passes `mockAgentLookup` as the last arg; the new arg follows the same pattern.      |

## Open Questions

- Should `AssemblerIO` be co-located in `session-config.ts` or extracted to a separate `session-config-types.ts`?
  The interface is small (4 methods) and tightly coupled to the assembler.
  Co-location in `session-config.ts` follows the existing pattern (`AssemblerContext`, `AssemblerOptions`, `SessionConfig` are all in the same file).
  Extract only if it grows or gains consumers beyond `agent-runner.ts`.
