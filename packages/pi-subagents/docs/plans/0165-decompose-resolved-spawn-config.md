---
issue: 165
issue_title: "refactor(pi-subagents): decompose ResolvedSpawnConfig (15 fields)"
---

# Decompose ResolvedSpawnConfig into domain-aligned sub-interfaces

## Problem Statement

`ResolvedSpawnConfig` in `tools/spawn-config.ts` has 15 fields mixing identity, execution, and presentation concerns.
Each consumer uses a different subset but receives the full bag — violating ISP and making the real dependencies of `foreground-runner` and `background-spawner` invisible.

## Goals

- Split `ResolvedSpawnConfig` into three focused interfaces: `SpawnIdentity`, `SpawnExecution`, `SpawnPresentation`.
- Each consumer declares its real dependencies explicitly.
- Preserve existing behavior — pure structural refactor with no behavioral changes.

## Non-Goals

- Extracting `ParentSessionInfo` from `AgentSpawnConfig` — that's #166.
- Changing how `resolveSpawnConfig` computes values internally.
- Modifying the `AgentSpawnConfig` interface passed to `AgentManager`.

## Background

`resolveSpawnConfig` is called by `agent-tool.ts` and produces a single flat config object.
Three consumers read from it:

1. `agent-tool.ts` — reads `inheritContext` (to build snapshot), `runInBackground` (to branch), and `detailBase` (for resume result).
2. `foreground-runner.ts` — reads identity fields for fallback messages, execution fields for spawn options, and `detailBase` for result formatting.
3. `background-spawner.ts` — reads identity fields for launch message, execution fields for spawn options, and `detailBase` for result formatting.

Two fields (`modelName`, `agentTags`) are never accessed by any external consumer — they're intermediate values used only inside `resolveSpawnConfig` to build `detailBase`.
They belong on `SpawnPresentation` for transparency but could also be made internal-only.

The `code-design` skill's ISP and dependency-width guidance both apply: clients should not depend on properties they don't use, and a shared bag where each consumer only touches a subset hides real dependencies.

## Design Overview

### New interfaces

```typescript
/** Identity: who is being spawned. */
export interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  fellBack: boolean;
  displayName: string;
}

/** Execution: how the agent will run. */
export interface SpawnExecution {
  prompt: string;
  description: string;
  model: Model<any> | undefined;
  effectiveMaxTurns: number | undefined;
  thinking: ThinkingLevel | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation: IsolationMode | undefined;
  agentInvocation: AgentInvocation;
}

/** Presentation: display/UI values derived from identity + execution. */
export interface SpawnPresentation {
  modelName: string | undefined;
  agentTags: string[];
  detailBase: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">;
}

/** Fully resolved config — now a composition of domain-aligned sub-interfaces. */
export interface ResolvedSpawnConfig {
  identity: SpawnIdentity;
  execution: SpawnExecution;
  presentation: SpawnPresentation;
}
```

### Consumer interaction pattern

```typescript
// agent-tool.ts — uses execution for routing, presentation for resume
const config = resolveSpawnConfig(params, registry, modelInfo, settings);
if ("error" in config) return textResult(config.error);
const snapshot = buildSnapshot(config.execution.inheritContext);
if (config.execution.runInBackground) { /* ... */ }
return buildDetails(config.presentation.detailBase, record);

// foreground-runner.ts — destructures what it needs
const { identity, execution, presentation } = params.config;
record = await manager.spawnAndWait(snapshot, identity.subagentType, execution.prompt, { ... });
const fallbackNote = identity.fellBack ? `Note: Unknown agent type "${identity.rawType}"...` : "";
```

This follows Tell-Don't-Ask — callers pick the sub-object relevant to their concern rather than reaching through a flat bag.
The one-level nesting (`config.execution.inheritContext`) is acceptable because it names the domain the field belongs to.

### Test factory migration

Both test files (`foreground-runner.test.ts`, `background-spawner.test.ts`) have `makeConfig()` factories that construct the full 15-field flat object.
These will be updated to construct the nested structure.
The `spawn-config.test.ts` assertions will shift from `result.subagentType` to `result.identity.subagentType` etc.

## Module-Level Changes

| File                                    | Change                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/spawn-config.ts`             | Add `SpawnIdentity`, `SpawnExecution`, `SpawnPresentation` interfaces. Change `ResolvedSpawnConfig` to nest them. Update `resolveSpawnConfig` return to build nested structure. |
| `src/tools/agent-tool.ts`               | Update config access: `config.execution.inheritContext`, `config.execution.runInBackground`, `config.presentation.detailBase`.                                                  |
| `src/tools/foreground-runner.ts`        | Destructure `config` into `identity`, `execution`, `presentation`. Update all field accesses.                                                                                   |
| `src/tools/background-spawner.ts`       | Destructure `config` into `identity`, `execution`, `presentation`. Update all field accesses.                                                                                   |
| `test/tools/spawn-config.test.ts`       | Update all assertions to use nested paths (`result.identity.subagentType`, etc.).                                                                                               |
| `test/tools/foreground-runner.test.ts`  | Update `makeConfig()` factory to build nested structure.                                                                                                                        |
| `test/tools/background-spawner.test.ts` | Update `makeConfig()` factory to build nested structure.                                                                                                                        |

## Test Impact Analysis

1. No new unit tests are needed — this is a structural refactor, not new behavior.
2. No existing tests become redundant — all current `spawn-config.test.ts` assertions still verify the same computation.
3. All existing tests must be updated to match the new nested access paths, but they continue to exercise the same logic.

## TDD Order

1. **Red→Green: introduce sub-interfaces and nest `ResolvedSpawnConfig`** — change `spawn-config.ts` to export the three sub-interfaces and restructure `ResolvedSpawnConfig`.
   Update `resolveSpawnConfig` to return the nested shape.
   Update `spawn-config.test.ts` assertions to match.
   Commit: `refactor(pi-subagents): introduce SpawnIdentity, SpawnExecution, SpawnPresentation`

2. **Green: update `agent-tool.ts`** — migrate the three field accesses (`inheritContext`, `runInBackground`, `detailBase`) to nested paths.
   Run `pnpm run check` to confirm types pass.
   Commit: `refactor(pi-subagents): update agent-tool to use nested spawn config`

3. **Green: update `foreground-runner.ts` and its test** — destructure config and update all field accesses.
   Update `makeConfig()` factory in `foreground-runner.test.ts`.
   Commit: `refactor(pi-subagents): update foreground-runner to use nested spawn config`

4. **Green: update `background-spawner.ts` and its test** — destructure config and update all field accesses.
   Update `makeConfig()` factory in `background-spawner.test.ts`.
   Commit: `refactor(pi-subagents): update background-spawner to use nested spawn config`

5. **Verify: full suite** — run `pnpm vitest run` and `pnpm run check` to confirm no regressions.
   Commit (if any lint/type cleanup needed): `chore(pi-subagents): post-decomposition cleanup`

## Risks and Mitigations

| Risk                                                           | Mitigation                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Step 1 breaks type checking for all consumers simultaneously   | Steps 2–4 must land in the same branch before pushing; or use a transitional type alias that spreads the sub-interfaces flat, removing it in the final step. |
| Test factories diverge from production shape                   | Each step updates the test factory in the same commit as the source change.                                                                                  |
| `modelName` and `agentTags` on `SpawnPresentation` look unused | They are unused by external consumers today but provide inspection affordance for debugging/logging. Keep them; #166 or later work may consume them.         |

## Open Questions

- None — the issue's proposed shape aligns with actual field usage patterns.
  The only observation is that `modelName` and `agentTags` are only consumed internally, but exposing them on `SpawnPresentation` is harmless and aids debuggability.
