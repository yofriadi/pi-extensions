---
issue: 170
issue_title: "refactor(pi-subagents): reduce buildContentLines complexity (cognitive 71)"
---

# Reduce `buildContentLines` complexity

## Problem Statement

`buildContentLines` in `ui/conversation-viewer.ts` has cyclomatic complexity 30 and cognitive complexity 71 — the highest in the codebase (fallow #2 refactoring target, score 9.7).
The method formats session events for display, handling user messages, assistant messages, tool calls, tool results, bash execution output, and a streaming indicator in a single function.

## Goals

- Extract per-content-type formatting into standalone pure functions in a new module.
- Reduce `buildContentLines` to a dispatch loop that delegates to formatters.
- Make each formatter independently testable with clear input/output.

## Non-Goals

- Changing the visual output or behavior of the conversation viewer.
- Refactoring `render()` or the chrome/scrolling logic.
- Restructuring the `ConversationViewer` class itself (constructor, options, etc.).

## Background

Issue #164 (reorganize source into domain directories) is implemented — files are already in `src/ui/`.

`buildContentLines` currently handles five concerns in a single method body:

1. **User messages** — extract text from string or content array, wrap, push with `[User]` header.
2. **Assistant messages** — separate text parts from tool calls, wrap text, append `[Tool: name]` lines.
3. **Tool results** — extract text, truncate to 500 chars, wrap in dim styling.
4. **Bash execution** — render command line, truncate/wrap output.
5. **Streaming indicator** — append activity description for running agents.

Each branch uses `this.theme` and `this.wrapText` but has no other instance dependencies.
The method also manages separator logic (`needsSeparator`) and applies a final `truncateToWidth` safety net.

Dependencies consumed by the formatters:

- `Theme` from `display.ts` — for `fg()` and `bold()`.
- `truncateToWidth` from `@earendil-works/pi-tui`.
- `extractText` from `session/context.ts`.
- `getToolCallName` and `isBashExecution` — file-local helpers in `conversation-viewer.ts`.

## Design Overview

### New module: `ui/message-formatters.ts`

A new file containing pure functions that convert a single message into display lines.
Each formatter receives the message, a `width`, and a narrow `FormatterContext` (theme + wrapText).
Each returns `string[]` — the formatted lines for that message, **excluding** separators and the final `truncateToWidth` pass (those remain in `buildContentLines`).

```typescript
/** Narrow context shared by all message formatters. */
export interface FormatterContext {
  theme: Theme;
  wrapText: (text: string, width: number) => string[];
}

export function formatUserMessage(
  content: string | unknown[],
  width: number,
  ctx: FormatterContext,
): string[] | null;

export function formatAssistantMessage(
  content: Array<{ type: string; text?: string }>,
  width: number,
  ctx: FormatterContext,
): string[];

export function formatToolResult(
  content: unknown[],
  width: number,
  ctx: FormatterContext,
): string[] | null;

export function formatBashExecution(
  msg: BashExecutionMessage,
  width: number,
  ctx: FormatterContext,
): string[];

export function formatStreamingIndicator(
  activeTools: ReadonlyMap<string, string>,
  responseText: string | undefined,
  width: number,
  theme: Theme,
): string[];
```

`formatUserMessage` and `formatToolResult` return `null` when the content is empty (matching the current `continue` behavior), letting the caller skip the separator.

### Relocated helpers

`getToolCallName`, the `ToolCallContent` interface, `BashExecutionMessage`, and `isBashExecution` move to `message-formatters.ts` — they are consumed only by the formatters.
The type guard `isBashExecution` remains exported so `buildContentLines` can use it in the dispatch condition.

### Simplified `buildContentLines`

After extraction, `buildContentLines` becomes a ~25-line dispatch loop:

```typescript
private buildContentLines(width: number): string[] {
  if (width <= 0) return [];
  const ctx = { theme: this.theme, wrapText: this.wrapText };
  const messages = this.session.messages;
  if (messages.length === 0) {
    return [this.theme.fg("dim", "(waiting for first message...)")];
  }
  const lines: string[] = [];
  let needsSeparator = false;
  for (const msg of messages) {
    const formatted = formatMessage(msg, width, ctx);
    if (!formatted) continue;
    if (needsSeparator) lines.push(this.theme.fg("dim", "───"));
    lines.push(...formatted);
    needsSeparator = true;
  }
  if (this.record.status === "running" && this.activity) {
    lines.push(...formatStreamingIndicator(
      this.activity.activeTools, this.activity.responseText, width, this.theme,
    ));
  }
  return lines.map(l => truncateToWidth(l, width));
}
```

A private `formatMessage` dispatcher selects the right formatter by `msg.role`, keeping the per-role logic in the new module.
The `formatMessage` function lives in `message-formatters.ts` and encapsulates the role-based dispatch:

```typescript
export function formatMessage(
  msg: { role: string; [key: string]: unknown },
  width: number,
  ctx: FormatterContext,
): string[] | null;
```

### Design principles applied

- **SRP**: Each formatter has one reason to change (its content type's display rules).
- **ISP**: `FormatterContext` is a 2-field interface — narrower than `ConversationViewerOptions`.
- **Tell-Don't-Ask**: The caller tells the formatter "format this message at this width" and receives lines back — no interrogation of the message's internals in the caller.
- **No output arguments**: Formatters return new arrays; they don't mutate a shared `lines` accumulator.

## Module-Level Changes

### New file: `src/ui/message-formatters.ts`

- `FormatterContext` interface.
- `ToolCallContent` interface (moved from `conversation-viewer.ts`).
- `BashExecutionMessage` interface (moved from `conversation-viewer.ts`).
- `getToolCallName` function (moved from `conversation-viewer.ts`).
- `isBashExecution` type guard (moved from `conversation-viewer.ts`).
- `formatUserMessage` function.
- `formatAssistantMessage` function.
- `formatToolResult` function.
- `formatBashExecution` function.
- `formatStreamingIndicator` function.
- `formatMessage` dispatcher function.

### Modified: `src/ui/conversation-viewer.ts`

- Remove `ToolCallContent`, `BashExecutionMessage`, `getToolCallName`, `isBashExecution` (moved to `message-formatters.ts`).
- Import `formatMessage`, `formatStreamingIndicator` from `message-formatters.ts`.
- Replace `buildContentLines` body with the dispatch loop above.

### New file: `test/message-formatters.test.ts`

- Unit tests for each formatter function and the `formatMessage` dispatcher.

### Modified: `test/conversation-viewer.test.ts`

- Existing tests remain as-is — they exercise the integrated `render()` and `buildContentLines` paths (width-safety and clamping), which are genuine integration tests for the viewer.
- No tests become redundant; the new unit tests cover formatter logic that was previously only reachable through the viewer's `render()` method.

## Test Impact Analysis

1. **New unit tests enabled**: Each formatter can now be tested in isolation — verifying header labels, text wrapping, truncation thresholds (500-char limit), tool-call name extraction, empty-content null returns, and streaming indicator formatting — without constructing a full `ConversationViewer` with mock `TUI`, `AgentSession`, and `AgentRecord`.
2. **No existing tests become redundant**: The existing `conversation-viewer.test.ts` tests are render-width-safety integration tests.
   They exercise the full `render()` → `buildContentLines` → `truncateToWidth` pipeline and should remain.
3. **Existing tests stay as-is**: They test the viewer's chrome, scrolling, and width-clamping behavior — concerns orthogonal to the per-message formatting logic being extracted.

## TDD Order

1. **Red → Green**: Add unit tests for `formatUserMessage` — plain string content, content-array content, empty content returning null, header and wrapping behavior.
   Commit: `test: add formatUserMessage unit tests`

2. **Red → Green**: Add unit tests for `formatAssistantMessage` — text-only content, tool-call-only content, mixed content, empty text parts.
   Commit: `test: add formatAssistantMessage unit tests`

3. **Red → Green**: Add unit tests for `formatToolResult` — normal content, content exceeding 500 chars (truncation), empty content returning null.
   Commit: `test: add formatToolResult unit tests`

4. **Red → Green**: Add unit tests for `formatBashExecution` — command rendering, output wrapping, long output truncation, empty output.
   Commit: `test: add formatBashExecution unit tests`

5. **Red → Green**: Add unit tests for `formatStreamingIndicator` — active tools, response text fallback, no-activity "thinking" fallback.
   Commit: `test: add formatStreamingIndicator unit tests`

6. **Red → Green**: Add unit tests for `formatMessage` dispatcher — correct delegation by role, unknown role returning null.
   Commit: `test: add formatMessage dispatcher tests`

7. **Green → Refactor**: Create `message-formatters.ts` with all formatter functions and the dispatcher.
   Move `ToolCallContent`, `BashExecutionMessage`, `getToolCallName`, `isBashExecution` from `conversation-viewer.ts`.
   Commit: `refactor: extract message formatters from conversation-viewer`

8. **Green → Refactor**: Simplify `buildContentLines` to use the new `formatMessage` dispatcher and `formatStreamingIndicator`.
   Verify all existing `conversation-viewer.test.ts` tests still pass.
   Commit: `refactor: simplify buildContentLines to dispatch loop`

## Risks and Mitigations

| Risk                                                                                | Mitigation                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatter output differs subtly from inline code (missing separator, wrong styling) | Steps 7–8 keep all existing integration tests passing — any visual regression fails the width-safety suite.                                                       |
| `FormatterContext` grows over time as new formatters need more dependencies         | The interface is deliberately minimal (2 fields); if a future formatter needs something new, it should accept it as a parameter rather than widening the context. |
| `msg` type is `unknown`-heavy due to Pi SDK not exporting narrow types              | Preserve the existing file-local type guards and interfaces — they already handle the runtime shape safely.                                                       |

## Open Questions

- None — the extraction is mechanical and the issue's approach section is unambiguous.
