---
issue: 168
issue_title: "refactor(pi-subagents): extract ToolFilterConfig from SessionConfig (11 fields)"
---

# Extract ToolFilterConfig from SessionConfig

## Problem Statement

`SessionConfig` in `session-config.ts` has 10 top-level fields.
Three of those fields — `toolNames`, `disallowedSet`, and `extensions` — form a cohesive tool-filtering cluster consumed together by `filterActiveTools` in `agent-runner.ts`.
Today `filterActiveTools` accepts these as three separate positional parameters, and the guard condition `cfg.extensions !== false || cfg.disallowedSet` is duplicated at both call sites.
Extracting the cluster into a named `ToolFilterConfig` type makes the relationship explicit and gives `filterActiveTools` a single named input.

## Goals

- Define a `ToolFilterConfig` interface grouping `toolNames`, `disallowedSet`, and `extensions`.
- Nest `ToolFilterConfig` inside `SessionConfig`, replacing the three flat fields.
- Change `filterActiveTools` to accept `ToolFilterConfig` instead of three positional parameters.
- Update `runAgent` to destructure `cfg.toolFilter` at both filter call sites.
- Update all test assertions that read the three flat fields to use the nested path.

## Non-Goals

- Extracting `ToolFilterConfig` into its own file — the type is small (3 fields) and co-located with its producer (`assembleSessionConfig`).
- Adding a `needsFiltering()` predicate or encapsulating the guard condition — follow-up if the duplication grows.
- Changing the `extensions` field on `AgentConfig` — that lives in the config domain and is unrelated.

## Background

### Affected modules

| Module                          | Role                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/session/session-config.ts` | Defines `SessionConfig`, produces it in `assembleSessionConfig`      |
| `src/lifecycle/agent-runner.ts` | Consumes `SessionConfig` in `runAgent`, contains `filterActiveTools` |

### Consumer analysis

`runAgent` accesses the three tool-filter fields in four places:

1. `tools: cfg.toolNames` — passed to `io.createSession` (session-creation tool list).
2. `noExtensions: cfg.extensions === false` — resource-loader option.
3. Two identical guard-plus-filter blocks passing all three fields to `filterActiveTools`.

After extraction, sites 1 and 2 will read from `cfg.toolFilter.toolNames` and `cfg.toolFilter.extensions`.
Site 3 (both occurrences) will pass `cfg.toolFilter` as a single argument.

### Test files affected

| Test file                                             | What changes                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `test/session/session-config.test.ts`                 | Assertions on `result.toolNames`, `result.extensions`, `result.disallowedSet` move to `result.toolFilter.*`  |
| `test/lifecycle/agent-runner-extension-tools.test.ts` | No direct `SessionConfig` assertions — exercises tool filtering via `runAgent` end-to-end; no changes needed |

### Dependency

Issue #164 (reorganize into domain directories) — closed ✓.

## Design Overview

### ToolFilterConfig shape

```typescript
/** Tool filtering configuration — consumed by filterActiveTools. */
export interface ToolFilterConfig {
  /** Built-in tool name allowlist for this agent type. */
  toolNames: string[];
  /** Disallowed tool set from agentConfig. undefined when empty. */
  disallowedSet: Set<string> | undefined;
  /** Resolved extensions setting: false | true | string[] allowlist. */
  extensions: boolean | string[];
}
```

### SessionConfig after extraction

```typescript
export interface SessionConfig {
  effectiveCwd: string;
  systemPrompt: string;
  toolFilter: ToolFilterConfig;
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  noSkills: boolean;
  extras: PromptExtras;
  agentMaxTurns: number | undefined;
}
```

Field count drops from 10 top-level fields to 8 (7 remaining + 1 `toolFilter`).

### filterActiveTools after extraction

```typescript
function filterActiveTools(
  activeTools: string[],
  config: ToolFilterConfig,
): string[] {
  const { toolNames, extensions, disallowedSet } = config;
  // ... body unchanged
}
```

### Consumer call site (runAgent)

```typescript
// Resource loader
noExtensions: cfg.toolFilter.extensions === false,

// Session creation
tools: cfg.toolFilter.toolNames,

// Guard + filter (two sites)
if (cfg.toolFilter.extensions !== false || cfg.toolFilter.disallowedSet) {
  const filtered = filterActiveTools(session.getActiveToolNames(), cfg.toolFilter);
  session.setActiveToolsByName(filtered);
}
```

## Module-Level Changes

### `src/session/session-config.ts`

1. Add `ToolFilterConfig` interface (exported — consumed by `agent-runner.ts`).
2. Replace `toolNames`, `disallowedSet`, and `extensions` fields on `SessionConfig` with a single `toolFilter: ToolFilterConfig` field.
3. Update `assembleSessionConfig` return statement to nest the three values under `toolFilter`.

### `src/lifecycle/agent-runner.ts`

1. Import `ToolFilterConfig` from `session-config.ts`.
2. Change `filterActiveTools` signature from `(activeTools, toolNames, extensions, disallowedSet)` to `(activeTools, config: ToolFilterConfig)`.
3. Destructure `config` inside `filterActiveTools` body.
4. Update both filter call sites to pass `cfg.toolFilter` instead of three separate arguments.
5. Update `noExtensions:` and `tools:` references to use `cfg.toolFilter.*`.

### `test/session/session-config.test.ts`

1. Update all assertions reading `result.toolNames` → `result.toolFilter.toolNames`.
2. Update all assertions reading `result.extensions` → `result.toolFilter.extensions`.
3. Update all assertions reading `result.disallowedSet` → `result.toolFilter.disallowedSet`.

## Test Impact Analysis

1. No new unit tests are needed — the extraction does not introduce new behavior or branching.
2. No existing tests become redundant — the assembler tests verify field population, and the extension-tools integration tests verify end-to-end filtering.
   Both remain valuable at their respective layers.
3. The `agent-runner-extension-tools.test.ts` tests exercise tool filtering via `runAgent` and do not reference `SessionConfig` fields directly, so they require no changes and serve as regression canaries for the refactoring.

## TDD Order

This is a pure refactoring with no new behavior, so the steps are refactor→verify rather than red→green.

1. **Add `ToolFilterConfig` interface and nest it in `SessionConfig`; update assembler return.**
   Update `session-config.test.ts` assertions to read from `result.toolFilter.*`.
   Run `pnpm run check` + tests.
   Commit: `refactor(pi-subagents): extract ToolFilterConfig from SessionConfig`

2. **Change `filterActiveTools` signature to accept `ToolFilterConfig`; update `runAgent` call sites.**
   Import `ToolFilterConfig`, destructure inside `filterActiveTools`, update all `cfg.*` references in `runAgent`.
   Run `pnpm run check` + full test suite.
   Commit: `refactor(pi-subagents): pass ToolFilterConfig to filterActiveTools`

## Risks and Mitigations

| Risk                                                                                                         | Mitigation                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `cfg.toolNames` is also used for `tools:` in `createSession` — nesting it might confuse readers about intent | The field name `toolFilter.toolNames` is still descriptive; add a brief inline comment at the `tools:` site if needed |
| Test assertions reference flat fields — missing one causes a silent pass on `undefined`                      | grep for all three field names across `test/` before committing step 1                                                |

## Open Questions

None — the issue's proposed shape matches the architecture doc exactly and the change is internal to the package.
