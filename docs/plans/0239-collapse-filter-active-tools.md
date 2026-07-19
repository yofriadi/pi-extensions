---
issue: 239
issue_title: "Collapse filterActiveTools to recursion guard (Phase 14, Step 3)"
---

# Collapse `filterActiveTools` to recursion guard

## Problem Statement

With `disallowed_tools` (#237) and `extensions` filtering (#238) removed, `filterActiveTools` retains two branches that no longer justify a config bag or two-pass pre-bind/post-bind dance:

1. The `extensions === false` early return — a passthrough that belongs at the callsite.
2. The `EXCLUDED_TOOL_NAMES` recursion guard — the function's sole essential purpose.

The `builtinToolNameSet` membership check always returns `true` now (no string-array `extensions` filtering remains), making it dead logic.
`ToolFilterConfig` exists only to carry two fields (`toolNames`, `extensions`) through the assembler→runner boundary, but after this change they travel independently: `toolNames` feeds `createSession`, `extensions` feeds the resource loader's `noExtensions` flag, and neither is consumed by the filter function.

## Goals

- Reduce `filterActiveTools` to a one-liner: filter out `EXCLUDED_TOOL_NAMES`.
- Delete the `ToolFilterConfig` interface.
- Flatten `SessionConfig.toolFilter` back into two top-level fields: `toolNames` and `extensions`.
- Remove the pre-bind filter call — without denylist/allowlist logic, filtering before `bindExtensions` serves no purpose.
- Keep a single post-bind filter call for the recursion guard.
- Update tests to reflect the simplified flow.

## Non-Goals

- Removing `extensions` from `SessionConfig` entirely — it's still needed for the `noExtensions` flag on the resource loader.
- Renaming `EXCLUDED_TOOL_NAMES` or moving it to a separate module.
- Phase 15 domain model changes (#227–#232) — those operate on the simplified codebase this change produces.

## Background

`filterActiveTools` was extracted as part of Phase 10 (#168) to group `toolNames`, `disallowedSet`, and `extensions` into a `ToolFilterConfig` bag.
Issue #237 removed `disallowedSet`; #238 narrowed `extensions` from `true | string[] | false` to `boolean`.
Both are now closed.

The two-pass filter dance (Patch 2, RepOne #443) exists to catch extension-registered tools that join the active set during `bindExtensions`.
With the only remaining filter logic being the `EXCLUDED_TOOL_NAMES` guard, a single post-bind pass suffices.

Current `filterActiveTools` body:

```typescript
function filterActiveTools(
  activeTools: string[],
  config: ToolFilterConfig,
): string[] {
  const { toolNames, extensions } = config;
  if (!extensions) {
    return activeTools;
  }
  const builtinToolNameSet = new Set(toolNames);
  return activeTools.filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    return true;
  });
}
```

The `builtinToolNameSet` check is dead — both branches return `true`.
The `!extensions` early return belongs at the callsite.

### Affected files

- `src/lifecycle/agent-runner.ts` — `filterActiveTools`, pre-bind/post-bind calls, `ToolFilterConfig` import
- `src/session/session-config.ts` — `ToolFilterConfig` interface, `SessionConfig.toolFilter` field, assembler return literal
- `test/lifecycle/agent-runner-extension-tools.test.ts` — pre-bind/post-bind assertions
- `test/session/session-config.test.ts` — `toolFilter.*` assertions
- `test/lifecycle/agent-runner.test.ts` — session mock (`setActiveToolsByName` calls)
- `docs/architecture/architecture.md` — references to `ToolFilterConfig`, `filterActiveTools`, Phase 14 status

## Design Overview

### `filterActiveTools` simplification

The function reduces to:

```typescript
function filterActiveTools(activeTools: string[]): string[] {
  return activeTools.filter((t) => !EXCLUDED_TOOL_NAMES.includes(t));
}
```

No config parameter.
The `extensions === false` guard moves to the callsite: `if (cfg.extensions)`.

### `SessionConfig` flattening

```typescript
export interface SessionConfig {
  effectiveCwd: string;
  systemPrompt: string;
  toolNames: string[];       // was toolFilter.toolNames
  extensions: boolean;        // was toolFilter.extensions
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  noSkills: boolean;
  extras: PromptExtras;
  agentMaxTurns: number | undefined;
}
```

### `runAgent` callsite changes

Before (two-pass):

```typescript
if (cfg.toolFilter.extensions) {
  const filtered = filterActiveTools(session.getActiveToolNames(), cfg.toolFilter);
  session.setActiveToolsByName(filtered);
}
// ... bindExtensions ...
if (cfg.toolFilter.extensions) {
  const refiltered = filterActiveTools(session.getActiveToolNames(), cfg.toolFilter);
  session.setActiveToolsByName(refiltered);
}
```

After (single post-bind pass):

```typescript
// ... bindExtensions ...
if (cfg.extensions) {
  const filtered = filterActiveTools(session.getActiveToolNames());
  session.setActiveToolsByName(filtered);
}
```

Other `cfg.toolFilter.*` references update to `cfg.toolNames` and `cfg.extensions`.

## Module-Level Changes

### `src/session/session-config.ts`

1. Delete the `ToolFilterConfig` interface.
2. Replace `toolFilter: ToolFilterConfig` on `SessionConfig` with two flat fields: `toolNames: string[]` and `extensions: boolean`.
3. Update the return literal in `assembleSessionConfig` from `toolFilter: { toolNames, extensions }` to `toolNames, extensions`.
4. Update the JSDoc on `SessionConfig` — remove "Tool filtering cluster" comment.

### `src/lifecycle/agent-runner.ts`

1. Remove the `ToolFilterConfig` import.
2. Simplify `filterActiveTools` to `(activeTools: string[]) => string[]` — just the `EXCLUDED_TOOL_NAMES` filter.
3. Remove the pre-bind filter block (the first `if (cfg.toolFilter.extensions)` block).
4. Update the post-bind filter block: `cfg.toolFilter.extensions` → `cfg.extensions`, remove the config argument from the `filterActiveTools` call.
5. Update `noExtensions: !cfg.toolFilter.extensions` → `noExtensions: !cfg.extensions`.
6. Update `tools: cfg.toolFilter.toolNames` → `tools: cfg.toolNames`.
7. Update or remove the Patch 2 comments — the two-pass dance is gone; the remaining call is just a recursion guard.

### `test/lifecycle/agent-runner-extension-tools.test.ts`

1. Remove the pre-bind/post-bind ordering assertions — there is only one post-bind call now.
2. Update `setActiveToolsByName` call count expectations from 2 to 1.
3. Update assertions to check `setActiveToolsByName.mock.calls[0][0]` (was `calls[1][0]` for the second call).
4. The `extensions: false` test continues to assert that `setActiveToolsByName` is not called.

### `test/session/session-config.test.ts`

1. Update `result.toolFilter.toolNames` → `result.toolNames`.
2. Update `result.toolFilter.extensions` → `result.extensions`.

### `test/lifecycle/agent-runner.test.ts`

1. No structural changes needed — the session mock already has `setActiveToolsByName: vi.fn()`, and the default test config has `extensions: false` (so the filter doesn't run).
   If any test asserts on `setActiveToolsByName` call counts, verify they still pass.

### `docs/architecture/architecture.md`

1. Update the Phase 14 Step 3 entry to mark it complete.
2. Update the structural analysis table: `SessionConfig` field count changes, `ToolFilterConfig` is removed.
3. Update the smell table to mark the two-pass filter and `ToolFilterConfig` smells as resolved.

## Test Impact Analysis

1. **New tests enabled:** None — the simplification doesn't introduce new testable surface.
2. **Tests that become redundant:** The pre-bind/post-bind ordering test in `agent-runner-extension-tools.test.ts` — the pre-bind call is removed.
   The test that the post-bind filter includes extension tools stays; it verifies the recursion guard runs after `bindExtensions`.
3. **Tests that stay as-is:** The `extensions: false` skip test, the `EXCLUDED_TOOL_NAMES` exclusion test, all `session-config.test.ts` tests (with property path updates).

## TDD Order

1. **Flatten `SessionConfig` and delete `ToolFilterConfig`** — Replace `toolFilter: ToolFilterConfig` with `toolNames: string[]` and `extensions: boolean` on `SessionConfig`.
   Delete the `ToolFilterConfig` interface.
   Update the assembler return literal.
   Update `session-config.test.ts` property paths (`result.toolFilter.toolNames` → `result.toolNames`, `result.toolFilter.extensions` → `result.extensions`).
   Run `pnpm run check` to verify downstream compile errors (expected in `agent-runner.ts`).
   Commit: `refactor: flatten SessionConfig and remove ToolFilterConfig`

2. **Simplify `filterActiveTools` and remove pre-bind call** — Reduce `filterActiveTools` to `(activeTools: string[]) => string[]`.
   Remove the `ToolFilterConfig` import.
   Remove the pre-bind filter block.
   Update the post-bind filter block to use `cfg.extensions` and pass no config to `filterActiveTools`.
   Update `noExtensions` and `tools` references to `cfg.extensions` and `cfg.toolNames`.
   Update `agent-runner-extension-tools.test.ts`: change `setActiveToolsByName` call count from 2 to 1, update assertion indices from `calls[1]` to `calls[0]`, remove the pre-bind/post-bind ordering test, update comments.
   Verify `agent-runner.test.ts` still passes.
   Commit: `refactor: simplify filterActiveTools to recursion guard`

3. **Update architecture docs** — Mark Phase 14 Step 3 as complete.
   Update `SessionConfig` field count and remove `ToolFilterConfig` references from the structural analysis.
   Mark the two-pass filter and `ToolFilterConfig` smells as resolved.
   Commit: `docs: mark Phase 14 Step 3 complete in architecture`

## Risks and Mitigations

1. **Pre-bind filter removal may miss a recursion-guard edge case** — If a subagent's own tools (`subagent`, `get_subagent_result`, `steer_subagent`) were in the built-in tool set before `bindExtensions`, removing the pre-bind filter could leave them active during the bind phase.
   Mitigation: These tools are registered by this extension during `bindExtensions`, not before.
   They cannot be in the pre-bind active set.
   The post-bind filter is sufficient.

2. **Flattening `SessionConfig` may break external consumers** — `SessionConfig` is not exported from the package entry point; it's an internal interface between `session-config.ts` and `agent-runner.ts`.
   No external consumers exist.

## Open Questions

None — the issue's changes are unambiguous and all dependencies are complete.
