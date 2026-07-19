---
issue: 71
issue_title: "refactor: extract pure agent-session assembler from agent-runner.ts"
---

# Extract session-config assembler from agent-runner

## Problem Statement

`agent-runner.ts` `runAgent()` is ~390 lines (post-#69 cleanup) and mixes three concerns:

1. Configuration assembly — resolve model, detect env, build prompt extras, preload skills, build memory blocks, assemble system prompt, compute tool names (~200 lines).
2. Session construction — create `DefaultResourceLoader`, call `createAgentSession`, filter tools, bind extensions (~100 lines).
3. Runtime orchestration — subscribe to events, enforce turn limits, collect results (~90 lines).

The configuration assembly is deterministic given resolved inputs and does not need an `AgentSession`.
Because it is inlined in `runAgent()`, it cannot be unit-tested without mocking the entire Pi SDK (`createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`).

## Goals

- Extract a pure `assembleSessionConfig()` function into a new `src/session-config.ts` module.
- The assembler takes resolved inputs (agent config, environment info, narrow context) and returns a data object with everything `runAgent()` needs to create the session.
- Reduce `runAgent()` to an IO shell: call the assembler, create SDK objects, wire subscriptions, and run the event loop.
- Add focused unit tests for the assembler covering model resolution fallback chain, skill preloading, memory block selection (read-write vs read-only), prompt mode, tool name assembly, and disallowed-tool computation.
- No behavior change.

## Non-Goals

- Changing the `RunResult` shape or `RunOptions` interface.
- Refactoring the event subscription / turn-limit logic (stays in `runAgent()`).
- Extracting `resumeAgent` or `steerAgent`.
- Modifying the public API surface (`service.ts`).

## Background

### Prior art

`pi-permission-system` extracted `evaluate()` — a pure function of `(surface, pattern, ruleset)` — from `PermissionManager.checkPermission()`.
That made permission decisions independently testable without filesystem access or a manager instance.
This plan follows the same pattern: extract a pure core from an IO-heavy function.

### Current `runAgent()` structure

Lines 220–460 of `agent-runner.ts` break into these logical phases:

| Phase                           | Lines (approx) | SDK dependency                                           |
| ------------------------------- | -------------- | -------------------------------------------------------- |
| Config + agentConfig lookup     | 224–225        | None (agent-types registry)                              |
| effectiveCwd                    | 228            | None                                                     |
| detectEnv                       | 230            | `pi.exec` (async IO)                                     |
| parentSystemPrompt              | 233            | `ctx.getSystemPrompt()`                                  |
| extensions / skills resolution  | 237–245        | None                                                     |
| Skill preloading                | 247–252        | `preloadSkills` (filesystem)                             |
| Tool names + memory             | 254–274        | None (agent-types registry)                              |
| System prompt assembly          | 277–303        | `buildAgentPrompt` (pure)                                |
| noSkills flag                   | 306            | None                                                     |
| DefaultResourceLoader           | 308–320        | `DefaultResourceLoader` (SDK)                            |
| Model resolution                | 323–324        | `ctx.modelRegistry` (narrow)                             |
| Thinking level                  | 327            | None                                                     |
| sessionOpts construction        | 329–345        | `SessionManager`, `SettingsManager`, `getAgentDir` (SDK) |
| createAgentSession              | 347            | SDK                                                      |
| Tool filtering + bindExtensions | 350–400        | `session.*` methods (SDK)                                |
| Event subscriptions + prompt    | 402–460        | `session.*` methods (SDK)                                |

Everything above the `DefaultResourceLoader` line is configuration assembly — deterministic given resolved inputs.
Everything from `DefaultResourceLoader` onward is SDK orchestration.

### Modules the assembler will call

All are internal to this package — not Pi SDK:

- `agent-types.ts` — `getConfig()`, `getAgentConfig()`, `getToolNamesForType()`, `getMemoryToolNames()`, `getReadOnlyMemoryToolNames()`
- `prompts.ts` — `buildAgentPrompt()`
- `memory.ts` — `buildMemoryBlock()`, `buildReadOnlyMemoryBlock()`
- `skill-loader.ts` — `preloadSkills()`
- `default-agents.ts` — `DEFAULT_AGENTS` (fallback config)

### Relevant constraints from AGENTS.md

- Keep modules focused and composable (one concern per file).
- Keep Pi SDK imports out of business-logic modules.
- Prefer explicit configuration over hidden behavior.
- Business logic should be pure functions wherever possible — keep IO at the edges.

### Issue #69 status

Issue #69 (`SubagentRuntime`) is implemented.
Module-scope mutable state has been removed from `agent-runner.ts`.
`defaultMaxTurns` and `graceTurns` flow through `RunOptions`.
This plan builds on the post-#69 codebase.

## Design Overview

### Separation of concerns

`detectEnv()` is the only async IO call in the assembly phase — it calls `pi.exec()` to check git state.
The assembler is synchronous and takes `EnvInfo` as a pre-resolved parameter.
`runAgent()` calls `detectEnv()` first, then calls the assembler, then does SDK work.

### Narrow context interface

The assembler does not accept `ExtensionContext` — it accepts a narrow interface with only the fields it reads:

```typescript
interface AssemblerContext {
  /** Parent working directory (overridable via options.cwd). */
  cwd: string;
  /** Parent's effective system prompt (for append-mode agents). */
  parentSystemPrompt: string;
  /** Parent's current model instance (fallback when agent config has no model). */
  parentModel?: Model<any>;
  /** Model registry for resolving config.model strings. */
  modelRegistry: ModelRegistry;
}
```

`ModelRegistry` is a narrow interface (already exists in `model-resolver.ts`):

```typescript
interface ModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable?(): Model<any>[];
}
```

Tests construct plain objects satisfying these interfaces — no SDK mocking needed.

### Assembler signature

```typescript
function assembleSessionConfig(
  type: SubagentType,
  ctx: AssemblerContext,
  options: AssemblerOptions,
  env: EnvInfo,
): SessionConfig;
```

`AssemblerOptions` is a narrow pick of `RunOptions`:

```typescript
interface AssemblerOptions {
  cwd?: string;
  isolated?: boolean;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}
```

### Return type

```typescript
interface SessionConfig {
  /** Resolved working directory (options.cwd ?? ctx.cwd). */
  effectiveCwd: string;
  /** Fully-assembled system prompt string. */
  systemPrompt: string;
  /** Tool names for session creation and filtering. */
  toolNames: string[];
  /** Disallowed tool set from agent config (for filterActiveTools). */
  disallowedSet: Set<string> | undefined;
  /** Resolved extensions setting (for resource loader and tool filtering). */
  extensions: boolean | string[];
  /** Resolved model instance (or undefined → parent fallback). */
  model: Model<any> | undefined;
  /** Resolved thinking level (or undefined → inherit). */
  thinkingLevel: ThinkingLevel | undefined;
  /** Whether to skip skill loading in the resource loader. */
  noSkills: boolean;
  /** Prompt extras for transparency / debugging. */
  extras: PromptExtras;
}
```

### `resolveDefaultModel` moves to session-config.ts

`resolveDefaultModel()` is a pure function that resolves model strings against a registry.
It belongs in the assembler module alongside the other resolution logic.
It becomes an internal function (not exported) — its behavior is tested through `assembleSessionConfig()`.

### `filterActiveTools` stays in agent-runner.ts

`filterActiveTools()` operates on a live session's active tool list.
It runs twice (pre- and post-`bindExtensions`) and is an IO-layer concern.
It stays in `agent-runner.ts` and consumes `toolNames`, `extensions`, and `disallowedSet` from the `SessionConfig` return.

### `normalizeMaxTurns` stays in agent-runner.ts

`normalizeMaxTurns()` is used in the turn-limit subscription callback — runtime orchestration, not config assembly.
It stays in `agent-runner.ts`.

### What runAgent() looks like after

```typescript
export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const env = await detectEnv(options.pi, effectiveCwd);

  const config = assembleSessionConfig(type, {
    cwd: ctx.cwd,
    parentSystemPrompt: ctx.getSystemPrompt(),
    parentModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
  }, {
    cwd: options.cwd,
    isolated: options.isolated,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
  }, env);

  // SDK orchestration: create loader, session, filter tools, bind, run
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ ... });
  await loader.reload();
  const { session } = await createAgentSession({ ... });

  // Tool filtering (two passes), bindExtensions, subscriptions, prompt
  // ...same as today, using config.toolNames, config.disallowedSet, etc.
}
```

Target: `runAgent()` drops to ~200 lines (down from ~390).

### Edge cases

- Unknown agent type: `getAgentConfig()` returns `undefined`.
  The assembler falls back to `DEFAULT_AGENTS.get("general-purpose")` with `name: type`, matching the current `runAgent()` fallback.
- Empty `builtinToolNames`: `getToolNamesForType()` already falls back to `BUILTIN_TOOL_NAMES`.
- `isolated: true` overrides `extensions` and `skills` to `false` — same as today, now inside the assembler.
- Memory block selection: write-capable agents (have `write` or `edit` in effective tool set, not denied) get read-write memory; others get read-only.
  The denylist check uses `disallowedSet` from the agent config.

## Module-Level Changes

### `src/session-config.ts` (new)

- `AssemblerContext` interface — narrow context (cwd, parentSystemPrompt, parentModel, modelRegistry).
- `AssemblerOptions` interface — narrow options subset (cwd, isolated, model, thinkingLevel).
- `SessionConfig` interface — return type with all assembled configuration.
- `assembleSessionConfig()` function — pure configuration assembly.
- `resolveDefaultModel()` — moved from `agent-runner.ts` (internal, not exported).

### `src/agent-runner.ts` (modified)

- Import `assembleSessionConfig` and `SessionConfig` from `./session-config.js`.
- Remove ~200 lines of configuration assembly from `runAgent()`.
- Replace with a call to `assembleSessionConfig()` followed by SDK orchestration using the returned `SessionConfig`.
- Remove `resolveDefaultModel()` (moved to session-config.ts).
- `filterActiveTools()`, `normalizeMaxTurns()`, `collectResponseText()`, `getLastAssistantText()`, `forwardAbortSignal()` — all stay.
- `RunOptions`, `RunResult`, `ToolActivity` — all stay (unchanged).

### `test/session-config.test.ts` (new)

- Unit tests for `assembleSessionConfig()` covering all assembly logic.
- Tests use plain objects for `AssemblerContext` — no SDK mocks.
- Mocks for `agent-types`, `prompts`, `memory`, `skill-loader` — simple function mocks.

### `test/agent-runner.test.ts` (modified)

- Existing tests stay as-is — they already mock the SDK and test the full `runAgent()` flow.
- Tests that verified assembly details (e.g., `suppresses AGENTS.md/CLAUDE.md` or `passes effective cwd to the loader`) remain valid because `runAgent()` still does the SDK orchestration.
- No tests are removed or rewritten.

### `test/agent-runner-extension-tools.test.ts` (unchanged)

- Tests extension-tool filtering via `filterActiveTools` — stays in `agent-runner.ts`.
- No impact.

## Test Impact Analysis

### New unit tests enabled by the extraction

1. Model resolution fallback chain — test that `assembleSessionConfig` returns the correct model for: explicit option model, config model string (valid/invalid), parent model fallback, and no model.
2. Skill preloading — test that `skills: string[]` triggers `preloadSkills` and populates `extras.skillBlocks`; `skills: false` and `skills: true` skip preloading.
3. Memory block selection — test read-write vs read-only memory based on tool availability and denylist interaction.
4. Tool name assembly — test that `getToolNamesForType` result is augmented with memory tool names when memory is configured.
5. Extensions / isolated interaction — test that `isolated: true` forces `extensions: false` and `skills: false`.
6. System prompt assembly — test that `buildAgentPrompt` is called with the correct config, extras, and env.
7. Disallowed tool set — test construction from `agentConfig.disallowedTools`.
8. Unknown type fallback — test that missing `agentConfig` triggers the general-purpose fallback.
9. Thinking level resolution — test explicit option vs config vs undefined.

### Existing tests that stay as-is

All tests in `test/agent-runner.test.ts`, `test/agent-runner-extension-tools.test.ts`, and `test/agent-runner-settings.test.ts` continue to pass unchanged.
They test the SDK orchestration layer which is not modified (only reduced in scope).
The assembly logic they implicitly tested is now covered more thoroughly by `test/session-config.test.ts`.

### Existing tests that could be simplified (future follow-up)

Some `agent-runner.test.ts` tests verify assembly-layer behavior through the full `runAgent()` call (e.g., checking `defaultResourceLoaderCtor` args).
These become redundant with the new assembler tests.
Simplifying them is a separate follow-up — not part of this issue's scope.

## TDD Order

1. **Red: assembler returns correct defaults for a standard agent type.**
   Create `test/session-config.test.ts` with a test that calls `assembleSessionConfig()` for the `"Explore"` type and asserts the returned `SessionConfig` shape: `effectiveCwd`, `systemPrompt`, `toolNames`, `extensions: false`, `noSkills: true`, `disallowedSet: undefined`.
   Mock `agent-types`, `prompts`, `memory`, `skill-loader` at the module level.
   This fails because `session-config.ts` does not exist yet.
   Commit: `test: add session-config assembler test for default agent type`

2. **Green: implement `assembleSessionConfig()` core path.**
   Create `src/session-config.ts` with `AssemblerContext`, `AssemblerOptions`, `SessionConfig` interfaces and the `assembleSessionConfig()` function.
   Implement the happy path: resolve config, compute effectiveCwd, resolve extensions/skills, build extras, build system prompt, compute toolNames, compute disallowedSet, resolve noSkills.
   Tests go green.
   Commit: `feat: add assembleSessionConfig in session-config.ts`

3. **Red→Green: model resolution fallback chain.**
   Add tests for: explicit option model wins, config model string resolves via registry, invalid config model falls back to parent, no model returns undefined.
   Move `resolveDefaultModel()` from `agent-runner.ts` to `session-config.ts` (internal).
   Commit: `test: model resolution fallback chain in session-config`

4. **Red→Green: skill preloading paths.**
   Add tests for: `skills: string[]` populates `extras.skillBlocks`, `skills: false` skips, `skills: true` skips preloading (loaded by resource loader instead), `isolated: true` forces skip.
   Commit: `test: skill preloading paths in session-config`

5. **Red→Green: memory block selection.**
   Add tests for: agent with memory + write tools → read-write block, agent with memory + read-only tools → read-only block, agent with memory + denied write tools → read-only block, agent without memory → no block.
   Commit: `test: memory block selection in session-config`

6. **Red→Green: isolated mode, unknown type fallback, thinking level.**
   Add tests for: `isolated: true` forces `extensions: false` and `noSkills: true`, unknown type falls back to general-purpose config, thinking level resolves from option > config > undefined.
   Commit: `test: isolated mode, unknown type fallback, thinking level`

7. **Refactor: wire `assembleSessionConfig` into `runAgent()`.**
   Replace the configuration assembly block in `runAgent()` with a call to `assembleSessionConfig()`.
   Use the returned `SessionConfig` fields to construct `DefaultResourceLoader`, `createAgentSession` opts, and `filterActiveTools` args.
   Remove `resolveDefaultModel()` from `agent-runner.ts` (already moved in step 3).
   Run full test suite — all existing `agent-runner.test.ts` tests pass unchanged.
   Commit: `refactor: wire assembleSessionConfig into runAgent (#71)`

8. **Verify acceptance criteria and clean up.**
   Confirm `runAgent()` is ≤200 lines.
   Confirm assembler tests run without mocking `AgentSession`, `ExtensionContext`, or Pi SDK types.
   Confirm full test suite passes with no regressions.
   Remove any dead imports.
   Run `pnpm run check` for type safety.
   Commit: `refactor: finalize session-config extraction (#71)`

## Risks and Mitigations

| Risk                                                                                                                            | Mitigation                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assembly logic has subtle ordering dependencies (e.g., tool names must be computed before memory block selection)               | The assembler mirrors the exact order from `runAgent()` today; tests verify each dependency chain explicitly.                                                                                                                                                           |
| Moving `resolveDefaultModel` changes import paths for any external consumer                                                     | `resolveDefaultModel` is not exported from the package — it is internal to `agent-runner.ts` today and internal to `session-config.ts` after the move. No external impact.                                                                                              |
| Existing `agent-runner.test.ts` tests break when assembly is delegated                                                          | The tests mock `agent-types`, `prompts`, `memory`, `skill-loader` — the assembler calls the same functions through the same module paths, so existing mocks continue to intercept.                                                                                      |
| `Model<any>` import from `@earendil-works/pi-ai` in the new module violates "keep Pi SDK imports out of business-logic modules" | `pi-ai` provides type-only interfaces (`Model`, `ThinkingLevel`) already used in `types.ts`. The constraint targets `pi-coding-agent` SDK types (`AgentSession`, `ExtensionContext`, `DefaultResourceLoader`). The assembler imports zero types from `pi-coding-agent`. |
| The assembler's return type becomes a wide interface (9 fields)                                                                 | All fields are consumed by `runAgent()` — none are unused. The interface represents a single cohesive concept (session configuration). No consumer uses a subset; there is no narrowing opportunity.                                                                    |

## Open Questions

- Should `assembleSessionConfig` also resolve `effectiveCwd` internally (trivial: `options.cwd ?? ctx.cwd`) or should the caller pre-compute it?
  The plan assumes the assembler computes it (self-contained), but `runAgent()` also needs `effectiveCwd` for `detectEnv()` before calling the assembler.
  Resolution: `runAgent()` computes `effectiveCwd` once, passes it as `options.cwd` (already resolved) or as a separate parameter.
  The assembler still computes `effectiveCwd` from its inputs, which produces the same value.
  This duplication is benign — both paths yield `options.cwd ?? ctx.cwd`.
