---
issue: 134
issue_title: "Reduce `as any` casts in test suite"
---

# Reduce as-any casts in test suite

## Problem Statement

The test suite contains 93 `as any` casts (plus 2 `as any[]`).
These casts silence the type checker, hiding real errors — if a production interface adds a required field, tests silently pass with incomplete mocks instead of failing at compile time.
The heaviest offenders are `renderer.test.ts` (29), `runtime.test.ts` (10), `agent-menu.test.ts` (8), and `helpers.test.ts` (7).
The production source has 8 `as any` casts — 2 SDK bridge casts in `index.ts` and 6 message-shape casts in `conversation-viewer.ts` and `agent-runner.ts`.

## Goals

- Target near-zero `as any` casts across both source and test code.
- Widen `CreateSessionOptions` and `ResourceLoaderOptions` to use SDK types, eliminating the SDK bridge casts in `index.ts`.
- Define local message-content types and type guards in `conversation-viewer.ts` and `agent-runner.ts`, eliminating polymorphic duck-typing casts.
- Define narrow production interfaces (`MenuCtx`, `WidgetLike`) where SDK types are too wide for test construction.
- Define typed test factories where partial mocks currently require casting.
- Preserve existing test coverage — no behavior changes.

## Non-Goals

- Changing production behavior or public API shapes.
- Reaching literally zero — 1–3 casts may remain for private-field test access (`(manager as any).cleanupInterval`) where the alternative (exposing internals) is worse than the cast.

## Background

### Prerequisites

Issues #132 and #133 (IO injection) are both closed.
These eliminated the `vi.mock()`-heavy test patterns and introduced narrow injectable interfaces (`AssemblerIO`, `RunnerIO`), which already removed some `as any` casts from `agent-runner.test.ts` and `session-config.test.ts`.

### Current as-any inventory by pattern

| Pattern                                          | Count | Primary files                                                                                                       |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Renderer — theme, message, result access         | 29    | `renderer.test.ts`                                                                                                  |
| Context — `ctx as any` for handler/menu          | 14    | `agent-menu.test.ts`, `agent-manager.test.ts`, `print-mode.test.ts`, `parent-snapshot.test.ts`, `make-deps.test.ts` |
| Session — `{ session: {} as any }`               | 10    | tool tests, `service-adapter.test.ts`, `print-mode.test.ts`, `agent-manager.test.ts`                                |
| Runtime/widget — `fakeWidget as any`             | 9     | `runtime.test.ts`                                                                                                   |
| Conversation viewer — message shapes             | 8     | `conversation-viewer.test.ts`, `src/conversation-viewer.ts`                                                         |
| Helpers — registry, activity, details            | 7     | `helpers.test.ts`                                                                                                   |
| RunOptions — `} as any, io)`                     | 3     | `agent-runner.test.ts`                                                                                              |
| Tool execute — `{} as any` for ctx               | 5     | `steer-tool.test.ts`, `get-result-tool.test.ts`, `make-deps.test.ts`                                                |
| SDK bridge — `opts as any` in index.ts           | 2     | `src/index.ts`                                                                                                      |
| Other — `messages: [] as any[]`, internal access | 6     | `agent-runner*.test.ts`, `usage.test.ts`, `agent-manager.test.ts`                                                   |

### Constraints from AGENTS.md

- Avoid `any` unless absolutely necessary.
- Prefer explicit configuration over hidden behavior.
- Keep scope tight; prefer small, reversible changes.

## Design Overview

### Production changes that make the test changes easy

Three targeted source-code changes remove the structural blockers that force casts elsewhere.

#### 1. SDK-typed option interfaces (eliminates 2 source casts)

`CreateSessionOptions` and `ResourceLoaderOptions` currently use `unknown` for opaque fields (`settingsManager`, `modelRegistry`, `model`).
Tests never construct these option objects — they mock `io.createSession` and `io.createResourceLoader` at the function level.
The `unknown` fields don't buy testability; the function-level mock does.

The SDK exports `CreateAgentSessionOptions` with all fields optional, using `ModelRegistry`, `Model<any>`, `ResourceLoader`, `SessionManager`, `SettingsManager`.
Widening `CreateSessionOptions` to use these SDK types makes the `as any` cast in `index.ts` unnecessary while preserving full test mockability.

```typescript
// Before (agent-runner.ts)
export interface CreateSessionOptions {
  settingsManager: unknown;
  modelRegistry: unknown;
  model?: unknown;
  // ...
}

// After — use SDK types (type-only imports)
import type { Model } from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface CreateSessionOptions {
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  model?: Model<any>;
  resourceLoader: ResourceLoader;
  sessionManager: SessionManager;
  // ...
}
```

The `RunnerIO.createSettingsManager` return type also changes from `unknown` to `SettingsManager`.

For `ResourceLoaderOptions`, the options are all primitives and callbacks — the SDK's `DefaultResourceLoader` constructor accepts them structurally.
The fix is to ensure the option interface matches the constructor's parameter type so `new DefaultResourceLoader(opts)` works without `as any`.

#### 2. Local message-content types + type guards (eliminates 6 source casts)

`conversation-viewer.ts` and `agent-runner.ts` both do:

```typescript
(c as any).name ?? (c as any).toolName ?? "unknown"
(msg as any).role === "bashExecution"
const bash = msg as any;
```

Fix: define local discriminated-union types for the content items and message roles the code actually handles, plus type guards:

```typescript
/** Tool-call content item — SDK doesn't export a narrow type for this variant. */
interface ToolCallContent {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

function getToolCallName(c: { type: string }): string | undefined {
  if (c.type !== "toolCall") return undefined;
  const tc = c as ToolCallContent;
  return tc.name ?? tc.toolName;
}

/** Bash execution message — not in the standard role union. */
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output?: string;
}

function isBashExecution(msg: { role: string }): msg is BashExecutionMessage {
  return msg.role === "bashExecution";
}
```

These are small, file-local types that document the shapes the code already handles at runtime.
They make the duck-typing explicit and compile-time checked.

#### 3. Narrow production interfaces (`MenuCtx`, `WidgetLike`)

Already described in the test-side patterns below.
These are production-code changes that make the test-side casts disappear.

### Test-side patterns

#### Pattern A: renderer.test.ts (29 casts → 0)

The renderer already defines narrow interfaces (`RendererMessage`, `RendererTheme`, `RenderOptions`).
The test casts because it doesn't use them — `stubTheme()` and `{ details: makeDetails() }` already satisfy the interfaces structurally.
The return type `Text` has a `.text` property — `(result as any).text` can become `result!.text` (non-null assertion after `expect(result).toBeDefined()`).

Fix: remove the casts; structural typing handles it.
For result access, define a minimal `{ text: string }` type or use non-null assertion.

#### Pattern B: context casts (14 casts → 0)

- `agent-menu.test.ts` (8): define `MenuCtx` in production; type `makeCtx()` return.
- `agent-manager.test.ts` (1): `mockCtx` is consumed by a mocked `buildParentSnapshot` — type as `unknown`.
- `parent-snapshot.test.ts` (1): define a test-local interface matching the fields `buildParentSnapshot` reads.
- `print-mode.test.ts` (2): type `makeHeadlessCtx()` return.
- `runtime.test.ts` (1): pass a structurally valid `UICtx` (fixed by `WidgetLike` step).
- `make-deps.test.ts` (3): type ctx args or use `unknown`.

#### Pattern C: session casts (10 casts → ~1)

Most are `{ session: {} as any, outputFile: ... }` for `record.execution`.
Fix: expand `createMockSession()` to include the fields these tests need (`dispose`, `steer`, `getSessionStats`), then use it.
One cast may remain for truly minimal session stubs.

#### Pattern D: runtime/widget casts (9 casts → 0)

Define `WidgetLike` in `runtime.ts`; change the `widget` field type.
Use real `AgentActivityTracker` instances (constructor takes only `maxTurns?`).

#### Pattern E: tool-execute ctx casts (5 casts → 0)

Define a `STUB_CTX` constant in `test/helpers/` satisfying the tool execute's context parameter.

#### Pattern F: RunOptions casts (3 casts → 0)

Check whether `defaultMaxTurns` and `graceTurns` are on `RunOptions` — they are.
The `as any` casts are vestigial; remove them.

#### Pattern G: helpers.test.ts (7 casts → 0)

Construct typed `TypeListRegistry` mocks.
Fix `textResult` return type to avoid `details as any`.
Use real `AgentActivityTracker` instances.

#### Pattern H: conversation-viewer test casts (4 test casts → ~1)

Type message mock objects using the local types from production change #2.
Keep `(viewer as any).buildContentLines()` (private method access — the alternative of exposing the method is worse).

#### Pattern I: other (6 casts → ~2)

- `messages: [] as any[]` → type as `unknown[]`.
- `(manager as any).cleanupInterval` → keep (private field assertion is intentional).
- `usage.test.ts` (2) → type mock objects.

## Module-Level Changes

### Modified source files

1. `src/agent-runner.ts`
   - Import SDK types (`Model`, `ModelRegistry`, `SettingsManager`, `SessionManager`, `ResourceLoader`) as type-only imports.
   - Widen `CreateSessionOptions` fields from `unknown` to SDK types.
   - Change `RunnerIO.createSettingsManager` return type from `unknown` to `SettingsManager`.
   - Define `getToolCallName()` helper and local `ToolCallContent` interface.
   - Replace `(c as any).name ?? (c as any).toolName` with `getToolCallName(c)` in `getAgentConversation`.

2. `src/ui/conversation-viewer.ts`
   - Define local `ToolCallContent`, `BashExecutionMessage` interfaces and type guards.
   - Replace `(c as any).name ?? (c as any).toolName` with typed helper.
   - Replace `(msg as any).role === "bashExecution"` / `const bash = msg as any` with type guard.

3. `src/ui/agent-menu.ts`
   - Define and export `MenuCtx` interface.
   - Change handler parameter type from `ExtensionContext` to `MenuCtx`.

4. `src/runtime.ts`
   - Define and export `WidgetLike` interface.
   - Change `widget` field type from `AgentWidget | null` to `WidgetLike | null`.

5. `src/tools/helpers.ts`
   - Change `textResult` to avoid `details as any` — type the return properly.

6. `src/index.ts`
   - Remove `opts as any` casts in `createResourceLoader` and `createSession` factories (enabled by SDK-typed option interfaces).

### Modified test files

1. `test/renderer.test.ts` — remove all 29 casts.
2. `test/runtime.test.ts` — use `WidgetLike` stubs and real `AgentActivityTracker`.
3. `test/ui/agent-menu.test.ts` — type `makeCtx()` as `MenuCtx`.
4. `test/tools/helpers.test.ts` — typed registry mocks, real `AgentActivityTracker`.
5. `test/conversation-viewer.test.ts` — typed message mocks.
6. `test/agent-runner.test.ts` — remove `as any` on RunOptions; type messages.
7. `test/agent-runner-extension-tools.test.ts` — type messages.
8. `test/agent-manager.test.ts` — type `mockCtx`.
9. `test/print-mode.test.ts` — type `makeHeadlessCtx()`.
10. `test/parent-snapshot.test.ts` — type mock context.
11. `test/service-adapter.test.ts` — use `createMockSession()`.
12. `test/tools/steer-tool.test.ts` — stub ctx, use `createMockSession()`.
13. `test/tools/get-result-tool.test.ts` — stub ctx, use `createMockSession()`.
14. `test/tools/foreground-runner.test.ts` — use `createMockSession()`.
15. `test/tools/background-spawner.test.ts` — use `createMockSession()`.
16. `test/tools/agent-tool.test.ts` — use `createMockSession()`.
17. `test/helpers/make-deps.test.ts` — type ctx args.
18. `test/usage.test.ts` — type mock objects.

## Test Impact Analysis

1. No new test coverage — this is a type-safety improvement on existing tests.
2. No tests become redundant.
3. All existing tests stay as-is in terms of assertions; only type annotations and mock construction change.
4. `pnpm run check` is the primary validation — every step must pass type checking since the goal is eliminating type holes.
5. Expanding `createMockSession()` affects multiple consumers — diff existing defaults before changing (per testing skill).

## TDD Order

Steps are ordered by independence and impact (production changes first, then largest cast-count test reductions).

1. **Widen option interfaces to SDK types; remove index.ts casts (2 source casts → 0).**
   Import SDK types as type-only in `agent-runner.ts`.
   Widen `CreateSessionOptions` fields (`settingsManager`, `modelRegistry`, `model`, `resourceLoader`, `sessionManager`) to SDK types.
   Change `RunnerIO.createSettingsManager` return type to `SettingsManager`.
   Remove `as any` casts from `index.ts` factories.
   Run `pnpm run check` + full suite.
   Commit: `feat: use SDK types in CreateSessionOptions (#134)`

2. **Add message-content type guards; remove viewer and runner source casts (6 source casts → 0).**
   Define `ToolCallContent` interface and `getToolCallName()` helper in `conversation-viewer.ts`.
   Define `BashExecutionMessage` interface and `isBashExecution()` guard in `conversation-viewer.ts`.
   Replace all source `as any` casts in `conversation-viewer.ts`.
   Define the same `getToolCallName()` helper (or extract a shared one) in `agent-runner.ts` and replace its cast.
   Run `pnpm run check` + affected tests.
   Commit: `fix: replace message-shape as-any casts with type guards (#134)`

3. **Remove renderer test casts (29 → 0).**
   Remove all `as any` casts on `stubTheme()`, message objects, and result access.
   Use `result!.text` (non-null assertion after `toBeDefined()` guard) for result access.
   Run `pnpm run check` + `pnpm vitest run test/renderer.test.ts`.
   Commit: `test: remove as-any casts in renderer tests (#134)`

4. **Add `MenuCtx` interface; remove menu-test casts (8 → 0).**
   Define `MenuCtx` in `agent-menu.ts`.
   Change handler parameter from `ExtensionContext` to `MenuCtx`.
   Type `makeCtx()` return in test.
   Run `pnpm run check` + `pnpm vitest run test/ui/agent-menu.test.ts`.
   Commit: `feat: narrow menu handler to MenuCtx interface (#134)`

5. **Add `WidgetLike`; remove runtime casts (9 → 0).**
   Define `WidgetLike` in `runtime.ts`.
   Change `widget` field type.
   Update `runtime.test.ts`: typed stubs, real `AgentActivityTracker` instances.
   Run `pnpm run check` + `pnpm vitest run test/runtime.test.ts`.
   Commit: `feat: narrow runtime widget field to WidgetLike interface (#134)`

6. **Expand `createMockSession`; remove session casts (10 → ~1).**
   Add fields to `createMockSession()` that tool/service tests need.
   Use it in tool tests, service-adapter, agent-manager for `record.execution.session`.
   Run `pnpm run check` + full suite.
   Commit: `test: use createMockSession for session execution casts (#134)`

7. **Remove helpers.test.ts casts (7 → 0).**
   Typed `TypeListRegistry` mocks.
   Fix `textResult` return type in `src/tools/helpers.ts`.
   Real `AgentActivityTracker` instances.
   Run `pnpm run check` + `pnpm vitest run test/tools/helpers.test.ts`.
   Commit: `test: remove as-any casts in helpers tests (#134)`

8. **Remove context casts across remaining test files (6 → 0).**
   Type `mockCtx` in `agent-manager.test.ts`.
   Type `makeHeadlessCtx()` in `print-mode.test.ts`.
   Type mock context in `parent-snapshot.test.ts`.
   Type `{} as any` in `make-deps.test.ts`.
   Run `pnpm run check` + full suite.
   Commit: `test: remove remaining context as-any casts (#134)`

9. **Remove RunOptions and message-array casts (5 → 0).**
   Remove vestigial `as any` on RunOptions objects.
   Type `messages` arrays as `unknown[]`.
   Run `pnpm run check` + affected tests.
   Commit: `test: remove RunOptions and message-array casts (#134)`

10. **Remove tool-execute ctx casts (5 → 0).**
    Define `STUB_CTX` in `test/helpers/`.
    Use it in `steer-tool.test.ts`, `get-result-tool.test.ts`, `make-deps.test.ts`.
    Run `pnpm run check` + affected tests.
    Commit: `test: remove tool-execute context casts (#134)`

11. **Clean up conversation-viewer test and usage casts (6 → ~2).**
    Type message mocks in `conversation-viewer.test.ts`.
    Type usage mock objects in `usage.test.ts`.
    Keep `(viewer as any).buildContentLines()` and `(manager as any).cleanupInterval` (private access, intentional).
    Run `pnpm run check` + full suite.
    Commit: `test: remove conversation-viewer and usage as-any casts (#134)`

## Risks and Mitigations

| Risk                                                                                            | Mitigation                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widening `CreateSessionOptions` to SDK types re-couples `agent-runner.ts` to SDK                | These are type-only imports — no runtime coupling. Tests still mock at the `RunnerIO` function level. The `RunnerIO` interface is the decoupling boundary, not the option types. |
| Narrowing `widget` to `WidgetLike` could break callers accessing `AgentWidget`-specific methods | Grep all `runtime.widget` access sites first; verify they only use `update()`, `markFinished()`, `setUICtx()`.                                                                   |
| Narrowing menu handler to `MenuCtx` could break callers passing `ExtensionContext`              | `ExtensionContext` is structurally a superset of `MenuCtx` — callers pass it unchanged.                                                                                          |
| Expanding `createMockSession()` could break consumers with different default expectations       | Diff existing consumers' default expectations before adding fields (per testing skill).                                                                                          |
| Message type guards add code to conversation-viewer and agent-runner                            | Each guard is 2–4 lines; they replace unsafe `as any` access with documented, compile-checked types. Net code stays similar.                                                     |
| 11-step plan is large                                                                           | Each step is independently committable. No step depends on a subsequent one. Steps can be reordered or skipped.                                                                  |

## Open Questions

- Should `getToolCallName()` be shared between `conversation-viewer.ts` and `agent-runner.ts`, or duplicated?
  Both files handle the same SDK message shape.
  A shared helper in a common module (e.g., `context.ts` which already has `extractText`) avoids duplication.
  Alternatively, the duplication is cheap (3 lines) and the two files have different concerns.
- Should `STUB_CTX` live in `test/helpers/stub-ctx.ts` or inline?
  Centralize — 3+ tool tests share the pattern.
- Estimated final count: 2–3 remaining casts (`(viewer as any).buildContentLines()`, `(manager as any).cleanupInterval`, possibly 1 more for an unexported SDK type).
