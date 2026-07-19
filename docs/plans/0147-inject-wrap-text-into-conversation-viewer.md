---
issue: 147
issue_title: "Inject text wrapping into ConversationViewer (Phase 9, Step O)"
---

# Inject text wrapping into ConversationViewer

## Problem Statement

`ConversationViewer` calls `wrapTextWithAnsi` directly from `@earendil-works/pi-tui` in four places inside `buildContentLines`.
Because the function is a module-level binding, tests must intercept it via a hoisted `vi.mock("@earendil-works/pi-tui")` factory that replaces the entire TUI module.
This is the last `vi.mock` on an SDK module in the test suite, added specifically to exercise the overwidth-clamping safety net.

## Goals

- Accept `wrapText: (text: string, width: number) => string[]` via `ConversationViewerOptions`.
- Destructure `ConversationViewerOptions` in the constructor signature (dependency bag convention).
- Replace all four `wrapTextWithAnsi` calls in `buildContentLines` with `this.wrapText`.
- Remove `wrapTextWithAnsi` from `conversation-viewer.ts`'s `@earendil-works/pi-tui` import.
- Pass `wrapTextWithAnsi` at the production call site in `agent-menu.ts`.
- Eliminate the hoisted `vi.mock("@earendil-works/pi-tui")` from `conversation-viewer.test.ts`.

## Non-Goals

- Injecting `truncateToWidth` or any other TUI function (only `wrapTextWithAnsi` is relevant here).
- Changing the overwidth-clamping behavior of `buildContentLines`.
- Touching `agent-widget.ts` (tracked separately as Issue #148, Step P — already closed).

## Background

`ui/conversation-viewer.ts` is the live conversation overlay rendered when a user selects an agent in the `/agents` menu.
Its `buildContentLines` method formats messages from the agent session into displayable lines, calling `wrapTextWithAnsi` to soft-wrap text to the available terminal width.

The overwidth-clamping safety net (`truncateToWidth` applied after `wrapTextWithAnsi`) exists because a prior upstream bug returned lines wider than the requested width.
The `vi.mock` in the test is the mechanism for simulating that bug by returning overwidth strings from `wrapTextWithAnsi`.

The only production call site for `new ConversationViewer(...)` is in the `viewAgentConversation` closure inside `createAgentsMenuHandler` in `ui/agent-menu.ts`.

Architecture reference: `docs/architecture/architecture.md` § Phase 9, Step O.

## Design Overview

### `ConversationViewerOptions` — add `wrapText`

```typescript
export interface ConversationViewerOptions {
  tui: TUI;
  session: AgentSession;
  record: AgentRecord;
  activity: AgentActivityTracker | undefined;
  theme: Theme;
  done: (result: undefined) => void;
  registry: AgentConfigLookup;
  wrapText: (text: string, width: number) => string[];
}
```

The field is **required** — it must be supplied at every construction site.
No default is provided; the default would be an invisible SDK dependency hidden inside the class.

### Constructor destructuring

The constructor adopts the dependency bag convention — destructure the options object rather than accessing via `options.*`:

```typescript
constructor({
  tui, session, record, activity, theme, done, registry, wrapText,
}: ConversationViewerOptions) {
  this.tui = tui;
  this.session = session;
  // … etc.
  this.wrapText = wrapText;
  this.unsubscribe = session.subscribe(() => { … });
}
```

### Production wiring — `agent-menu.ts`

`agent-menu.ts` statically imports `wrapTextWithAnsi` from `@earendil-works/pi-tui` and passes it when constructing `ConversationViewer`:

```typescript
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
// …
return new ConversationViewer({
  tui, session, record, activity, theme, done, registry,
  wrapText: wrapTextWithAnsi,
});
```

Adding `wrapText` to `AgentMenuDeps` and threading it through the closure would violate the Law of Demeter — `AgentMenuDeps` has no conceptual ownership of a text-wrapping function.
The `viewAgentConversation` closure is the direct consumer; the import belongs there.

### Test strategy

After DI, tests pass `wrapText` directly in `ConversationViewerOptions`:

- **"render width safety" tests**: pass `wrapText: wrapTextWithAnsi` (real function, statically imported — no mock).
- **"safety net" tests**: pass a stub `wrapText: () => ["X".repeat(width + 50)]` inline in options — no `vi.mock` needed.
- The "mock is intercepting wrapTextWithAnsi" test is removed (it verified the mock mechanism, not viewer behavior).
- The module-level `wrapOverride` variable and the `vi.mock` block are removed entirely.
- The `await import("@earendil-works/pi-tui")` and `await import("../src/ui/conversation-viewer.js")` dynamic imports are converted to ordinary top-level `import` statements.

## Module-Level Changes

| File                               | Change                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui/conversation-viewer.ts`    | Add `wrapText` field to `ConversationViewerOptions`; add `private wrapText` field; destructure options in constructor; replace 4× `wrapTextWithAnsi(...)` with `this.wrapText(...)`; remove `wrapTextWithAnsi` from the `@earendil-works/pi-tui` import line |
| `src/ui/agent-menu.ts`             | Add `import { wrapTextWithAnsi } from "@earendil-works/pi-tui"`; pass `wrapText: wrapTextWithAnsi` in `viewAgentConversation`                                                                                                                                |
| `test/conversation-viewer.test.ts` | Convert top-level dynamic `await import()` to static imports; remove `vi.mock`, `wrapOverride`, and "mock is intercepting" test; add `wrapText` to every `new ConversationViewer({…})` call; update safety-net tests to pass inline stub `wrapText`          |

No symbols are removed from exported API (`ConversationViewerOptions`, `ConversationViewer`, `VIEWPORT_HEIGHT_PCT` all remain).
The `wrapText` addition to `ConversationViewerOptions` is a breaking change for any external consumers that construct `ConversationViewer` — check for usages outside this package.

Grep check: `ConversationViewer` appears only in `src/ui/conversation-viewer.ts`, `src/ui/agent-menu.ts`, and `test/conversation-viewer.test.ts` — no other files construct it.

## Test Impact Analysis

1. **New unit-test capability**: The safety-net tests can now inject exactly the stub they need without patching a module.
   Each test is self-contained and immediately legible — the stub is declared inline at the call site.

2. **Tests that become redundant**: The "mock is intercepting wrapTextWithAnsi" test verified the test mechanism, not production behavior.
   It is deleted.
   The `wrapOverride` reset in `beforeEach` is no longer needed.

3. **Tests that stay**: All "render width safety" tests and all overwidth-clamping tests remain; they exercise real viewer behavior with real or controlled inputs.

## TDD Order

### Cycle 1 — Add `wrapText` field and update production wiring

1. **Red**: Update one `new ConversationViewer({…})` in the test to include `wrapText: vi.fn()` — TypeScript rejects the unknown field.
2. **Green**:
   - Add `wrapText: (text: string, width: number) => string[]` to `ConversationViewerOptions`.
   - Add `private wrapText: (text: string, width: number) => string[]` field to the class.
   - Destructure options in the constructor; assign `this.wrapText = wrapText`.
   - Replace all four `wrapTextWithAnsi(...)` calls with `this.wrapText(...)` in `buildContentLines`.
   - Remove `wrapTextWithAnsi` from the `@earendil-works/pi-tui` import in `conversation-viewer.ts`.
   - In `agent-menu.ts`: add static import of `wrapTextWithAnsi` from `@earendil-works/pi-tui`; pass `wrapText: wrapTextWithAnsi`.
   - Update **all** `new ConversationViewer({…})` calls in `conversation-viewer.test.ts` to include `wrapText`.
     "Render width safety" tests pass `wrapText: wrapTextWithAnsi` (real function, still imported via the existing `vi.mock` shim for now).
     Safety-net tests pass a stub inline: `wrapText: () => ["X".repeat(w + 50)]`.
   - Delete the "mock is intercepting wrapTextWithAnsi" test.
3. **Verify**: `pnpm vitest run test/conversation-viewer.test.ts` passes.
4. **Commit**: `feat: inject wrapText into ConversationViewer (Phase 9, Step O) (#147)`

### Cycle 2 — Remove the module mock

1. **Red**: Remove the `vi.mock("@earendil-works/pi-tui", …)` block, the `wrapOverride` variable, and the `beforeEach(() => { wrapOverride = null; })` reset.
   Convert `const { visibleWidth } = await import("@earendil-works/pi-tui")` to `import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"`.
   Convert `const { ConversationViewer } = await import("../src/ui/conversation-viewer.js")` to `import { ConversationViewer } from "../src/ui/conversation-viewer.js"`.
   Run tests — they should still pass (the mock was no longer needed after Cycle 1).
2. **Green**: Tests pass without any module mock.
3. **Verify**: `pnpm vitest run test/conversation-viewer.test.ts` and `pnpm run check` both pass.
4. **Commit**: `refactor: remove vi.mock from conversation-viewer tests (#147)`

## Risks and Mitigations

| Risk                                                                              | Mitigation                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Missing a `new ConversationViewer({…})` call site in tests                        | Grep confirms only `test/conversation-viewer.test.ts` constructs the viewer; all instances are in-file |
| TypeScript missing the `private wrapText` field type                              | Use `pnpm run check` after Cycle 1 to verify no type errors                                            |
| The dynamic `await import()` pattern in tests was necessary for some other reason | The only purpose was to run after `vi.mock` hoisting; once the mock is gone, static imports work fine  |

## Open Questions

None — the issue's "Changes" section is unambiguous and the call-site inventory is small.
