---
issue: 180
issue_title: "perf(pi-subagents): reorder append-mode system prompt to enable KV cache reuse"
---

# Reorder append-mode system prompt for KV cache reuse

## Problem Statement

In append mode, `buildAgentPrompt()` places varying, agent-specific content (the `<active_agent>` tag and env block) *before* the large shared inherited system prompt (~8k tokens).
LLM KV caching works on prefixes — the cache is only reusable when the beginning of the prompt matches.
Every subagent spawn reprocesses the entire inherited prompt from scratch because the prefix differs per agent.

## Goals

- Reorder the append-mode system prompt so shared/stable content comes first and varying content follows.
- Preserve the `<active_agent>` tag at any position — pi-permission-system's `ACTIVE_AGENT_TAG_REGEX.exec()` searches the full string.
- Keep replace-mode prompt ordering unchanged (it has no shared inherited content to cache).
- Update tests and JSDoc to reflect the new ordering.

## Non-Goals

- Changing replace-mode prompt assembly (no shared prefix to cache).
- Modifying pi-permission-system (its regex parsing is already position-independent).
- Changing the *content* of any prompt section — only reordering.

## Background

`buildAgentPrompt()` in `src/session/prompts.ts` assembles the system prompt for subagents.
In append mode, the current ordering is:

```text
1. <active_agent name="${name}"/>     ← VARIES per agent
2. # Environment ...                  ← VARIES per runtime
3. <inherited_system_prompt>          ← SHARED (~8k tokens)
4. <sub_agent_context>                ← SHARED (static)
5. <agent_instructions>               ← VARIES per agent
6. memory / skills                    ← VARIES
```

pi-permission-system's `getActiveAgentNameFromSystemPrompt()` in `src/active-agent.ts` uses `ACTIVE_AGENT_TAG_REGEX.exec(systemPrompt)` — a regex search that finds the tag at any position, confirmed by reading the source.

## Design Overview

Move shared/stable sections to the front of the append-mode prompt:

```text
1. <inherited_system_prompt>          ← SHARED (~8k tokens, NOW CACHEABLE)
2. <sub_agent_context>                ← SHARED (static)
3. <active_agent name="${name}"/>     ← VARIES (after cached prefix)
4. # Environment ...                  ← VARIES
5. <agent_instructions>               ← VARIES per agent
6. memory / skills                    ← VARIES
```

This is a pure reordering — no content changes.
The `<active_agent>` tag remains in the system prompt for pi-permission-system to find via regex.
The env block and agent instructions still provide context to the model; their position relative to the inherited prompt is not semantically significant.

## Module-Level Changes

### `src/session/prompts.ts`

1. Reorder the return statement in the `config.promptMode === "append"` branch to place `identity` (wrapped in `<inherited_system_prompt>`) and `bridge` before `activeAgentTag` and `envBlock`.
2. Update the JSDoc comment on `buildAgentPrompt()` — replace "Both modes prepend" language with a description that notes the tag is included (not necessarily prepended) in append mode.

### `test/session/prompts.test.ts`

1. Update "prepends `<active_agent>` tag in append mode" — change from asserting `prompt.startsWith()` to asserting the tag appears *after* the inherited system prompt.
2. Update "active_agent tag appears before envBlock in both modes" — the append-mode assertions change: the tag should still appear before the env block, but no longer at index 0.
   The replace-mode assertions remain unchanged (`tagIdx === 0`).

## Test Impact Analysis

- Two existing tests assert `<active_agent>` is prepended (index 0) in append mode — these must change to assert the new ordering.
- All other prompt tests use `toContain()` and are position-independent — they pass without changes.
- No new test files or test surfaces are needed; the existing test suite covers the reordering adequately once the positional assertions are updated.

## TDD Order

1. **Red: update positional assertions for append mode.**
   Change the two append-mode tests to assert the new ordering: `<inherited_system_prompt>` appears before `<active_agent>`, and the tag appears before the env block but not at index 0.
   Commit: `test: assert cache-friendly prompt ordering in append mode (#180)`

2. **Green: reorder the append-mode return statement.**
   Move `identity` + `<inherited_system_prompt>` wrapper and `bridge` before `activeAgentTag` + `envBlock` in the return expression.
   Update the JSDoc on `buildAgentPrompt()`.
   Commit: `perf: reorder append-mode prompt for KV cache reuse (#180)`

## Risks and Mitigations

| Risk                                         | Mitigation                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-permission-system depends on tag position | Confirmed `ACTIVE_AGENT_TAG_REGEX.exec()` searches the full string — position-independent.                                                         |
| Model behavior changes with reordered prompt | The same content is present; only ordering changes. The inherited system prompt as the "base" followed by specialization is arguably more natural. |
| Replace mode accidentally affected           | Replace mode has its own code path and is not touched by this change.                                                                              |

## Open Questions

None — the design is straightforward and confirmed safe by code inspection.
