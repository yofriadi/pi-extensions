---
issue: 167
issue_title: "refactor(pi-subagents): narrow RunnerIO (9 methods → 2 focused interfaces)"
---

# Narrow RunnerIO into EnvironmentIO + SessionFactoryIO

## Problem Statement

`RunnerIO` in `agent-runner.ts` bundles 8 members (7 methods + 1 sub-interface) into a single IO boundary.
The methods split naturally into two concerns — environment discovery vs. SDK object creation — but the current monolithic interface forces every consumer (and every test mock) to provide all members regardless of which subset they actually use.
This violates Interface Segregation (ISP) and inflates test factory helpers.

## Goals

- Split `RunnerIO` into two focused interfaces: `EnvironmentIO` (3 methods) and `SessionFactoryIO` (5 methods + `assemblerIO`).
- Keep `RunnerIO` as a type alias (`EnvironmentIO & SessionFactoryIO`) so the change is fully backward-compatible at the type level.
- Update both test `createRunnerIO()` factories to use the new sub-interfaces in their comments/structure (no behavioral test changes needed — factories already return plain objects).
- Zero runtime behavior change.

## Non-Goals

- Splitting the `runAgent()` function itself — that's a separate concern.
- Changing how `createAgentRunner()` accepts its IO parameter — it keeps taking `RunnerIO` (the intersection).
- Refactoring `index.ts` wiring — the construction site already builds a plain object; it will continue to satisfy `RunnerIO`.
- Extracting `AssemblerIO` further — it already has its own interface in `session-config.ts`.

## Background

`RunnerIO` was introduced in issue #133 to decouple `agent-runner.ts` from direct Pi SDK imports.
It succeeded at making the runner testable via plain stubs, but bundled all IO into one wide interface.
Issue #164 (closed) reorganized source into domain directories; the current file path is `src/lifecycle/agent-runner.ts`.

The 8 members group into two cohesive clusters:

| Cluster               | Members                                                                                                 | Responsibility                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Environment discovery | `detectEnv`, `getAgentDir`, `deriveSessionDir`                                                          | Discover runtime environment, resolve directories |
| Session factory       | `createResourceLoader`, `createSessionManager`, `createSettingsManager`, `createSession`, `assemblerIO` | Create SDK objects for a child session            |

In `runAgent()`, the environment methods are called first (lines ~265–275), then the factory methods build SDK objects (lines ~280–320).
The two groups have no cross-dependencies within `runAgent()`.

## Design Overview

### New interfaces

```typescript
/** Environment discovery — detect runtime context and resolve directories. */
export interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (parentSessionFile: string | undefined, effectiveCwd: string) => string;
}

/** Session factory — create SDK objects for a child agent session. */
export interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}

/**
 * IO boundary injected into runAgent().
 * Backward-compatible intersection of the two focused interfaces.
 */
export type RunnerIO = EnvironmentIO & SessionFactoryIO;
```

### Backward compatibility

- `RunnerIO` becomes a type alias for the intersection.
  Any code that imports `RunnerIO` continues to compile unchanged.
- `index.ts` builds a plain object literal that satisfies `RunnerIO` — no change needed.
- Test factories return unannotated objects that are structurally compatible — no change needed for compilation, but comments can be updated to reference the sub-interfaces.

### Consumer call-site verification

The call site in `createAgentRunner()` (3 lines):

```typescript
export function createAgentRunner(io: RunnerIO): AgentRunner {
  return {
    run: (snapshot, type, prompt, options) => runAgent(snapshot, type, prompt, options, io),
    resume: resumeAgent,
  };
}
```

This passes the full `io` to `runAgent()`, which continues to accept `RunnerIO`.
No Tell-Don't-Ask or LoD violations introduced.

## Module-Level Changes

### `src/lifecycle/agent-runner.ts`

1. Add `EnvironmentIO` interface (3 members) before the current `RunnerIO` definition.
2. Add `SessionFactoryIO` interface (5 members) after `EnvironmentIO`.
3. Change `RunnerIO` from an `interface` to a `type` alias: `type RunnerIO = EnvironmentIO & SessionFactoryIO`.
4. Export the two new interfaces alongside `RunnerIO`.
5. Move existing JSDoc from `RunnerIO` members to the sub-interfaces.
6. No changes to function signatures — `runAgent()` and `createAgentRunner()` keep accepting `RunnerIO`.

### `src/index.ts`

No changes.
The construction site builds a plain object satisfying all 8 members — TypeScript's structural typing ensures it satisfies `EnvironmentIO & SessionFactoryIO` without annotation changes.

### Test files

No behavioral changes.
The `createRunnerIO()` factories in both test files return unannotated plain objects that structurally satisfy the intersection.
Comments referencing `RunnerIO` can be updated to mention the sub-interfaces for documentation clarity.

Files affected:

- `test/lifecycle/agent-runner.test.ts` — update comment (line ~23–27).
- `test/lifecycle/agent-runner-extension-tools.test.ts` — update comment (line ~46).

## Test Impact Analysis

1. **New unit tests enabled:** The split enables future tests that inject only `EnvironmentIO` or only `SessionFactoryIO` — useful when testing environment-only or factory-only code paths in future extractions.
   No new tests are needed in this issue because `runAgent()` still consumes the full intersection.
2. **Redundant tests:** None — existing tests already test through `runAgent()` which uses all members.
3. **Tests that stay as-is:** All existing tests in both `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` remain valid; the factories produce objects compatible with the new type alias.

## TDD Order

1. **Red → Green: export `EnvironmentIO` and `SessionFactoryIO`, convert `RunnerIO` to type alias.**
   Test surface: existing `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` suites (must still pass).
   Run `pnpm run check` to verify type compatibility.
   Commit: `refactor: split RunnerIO into EnvironmentIO and SessionFactoryIO (#167)`

2. **Update test comments to reference sub-interfaces.**
   Test surface: no behavioral test changes — comment-only updates.
   Commit: `refactor: update test comments for RunnerIO sub-interfaces (#167)`

## Risks and Mitigations

| Risk                                          | Mitigation                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| External consumers importing `RunnerIO` break | `RunnerIO` remains exported as a type alias for the intersection — fully backward-compatible        |
| Test factories need updating                  | Factories return unannotated objects — structural typing handles the new type alias without changes |
| Future extractions assume wrong interface     | Each sub-interface has a clear JSDoc explaining its scope                                           |

## Open Questions

None — the split follows the natural cohesion boundary identified in the issue body.
