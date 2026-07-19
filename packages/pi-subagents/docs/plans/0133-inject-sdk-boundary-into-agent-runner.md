---
issue: 133
issue_title: "Inject SDK boundary into `agent-runner`"
---

# Inject SDK boundary into agent-runner

## Problem Statement

`agent-runner.ts` directly imports five Pi SDK symbols (`createAgentSession`, `DefaultResourceLoader`, `getAgentDir`, `SessionManager`, `SettingsManager`) and two sibling modules (`detectEnv`, `deriveSubagentSessionDir`).
It also imports four functions (`preloadSkills`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock`, `buildAgentPrompt`) solely to construct the `AssemblerIO` object introduced in #132.
This forces `agent-runner.test.ts` to use 7 `vi.mock()` calls, a `vi.hoisted()` block with 5+ mock factories, and a `beforeEach` that manually resets 6+ mocks.
Tests verify internal call patterns ("defaultResourceLoaderCtor was called with `noContextFiles: true`") rather than behavioral outcomes, making any internal restructuring break multiple tests without changing observable behavior.
The same 7-mock pattern is duplicated in `agent-runner-extension-tools.test.ts`.

## Goals

- Define a `RunnerIO` interface bundling all SDK and IO collaborators used by `runAgent()`.
- Add `io: RunnerIO` as a parameter to `runAgent()`.
- Provide a `createAgentRunner(io: RunnerIO): AgentRunner` factory so the `AgentRunner` interface and `AgentManager` remain unchanged.
- Replace direct SDK and sibling-module imports in `runAgent()` with calls through `io`.
- Update the wiring in `index.ts` to construct a real `RunnerIO` and use `createAgentRunner()`.
- Eliminate all 7 `vi.mock()` calls in `agent-runner.test.ts`.
- Eliminate all 7 `vi.mock()` calls in `agent-runner-extension-tools.test.ts`.
- Shift test assertions toward behavioral outcomes (turn limits enforced, tool filtering correct, response text collected).

## Non-Goals

- Changing `resumeAgent` — it receives an already-created `AgentSession` and has no SDK/IO deps to inject.
- Injecting `assembleSessionConfig` itself — the function is pure (after #132) and stays as a direct import; only its `AssemblerIO` collaborators move into `RunnerIO`.
- Injecting `getMemoryToolNames` / `getReadOnlyMemoryToolNames` — these are pure utility functions with no IO; they remain as direct imports in `session-config.ts`.
- Refactoring `filterActiveTools` or the turn-limit logic — out of scope.
- Consolidating shared test fixtures (#131) — independent work.

## Background

### Prerequisite

Issue #132 (inject IO into session-config) is closed.
`assembleSessionConfig` now receives an `AssemblerIO` parameter and no longer imports IO functions directly.
However, `agent-runner.ts` still imports those four functions to construct the `AssemblerIO` object, and the SDK factories remain as direct imports.

### Current vi.mock inventory in agent-runner.test.ts

| #   | Module                            | Symbols mocked                                                                                    | Why mocked                            |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | `@earendil-works/pi-coding-agent` | `createAgentSession`, `DefaultResourceLoader`, `getAgentDir`, `SessionManager`, `SettingsManager` | SDK constructors and factories        |
| 2   | `../src/agent-types.js`           | `getMemoryToolNames`, `getReadOnlyMemoryToolNames`                                                | Pure functions used by session-config |
| 3   | `../src/env.js`                   | `detectEnv`                                                                                       | Async IO (shell exec)                 |
| 4   | `../src/prompts.js`               | `buildAgentPrompt`                                                                                | Relayed to AssemblerIO                |
| 5   | `../src/memory.js`                | `buildMemoryBlock`, `buildReadOnlyMemoryBlock`                                                    | Relayed to AssemblerIO                |
| 6   | `../src/skill-loader.js`          | `preloadSkills`                                                                                   | Relayed to AssemblerIO                |
| 7   | `../src/session-dir.js`           | `deriveSubagentSessionDir`                                                                        | Path derivation                       |

`agent-runner-extension-tools.test.ts` has an identical set.

### Established DI patterns

- `AgentManager` already receives `AgentRunner` via constructor injection — the same boundary this issue pushes down one layer.
- `AssemblerIO` (#132) bundles four IO collaborators into a single injectable interface.
- `AgentManagerLike` in `service-adapter.ts` defines a narrow interface for the concrete `AgentManager` class, avoiding coupling to the concrete type.

### Architecture reference

Phase 8, Step H in `docs/architecture/architecture.md`.

### Constraints from AGENTS.md

- Keep scope tight; prefer small, reversible changes.
- Prefer explicit configuration over hidden behavior.
- Business logic should be pure functions — keep IO at the edges.
- Keep Pi SDK imports out of business-logic modules.

## Design Overview

### `RunnerIO` interface

Defined in `agent-runner.ts` alongside the existing runner types.
Bundles all IO dependencies that `runAgent()` uses:

```typescript
/** Minimal resource-loader contract used by the runner. */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal session-manager contract used by the runner. */
export interface SessionManagerLike {
  newSession(opts: { parentSession?: string }): void;
  getSessionFile(): string | undefined;
}

/** Options passed to RunnerIO.createResourceLoader. */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPromptOverride?: () => string;
  appendSystemPromptOverride?: () => unknown[];
}

/** Options passed to RunnerIO.createSession. */
export interface CreateSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerLike;
  settingsManager: unknown;
  modelRegistry: unknown;
  model?: unknown;
  tools: string[];
  resourceLoader: ResourceLoaderLike;
  thinkingLevel?: ThinkingLevel;
}

/**
 * IO boundary injected into runAgent().
 *
 * Decouples the runner from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface RunnerIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  deriveSessionDir: (
    parentSessionFile: string | undefined,
    effectiveCwd: string,
  ) => string;
  createSessionManager: (
    cwd: string,
    sessionDir: string,
  ) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => unknown;
  createSession: (
    opts: CreateSessionOptions,
  ) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}
```

The interface has 8 fields (7 functions + 1 nested `AssemblerIO`).
All 8 are consumed by `runAgent()` — no field is relayed without use.

### `createAgentRunner` factory

```typescript
export function createAgentRunner(io: RunnerIO): AgentRunner {
  return {
    run: (snapshot, type, prompt, options) =>
      runAgent(snapshot, type, prompt, options, io),
    resume: resumeAgent,
  };
}
```

This keeps the `AgentRunner` interface unchanged.
`AgentManager` continues to receive an `AgentRunner` — it never sees `RunnerIO`.

### Call site in `index.ts`

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt } from "./prompts.js";
import { deriveSubagentSessionDir } from "./session-dir.js";
import { preloadSkills } from "./skill-loader.js";

const runnerIO: RunnerIO = {
  detectEnv,
  getAgentDir,
  createResourceLoader: (opts) => new DefaultResourceLoader(opts),
  deriveSessionDir: deriveSubagentSessionDir,
  createSessionManager: (cwd, dir) => SessionManager.create(cwd, dir),
  createSettingsManager: (cwd, dir) => SettingsManager.create(cwd, dir),
  createSession: createAgentSession,
  assemblerIO: {
    preloadSkills,
    buildMemoryBlock,
    buildReadOnlyMemoryBlock,
    buildAgentPrompt,
  },
};

const manager = new AgentManager({
  runner: createAgentRunner(runnerIO),
  // ... rest unchanged
});
```

SDK and IO imports move from `agent-runner.ts` to `index.ts` — the extension entry point, which is the natural IO edge.

### Test-side stubs

Tests create a plain `RunnerIO` object with `vi.fn()` stubs:

```typescript
function createRunnerIO(): RunnerIO {
  return {
    detectEnv: vi.fn(async () => ({
      isGitRepo: false,
      branch: "",
      platform: "linux",
    })),
    getAgentDir: vi.fn(() => "/mock/agent-dir"),
    createResourceLoader: vi.fn(() => ({ reload: vi.fn() })),
    deriveSessionDir: vi.fn(() => "/mock/session-dir/tasks"),
    createSessionManager: vi.fn(() => ({
      newSession: vi.fn(),
      getSessionFile: vi.fn(() => "/sessions/child.jsonl"),
    })),
    createSettingsManager: vi.fn(() => ({ kind: "settings-manager" })),
    createSession: vi.fn(),
    assemblerIO: {
      preloadSkills: vi.fn(() => []),
      buildMemoryBlock: vi.fn(() => ""),
      buildReadOnlyMemoryBlock: vi.fn(() => ""),
      buildAgentPrompt: vi.fn(() => "system prompt"),
    },
  };
}
```

This replaces all 7 `vi.mock()` calls, the `vi.hoisted()` block, and most of the `beforeEach` resets.
Each test calls `runAgent(snapshot, type, prompt, options, io)` directly with a stub `io`.

### Interaction verification — consumer call site (Tell-Don't-Ask check)

```typescript
// In index.ts — the consumer constructs RunnerIO and hands it off:
const runnerIO: RunnerIO = { detectEnv, getAgentDir, ... };
const manager = new AgentManager({
  runner: createAgentRunner(runnerIO),
});
// AgentManager calls runner.run(...) — never reaches through to runnerIO.
// Tell-Don't-Ask: ✓  Manager tells runner to run; runner uses its own IO.
```

### Pure functions stay as direct imports

`assembleSessionConfig` (pure after #132), `filterActiveTools` (module-private), `normalizeMaxTurns` (pure exported), `collectResponseText`, `getLastAssistantText`, and `forwardAbortSignal` remain as direct code — they have no IO dependencies.

`getMemoryToolNames` / `getReadOnlyMemoryToolNames` in `session-config.ts` remain as direct imports (pure, no IO).
The `vi.mock("../src/agent-types.js", ...)` in both test files can be removed because the mock agent config has no `memory` field, so the memory branch in `assembleSessionConfig` is never entered and those functions are never called.

## Module-Level Changes

### Modified files

1. `src/agent-runner.ts`
   - Add `RunnerIO`, `ResourceLoaderLike`, `SessionManagerLike`, `ResourceLoaderOptions`, `CreateSessionOptions` interface exports.
   - Add `createAgentRunner(io: RunnerIO): AgentRunner` factory export.
   - Add `io: RunnerIO` parameter to `runAgent()`.
   - Replace `detectEnv(...)` with `io.detectEnv(...)`.
   - Replace `getAgentDir()` with `io.getAgentDir()`.
   - Replace `new DefaultResourceLoader(...)` with `io.createResourceLoader(...)`.
   - Replace `deriveSubagentSessionDir(...)` with `io.deriveSessionDir(...)`.
   - Replace `SessionManager.create(...)` with `io.createSessionManager(...)`.
   - Replace `SettingsManager.create(...)` with `io.createSettingsManager(...)`.
   - Replace `createAgentSession(...)` with `io.createSession(...)`.
   - Replace inline `AssemblerIO` construction with `io.assemblerIO`.
   - Remove imports: `createAgentSession`, `DefaultResourceLoader`, `getAgentDir`, `SessionManager`, `SettingsManager` from `@earendil-works/pi-coding-agent`; `detectEnv` from `./env.js`; `deriveSubagentSessionDir` from `./session-dir.js`; `preloadSkills` from `./skill-loader.js`; `buildMemoryBlock`, `buildReadOnlyMemoryBlock` from `./memory.js`; `buildAgentPrompt` from `./prompts.js`.
   - Keep imports: `type AgentSession`, `type AgentSessionEvent` from SDK (used in function signatures and event handling); `type AssemblerIO` from `./session-config.js`; `assembleSessionConfig` from `./session-config.js`; `extractText` from `./context.js`.

2. `src/index.ts`
   - Add imports: `detectEnv` from `./env.js`; `deriveSubagentSessionDir` from `./session-dir.js`; `preloadSkills` from `./skill-loader.js`; `buildMemoryBlock`, `buildReadOnlyMemoryBlock` from `./memory.js`; `buildAgentPrompt` from `./prompts.js`.
   - Add import: `createAgentRunner`, `type RunnerIO` from `./agent-runner.js`.
   - Remove import: `runAgent` from `./agent-runner.js` (replaced by factory).
   - Construct `runnerIO` object from real implementations.
   - Replace `runner: { run: runAgent, resume: resumeAgent }` with `runner: createAgentRunner(runnerIO)`.

3. `test/agent-runner.test.ts`
   - Remove all 7 `vi.mock()` calls and the `vi.hoisted()` block.
   - Add `createRunnerIO()` factory function returning a stub `RunnerIO`.
   - Pass `io` to all `runAgent()` calls.
   - Simplify `beforeEach` to reset `io.createSession` (the only mock that needs per-test setup).
   - Remove `mockAgentLookup.resolveAgentConfig` and `mockAgentLookup.getToolNamesForType` resets that are now unnecessary.
   - Update assertions that verify SDK constructor arguments (e.g., `defaultResourceLoaderCtor` calls) to verify `io.createResourceLoader` calls instead.
   - Remove the `agent-types.js` mock — pure functions run against controlled inputs.

4. `test/agent-runner-extension-tools.test.ts`
   - Same structural changes as `agent-runner.test.ts`: remove all 7 `vi.mock()` calls, inject `RunnerIO` stubs.
   - Keep the `createSessionWithExtensionToolRegistration` helper — it creates mock sessions for testing post-bind tool filtering, which is behavioral.
   - Update assertions to use `io.createResourceLoader` / `io.createSession` stubs.

### Unchanged files

- `src/agent-manager.ts` — receives `AgentRunner` via injection; unaffected by `RunnerIO`.
- `test/agent-manager.test.ts` — already injects a mock `AgentRunner`; unaffected.
- `src/session-config.ts` — pure function, already receives `AssemblerIO`; unaffected.
- `test/session-config.test.ts` — tests the pure assembler directly; unaffected.
- `test/agent-runner-settings.test.ts` — tests `normalizeMaxTurns` (pure, no mocks); unaffected.
- `test/print-mode.test.ts` — mocks `runAgent` itself at the module level; unaffected (it tests `index.ts` notification wiring, not the runner internals).

## Test Impact Analysis

1. The `RunnerIO` injection enables testing `runAgent` without any module mocking.
   Tests create plain stub objects satisfying `RunnerIO` — no `vi.mock()`, no `vi.hoisted()`, no module-level mock variable management.
   This was previously impossible because `runAgent` hard-imported SDK constructors.

2. Several existing tests that verify mock constructor arguments become redundant or shift to verifying `io.*` stub calls:
   - "passes effective cwd and agentDir to the loader and settings manager" → verifies `io.createResourceLoader` and `io.createSettingsManager` were called with expected args (simpler, no `defaultResourceLoaderCtor` indirection).
   - "suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents" → verifies `io.createResourceLoader` was called with `noContextFiles: true` and an `appendSystemPromptOverride` that returns `[]`.

3. Tests for turn-limit enforcement, abort forwarding, and response-text collection stay as-is — they already test behavioral outcomes through the mock session, not through SDK mock call patterns.

4. The extension-tools tests (Patch 2) remain behavioral — they verify `setActiveToolsByName` calls before/after `bindExtensions`.
   The only change is how the session is created (via `io.createSession` stub instead of a module mock).

5. The `agent-types.js` mock can be removed from both test files because the mock agent configs have no `memory` field, so the code path through `getMemoryToolNames` / `getReadOnlyMemoryToolNames` is never reached.

## TDD Order

1. **Define `RunnerIO` and `createAgentRunner`; inject IO into `runAgent`.**
   Add the `RunnerIO`, `ResourceLoaderLike`, `SessionManagerLike`, `ResourceLoaderOptions`, and `CreateSessionOptions` interfaces to `agent-runner.ts`.
   Add `io: RunnerIO` parameter to `runAgent()`.
   Add `createAgentRunner(io)` factory export.
   Replace all direct SDK and IO imports with `io.*` calls inside `runAgent()`.
   Remove the now-unused direct imports.
   Update `index.ts` to construct `runnerIO` from real implementations and use `createAgentRunner(runnerIO)`.
   Run `pnpm run check` to verify types compile.
   Commit: `feat: inject SDK boundary into agent-runner via RunnerIO (#133)`

2. **Migrate `agent-runner.test.ts` to use injected `RunnerIO` stubs.**
   Add `createRunnerIO()` helper returning a fully-stubbed `RunnerIO`.
   Pass `io` to all `runAgent()` calls.
   Remove all 7 `vi.mock()` calls and the `vi.hoisted()` block.
   Simplify `beforeEach` to reset only `io.createSession`.
   Update assertions that referenced hoisted mocks (e.g., `defaultResourceLoaderCtor`, `sessionManagerCreate`, `settingsManagerCreate`, `getAgentDir`) to reference `io.*` stubs.
   Remove the `mockAgentLookup` mock resets that are now unnecessary.
   All existing tests pass with equivalent assertions.
   Commit: `test: replace vi.mock with RunnerIO stubs in agent-runner tests (#133)`

3. **Migrate `agent-runner-extension-tools.test.ts` to use injected `RunnerIO` stubs.**
   Same structural changes as step 2: remove all 7 `vi.mock()` calls, inject `RunnerIO` stubs.
   Keep `createSessionWithExtensionToolRegistration` helper (tests tool filtering behavior).
   Simplify `beforeEach` and update stub references.
   Commit: `test: replace vi.mock with RunnerIO stubs in extension-tools tests (#133)`

4. **Shift constructor-argument assertions to behavioral checks.**
   In `agent-runner.test.ts`, update tests that verify internal SDK call arguments:
   - Replace `expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({...}))` with `expect(io.createResourceLoader).toHaveBeenCalledWith(expect.objectContaining({...}))`.
   - Where the assertion only verified plumbing (e.g., "settings manager gets the right cwd"), simplify to a behavioral assertion or remove if covered by other tests.
   - Keep assertions that verify meaningful configuration decisions (e.g., `noContextFiles: true`, `appendSystemPromptOverride` returns `[]`).
   Run full test suite.
   Commit: `test: shift agent-runner assertions toward behavioral checks (#133)`

## Risks and Mitigations

| Risk                                                                                                    | Mitigation                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunnerIO` at 8 fields may seem wide                                                                    | All 8 are consumed by the single consumer (`runAgent`). No field is relayed without use. The interface represents a genuine IO boundary — further narrowing would require splitting `runAgent` itself (out of scope). |
| Removing the `agent-types.js` mock could cause failures if a test unexpectedly enters the memory branch | The mock agent config has no `memory` field (`undefined`), so the memory branch is guarded by `if (agentConfig.memory)`. Verified by reading the test's `resolveAgentConfig` mock return value.                       |
| `index.ts` accumulates many new imports                                                                 | The imports move from `agent-runner.ts` to `index.ts` — the extension entry point is the natural IO edge. The total import count across the two files is unchanged.                                                   |
| `createAgentRunner` factory adds indirection                                                            | The factory is a one-liner that captures `io` in a closure. The `AgentRunner` interface and `AgentManager` are completely unchanged. No new abstraction layer — just a construction-time binding.                     |
| Steps 2–3 touch many call sites in two test files (add `, io` argument)                                 | All changes are mechanical. Each `runAgent(snapshot, type, prompt, {...})` becomes `runAgent(snapshot, type, prompt, {...}, io)`. A single find-and-replace handles it.                                               |
| `print-mode.test.ts` mocks `runAgent` at the module level — does the new `io` parameter break it?       | `print-mode.test.ts` mocks the entire `runAgent` export with `vi.mock("../src/agent-runner.js", ...)`. The mock replaces the function entirely, so the new parameter has no effect on that test.                      |

## Open Questions

- Should `RunnerIO` live in `agent-runner.ts` or be extracted to a separate types file?
  The interface is tightly coupled to `runAgent()` — co-location follows the `AssemblerIO` precedent in `session-config.ts`.
  Extract only if a second consumer appears.
