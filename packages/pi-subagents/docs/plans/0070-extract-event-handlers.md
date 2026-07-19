---
issue: 70
issue_title: "refactor: extract event handlers from pi-subagents index.ts into src/handlers/"
---

# Extract event handlers from index.ts

## Problem Statement

After #54 and #69, `src/index.ts` is still ~281 lines.
Four event handlers (`session_start`, `session_before_switch`, `session_shutdown`, `tool_execution_start`) are inline lambdas inside the factory closure.
They cannot be tested in isolation because they reach into closure-scoped objects (`runtime`, `manager`, `notifications`, `pi`).
`pi-permission-system` solved the same problem in #42 by extracting all handlers into `src/handlers/` as classes receiving narrow constructor-injected dependencies.

## Goals

- Create `src/handlers/` with dedicated modules for each handler group.
- Define handler classes with constructor-injected narrow interfaces that replace closure-captured state with explicit, testable contracts.
- Reduce `src/index.ts` by moving handler bodies out — target ≤ 200 lines (the remaining bulk is tool/menu wiring, which is out of scope).
- Enable unit testing of each handler module via mocked deps.
- No behavior change — pure structural refactor.

## Non-Goals

- Extracting tool registration or menu wiring from `index.ts` (separate concern; not in scope).
- Changing the `SubagentsService` interface.
- Refactoring `AgentManager` constructor signature.
- Consolidating notification callbacks — the notification system's shape is unchanged.

## Background

### Current handler bodies in index.ts

```typescript
// session_start (~3 lines)
runtime.currentCtx = { pi, ctx };
manager.clearCompleted();

// session_before_switch (~1 line)
manager.clearCompleted();

// session_shutdown (~5 lines)
unpublishSubagentsService();
runtime.currentCtx = undefined;
manager.abortAll();
notifications.dispose();
manager.dispose();

// tool_execution_start (~2 lines)
runtime.widget!.setUICtx(ctx.ui as UICtx);
runtime.widget!.onTurnStart();
```

### Prior art: pi-permission-system src/handlers/

Issue #42 extracted lifecycle, agent-prep, and permission-gate handlers into classes that receive narrow constructor deps.
Each class exposes handler methods matching the Pi SDK event signatures.
`index.ts` constructs the handler objects and wires `pi.on(event, handler.method)`.

This plan follows the same class-based pattern.
Although the individual handler bodies are small (1–5 lines), the lifecycle handlers share `runtime` and `manager` as collaborators — shared state that a class captures naturally via constructor injection rather than threading through each call.

### Prerequisite status

- Issue #69 (SubagentRuntime) — **closed / implemented**.
  The runtime object exists in `src/runtime.ts` and is already wired into `index.ts`.
- Issue #87 (evolve SubagentRuntime from data bag to object with methods) — **open / must land first**.
  Adds `setSessionContext()` / `clearSessionContext()` and widget delegation methods (`setUICtx()`, `onTurnStart()`, `markFinished()`, `updateWidget()`, `ensureTimer()`).
  Without #87, extracted handlers would just move the output-argument and LoD smells from `index.ts` into handler classes.
  With #87, handlers call methods on narrow runtime interfaces — no raw field writes, no `widget!` reach-throughs.

### Relevant constraints from AGENTS.md / code-style skill

- Keep modules focused and composable (one concern per file).
- Do not pass a shared dependency bag to functions that only use a subset — define narrow interfaces per consumer.
- Keep Pi SDK imports out of business-logic modules — handler modules should accept lean local payload interfaces, not full SDK event types.
- Prefer explicit configuration over hidden behavior.

## Design Overview

### Module layout

```text
src/handlers/
  lifecycle.ts    # session_start, session_before_switch, session_shutdown
  tool-start.ts   # tool_execution_start
  index.ts        # barrel re-export
```

No shared `types.ts` file — each module defines its own narrow constructor interfaces.
This follows the code-style guidance ("do not pass a shared dependency bag to functions that only use a subset") and matches the permission-system's prior art where each handler class takes its own narrow constructor deps.

### Narrow constructor interfaces

Each class defines local interfaces for its collaborators, exposing only the methods the class actually calls.
This keeps tests simple (mock only what's used) and decouples handlers from concrete types.

#### SessionLifecycleHandler (in lifecycle.ts)

```typescript
/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
  clearCompleted(): void;
  abortAll(): void;
  dispose(): void;
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(pi: unknown, ctx: unknown): void;
  clearSessionContext(): void;
}

export class SessionLifecycleHandler {
  constructor(
    private readonly pi: unknown,
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly unpublishService: () => void,
  ) {}

  handleSessionStart(_event: unknown, ctx: unknown): void { ... }
  handleSessionBeforeSwitch(): void { ... }
  async handleSessionShutdown(): Promise<void> { ... }
}
```

Five constructor params — `runtime` and `manager` are shared across all three methods (the key insight the plain-function design missed), while `disposeNotifications` and `unpublishService` are shutdown-only callbacks.

`LifecycleRuntime` exposes methods, not mutable fields — the handler *tells* the runtime to set/clear session context instead of writing raw fields (the output-argument smell that #87 eliminates).

#### ToolStartHandler (in tool-start.ts)

```typescript
/** Narrow runtime interface — only the widget-delegation methods the handler calls. */
export interface ToolStartRuntime {
  setUICtx(ctx: UICtx): void;
  onTurnStart(): void;
}

export class ToolStartHandler {
  constructor(
    private readonly runtime: ToolStartRuntime,
  ) {}

  handleToolExecutionStart(_event: unknown, ctx: ToolStartCtx): void { ... }
}
```

After #87, the runtime owns widget delegation — `runtime.setUICtx()` delegates to `this.widget?.setUICtx()` internally, handling the null check.
The handler takes a narrow `ToolStartRuntime` interface (just the two methods it calls) and does not know about `widget` or `SubagentRuntime` at all.

### Event payload interfaces

Following the code-style skill ("prefer lean local payload interfaces over full SDK event types"), each handler defines minimal payload types for the events it consumes.

`session_start` receives `(event, ctx)` — but the current handler ignores the event payload entirely and only reads `ctx`.
`tool_execution_start` receives `(event, ctx)` — the handler reads `ctx.ui`.

Since handlers ignore event payloads, the method signatures use `_event: unknown`.

### index.ts wire-up

After extraction, `index.ts` constructs handler instances and binds:

```typescript
import { SessionLifecycleHandler } from "./handlers/index.js";
import { ToolStartHandler } from "./handlers/index.js";

const lifecycle = new SessionLifecycleHandler(
  pi,
  runtime,
  manager,
  () => notifications.dispose(),
  unpublishSubagentsService,
);

pi.on("session_start", (event, ctx) => lifecycle.handleSessionStart(event, ctx));
pi.on("session_before_switch", () => lifecycle.handleSessionBeforeSwitch());
pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());

const toolStart = new ToolStartHandler(runtime);

pi.on("tool_execution_start", (event, ctx) => toolStart.handleToolExecutionStart(event, ctx));
```

Handler instances are constructed once and hold their collaborators for the extension's lifetime — the same pattern as pi-permission-system's `SessionLifecycleHandler`.
`runtime` satisfies both `LifecycleRuntime` and `ToolStartRuntime` structurally — TypeScript matches the narrow interface without an explicit cast.

### Edge cases

- `session_shutdown` calls `unpublishSubagentsService()` which is a module-level import — the handler receives it as a constructor callback, keeping the handler SDK-free.
- Constructor params are narrow interfaces (`LifecycleManager`, `LifecycleRuntime`, `ToolStartRuntime`) rather than concrete types (`AgentManager`, `SubagentRuntime`), so tests construct mocks without importing production classes.
- Widget null safety: after #87, the runtime's delegation methods handle null internally (`this.widget?.setUICtx(ctx)`), so handlers never see the null case.
  `ToolStartHandler` tests mock the narrow `ToolStartRuntime` interface directly — no widget null logic to test in the handler.

## Module-Level Changes

### `src/handlers/lifecycle.ts` (new)

- `LifecycleManager` interface (narrow: `clearCompleted`, `abortAll`, `dispose`).
- `LifecycleRuntime` interface (narrow: `setSessionContext`, `clearSessionContext`).
- `SessionLifecycleHandler` class — constructor takes `(pi, runtime, manager, disposeNotifications, unpublishService)`.
- `handleSessionStart(_event, ctx)` — calls `this.runtime.setSessionContext(this.pi, ctx)`, calls `this.manager.clearCompleted()`.
- `handleSessionBeforeSwitch()` — calls `this.manager.clearCompleted()`.
- `handleSessionShutdown()` — calls `this.unpublishService()`, `this.runtime.clearSessionContext()`, `this.manager.abortAll()`, `this.disposeNotifications()`, `this.manager.dispose()`.

### `src/handlers/tool-start.ts` (new)

- `ToolStartRuntime` interface (narrow: `setUICtx`, `onTurnStart`).
- `ToolStartCtx` local interface (`{ ui: UICtx }`).
- `ToolStartHandler` class — constructor takes `runtime: ToolStartRuntime`.
- `handleToolExecutionStart(_event, ctx)` — calls `this.runtime.setUICtx(ctx.ui)`, `this.runtime.onTurnStart()`.

### `src/handlers/index.ts` (new)

- Barrel re-export of handler classes and their narrow interfaces.

### `src/index.ts` (modified)

- Add imports from `./handlers/index.js`.
- Construct `SessionLifecycleHandler` with `(pi, runtime, manager, () => notifications.dispose(), unpublishSubagentsService)`.
- Construct `ToolStartHandler` with `runtime`.
- Replace inline `pi.on("session_start", ...)` lambda with `lifecycle.handleSessionStart` delegation.
- Replace inline `pi.on("session_before_switch", ...)` lambda with `lifecycle.handleSessionBeforeSwitch` delegation.
- Replace inline `pi.on("session_shutdown", ...)` lambda with `lifecycle.handleSessionShutdown` delegation.
- Replace inline `pi.on("tool_execution_start", ...)` lambda with `toolStart.handleToolExecutionStart` delegation.
- `unpublishSubagentsService` import stays — passed to the handler constructor.

### `test/handlers/lifecycle.test.ts` (new)

- Construct `SessionLifecycleHandler` with mocked `LifecycleManager`, `LifecycleRuntime`, and stub callbacks.
- `handleSessionStart`: verify `runtime.setSessionContext` called with `(pi, ctx)`, `manager.clearCompleted` called.
- `handleSessionBeforeSwitch`: verify `manager.clearCompleted` called.
- `handleSessionShutdown`: verify all five cleanup calls in correct order (unpublish → clearSessionContext → abortAll → disposeNotifications → dispose manager).

### `test/handlers/tool-start.test.ts` (new)

- Construct `ToolStartHandler` with a mock `ToolStartRuntime`.
- Verify `setUICtx` and `onTurnStart` called with correct arguments.

### `test/print-mode.test.ts` (unchanged)

- This integration test calls `handlers.get("session_shutdown")` on the extension's registered handlers.
  The extraction is transparent — the Pi event registration is still in `index.ts`, just delegating to extracted functions.
  No changes needed.

## Test Impact Analysis

### New unit tests enabled by the extraction

1. `test/handlers/lifecycle.test.ts` — Each lifecycle handler tested in isolation with mocked deps.
   Previously impossible because handlers were inline lambdas with closure-captured `runtime`, `manager`, `notifications`, and `pi`.
2. `test/handlers/tool-start.test.ts` — `tool_execution_start` handler tested with mocked widget.
   Previously untestable because the handler was an inline lambda closing over `runtime.widget`.
3. Widget null-safety is not the handler's concern — the runtime handles it internally after #87.

### Existing tests that become redundant

None.
No existing tests directly test the event handler bodies — they were untestable inline lambdas.
The extraction creates *new* coverage, not duplicate coverage.

### Existing tests that stay as-is

- `test/print-mode.test.ts` — calls `session_shutdown` via the extension's registered handler map; still works because `index.ts` still registers the event, just delegates to extracted functions.
- All other test files — no dependency on handler internals.

## TDD Order

1. **Create `src/handlers/lifecycle.ts` with `SessionLifecycleHandler` class.**
   Write `test/handlers/lifecycle.test.ts` constructing the handler with mocked narrow interfaces.
   Verify: `handleSessionStart` sets `currentCtx` and calls `clearCompleted`; `handleSessionBeforeSwitch` calls `clearCompleted`; `handleSessionShutdown` calls all five cleanup steps in order.
   Commit: `feat: add SessionLifecycleHandler`

2. **Create `src/handlers/tool-start.ts` with `ToolStartHandler` class.**
   Write `test/handlers/tool-start.test.ts` constructing the handler with a mock getter.
   Verify: calls `setUICtx` and `onTurnStart` on widget; no-op when widget is null.
   Commit: `feat: add ToolStartHandler`

3. **Create `src/handlers/index.ts` barrel and wire handlers into `src/index.ts`.**
   Add barrel re-export in `src/handlers/index.ts`.
   Replace inline lambdas in `src/index.ts` with handler instance method delegation.
   Construct `SessionLifecycleHandler` and `ToolStartHandler` in the factory.
   Run full test suite to verify no regressions.
   Run `pnpm run check` to verify types.
   Commit: `refactor: wire extracted handlers into extension factory (#70)`

## Risks and Mitigations

| Risk                                                                    | Mitigation                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler extraction changes call order in `session_shutdown`             | Test explicitly asserts call order; current order is preserved exactly.                                                                                                                                                                                                                |
| `SessionLifecycleHandler` has 5 constructor params                      | Reviewed against design-review: `runtime` and `manager` are shared across all three methods (the core shared-state argument for a class). The two callbacks (`disposeNotifications`, `unpublishService`) are shutdown-only but small enough to not warrant a second class. Acceptable. |
| `print-mode.test.ts` integration test breaks                            | Test calls `session_shutdown` via the extension's handler map, not the extracted function directly. The delegation is transparent. Verified no changes needed.                                                                                                                         |
| `UICtx` type import in `tool-start.ts` couples handler to widget module | `UICtx` is a lean interface already exported from `ui/agent-widget.ts`. The handler only references it in the `ToolStartCtx` local type. Acceptable coupling.                                                                                                                          |

## Open Questions

- Should the `session_shutdown` handler call cleanup in a specific guaranteed order (e.g., unpublish → abort → dispose)?
  The current inline code uses a specific order; the extraction preserves it.
  If order matters for correctness, add a code comment documenting it.
  Decide during implementation.
- Should the `ToolStartHandler` also handle `UICtx` type re-export, or should `tool-start.ts` import `UICtx` from `ui/agent-widget.ts` directly?
  Decide during implementation — if the handler defines its own `ToolStartCtx` with `{ ui: unknown }`, it avoids the import entirely.
