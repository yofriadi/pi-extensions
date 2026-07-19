---
issue: 215
issue_title: "Decompose buildParentContext (cognitive 30) (Phase 13, Step 2)"
---

# Decompose `buildParentContext`

## Problem Statement

`buildParentContext` in `src/session/context.ts` is the only remaining fallow refactoring target in the package.
The function has a cognitive complexity of 30, driven by a loop with three type-check branches (`message`, `compaction`, default), each with sub-branches for role (`user` vs `assistant`) and content type (`string` vs array).
The architecture roadmap (Phase 13, Step 2) targets cognitive complexity < 10 and function body < 15 LOC.

## Goals

- Extract per-entry-type formatters: `formatMessageEntry(entry)` and `formatCompactionEntry(entry)`.
- Reduce `buildParentContext` to a loop + filter + join orchestrator (< 15 LOC).
- Achieve cognitive complexity < 10 for all functions in the file.
- Add unit tests for the extracted formatters and the orchestrator.

## Non-Goals

- Changing the public API surface (`buildParentContext`, `extractText`) — signatures stay the same.
- Moving `extractText` to another module (noted as a follow-up in prior plans but out of scope).
- Refactoring callers (`parent-snapshot.ts`) — they are already tested via mocks.

## Background

### Current file: `src/session/context.ts`

The file exports two functions:

1. `extractText(content: unknown[]): string` — filters an array of content blocks to `TextContent` items and joins their `.text` values.
   Used by `agent-runner.ts`, `message-formatters.ts`, and `buildParentContext` itself.
2. `buildParentContext(ctx: SessionContext): string` — iterates session branch entries, formatting `message` entries (user/assistant) and `compaction` entries into a text representation prefixed with a header.

The file also defines three local types (`MessageEntry`, `CompactionEntry`, `BranchEntry`) and one helper (`isTextContent`).

### Callers

- `buildParentContext` is called only from `parent-snapshot.ts` (where it is mocked in tests).
- `extractText` is called from `agent-runner.ts`, `message-formatters.ts`, and internally within `buildParentContext`.

### Existing tests

There are no direct unit tests for `context.ts`.
`parent-snapshot.test.ts` mocks `buildParentContext` entirely, so the formatting logic is currently untested.

## Design Overview

### Extracted formatters

Each formatter takes a typed entry and returns `string | undefined` (undefined when the entry should be skipped):

```typescript
function formatMessageEntry(entry: MessageEntry): string | undefined {
  const msg = entry.message;
  const text =
    typeof msg.content === "string"
      ? msg.content
      : extractText(msg.content);
  if (!text.trim()) return undefined;
  if (msg.role === "user") return `[User]: ${text.trim()}`;
  if (msg.role === "assistant") return `[Assistant]: ${text.trim()}`;
  return undefined; // skip toolResult and other roles
}

function formatCompactionEntry(entry: CompactionEntry): string | undefined {
  return entry.summary ? `[Summary]: ${entry.summary}` : undefined;
}
```

### Simplified orchestrator

```typescript
export function buildParentContext(ctx: SessionContext): string {
  const entries = ctx.sessionManager.getBranch();
  if (!entries || entries.length === 0) return "";

  const parts = (entries as BranchEntry[])
    .map(formatBranchEntry)
    .filter((p): p is string => p !== undefined);

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
```

A thin dispatcher (`formatBranchEntry`) routes by `type`:

```typescript
function formatBranchEntry(entry: BranchEntry): string | undefined {
  if (entry.type === "message") return formatMessageEntry(entry as MessageEntry);
  if (entry.type === "compaction") return formatCompactionEntry(entry as CompactionEntry);
  return undefined;
}
```

### Complexity analysis

- `formatMessageEntry`: 3 branches (string-vs-array, empty check, role) — estimated cognitive complexity ~4.
- `formatCompactionEntry`: 1 branch — estimated cognitive complexity ~1.
- `formatBranchEntry`: 2 branches — estimated cognitive complexity ~2.
- `buildParentContext`: 2 branches (empty entries, empty parts) — estimated cognitive complexity ~3.

All well under the < 10 target.

## Module-Level Changes

### `src/session/context.ts`

1. Add `formatMessageEntry(entry: MessageEntry): string | undefined` — private helper.
2. Add `formatCompactionEntry(entry: CompactionEntry): string | undefined` — private helper.
3. Add `formatBranchEntry(entry: BranchEntry): string | undefined` — private dispatcher.
4. Simplify `buildParentContext` body to use `map(formatBranchEntry).filter(...)`.
5. No changes to exports — `buildParentContext` and `extractText` signatures are unchanged.
6. No changes to local types (`MessageEntry`, `CompactionEntry`, `BranchEntry`) or `isTextContent`.

### `test/session/context.test.ts` (new)

Unit tests for:

- `extractText` — string extraction from mixed content arrays.
- `buildParentContext` — end-to-end formatting with user, assistant, compaction, and skipped entries.

The formatters are private, so they are tested indirectly through `buildParentContext`.

## Test Impact Analysis

1. The new `context.test.ts` enables direct testing of formatting logic that was previously untested (mocked away in `parent-snapshot.test.ts`).
2. No existing tests become redundant — `parent-snapshot.test.ts` tests snapshot assembly, not formatting.
3. No existing tests need modification — the public API is unchanged.

## TDD Order

1. **Red → Green:** Add `test/session/context.test.ts` with tests for `extractText` — empty array, text-only, mixed content types, no text content.
   Commit: `test: add extractText unit tests (#215)`

2. **Red → Green:** Add tests for `buildParentContext` — empty branch, user messages, assistant messages, compaction entries with/without summary, mixed entry types, entries with empty text (skipped), non-message/non-compaction entries (skipped), string vs array content.
   Commit: `test: add buildParentContext unit tests (#215)`

3. **Refactor:** Extract `formatMessageEntry`, `formatCompactionEntry`, and `formatBranchEntry` from `buildParentContext`.
   Simplify `buildParentContext` to map/filter/join.
   All tests from steps 1–2 must still pass.
   Commit: `refactor: decompose buildParentContext into per-entry formatters (#215)`

## Risks and Mitigations

| Risk                                                                                               | Mitigation                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Behavioral regression in formatting                                                                | Steps 1–2 lock in current behavior with tests before refactoring     |
| Extracted helpers expose implementation details                                                    | Helpers are private (not exported); tested indirectly via public API |
| `eslint-disable` comment for `no-unnecessary-condition` on `getBranch()` check may need adjustment | Preserve the comment — runtime nullability is documented             |

## Open Questions

None — the decomposition target and strategy are specified by the architecture roadmap.
