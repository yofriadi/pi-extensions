---
issue: 237
issue_title: "Remove disallowed_tools from pi-subagents (Phase 14, Step 1)"
---

# Remove `disallowed_tools` from pi-subagents

## Problem Statement

The `disallowed_tools` frontmatter field and its runtime counterpart `disallowedSet` duplicate what pi-permission-system already provides via the `permission:` frontmatter with richer semantics (allow/ask/deny vs. binary hide).
Removing it establishes a single source of truth for tool access control in pi-permission-system and simplifies `filterActiveTools`, `ToolFilterConfig`, and `AgentConfig`.

## Goals

- Remove the `disallowedTools` field from `AgentConfig` and all code that reads, parses, or serializes it.
- Remove the `disallowedSet` field from `ToolFilterConfig` and the construction logic in `assembleSessionConfig`.
- Remove the `disallowedSet` branch from `filterActiveTools` in `agent-runner.ts`.
- Remove `disallowed_tools` from the agent config editor UI and the agent creation wizard.
- Update README.md to remove all `disallowed_tools` references and add a migration note.
- Update tests to remove `disallowedTools`/`disallowedSet` assertions and fixture data.
- This is a **breaking change** — users with `disallowed_tools` in agent frontmatter must migrate to `permission:` frontmatter.

## Non-Goals

- Removing `extensions` filtering (Step 2, #238).
- Collapsing `filterActiveTools` to a recursion guard (Step 3, #239).
- Changing any pi-permission-system code — this issue is purely pi-subagents.
- Adding deprecation warnings or runtime migration helpers — the architecture doc calls for clean removal.

## Background

### Phase 14 context

This is Phase 14, Step 1 of the architecture roadmap in `docs/architecture/architecture.md`.
Steps 1 and 2 (#237, #238) are independent; Step 3 (#239) depends on both.

### Files involved

| File                              | Role                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `src/types.ts`                    | `AgentConfig.disallowedTools` field definition                             |
| `src/config/custom-agents.ts`     | Parses `disallowed_tools` from YAML frontmatter                            |
| `src/session/session-config.ts`   | `ToolFilterConfig.disallowedSet` + construction in `assembleSessionConfig` |
| `src/lifecycle/agent-runner.ts`   | `filterActiveTools` denylist branch + guard conditions at two call sites   |
| `src/ui/agent-config-editor.ts`   | Serializes `disallowedTools` to `disallowed_tools` frontmatter             |
| `src/ui/agent-creation-wizard.ts` | Template text showing `disallowed_tools` as an available field             |
| `README.md`                       | Feature list, frontmatter table, memory detection note, patch notes        |

### `filterActiveTools` after this change

With `disallowedSet` removed, the function simplifies:

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
    if (Array.isArray(extensions)) {
      return extensions.some((ext) => t.startsWith(ext) || t.includes(ext));
    }
    return true;
  });
}
```

The `extensions === false` branch becomes a trivial passthrough — no filtering at all.
The guard condition at both call sites simplifies from `cfg.toolFilter.extensions !== false || cfg.toolFilter.disallowedSet` to `cfg.toolFilter.extensions !== false`.

## Design Overview

This is a pure removal — no new types, no new modules, no new behavior.
Every change deletes or simplifies existing code.

### Migration path

Users currently using `disallowed_tools` in agent frontmatter migrate to pi-permission-system's `permission:` frontmatter:

```yaml
# Before
disallowed_tools: bash

# After
permission:
  bash: deny
```

## Module-Level Changes

1. **`src/types.ts`** — Remove the `disallowedTools` field and its JSDoc comment from `AgentConfig`.
2. **`src/config/custom-agents.ts`** — Remove the `disallowedTools: csvListOptional(fm.disallowed_tools)` line from the agent config construction.
3. **`src/session/session-config.ts`** — Remove `disallowedSet` from the `ToolFilterConfig` interface.
   Remove the `disallowedSet` construction block and its comment in `assembleSessionConfig`.
   Remove `disallowedSet` from the `toolFilter` object literal.
4. **`src/lifecycle/agent-runner.ts`** — Remove the `disallowedSet` destructure and denylist branches from `filterActiveTools`.
   Simplify the `extensions === false` branch to `return activeTools`.
   Simplify both guard conditions from `cfg.toolFilter.extensions !== false || cfg.toolFilter.disallowedSet` to `cfg.toolFilter.extensions !== false`.
   Update comments that mention `disallowedTools denylist`.
5. **`src/ui/agent-config-editor.ts`** — Remove the two lines that serialize `disallowedTools` to `disallowed_tools` frontmatter.
6. **`src/ui/agent-creation-wizard.ts`** — Remove the `disallowed_tools:` line from the template text.
7. **`README.md`** — Remove the "Tool denylist" feature bullet, the `disallowed_tools` row from the frontmatter table, the memory write-capability paragraph (memory was removed in #185; this reference is already stale), the `disallowed_tools` example in the memory section, and the `disallowedTools` mention in the Patch 2 notes.
   Add a migration note under a "Migration" heading or in the breaking changes section.

### Test files

8. **`test/config/custom-agents.test.ts`** — Remove the two `disallowed_tools` tests ("parses disallowed_tools as csv list" and "disallowed_tools defaults to undefined when omitted").
9. **`test/session/session-config.test.ts`** — Remove the `disallowedSet` assertion from the default config test and remove the entire "builds disallowedSet from agentConfig.disallowedTools" test.
10. **`test/lifecycle/agent-runner-extension-tools.test.ts`** — Remove `disallowedTools` from both mock agent config objects.
    Remove the three `disallowedTools`-specific tests ("post-bind re-filter respects disallowedTools denylist", "extensions: false still applies disallowedTools", "extensions: false with no disallowedTools skips the filter").
    Update the file-level JSDoc comment.
11. **`test/ui/agent-config-editor.test.ts`** — Remove `disallowedTools` from the test fixture and remove the `disallowed_tools` assertion.

### Architecture docs

12. **`docs/architecture/architecture.md`** — Mark Step 1 as complete (update the step heading or add a completion note).

## Test Impact Analysis

1. **Tests removed** — 7 tests that directly assert `disallowedTools`/`disallowedSet` behavior become meaningless and are deleted:
   - `custom-agents.test.ts`: 2 tests (csv parsing, undefined default)
   - `session-config.test.ts`: 1 test (`disallowedSet` construction) + 1 assertion in default config test
   - `agent-runner-extension-tools.test.ts`: 3 tests (denylist for extension tools, denylist for built-in tools with `extensions: false`, filter skip with `extensions: false` + no denylist)
   - `agent-config-editor.test.ts`: 1 assertion in the serialization test

2. **Tests updated** — Several tests have `disallowedTools` in their mock fixtures but don't test it directly; those fixtures lose the field:
   - `agent-runner-extension-tools.test.ts`: both mock config objects drop `disallowedTools`

3. **Tests unchanged** — The remaining `agent-runner-extension-tools.test.ts` tests (`extensions: true`, `extensions: string[]` allowlist, `extensions: false` passthrough) remain valid — they test extension filtering, not the denylist.

## TDD Order

1. **Remove `disallowedTools` from `AgentConfig`** — Delete the field and JSDoc from `types.ts`.
   Remove `disallowedTools` parsing from `custom-agents.ts`.
   Remove the two `disallowed_tools` tests from `custom-agents.test.ts`.
   Run `pnpm run check` to surface all downstream type errors.
   Commit: `feat!: remove disallowedTools from AgentConfig`

2. **Remove `disallowedSet` from `ToolFilterConfig` and `assembleSessionConfig`** — Delete the field from `ToolFilterConfig`, the construction block in `assembleSessionConfig`, and the `disallowedSet` key from the return literal.
   Remove the `disallowedSet`-specific test and assertion from `session-config.test.ts`.
   Run `pnpm run check`.
   Commit: `refactor: remove disallowedSet from ToolFilterConfig`

3. **Simplify `filterActiveTools` and guard conditions** — Remove the `disallowedSet` destructure and denylist branches from `filterActiveTools`.
   Simplify the `extensions === false` branch to `return activeTools`.
   Simplify both guard conditions to `cfg.toolFilter.extensions !== false`.
   Update comments.
   Remove the three `disallowedTools`-specific tests and update mock fixtures in `agent-runner-extension-tools.test.ts`.
   Run tests: `pnpm vitest run`.
   Commit: `refactor: remove disallowedSet branch from filterActiveTools`

4. **Remove `disallowed_tools` from UI** — Remove serialization from `agent-config-editor.ts` and the template line from `agent-creation-wizard.ts`.
   Remove `disallowedTools` from the test fixture and assertion in `agent-config-editor.test.ts`.
   Run tests: `pnpm vitest run`.
   Commit: `refactor: remove disallowed_tools from config editor and creation wizard`

5. **Update README.md** — Remove all `disallowed_tools` references (feature bullet, frontmatter table row, stale memory paragraph, example, patch notes mention).
   Add a migration note directing users to `permission:` frontmatter.
   Commit: `docs: remove disallowed_tools from README and add migration note`

6. **Mark Phase 14 Step 1 complete in architecture doc** — Update `docs/architecture/architecture.md` to reflect completion.
   Commit: `docs: mark Phase 14 Step 1 complete in architecture`

## Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users with existing `disallowed_tools` frontmatter silently lose tool restrictions | Breaking change is intentional and documented; `feat!:` commit triggers a major version bump via release-please; README migration note directs to `permission:` frontmatter |
| `filterActiveTools` behavior regresses for non-denylist paths                      | Steps 1–3 each run `pnpm run check` or `pnpm vitest run`; existing extension-filtering tests remain unchanged                                                               |
| Stale references to `disallowed_tools` in docs or plans                            | Grep sweep in step 5 covers README; architecture doc updated in step 6; historical plan/retro files are left as-is (they document past state)                               |

## Open Questions

None — the issue's proposed change is unambiguous and the architecture doc provides detailed step-by-step guidance.
