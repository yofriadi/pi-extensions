---
issue: 242
issue_title: "Rename `Agent` tool to `subagent`"
---

# Rename `Agent` tool to `subagent`

## Problem Statement

The `Agent` tool is the only PascalCase tool name in the Pi ecosystem.
Pi's built-in tools are all lowercase (`read`, `bash`, `write`, `edit`, `find`, `grep`, `ls`), and the companion tools in this package already use lowercase snake_case (`get_subagent_result`, `steer_subagent`).
The PascalCase name was inherited from tintinweb/pi-subagents, which mimicked Claude Code's convention rather than Pi's.

## Goals

- Rename the tool from `"Agent"` to `"subagent"` — a **breaking change** (`feat!:`).
- Update `label`, `promptSnippet`, and `description` text to reference `subagent` instead of `Agent`.
- Update `EXCLUDED_TOOL_NAMES` in `agent-runner.ts`.
- Update the fallback display name in `agent-tool.ts` `renderCall`.
- Update architecture docs that reference the `Agent` tool name.
- Update `README.md` tool-name references.
- Update all affected tests.

## Non-Goals

- Renaming the `displayName` of the general-purpose agent type (`"Agent"` in `default-agents.ts` and `agent-types.ts` fallback) — that is a UI display name for the agent *type*, not the tool name.
  The widget shows "Agent" as the display name for general-purpose agents; this is a separate concern.
- Renaming the companion tools `get_subagent_result` and `steer_subagent` — they already follow the lowercase convention.
- Updating the companion tools' `label` fields (`"Steer Agent"`, `"Get Agent Result"`) — these use "Agent" in the human-readable sense, not as the tool name.
- Collapsing `filterActiveTools` (#239) — that step is independent within Phase 14.
- Updating pi-permission-system docs — verified that no docs there reference the `Agent` tool name specifically.
  All "Agent" references in that package's docs refer to the agent-name concept (per-agent overrides, agent frontmatter), not the tool.

## Background

Phase 14 of the architecture roadmap strips policy enforcement from pi-subagents.
Steps 1 and 2 (#237, #238) are complete; Step 3 (#239, collapse `filterActiveTools`) is open but independent of this rename.
This is Step 4 — the final convention-alignment step in Phase 14.

### Files affected

| File                                                  | Current `"Agent"` references                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/agent-tool.ts`                             | `name`, `label`, `promptSnippet`, description text, `renderCall` fallback (line 247)                                                              |
| `src/lifecycle/agent-runner.ts`                       | `EXCLUDED_TOOL_NAMES` array (line 22)                                                                                                             |
| `README.md`                                           | Tool name references, usage examples, tool parameter table heading                                                                                |
| `docs/architecture/architecture.md`                   | Directory listing comment, findings table, Step 4 description                                                                                     |
| `test/tools/agent-tool.test.ts`                       | `name` and `label` assertions                                                                                                                     |
| `test/lifecycle/agent-runner-extension-tools.test.ts` | `"Agent"` in active-tools arrays and `not.toContain` assertion                                                                                    |
| `test/print-mode.test.ts`                             | `tools.get("Agent")` lookup                                                                                                                       |
| `test/widget-renderer.test.ts`                        | `"Agent"` in display-name comment and assertion                                                                                                   |
| `test/tools/spawn-config.test.ts`                     | `displayName: "Agent"` assertions (general-purpose type display name — **no change**, these test the agent type's displayName, not the tool name) |
| `test/tools/foreground-runner.test.ts`                | `displayName: "Agent"` in fixture data (**no change** — tests general-purpose type displayName)                                                   |
| `test/tools/helpers.test.ts`                          | `displayName: "Agent"` in fixture data (**no change** — tests result rendering, not tool name)                                                    |
| `test/display.test.ts`                                | `"Agent"` display name assertion (**no change** — tests `getDisplayName` for general-purpose type)                                                |

## Design Overview

This is a straightforward string-replacement change with no logic or type changes.
The tool's `name` field drives Pi's tool registration, system-prompt toolbox, and LLM invocations.

### Tool definition changes

```typescript
// Before
name: "Agent" as const,
label: "Agent",
promptSnippet: "Agent: Launch a specialized agent for complex, multi-step tasks.",

// After
name: "subagent" as const,
label: "Subagent",
promptSnippet: "subagent: Launch a specialized agent for complex, multi-step tasks.",
```

The description body changes `"The Agent tool launches"` → `"The subagent tool launches"` and `"Agent results are returned"` → `"Subagent results are returned"`.

### renderCall fallback

```typescript
// Before
: "Agent";
// After
: "Subagent";
```

This fallback shows when no `subagent_type` is provided.
Using `"Subagent"` (capitalized for display) is appropriate — it mirrors the tool's identity without conflating with the general-purpose agent type's `displayName`.

### EXCLUDED_TOOL_NAMES

```typescript
// Before
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];
// After
const EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];
```

## Module-Level Changes

### `src/tools/agent-tool.ts`

1. Change `name: "Agent" as const` → `name: "subagent" as const`.
2. Change `label: "Agent"` → `label: "Subagent"`.
3. Change `promptSnippet` to start with `subagent:` instead of `Agent:`.
4. Change `"The Agent tool launches"` → `"The subagent tool launches"` in description.
5. Change `"Agent results are returned"` → `"Subagent results are returned"` in description guidelines.
6. Change fallback `"Agent"` → `"Subagent"` in `renderCall`.

### `src/lifecycle/agent-runner.ts`

1. Change `"Agent"` → `"subagent"` in `EXCLUDED_TOOL_NAMES`.

### `README.md`

1. Update tool name references in the "features" bullet (`` `Agent` `` → `` `subagent` ``).
2. Update usage example heading and code block (`Agent({` → `subagent({`).
3. Update tool parameter table heading (`### \`Agent\`` → `### \`subagent\``).
4. Update prose references to the `Agent` tool ("`Agent` tool parameters", "`Agent` tool returns").
5. Update widget example display — the widget shows `Agent` because the general-purpose type's `displayName` is `"Agent"`, so those lines stay as-is.

### `docs/architecture/architecture.md`

1. Update the directory listing comment: `agent-tool.ts` description → `subagent tool definition`.
2. Update the findings table row to mark the item as resolved.
3. Update Step 4 description to indicate completion.
4. The `(née \`Agent\`)` parenthetical in the "What the core owns" section already anticipates the rename — keep it as-is for historical context.

### Test files

1. `test/tools/agent-tool.test.ts` — update `name` and `label` assertions.
2. `test/lifecycle/agent-runner-extension-tools.test.ts` — update `"Agent"` in active-tools arrays and `.not.toContain("Agent")` → `.not.toContain("subagent")`.
3. `test/print-mode.test.ts` — update `tools.get("Agent")` → `tools.get("subagent")`.
4. `test/widget-renderer.test.ts` — update the comment text (the assertion tests general-purpose displayName, which stays `"Agent"`).

## Test Impact Analysis

1. No new tests are needed — this is a string-value change.
2. Existing tests that assert the tool name `"Agent"` must be updated to assert `"subagent"`.
3. Tests that assert the general-purpose agent type's `displayName` (`"Agent"`) are **not affected** — the `displayName` is an agent-type property, not the tool name.

## TDD Order

1. **Update tool definition and runner constant.**
   Change `name`, `label`, `promptSnippet`, description text, and `renderCall` fallback in `agent-tool.ts`.
   Change `EXCLUDED_TOOL_NAMES` in `agent-runner.ts`.
   Update affected tests in `agent-tool.test.ts`, `agent-runner-extension-tools.test.ts`, `print-mode.test.ts`, and `widget-renderer.test.ts`.
   Commit: `feat!: rename Agent tool to subagent (#242)`

2. **Update documentation.**
   Update `README.md` tool-name references and usage examples.
   Update `docs/architecture/architecture.md` directory listing, findings table, and Step 4 status.
   Commit: `docs: update tool name references after Agent → subagent rename (#242)`

## Risks and Mitigations

| Risk                                                                                            | Mitigation                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Breaking change for users referencing `Agent` in AGENTS.md, prompt templates, or custom configs | This is intentional and documented in the issue. Fits within the Phase 14 breaking-change window. Use `feat!:` commit prefix. |
| Forgetting a test reference to `"Agent"`                                                        | Grep all test files for `"Agent"` before committing. Distinguish tool-name references from agent-type displayName references. |
| Companion tool labels (`"Steer Agent"`, `"Get Agent Result"`) use "Agent"                       | These use "Agent" in the human-readable sense. They are not affected by the tool-name rename and remain consistent.           |

## Open Questions

None — the issue scope is unambiguous.
