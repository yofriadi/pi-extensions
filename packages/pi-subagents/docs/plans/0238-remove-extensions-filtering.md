---
issue: 238
issue_title: "Remove extensions filtering from pi-subagents (Phase 14, Step 2)"
---

# Remove `extensions` filtering from pi-subagents

## Problem Statement

The `extensions: string[]` allowlist in agent configuration is tool filtering disguised as extension lifecycle control.
Extensions always initialize via `bindExtensions()` — the allowlist only hides their tools from the active set afterward, which is pi-permission-system's responsibility.
Simplifying `extensions` from `true | string[] | false` to `boolean` removes this overlap and makes pi-permission-system the sole authority for tool access control.

## Goals

- Simplify `extensions` from `true | string[] | false` to `boolean` in `AgentConfig`, `ToolFilterConfig`, and all related code.
- Remove the `Array.isArray(extensions)` branch from `filterActiveTools` in `agent-runner.ts`.
- Remove extensions array handling from the agent config editor and creation wizard.
- Update custom agent frontmatter parsing to coerce array values to `true` (with a deprecation warning).
- Update tests to remove `extensions: string[]` assertions and fixture data.
- This is a **breaking change** — users with `extensions: <csv-list>` in agent frontmatter lose per-extension filtering.

## Non-Goals

- Collapsing `filterActiveTools` to a recursion guard (Step 3, #239).
- Removing `extensions: false` — it is retained here (used by `isolated`) and dissolved in Phase 16.
- Changing any pi-permission-system code — this issue is purely pi-subagents.
- Removing Patch 2 (post-bind re-filter) — it still serves the `EXCLUDED_TOOL_NAMES` recursion guard when `extensions === true`.
  Issue #239 collapses the two-pass dance.

## Background

### Phase 14 context

This is Phase 14, Step 2 of the architecture roadmap in `docs/architecture/architecture.md`.
Steps 1 (#237, completed) and 2 (#238) are independent; Step 3 (#239) depends on both.

### Files involved

| File                              | Role                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `src/types.ts`                    | `AgentConfig.extensions` field type                                         |
| `src/config/custom-agents.ts`     | Parses `extensions` from YAML frontmatter via `inheritField()`              |
| `src/session/session-config.ts`   | `ToolFilterConfig.extensions` type + passthrough in `assembleSessionConfig` |
| `src/lifecycle/agent-runner.ts`   | `filterActiveTools` array branch + Patch 2 comment                          |
| `src/ui/agent-config-editor.ts`   | Serializes `extensions` array to frontmatter                                |
| `src/ui/agent-creation-wizard.ts` | Template text describing `extensions` field options                         |
| `README.md`                       | Frontmatter table row, Patch 2 notes                                        |

### `filterActiveTools` after this change

```typescript
function filterActiveTools(
  activeTools: string[],
  config: ToolFilterConfig,
): string[] {
  const { toolNames, extensions } = config;
  if (extensions === false) {
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

The `Array.isArray(extensions)` branch is gone.
The `builtinToolNameSet.has(t)` check becomes redundant (always returns true for builtins, falls through to `return true` for non-builtins) — but simplifying further is #239's scope.

### Custom agent frontmatter migration

The `inheritField()` function currently parses CSV values into `string[]`.
After this change, it must still accept array values gracefully: coerce them to `true` and emit a warning so users know to update their frontmatter.

## Design Overview

This is primarily a removal — no new types, no new modules.
The one piece of new behavior is the deprecation warning when `inheritField` encounters an array value for `extensions`.

### `inheritField` change

Currently `inheritField` is shared between `extensions` and `skills` parsing.
Since `skills` still supports `string[]`, the function itself cannot change.
Instead, the call site for `extensions` will post-process: if `inheritField` returns `string[]`, coerce to `true` and log a warning.

### Type change scope

`AgentConfig.extensions` changes from `true | string[] | false` to `boolean`.
`ToolFilterConfig.extensions` changes from `boolean | string[]` to `boolean`.
Both are narrowing changes — existing `true` and `false` values remain valid.

## Module-Level Changes

1. **`src/types.ts`** — Change `extensions` type from `true | string[] | false` to `boolean`.
   Update JSDoc comment to remove the `string[] = only listed` description.
2. **`src/config/custom-agents.ts`** — After calling `inheritField(fm.extensions ?? fm.inherit_extensions)`, coerce `string[]` results to `true` and emit a `debugLog` warning.
   The warning informs users that `extensions: <csv-list>` is no longer supported and treated as `extensions: true`.
3. **`src/session/session-config.ts`** — Change `ToolFilterConfig.extensions` type from `boolean | string[]` to `boolean`.
   Update the JSDoc comment.
   The `assembleSessionConfig` passthrough `const extensions = options.isolated ? false : agentConfig.extensions;` works without changes since the type narrows.
4. **`src/lifecycle/agent-runner.ts`** — Remove the `Array.isArray(extensions)` branch (lines 47–49) from `filterActiveTools`.
   Update the Patch 2 comment (line 366) that references `extensions: string[]`.
   Update the comment at line 341 ("apply extension allowlist if specified").
5. **`src/ui/agent-config-editor.ts`** — Remove the `else if (Array.isArray(cfg.extensions))` branch (lines 51–52) from `buildEjectContent`.
6. **`src/ui/agent-creation-wizard.ts`** — Simplify the `extensions:` line in the template text from `<true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>` to `<true (inherit all MCP/extension tools) or false (none). Default: true>`.
7. **`README.md`** — Simplify the `extensions` row in the frontmatter table to document boolean-only.
   Update Patch 2 notes to remove `extensions: string[]` reference.
8. **`src/config/default-agents.ts`** — No changes needed; all defaults already use `extensions: true`.

### Test files

9. **`test/config/custom-agents.test.ts`** — Update the "handles extension allowlist" test: change expectation from `toEqual(["web-search", "mcp-server"])` to `toBe(true)` since CSV values now coerce to `true`.
   Add a test verifying the deprecation warning is emitted.
10. **`test/session/session-config.test.ts`** — Update the "isolated:true forces extensions to false even for string[] extension list" test: since `AgentConfig.extensions` no longer supports `string[]`, simplify this test to use `extensions: true` and verify `isolated` still forces it to `false`.
    The test name changes to reflect the boolean type.
11. **`test/lifecycle/agent-runner-extension-tools.test.ts`** — Remove the "post-bind re-filter respects extensions: string[] allowlist" test (line 139).
    Change the `extensions` type annotation in the mutable config mock (line 26) from `boolean | string[]` to `boolean`.
    Update the file-level JSDoc comment to remove `extensions: string[]` references.
12. **`test/ui/agent-config-editor.test.ts`** — Remove the "emits 'extensions: \<list\>' when extensions is an array" test.
13. **Test fixtures** — All test helper defaults already use `extensions: false` or `extensions: true`; no fixture changes needed beyond the tests listed above.

### Architecture docs

14. **`docs/architecture/architecture.md`** — Mark Step 2 as complete.

## Test Impact Analysis

1. **Tests removed** — 2 tests that directly assert `extensions: string[]` behavior:
   - `agent-runner-extension-tools.test.ts`: "post-bind re-filter respects extensions: string[] allowlist"
   - `agent-config-editor.test.ts`: "emits 'extensions: \<list\>' when extensions is an array"

2. **Tests updated** — 3 tests that reference `extensions: string[]` in fixtures or assertions:
   - `custom-agents.test.ts`: "handles extension allowlist" → expectation changes to `true`
   - `session-config.test.ts`: "isolated:true forces extensions to false even for string[] extension list" → uses `true` instead of array
   - `agent-runner-extension-tools.test.ts`: mock config type annotation narrows

3. **Tests added** — 1 test:
   - `custom-agents.test.ts`: verifies deprecation warning when array value is provided

4. **Tests unchanged** — All other `extensions: true` and `extensions: false` tests remain valid since the boolean cases are preserved.

## TDD Order

1. **Narrow `extensions` type in `AgentConfig` and `ToolFilterConfig`** — Change `extensions` from `true | string[] | false` to `boolean` in `types.ts`.
   Change `ToolFilterConfig.extensions` from `boolean | string[]` to `boolean` in `session-config.ts`.
   Update JSDoc comments.
   Run `pnpm run check` to surface all downstream type errors.
   Commit: `feat!: narrow extensions type from union to boolean`

2. **Remove array branch from `filterActiveTools`** — Remove the `Array.isArray(extensions)` branch.
   Update the Patch 2 comment and the pre-bind filter comment.
   Remove the "post-bind re-filter respects extensions: string[] allowlist" test.
   Narrow the mock config type annotation in `agent-runner-extension-tools.test.ts`.
   Update the file-level JSDoc.
   Run tests: `pnpm vitest run`.
   Commit: `refactor: remove extensions array branch from filterActiveTools`

3. **Coerce array values in custom agent frontmatter** — Update the `extensions` assignment in `custom-agents.ts` to coerce `string[]` results from `inheritField` to `true` with a deprecation warning.
   Update the "handles extension allowlist" test expectation from array to `true`.
   Add a test for the deprecation warning.
   Update the "isolated:true forces extensions to false even for string[] extension list" test in `session-config.test.ts` to use `extensions: true`.
   Run tests: `pnpm vitest run`.
   Commit: `refactor: coerce extensions array values to true with deprecation warning`

4. **Remove extensions array from UI** — Remove the `Array.isArray(cfg.extensions)` branch from `buildEjectContent`.
   Simplify the `extensions:` line in the creation wizard template.
   Remove the "emits 'extensions: \<list\>'" test from `agent-config-editor.test.ts`.
   Run tests: `pnpm vitest run`.
   Commit: `refactor: remove extensions array from config editor and creation wizard`

5. **Update README** — Simplify the `extensions` frontmatter table row to document boolean-only.
   Update Patch 2 notes to remove `extensions: string[]` reference.
   Commit: `docs: simplify extensions field to boolean in README`

6. **Mark Phase 14 Step 2 complete** — Update `docs/architecture/architecture.md`.
   Commit: `docs: mark Phase 14 Step 2 complete in architecture`

## Risks and Mitigations

| Risk                                                                             | Mitigation                                                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Users with `extensions: <csv-list>` silently lose per-extension filtering        | `feat!:` commit triggers major version bump; frontmatter parser emits deprecation warning and coerces to `true`; README documents the change |
| `filterActiveTools` behavior regresses for boolean paths                         | Steps 1–4 each run type checks or tests; `extensions: true` and `extensions: false` tests are unchanged                                      |
| Type annotation `boolean | string[]` in test mock causes tsc errors after step 1 | Step 2 narrows the annotation in the same commit that removes the array branch                                                               |

## Open Questions

None — the issue's proposed change and the architecture doc's step description are unambiguous.
