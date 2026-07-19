---
issue: 152
issue_title: "Add promptSnippet to pi-subagents tools"
---

# Add `promptSnippet` to pi-subagents tools

## Problem Statement

The `Agent`, `get_subagent_result`, and `steer_subagent` tools are the only tools across the monorepo that lack `promptSnippet`.
Pi's `buildSystemPrompt` uses `promptSnippet` to build a concise tool summary in the system prompt.
Without it, these tools rely entirely on their `description` field for model guidance.
The `Agent` tool's description is especially long (embeds full usage guidelines), so a short snippet would give the model a better quick-reference view.

## Goals

- Add `promptSnippet` to each of the three tool registrations in pi-subagents.
- Match the established `"<toolName>: <one-liner>"` format used by pi-github-tools and pi-colgrep.

## Non-Goals

- Changing `description`, `promptGuidelines`, or any other tool registration field.
- Adding `promptSnippet` to tools in other packages (already done).

## Background

Sibling packages pi-github-tools and pi-colgrep already provide `promptSnippet` on every tool.
The convention is a single string in the form `"tool_name: Short imperative description."`.
For example: `"ci_list: List recent CI runs for a workflow."`.

The three tool factories live in:

| Factory               | File                           |
| --------------------- | ------------------------------ |
| `createAgentTool`     | `src/tools/agent-tool.ts`      |
| `createGetResultTool` | `src/tools/get-result-tool.ts` |
| `createSteerTool`     | `src/tools/steer-tool.ts`      |

Each factory returns a plain object with `name`, `label`, `description`, `parameters`, and `execute`.
Adding `promptSnippet` is a single property addition per factory.

## Design Overview

No structural change — this is a property addition to three existing object literals.

Proposed snippets:

- **Agent** — `"Agent: Launch a specialized agent for complex, multi-step tasks."`
- **get_subagent_result** — `"get_subagent_result: Check status and retrieve results from a background agent."`
- **steer_subagent** — `"steer_subagent: Send a mid-run message to redirect a running background agent."`

These are the exact phrasings from the issue.
Exact wording may be refined during implementation.

## Module-Level Changes

### `src/tools/agent-tool.ts`

Add `promptSnippet` property to the object returned by `createAgentTool`, after `label`.

### `src/tools/get-result-tool.ts`

Add `promptSnippet` property to the object returned by `createGetResultTool`, after `label`.

### `src/tools/steer-tool.ts`

Add `promptSnippet` property to the object returned by `createSteerTool`, after `label`.

## Test Impact Analysis

Existing tool-definition tests (`test/tools/agent-tool.test.ts`, `get-result-tool.test.ts`, `steer-tool.test.ts`) assert `name`, `label`, and `description` but not `promptSnippet`.
New assertions will verify the property exists with the expected value.
No existing tests need modification — the new property is additive.

## TDD Order

1. **Red → Green:** Add `promptSnippet` assertions to the tool-definition tests for all three tools, then add the `promptSnippet` property to each factory.
   Commit: `feat: add promptSnippet to Agent, get_subagent_result, and steer_subagent (#152)`

This is a single-cycle change — one test step, one implementation step, one commit.

## Risks and Mitigations

| Risk                                                  | Mitigation                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Snippet wording doesn't match what Pi displays well   | The snippets mirror the first sentence of each tool's `description`; can be tweaked in a follow-up without breaking anything. |
| SDK `defineTool` doesn't pass through `promptSnippet` | Sibling packages already use it successfully, confirming SDK support.                                                         |

## Open Questions

None.
