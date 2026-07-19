---
issue: 188
issue_title: "refactor(pi-subagents): replace any casts with SDK types in extractText and SubscribableSession"
---

# Replace `any` casts with SDK types

## Problem Statement

Two places in pi-subagents use `any` where proper SDK types are available and already imported in adjacent files.
`extractText` in `session/context.ts` uses `(c: any)` in a filter/map chain, requiring a top-level `eslint-disable` for `no-unsafe-member-access` and `no-unsafe-return`.
`record-observer.ts` and `ui-observer.ts` each define an identical local `SubscribableSession` interface with `(event: any) => void`, creating both a type hole and duplicated boilerplate.

## Goals

- Replace `any` casts in `extractText` with a `TextContent` type predicate.
- Remove the `eslint-disable` comment from `session/context.ts`.
- Replace `any` in the `SubscribableSession` interface with `AgentSessionEvent`.
- Deduplicate the `SubscribableSession` interface into a single shared definition.

## Non-Goals

- Changing the `extractText` parameter type from `unknown[]` — callers in `message-formatters.ts` pass `unknown[]`, and widening the refactoring surface is out of scope.
- Replacing the `SubscribableSession` interface with the full `AgentSession` class — ISP requires a narrow interface (the observers only need `subscribe`).
- Addressing the `eslint-disable` in `record-observer.ts` and `ui-observer.ts` for `no-unsafe-member-access` / `no-unsafe-assignment` — those are caused by the `event` property access pattern inside the callback body, not by the parameter type.
  Once the callback parameter is typed as `AgentSessionEvent`, the unsafe-access rules should be satisfied and those `eslint-disable` comments can be removed too.

## Background

### Existing conventions

`content-items.ts` already imports `TextContent` from `@earendil-works/pi-ai` and uses `(c as TextContent).text` after a `c.type === "text"` guard.
`agent-runner.ts` already imports `AgentSessionEvent` from `@earendil-works/pi-coding-agent` and uses it as the parameter type in `session.subscribe((event: AgentSessionEvent) => { ... })`.
Both SDK types are proven to work in this package.

### `extractText` callers

`extractText(content: unknown[])` is called from:

- `session/context.ts` — `buildParentContext` passes `msg.content` from session entries.
- `lifecycle/agent-runner.ts` — `getLastAssistantText` and `getAgentConversation` pass `msg.content`.
- `ui/message-formatters.ts` — `formatUserMessage` and `formatToolResult` pass `unknown[]` content.

The parameter type stays `unknown[]` to avoid rippling through callers.
The type predicate narrows inside the function body.

### `SubscribableSession` consumers

Both `subscribeRecordObserver` and `subscribeUIObserver` accept a `SubscribableSession` parameter.
Tests use `createMockSession()` from `test/helpers/mock-session.ts`, which returns a `MockSession` with `subscribe: Mock<(fn: (event: unknown) => void) => () => void>`.

Changing `SubscribableSession.subscribe` to accept `(event: AgentSessionEvent) => void` is structurally sound: the mock's `subscribe` accepting `(fn: (event: unknown) => void)` is a supertype — a function that accepts any event can accept an `AgentSessionEvent`.
The TypeScript compiler allows this because of function parameter contravariance.
Tests construct inline event objects that match `AgentSessionEvent` member shapes, so no test changes are needed.

### Shared location for `SubscribableSession`

The interface is used by two domains (observation, UI).
A new shared types location is needed.
The existing `types.ts` at the package root contains cross-cutting types (`SubagentType`, `ThinkingLevel`, `ShellExec`).
`SubscribableSession` fits there — it's a narrow cross-domain interface for session event subscription.

## Design Overview

### `extractText` type predicate

Replace the `any` casts with a user-defined type guard:

```typescript
import type { TextContent } from "@earendil-works/pi-ai";

function isTextContent(c: unknown): c is TextContent {
  return typeof c === "object" && c !== null && (c as { type: string }).type === "text";
}

export function extractText(content: unknown[]): string {
  return content
    .filter(isTextContent)
    .map((c) => c.text ?? "")
    .join("\n");
}
```

The type predicate eliminates both `any` casts and the `eslint-disable` at the top of the file.

### `SubscribableSession` with `AgentSessionEvent`

Move the interface to `types.ts` and type the callback:

```typescript
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface SubscribableSession {
  subscribe(fn: (event: AgentSessionEvent) => void): () => void;
}
```

Both observer files import from `types.ts` instead of defining their own.

### Event property access in observer callbacks

Once the callback parameter is typed as `AgentSessionEvent`, TypeScript knows the event's discriminated union members.
The `event.type` checks narrow the union, so `event.toolName`, `event.message`, etc. become type-safe.
The `eslint-disable` comments for `no-unsafe-member-access` and `no-unsafe-assignment` can be removed from both observer files.

## Module-Level Changes

| File                                 | Change                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/context.ts`             | Import `TextContent`; add `isTextContent` type predicate; replace `any` filter/map; remove top-level `eslint-disable`                                         |
| `src/types.ts`                       | Add `SubscribableSession` interface with `AgentSessionEvent` callback type; add `AgentSessionEvent` import                                                    |
| `src/observation/record-observer.ts` | Import `SubscribableSession` from `types.ts`; remove local interface; remove top-level `eslint-disable`; remove inline `any` annotation on callback parameter |
| `src/ui/ui-observer.ts`              | Import `SubscribableSession` from `types.ts`; remove local interface; remove top-level `eslint-disable`; remove inline `any` annotation on callback parameter |

No test file changes expected — the mock session's structural typing remains compatible.

## Test Impact Analysis

1. No new unit tests are needed — the refactoring is type-only (no behavioral change).
2. No existing tests become redundant.
3. All existing tests for `subscribeRecordObserver` and `subscribeUIObserver` must pass as-is — they verify the same event-handling behavior.

## TDD Order

This is a pure refactoring with no behavioral change.
Each step should pass `pnpm run check` (type-check) and `pnpm vitest run` (tests) before committing.

1. **Add `isTextContent` type predicate and remove `any` from `extractText`.**
   Import `TextContent` from `@earendil-works/pi-ai`.
   Add `isTextContent` predicate function.
   Replace the `any`-cast filter/map chain with the predicate.
   Remove the top-level `eslint-disable` comment.
   Verify: `pnpm run check`, `pnpm vitest run`.
   Commit: `refactor: replace any casts in extractText with TextContent type predicate (#188)`

2. **Move `SubscribableSession` to `types.ts` with `AgentSessionEvent`.**
   Add `AgentSessionEvent` import and `SubscribableSession` interface to `src/types.ts`.
   Update `record-observer.ts`: import from `types.ts`, remove local interface, remove `eslint-disable`, remove `any` from callback parameter.
   Update `ui-observer.ts`: import from `types.ts`, remove local interface, remove `eslint-disable`, remove `any` from callback parameter.
   Verify: `pnpm run check`, `pnpm vitest run`.
   Commit: `refactor: replace any in SubscribableSession with AgentSessionEvent (#188)`

## Risks and Mitigations

1. **`AgentSessionEvent` union may not cover all event shapes accessed in observers.**
   Mitigation: `agent-runner.ts` already uses the same type for identical event patterns (`event.type`, `event.toolName`, `event.message`).
   The type checker will flag any property access that the union doesn't support.
   Run `pnpm run check` after each step.

2. **Mock session type incompatibility.**
   The mock's `subscribe` accepts `(fn: (event: unknown) => void)`.
   A `SubscribableSession` with `(fn: (event: AgentSessionEvent) => void)` is structurally compatible via contravariance.
   If the compiler disagrees, the mitigation is to update `MockSession.subscribe` to accept `(fn: (event: AgentSessionEvent) => void)` — a one-line change.

3. **`TextContent.text` is non-optional in the SDK type.**
   The current code uses `c.text ?? ""` which implies `text` could be undefined.
   `TextContent` defines `text: string` (required), so the nullish coalescing is harmless but unnecessary.
   Keep it for safety — removing it is a separate cleanup.

## Open Questions

None — the issue's proposed approach is unambiguous and the SDK types are already validated in adjacent files.
