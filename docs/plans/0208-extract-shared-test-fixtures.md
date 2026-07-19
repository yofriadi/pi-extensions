---
issue: 208
issue_title: "Extract shared test fixtures to reduce test duplication"
---

# Extract shared test fixtures

## Problem Statement

Test duplication across the pi-subagents package is 1,367 lines (7.2%) across 23 files (67 clone groups per fallow analysis).
The three heaviest clone families are:

1. Runner IO tests (`agent-runner.test.ts` + `agent-runner-extension-tools.test.ts` + `concrete-agent-runner.test.ts`): 60-line shared setup — `createRunnerIO()`, `AgentConfigLookup` stub, `ParentSnapshot` constant.
2. Menu/wizard UI tests (`agent-menu.test.ts` + `agent-creation-wizard.test.ts` + `agent-config-editor.test.ts`): 54+51+24 lines — `makeFileOps()`, `makeUI()`, `makeManager()`, `AgentConfig` defaults, `ParentSnapshot` constant.
3. `agent-manager.test.ts` internal: 18 clone groups, 210 duplicated lines — repetitive `manager.spawn(...)` call patterns.

Issue #131 (closed) already extracted `createMockSession`, `createToolDeps`, and `createTestRecord` into `test/helpers/`.
This issue targets the remaining duplication families.

## Goals

- Extract `createRunnerIO()` and `createAgentLookup()` into `test/helpers/runner-io.ts` — single source of truth for the `RunnerIO` and `AgentConfigLookup` stubs used by runner tests.
- Extract `makeFileOps()`, `makeMenuUI()`, `makeMenuManager()`, and `createTestAgentConfig()` into `test/helpers/ui-stubs.ts` — shared factories for the three UI test files.
- Consolidate `agent-manager.test.ts` internal duplication with local helper functions (`spawnBg`, `spawnFg`).
- Replace local `ParentSnapshot` definitions with the existing `STUB_SNAPSHOT` from `test/helpers/stub-ctx.ts` where possible.
- Remove stale `buildMemoryBlock` and `buildReadOnlyMemoryBlock` stubs from the `createRunnerIO` factory (these methods no longer exist on `AssemblerIO`).
- Target: ~250 lines of test duplication removed.

## Non-Goals

- Extracting session mock factories from the runner tests — each file's session factory serves a specialized purpose (`createSession(finalText)`, `createSessionWithExtensionToolRegistration(beforeBind, afterBind)`, `makeSession(text)`) and the variance is structural, not incidental.
- Extracting `makeSettings()` from `agent-menu.test.ts` — only used in one file.
- Extracting `makeHandler()` / `makeEditor()` / `makeDeps()` wrapper functions that compose collaborator stubs for specific handlers — too tightly coupled to each file's test structure.
- Extracting the mutable `agentConfigMock` pattern from `agent-runner-extension-tools.test.ts` — its per-test config mutation is inherently local.
- Decomposing UI complexity (Steps 1–3 of Phase 12, issues #205, #206, #207) — separate issues.

## Background

### Existing test helpers

`test/helpers/` already contains shared factories from issue #131:

| File              | Exports                                   | Used by                                                 |
| ----------------- | ----------------------------------------- | ------------------------------------------------------- |
| `mock-session.ts` | `createMockSession()`, `toAgentSession()` | agent-manager, record-observer, ui-observer tests       |
| `make-deps.ts`    | `createToolDeps()`                        | agent-tool, background-spawner, foreground-runner tests |
| `make-record.ts`  | `createTestRecord()`                      | tool tests, UI tests                                    |
| `stub-ctx.ts`     | `STUB_CTX`, `STUB_SNAPSHOT`               | tool tests (via `make-deps.ts`)                         |

The new factories follow the same pattern: shared files in `test/helpers/` with optional unit tests.

### Architecture doc reference

Phase 12, Step 4 in `docs/architecture/architecture.md` (lines 637–644) calls for `test/fixtures/` modules.
We use `test/helpers/` instead to follow the existing convention established in issue #131.
The architecture doc reference will be updated as part of this work.

### Interface shapes

`RunnerIO` = `EnvironmentIO & SessionFactoryIO` (in `src/lifecycle/agent-runner.ts`):

```typescript
interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (parentSessionFile: string | undefined, cwd: string) => string;
}

interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}
```

`AssemblerIO` (in `src/session/session-config.ts`) has only `preloadSkills` and `buildAgentPrompt`.
The existing test factories in `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` include stale `buildMemoryBlock` and `buildReadOnlyMemoryBlock` stubs that no longer match the interface — the shared factory will omit them.

### Duplication diff: default values across copies

Before extracting, the following differences across copies were identified:

**`createRunnerIO` / `makeIO`:**

| Field                                  | agent-runner    | extension-tools | concrete-agent-runner |
| -------------------------------------- | --------------- | --------------- | --------------------- |
| `assemblerIO.buildMemoryBlock`         | present (stale) | present (stale) | absent                |
| `assemblerIO.buildReadOnlyMemoryBlock` | present (stale) | absent          | absent                |
| Other fields                           | identical       | identical       | identical             |

**`ParentSnapshot` stubs:**

| Field                        | agent-runner    | extension-tools | concrete-agent-runner | agent-manager   | agent-menu/wizard | STUB_SNAPSHOT     |
| ---------------------------- | --------------- | --------------- | --------------------- | --------------- | ----------------- | ----------------- |
| `cwd`                        | "/tmp"          | "/tmp"          | "/workspace"          | "/tmp"          | "/test"           | "/test"           |
| `systemPrompt`               | "parent prompt" | "parent prompt" | ""                    | "parent prompt" | ""                | "test prompt"     |
| `model`                      | undefined       | undefined       | {}                    | undefined       | {}                | undefined         |
| `modelRegistry.find`         | vi.fn()         | vi.fn()         | vi.fn()               | vi.fn()         | `() => undefined` | `() => undefined` |
| `modelRegistry.getAvailable` | vi.fn()         | vi.fn()         | —                     | —               | —                 | —                 |

None of the consumer tests assert on `cwd`, `systemPrompt`, `model`, or `modelRegistry.find` return values — these fields are passed through to functions that are already mocked.
Using `STUB_SNAPSHOT` is safe for all consumers.

**`makeFileOps`:** character-for-character identical in all three UI test files.

**`makeUI`:** identical core in wizard and config-editor; agent-menu wraps it in an outer `{ ui, modelRegistry, parentSnapshot }` object.

**`makeManager`:** identical in agent-menu and wizard.

**`testDefaultAgentConfig`:** identical in agent-menu and config-editor (same 9 fields).

## Design Overview

### `test/helpers/runner-io.ts`

Two exports:

```typescript
/** Shared RunnerIO stub factory for agent-runner tests. */
function createRunnerIO(assemblerOverrides?: Partial<AssemblerIOStub>): RunnerIOStub;

/** Shared AgentConfigLookup stub. Returns a static Explore config by default. */
function createAgentLookup(config?: Partial<AgentConfig>): AgentLookupStub;
```

`createRunnerIO` builds the full `RunnerIO` stub shape.
The `assemblerIO` sub-object defaults to stubs for `preloadSkills` and `buildAgentPrompt` only (matching the current `AssemblerIO` interface).
`assemblerOverrides` lets tests customize individual methods without rebuilding the entire factory.

`createAgentLookup` returns `{ resolveAgentConfig, getToolNamesForType }` wrapping a static config.
The default config is the Explore agent used in `agent-runner.test.ts` and `concrete-agent-runner.test.ts`.
Tests that need per-test config mutation (extension-tools) keep their local mutable wrapper but use the default config as a starting point.

Return types are deliberately unannotated (per testing skill) so `vi.fn()` stubs retain their `Mock<...>` methods.

### `test/helpers/ui-stubs.ts`

Four exports:

```typescript
/** FileOps stub — identical across all three UI test files. */
function makeFileOps(): FileOpsStub;

/** MenuUI stub with sequential select responses. */
function makeMenuUI(selectResults?: (string | undefined)[]): MenuUIStub;

/** Manager stub for UI tests (listAgents, getRecord, spawnAndWait). */
function makeMenuManager(): MenuManagerStub;

/** AgentConfig factory with sensible defaults and override support. */
function createTestAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig;
```

`makeMenuUI` returns the flat UI shape (select, input, confirm, editor, notify, custom).
`agent-menu.test.ts` wraps this locally into its `{ ui, modelRegistry, parentSnapshot }` structure — the wrapping stays in the test file because it's specific to `AgentsMenuHandler`'s interface.

### `agent-manager.test.ts` local helpers

Two local helpers reduce the 42 repetitive `manager.spawn(...)` calls:

```typescript
function spawnBg(mgr: AgentManager, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    isBackground: true,
  });
}

function spawnFg(mgr: AgentManager, prompt = "test", desc = prompt) {
  return mgr.spawnAndWait(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
  });
}
```

These stay local because they are only needed in this file.
They also replace the local `mockSnapshot` with the imported `STUB_SNAPSHOT`.

## Module-Level Changes

### New files

1. `test/helpers/runner-io.ts` — exports `createRunnerIO()`, `createAgentLookup()`.
2. `test/helpers/runner-io.test.ts` — unit tests: verifies stub shape satisfies `RunnerIO`, override merging, default config shape.
3. `test/helpers/ui-stubs.ts` — exports `makeFileOps()`, `makeMenuUI()`, `makeMenuManager()`, `createTestAgentConfig()`.
4. `test/helpers/ui-stubs.test.ts` — unit tests: verifies stub shapes, sequential select behavior, config override merging.

### Modified files

1. `test/lifecycle/agent-runner.test.ts` — remove local `createRunnerIO()`, `mockAgentLookup`, `snapshot`, `exec`; import from helpers.
2. `test/lifecycle/agent-runner-extension-tools.test.ts` — remove local `createRunnerIO()`, `snapshot`; import from helpers; keep local mutable `agentConfigMock` and `mockAgentLookup` (they use the mutable wrapper pattern).
3. `test/lifecycle/concrete-agent-runner.test.ts` — remove local `makeIO()`, `registry`, `snapshot`; import from helpers.
4. `test/lifecycle/agent-manager.test.ts` — remove local `mockSnapshot`; import `STUB_SNAPSHOT`; add local `spawnBg()` and `spawnFg()` helpers; update all `manager.spawn(mockSnapshot, ...)` calls.
5. `test/ui/agent-menu.test.ts` — remove local `makeFileOps()`, `makeManager()`, `testDefaultAgentConfig`, `stubParentSnapshot`; import from helpers; keep local `makeSettings()` and `makeHandler()`.
6. `test/ui/agent-creation-wizard.test.ts` — remove local `makeFileOps()`, `makeManager()`, `stubParentSnapshot`; import from helpers; keep local `makeDeps()`.
7. `test/ui/agent-config-editor.test.ts` — remove local `makeFileOps()`, `testDefaultConfig`, `testCustomConfig`; import from helpers; keep local `makeEditor()`.

### Doc updates

1. `docs/architecture/architecture.md` — update Phase 12 Step 4 reference from `test/fixtures/` to `test/helpers/` (lines 640, 642).

## Test Impact Analysis

1. The new factory unit tests (`runner-io.test.ts`, `ui-stubs.test.ts`) verify shared fixture behavior that was previously only implicitly tested through consumer test files.
   This enables targeted debugging when a mock shape drifts from the production interface.
2. No existing tests become redundant — consumer tests exercise distinct production behavior that the factory tests do not cover.
3. All existing tests stay as-is in terms of assertions.
   Only the setup code (local factory → shared import) changes.
4. The removal of stale `buildMemoryBlock` and `buildReadOnlyMemoryBlock` stubs from `createRunnerIO` is safe because `AssemblerIO` no longer declares these methods — structural typing means they were always no-ops.

## TDD Order

1. **Red → Green: `createRunnerIO` and `createAgentLookup` factories.**
   Write `test/helpers/runner-io.test.ts` — verify `createRunnerIO()` returns a shape satisfying `RunnerIO` (`EnvironmentIO & SessionFactoryIO`), verify `assemblerIO` override merging, verify `createAgentLookup()` returns the default Explore config and accepts overrides.
   Implement `test/helpers/runner-io.ts`.
   Run: `pnpm vitest run test/helpers/runner-io.test.ts`.
   Commit: `test: add createRunnerIO and createAgentLookup shared test fixtures`

2. **Green: migrate `agent-runner.test.ts` to shared runner-io factories.**
   Import `createRunnerIO`, `createAgentLookup` from helpers.
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `createRunnerIO()`, `mockAgentLookup`, `snapshot`.
   Run: `pnpm vitest run test/lifecycle/agent-runner.test.ts`.
   Commit: `test: use shared runner-io fixtures in agent-runner tests`

3. **Green: migrate `agent-runner-extension-tools.test.ts` to shared `createRunnerIO`.**
   Import `createRunnerIO` from helpers.
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `createRunnerIO()` and `snapshot`.
   Keep local `agentConfigMock` and `mockAgentLookup` (mutable wrapper pattern).
   Run: `pnpm vitest run test/lifecycle/agent-runner-extension-tools.test.ts`.
   Commit: `test: use shared createRunnerIO in extension-tools tests`

4. **Green: migrate `concrete-agent-runner.test.ts` to shared factories.**
   Import `createRunnerIO`, `createAgentLookup` from helpers.
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `makeIO()`, `registry`, `snapshot`.
   Run: `pnpm vitest run test/lifecycle/concrete-agent-runner.test.ts`.
   Commit: `test: use shared runner-io fixtures in concrete-agent-runner tests`

5. **Red → Green: UI stub factories.**
   Write `test/helpers/ui-stubs.test.ts` — verify `makeFileOps()` shape, `makeMenuUI()` sequential select behavior, `makeMenuManager()` shape, `createTestAgentConfig()` default and override merging.
   Implement `test/helpers/ui-stubs.ts`.
   Run: `pnpm vitest run test/helpers/ui-stubs.test.ts`.
   Commit: `test: add shared UI stub factories`

6. **Green: migrate `agent-config-editor.test.ts` to shared UI stubs.**
   Import `makeFileOps`, `makeMenuUI`, `createTestAgentConfig` from helpers.
   Remove local `makeFileOps()`, `makeUI()`, `testDefaultConfig`; derive `testCustomConfig` from `createTestAgentConfig`.
   Run: `pnpm vitest run test/ui/agent-config-editor.test.ts`.
   Commit: `test: use shared UI stubs in agent-config-editor tests`

7. **Green: migrate `agent-creation-wizard.test.ts` to shared UI stubs.**
   Import `makeFileOps`, `makeMenuUI`, `makeMenuManager` from helpers.
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `makeFileOps()`, `makeUI()`, `makeManager()`, `stubParentSnapshot`.
   Run: `pnpm vitest run test/ui/agent-creation-wizard.test.ts`.
   Commit: `test: use shared UI stubs in agent-creation-wizard tests`

8. **Green: migrate `agent-menu.test.ts` to shared UI stubs.**
   Import `makeFileOps`, `makeMenuUI`, `makeMenuManager`, `createTestAgentConfig` from helpers.
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `makeFileOps()`, `makeManager()`, `testDefaultAgentConfig`, `stubParentSnapshot`.
   Adapt `makeHandler()` to wrap `makeMenuUI()` into its `{ ui, modelRegistry, parentSnapshot }` shape.
   Keep local `makeSettings()`.
   Run: `pnpm vitest run test/ui/agent-menu.test.ts`.
   Commit: `test: use shared UI stubs in agent-menu tests`

9. **Green: consolidate `agent-manager.test.ts` internal duplication.**
   Import `STUB_SNAPSHOT` from `stub-ctx.ts`.
   Remove local `mockSnapshot`.
   Add local `spawnBg()` and `spawnFg()` helpers.
   Update all ~42 `manager.spawn(mockSnapshot, ...)` calls to use `spawnBg()`.
   Update `spawnAndWait` calls to use `spawnFg()`.
   Run: `pnpm vitest run test/lifecycle/agent-manager.test.ts`.
   Commit: `test: consolidate agent-manager spawn patterns with local helpers`

10. **Docs: update architecture doc reference.**
    Update `docs/architecture/architecture.md` Phase 12 Step 4 to reference `test/helpers/` instead of `test/fixtures/`.
    Commit: `docs: update Phase 12 Step 4 to reference test/helpers/`

## Risks and Mitigations

| Risk                                                                                                          | Mitigation                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STUB_SNAPSHOT` shape differs from local snapshots (`cwd`, `model`, `systemPrompt` values)                    | Verified: no consumer tests assert on these field values. The snapshot is passed through to fully-mocked functions. Run full test suite after each migration step.                       |
| Removing stale `buildMemoryBlock`/`buildReadOnlyMemoryBlock` stubs breaks a test that somehow depends on them | These methods don't exist on `AssemblerIO` — any code accessing them would be a TypeScript error in production. Vitest's esbuild won't catch this, so run `pnpm run check` after step 2. |
| Wider mock shape in `createRunnerIO` causes false-positive tests (runner tests pass when they should fail)    | The production `RunnerIO` interface is already narrow; extra mock methods are harmless. Existing assertions on specific mock calls catch regressions.                                    |
| `makeMenuUI` sequential-select pattern breaks when agent-menu wraps it differently                            | Agent-menu's `makeHandler()` composes the wrapping locally. The shared factory returns only the flat UI shape, avoiding coupling to any specific consumer's wrapping structure.          |
| `agent-manager.test.ts` `spawnBg()` helper hides important spawn options from test readers                    | Helper uses default values matching the most common pattern. Tests that need non-default options (e.g., `description: "first"`) pass explicit arguments, preserving readability.         |

## Open Questions

- Should `STUB_SNAPSHOT` be updated to use `vi.fn()` for `modelRegistry.find` instead of `() => undefined`?
  Currently it uses plain functions, but some runner tests use `vi.fn()`.
  Decide during implementation — if no test asserts on `find` call counts, plain functions are fine.
