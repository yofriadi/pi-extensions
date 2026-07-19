---
issue: 172
issue_title: "refactor(pi-subagents): extract shared turn-formatting logic"
---

# Extract shared turn-formatting logic

## Problem Statement

Fallow identified 18 lines of duplicated production code between `lifecycle/agent-runner.ts` and `ui/message-formatters.ts` (originally `conversation-viewer.ts` before #170 extracted formatters).
Both sites iterate over assistant message content items, extracting tool names and text parts for display.
The `ToolCallContent` interface and `getToolCallName` helper are duplicated verbatim in both files.

## Goals

- Extract the duplicated `ToolCallContent` type and `getToolCallName` function into a single shared module.
- Extract the content-iteration pattern (collecting text parts and tool names from assistant message content) into a reusable `extractAssistantContent` function.
- Both consumers (`getAgentConversation` in `agent-runner.ts` and `formatAssistantMessage` in `message-formatters.ts`) import from the shared module.
- Eliminate the fallow production-duplication finding.

## Non-Goals

- Moving `extractText` from `session/context.ts` to the new module — same concern (content parsing) but out of scope; note as a follow-up.
- Refactoring `getAgentConversation` itself (it has no tests and its full-loop structure mixes user/assistant/toolResult formatting) — separate concern.
- Changing `buildParentContext` in `session/context.ts`, which has a similar but simpler iteration pattern (no tool calls, different data source).

## Background

### Current duplication sites

`lifecycle/agent-runner.ts` (private scope):

```typescript
interface ToolCallContent {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

function getToolCallName(c: { type: string }): string {
  if (c.type !== "toolCall") return "unknown";
  const tc = c as ToolCallContent;
  return tc.name ?? tc.toolName ?? "unknown";
}
```

`ui/message-formatters.ts` (exported):

```typescript
interface ToolCallContent { /* identical */ }
export function getToolCallName(c: { type: string }): string { /* identical */ }
```

The content-iteration pattern appears in:

1. `getAgentConversation` (agent-runner.ts lines 480–486) — plain-text output for LLM consumption
2. `formatAssistantMessage` (message-formatters.ts lines 144–148) — themed display lines for TUI

Both collect `textParts: string[]` and tool names via the same `for (const c of content)` loop with identical guards.

### Structural analysis

Per the code-design skill's "structural reasons before extracting duplication" check: the two consumers differ only in *presentation* (plain text vs. themed TUI lines).
The *data extraction* — identifying text items and tool-call items, extracting tool names — is the same logical operation.
This is incidental duplication suitable for extraction.

### Dependencies

- Issue #164 (domain directory reorganization): ✓ closed — files are already in `lifecycle/` and `ui/`.
- Issue #170 (buildContentLines complexity reduction): ✓ closed — formatting logic is already in `message-formatters.ts`.
- Issue #170 is related: the extraction may simplify `formatAssistantMessage` slightly (the issue body predicted this).

### Placement

The architecture doc (Phase 10, Step 9) says: "extracts into a shared function in the session domain."
The `session/` directory already hosts `context.ts` which exports the related `extractText` function.
A new `session/content-items.ts` module keeps the concern focused without overloading `context.ts`.

## Design Overview

### New module: `session/content-items.ts`

```typescript
/** Tool-call content item — SDK exposes this at runtime but doesn't export the type. */
export interface ToolCallContent {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

/** Extracts the display name from a tool-call content item. */
export function getToolCallName(c: { type: string }): string {
  if (c.type !== "toolCall") return "unknown";
  const tc = c as ToolCallContent;
  return tc.name ?? tc.toolName ?? "unknown";
}

/** Extracted text parts and tool names from assistant message content. */
export interface AssistantContentParts {
  textParts: string[];
  toolNames: string[];
}

/**
 * Extract text and tool-call names from assistant message content items.
 * Pure data extraction — consumers apply their own formatting.
 */
export function extractAssistantContent(
  content: { type: string; [key: string]: unknown }[],
): AssistantContentParts {
  const textParts: string[] = [];
  const toolNames: string[] = [];
  for (const c of content) {
    if (c.type === "text" && c.text) textParts.push(c.text as string);
    else if (c.type === "toolCall") toolNames.push(getToolCallName(c));
  }
  return { textParts, toolNames };
}
```

### Consumer call sites (pseudocode)

`getAgentConversation` (agent-runner.ts):

```typescript
const { textParts, toolNames } = extractAssistantContent(msg.content);
if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
if (toolNames.length > 0) parts.push(`[Tool Calls]:\n${toolNames.map(n => `  Tool: ${n}`).join("\n")}`);
```

`formatAssistantMessage` (message-formatters.ts):

```typescript
const { textParts, toolNames } = extractAssistantContent(content);
const lines: string[] = [theme.bold("[Assistant]")];
if (textParts.length > 0) lines.push(...wrapText(textParts.join("\n").trim(), width));
for (const name of toolNames) lines.push(truncateToWidth(theme.fg("muted", `  [Tool: ${name}]`), width));
```

Both consumers call the same extraction, then apply their own presentation.
This follows Tell-Don't-Ask: the shared function returns structured data, not formatted strings.

## Module-Level Changes

### New files

| File                                 | Description                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/session/content-items.ts`       | `ToolCallContent`, `getToolCallName`, `AssistantContentParts`, `extractAssistantContent` |
| `test/session/content-items.test.ts` | Unit tests for `getToolCallName` and `extractAssistantContent`                           |

### Changed files

| File                                | Change                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lifecycle/agent-runner.ts`     | Remove `ToolCallContent` and `getToolCallName`; import `extractAssistantContent` from `session/content-items`; refactor `getAgentConversation` assistant branch        |
| `src/ui/message-formatters.ts`      | Remove `ToolCallContent` and `getToolCallName`; import `extractAssistantContent` and `getToolCallName` from `session/content-items`; refactor `formatAssistantMessage` |
| `docs/architecture/architecture.md` | Update Step 9 status to "✓ Done"; update `session/` module listing to include `content-items.ts`; update production duplication section                                |

### Architecture doc updates

The architecture doc references this issue in three places:

1. Line 487 — "Production duplication" subsection: update to note the duplication is resolved.
2. Line 247 — `session/` module listing: add `content-items.ts`.
3. Line 653 — Phase 10, Step 9: mark "✓ Done".

## Test Impact Analysis

1. **New unit tests enabled**: `getToolCallName` and `extractAssistantContent` get direct unit tests for the first time.
   Previously, `getToolCallName` was only exercised indirectly through `formatAssistantMessage` tests.
2. **Existing tests that stay as-is**: `message-formatters.test.ts` tests for `formatAssistantMessage` continue to exercise the full pipeline (extraction + formatting).
   They become integration-level tests relative to the new extraction layer — they should not be simplified or removed.
3. **No existing tests become redundant**: `getAgentConversation` has no tests today, so nothing to deduplicate.

## TDD Order

1. `test:` Write tests for `getToolCallName` in `test/session/content-items.test.ts` — covers `toolCall` with `name`, `toolName`, both (prefers `name`), neither (returns "unknown"), and non-toolCall type.
   Commit: `test: add getToolCallName unit tests`
2. `test:` Write tests for `extractAssistantContent` in the same file — covers empty array, text-only items, toolCall-only items, mixed items, and items with other types (e.g., `image`).
   Commit: `test: add extractAssistantContent unit tests`
3. `feat:` Create `src/session/content-items.ts` with `ToolCallContent`, `getToolCallName`, `AssistantContentParts`, and `extractAssistantContent`.
   All tests go green.
   Commit: `feat: extract shared content-item parsing into session/content-items`
4. `refactor:` Update `message-formatters.ts` — remove local `ToolCallContent` and `getToolCallName`; import `getToolCallName` and `extractAssistantContent` from `session/content-items`; refactor `formatAssistantMessage` to use `extractAssistantContent`.
   Existing `message-formatters.test.ts` stays green.
   Commit: `refactor: use shared content-items in message-formatters`
5. `refactor:` Update `agent-runner.ts` — remove local `ToolCallContent` and `getToolCallName`; import `extractAssistantContent` from `session/content-items`; refactor `getAgentConversation` assistant branch.
   Existing `agent-runner.test.ts` stays green.
   Commit: `refactor: use shared content-items in agent-runner`
6. `docs:` Update `docs/architecture/architecture.md` — mark Step 9 done, update module listing, update duplication section.
   Commit: `docs: mark step 9 (extract turn-formatting) done in architecture`

## Risks and Mitigations

| Risk                                                                                                              | Mitigation                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `getToolCallName` signature change breaking callers                                                               | Signature is identical — no change needed. Import path changes are the only difference.                        |
| `extractAssistantContent` return shape mismatch with consumers                                                    | Consumer pseudocode verified above; both sites restructure trivially around `{ textParts, toolNames }`.        |
| `message-formatters.ts` re-exports `getToolCallName` — removing the local definition could break external imports | Grep confirms no external consumers import `getToolCallName` from `message-formatters.ts`. Drop the re-export. |
| `isBashExecution` in `message-formatters.ts` also uses a local type — could be confused with this extraction      | `isBashExecution` and `BashExecutionMessage` are unrelated to the tool-call duplication; leave them in place.  |

## Open Questions

- Should `extractText` (currently in `session/context.ts`) move to `session/content-items.ts` for consistency?
  Deferred — it works fine where it is, and moving it means updating all importers for no functional benefit.
