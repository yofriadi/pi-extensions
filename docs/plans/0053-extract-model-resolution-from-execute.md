---
issue: 53
issue_title: "refactor: extract model resolution from Agent.execute"
---

# Extract model resolution from Agent.execute

## Problem Statement

The `Agent` tool's `execute` callback in `index.ts` contains inline model-resolution logic (~lines 660–670) that determines which model an agent runs with.
This block checks `resolvedConfig.modelInput`, calls `resolveModel()`, distinguishes error strings from resolved model instances, and silently falls back to the parent model for config-specified models that fail resolution.
The logic is not independently testable — it is only exercised through integration-level agent spawning.

A second, simpler call site in `getModelLabel()` (~line 1043) also calls `resolveModel()` inline but only checks whether the model resolves; it does not need the same fallback semantics.

## Goals

- Extract the inline model-resolution block from `Agent.execute` into a named, unit-testable function in `model-resolver.ts`.
- Keep the existing `resolveModel()` function unchanged — the new function composes it.
- No behavior change: model-resolution priority and fallback semantics remain identical.

## Non-Goals

- Changing the `resolveModel()` fuzzy-matching algorithm.
- Refactoring the `getModelLabel()` call site (~line 1043) — it has different semantics (display-only, no fallback) and does not benefit from the same extraction.
- Refactoring `service-adapter.ts` model resolution — it already uses a clean injected-dependency pattern.
- Changing any public API surface.

## Background

### Existing modules

| Module                 | Role                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-resolver.ts`    | Exports `resolveModel(input, registry)` — returns a `Model` on success or an error string on failure.                                                                                                                                   |
| `invocation-config.ts` | Exports `resolveAgentInvocationConfig()` — merges tool params with agent config. Returns `modelInput` (the raw string) and `modelFromParams` (whether the string came from tool params vs. agent config).                               |
| `service-adapter.ts`   | Already receives `resolveModel` as a dependency via `AdapterDeps`. Its model resolution is simpler (always throw on failure).                                                                                                           |
| `index.ts`             | `Agent.execute` contains the inline block. Uses both `modelInput` and `modelFromParams` to decide: (a) return error to user if params-specified model fails, or (b) silently fall back to parent model if config-specified model fails. |

### Relevant constraint from AGENTS.md

> Keep modules focused and composable (one concern per file).

The new function belongs in `model-resolver.ts` alongside `resolveModel()` since it composes the latter with invocation-level fallback policy.

## Design Overview

### New function signature

```typescript
interface ModelResolutionResult {
  model: unknown;
  error?: undefined;
}

interface ModelResolutionError {
  model?: undefined;
  error: string;
}

type ModelResolution = ModelResolutionResult | ModelResolutionError;

function resolveInvocationModel(
  parentModel: unknown,
  modelInput: string | undefined,
  modelFromParams: boolean,
  registry: ModelRegistry,
): ModelResolution;
```

### Decision model

The function encapsulates the existing three-branch logic:

1. **No `modelInput`** → return `{ model: parentModel }` (inherit parent).
2. **`modelInput` resolves** → return `{ model: resolved }`.
3. **`modelInput` fails to resolve**:
   - If `modelFromParams` (user typed it) → return `{ error: errorMessage }` so the caller can surface it.
   - If `!modelFromParams` (agent config specified it) → return `{ model: parentModel }` (silent fallback).

### Result shape rationale

A discriminated union (`ModelResolution`) with `model` and `error` fields avoids the existing `typeof resolved === "string"` type-narrowing smell.
The caller in `index.ts` becomes:

```typescript
const resolution = resolveInvocationModel(
  ctx.model,
  resolvedConfig.modelInput,
  resolvedConfig.modelFromParams,
  ctx.modelRegistry,
);
if (resolution.error) return textResult(resolution.error);
const model = resolution.model;
```

### Edge cases

- `modelInput` is `undefined` → short-circuit, return parent model.
- `modelInput` is an empty string → delegates to `resolveModel()`, which currently matches vacuously (documented in existing tests); no change in behavior.

## Module-Level Changes

### `src/model-resolver.ts`

- Add `ModelResolutionResult`, `ModelResolutionError`, and `ModelResolution` type exports.
- Add `resolveInvocationModel()` export.
- No changes to existing `resolveModel()`, `ModelEntry`, or `ModelRegistry`.

### `src/index.ts`

- Update import to include `resolveInvocationModel`.
- Replace the inline model-resolution block in `Agent.execute` (~lines 660–670) with a call to `resolveInvocationModel()` and a check on the result.
- Remove the now-unused destructuring of `modelFromParams` from `resolvedConfig` at the call site (it is consumed internally by `resolveInvocationModel` via the parameter).

### `test/model-resolver.test.ts`

- Add a new `describe("resolveInvocationModel")` block with tests covering all three branches plus edge cases.

## Test Impact Analysis

### New unit tests enabled

The extraction enables direct testing of the three-branch fallback logic (inherit, resolve, fallback-on-config-failure) that was previously only exercisable through full agent spawning.
Specifically:

- Parent model inheritance when no `modelInput` is provided.
- Successful resolution returns the resolved model.
- User-specified model failure returns an error.
- Config-specified model failure silently falls back to parent.

### Existing tests that stay as-is

- All existing `resolveModel` tests in `test/model-resolver.test.ts` — they test the lower-level function which is unchanged.
- Integration-level tests in `test/agent-runner.test.ts` and `test/agent-manager.test.ts` — they exercise model usage through the full agent lifecycle.
- `test/invocation-config.test.ts` — unchanged module.
- `test/service-adapter.test.ts` — uses its own injected `resolveModel` dependency, unaffected.

### Tests that become redundant

None.
The inline block was not directly tested anywhere — it was only reached through integration paths that test much more than model resolution.

## TDD Order

1. **Red → Green: parent model inheritance.**
   Test: `resolveInvocationModel` returns `{ model: parentModel }` when `modelInput` is `undefined`.
   Commit: `test: add resolveInvocationModel tests for parent model inheritance`

2. **Red → Green: successful model resolution.**
   Test: returns `{ model: resolvedModel }` when `resolveModel` succeeds (both params-specified and config-specified).
   Commit: `test: add resolveInvocationModel tests for successful resolution`

3. **Red → Green: user-specified model failure.**
   Test: returns `{ error: message }` when `modelFromParams` is `true` and `resolveModel` returns an error string.
   Commit: `test: add resolveInvocationModel tests for param model failure`

4. **Red → Green: config-specified model silent fallback.**
   Test: returns `{ model: parentModel }` when `modelFromParams` is `false` and `resolveModel` returns an error string.
   Commit: `test: add resolveInvocationModel tests for config model fallback`

5. **Green: implement `resolveInvocationModel` in `model-resolver.ts`.**
   All four test cases go green.
   Commit: `feat: add resolveInvocationModel to model-resolver`

6. **Refactor: replace inline block in `index.ts`.**
   Replace the inline model-resolution block in `Agent.execute` with a call to `resolveInvocationModel`.
   Run full test suite to confirm no regressions.
   Commit: `refactor: use resolveInvocationModel in Agent.execute (#53)`

## Risks and Mitigations

| Risk                                                                                   | Mitigation                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtle behavior difference in the extracted function vs. the inline block              | TDD steps 1–4 encode the exact current semantics; step 6 is a pure mechanical substitution.                                                                                                        |
| `resolveModel` return type is `any \| string` — fragile narrowing                      | The new function encapsulates the `typeof` check behind a discriminated union, reducing but not eliminating the `any`. Fixing the `any` is out of scope (would require Pi SDK model type changes). |
| Second call site (`getModelLabel`) might seem like it should also use the new function | Explicitly listed as a non-goal — it has display-only semantics with no fallback behavior.                                                                                                         |

## Open Questions

None — the extraction is mechanical and the issue's acceptance criteria are unambiguous.
