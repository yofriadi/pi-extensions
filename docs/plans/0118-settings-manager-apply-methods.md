---
issue: 118
issue_title: "refactor(pi-subagents): SettingsManager apply methods — eliminate cross-collaborator orchestration"
---

# SettingsManager apply methods — eliminate cross-collaborator orchestration

## Problem Statement

`showSettings` in `agent-menu.ts` orchestrates across two collaborators when changing a setting — it mutates `settings` properties directly (output arguments), separately pokes `manager.notifyConcurrencyChanged()`, then calls `settings.saveAndNotify()`.
The menu knows too much about the consequence chain of a settings change.

This is a Law of Demeter / Tell-Don't-Ask violation: the menu should *tell* settings what the user wants, not coordinate the mechanics of persistence and queue drain.

## Goals

- Add `applyMaxConcurrent(n)`, `applyDefaultMaxTurns(n)`, `applyGraceTurns(n)` methods to `SettingsManager` that own the full consequence chain: normalize → set in memory → notify interested parties → persist → emit lifecycle event → return toast.
- Accept an optional `onMaxConcurrentChanged` callback in `SettingsManager` constructor deps, wired to `manager.notifyConcurrencyChanged()` at init.
- Narrow `AgentMenuSettings` — replace writable property setters and `saveAndNotify` with 3 read-only getters and 3 apply methods.
- Remove `notifyConcurrencyChanged` from `AgentMenuManager` — the menu no longer needs to know about the manager for settings changes.
- This is a non-breaking refactoring — no public API surface changes.

## Non-Goals

- Narrowing `AgentToolDeps` or `AgentMenuDeps` further (#114) — that is a separate issue.
- Changing the persistence format or the global-vs-project merge strategy.
- Removing `saveAndNotify` from `SettingsManager` — it remains as a public method; the apply methods delegate to it internally.
- Removing the property setters from `SettingsManager` — they remain for `load()` and direct test use; only the `AgentMenuSettings` interface narrows.

## Background

### Current flow (max concurrency example)

```text
showSettings (agent-menu.ts)
  ├── deps.settings.maxConcurrent = n        ← output argument
  ├── deps.manager.notifyConcurrencyChanged()← cross-collaborator orchestration
  └── notifyApplied(ctx, message)
        └── deps.settings.saveAndNotify(msg) ← separate persist + emit call
```

### Target flow

```text
showSettings (agent-menu.ts)
  └── deps.settings.applyMaxConcurrent(n)    ← one call, toast returned
        ├── this.maxConcurrent = n           ← internal set
        ├── this.onMaxConcurrentChanged?.()  ← callback to manager
        └── this.saveAndNotify(message)      ← internal persist + emit
```

### Module map (affected files only)

| Module                 | Current role                                           | Change                                                        |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `src/settings.ts`      | `SettingsManager` class with setters, `saveAndNotify`  | Add `onMaxConcurrentChanged` callback; add 3 `apply*` methods |
| `src/ui/agent-menu.ts` | `showSettings` orchestrates across manager + settings  | Simplify to single apply call per setting                     |
| `src/agent-manager.ts` | `notifyConcurrencyChanged()` public method             | No change — still called via callback                         |
| `src/index.ts`         | Wires `notifyConcurrencyChanged` on `AgentMenuManager` | Wire `onMaxConcurrentChanged` on settings constructor instead |

### Architecture reference

Follow-up to Phase 7, Step A2 (#109, closed/implemented).
Sequenced before D2 (#114, open).

### Applicable constraints

- Law of Demeter — eliminate cross-collaborator reach-through (code-design skill).
- No output arguments — the menu should not write into received deps (code-design skill).
- Dependency inversion — consumers accept narrow interfaces (code-design skill).
- One concern per file — `SettingsManager` already owns the concern; this deepens encapsulation.

## Design Overview

### SettingsManager constructor deps change

```typescript
constructor(deps: {
  emit: SettingsEmit;
  cwd: string;
  onMaxConcurrentChanged?: () => void;  // ← new
})
```

The callback is stored as a private field and called from `applyMaxConcurrent` only.

### Apply methods

Each method normalizes the input, sets the in-memory value, calls any interested-party callback, and delegates to `saveAndNotify` for persist + emit + toast:

```typescript
applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
  this.maxConcurrent = n;   // setter normalizes (max(1, n))
  this.onMaxConcurrentChanged?.();
  return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
}

applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" } {
  this.defaultMaxTurns = n === 0 ? undefined : n;  // setter normalizes
  const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
  return this.saveAndNotify(`Default max turns set to ${label}`);
}

applyGraceTurns(n: number): { message: string; level: "info" | "warning" } {
  this.graceTurns = n;      // setter normalizes (max(1, n))
  return this.saveAndNotify(`Grace turns set to ${this.graceTurns}`);
}
```

The toast message uses the *post-normalization* value (e.g., `max(1, n)`) so the user sees what was actually applied.

### Consumer call-site sketch (agent-menu.ts)

```typescript
// Max concurrency — before:
deps.settings.maxConcurrent = n;
deps.manager.notifyConcurrencyChanged();
notifyApplied(ctx, `Max concurrency set to ${n}`);

// Max concurrency — after:
const toast = deps.settings.applyMaxConcurrent(n);
ctx.ui.notify(toast.message, toast.level);
```

Three property writes + one cross-collaborator call + one persist call → one method call.
The menu never touches the manager for settings changes.

### Narrowed AgentMenuSettings interface

```typescript
export interface AgentMenuSettings {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
}
```

### Narrowed AgentMenuManager interface

```typescript
export interface AgentMenuManager {
  listAgents: () => AgentRecord[];
  getRecord: (id: string) => AgentRecord | undefined;
  spawnAndWait: (...) => Promise<AgentRecord>;
  // notifyConcurrencyChanged removed — settings owns the callback
}
```

### index.ts wiring change

```typescript
// Before:
const settings = new SettingsManager({ emit, cwd });
// ... later in menu deps:
manager: { ..., notifyConcurrencyChanged: () => manager.notifyConcurrencyChanged() },

// After:
const settings = new SettingsManager({
  emit,
  cwd,
  onMaxConcurrentChanged: () => manager.notifyConcurrencyChanged(),
});
// ... menu deps no longer includes notifyConcurrencyChanged
```

The closure captures `manager` by reference — safe because the callback is never invoked before `manager` is constructed.

## Module-Level Changes

### `src/settings.ts`

- **Add** `onMaxConcurrentChanged?: () => void` to constructor deps.
- **Add** `applyMaxConcurrent(n)`, `applyDefaultMaxTurns(n)`, `applyGraceTurns(n)` methods.
- **Keep** property setters, `saveAndNotify`, `load`, `snapshot` — apply methods delegate to them.

### `src/ui/agent-menu.ts`

- **Change** `AgentMenuSettings`: replace writable properties + `saveAndNotify` with readonly properties + 3 apply methods.
- **Change** `AgentMenuManager`: remove `notifyConcurrencyChanged`.
- **Change** `showSettings`: replace 3-step orchestration with single apply call per setting.
- **Remove** `notifyApplied` helper — no longer needed; each branch calls `ctx.ui.notify(toast.message, toast.level)` directly.

### `src/index.ts`

- **Add** `onMaxConcurrentChanged` to `SettingsManager` constructor call.
- **Remove** `notifyConcurrencyChanged` from the menu's manager dep.

### `src/agent-manager.ts`

- **No change** — `notifyConcurrencyChanged()` remains as a public method, now called via callback instead of menu.

## Test Impact Analysis

### New unit tests enabled

- **Apply method integration**: construct `SettingsManager` with an `onMaxConcurrentChanged` spy → call `applyMaxConcurrent(n)` → verify the spy was called, value was set, `saveAndNotify` persisted, and the returned toast is correct.
  Previously impossible because the consequence chain was spread across the menu and two collaborators.
- **Toast message accuracy**: verify that apply methods use post-normalization values in the toast (e.g., `applyMaxConcurrent(0)` sets to 1 and reports "set to 1", not "set to 0").
- **Callback not invoked for non-concurrency settings**: verify `onMaxConcurrentChanged` is *not* called when `applyDefaultMaxTurns` or `applyGraceTurns` is used.

### Existing tests that become simpler

- `agent-menu.test.ts` settings tests: currently assert 3 side effects per setting (property mutation, `notifyConcurrencyChanged` call, `saveAndNotify` call).
  After: assert a single `apply*` call with the correct argument.
  The mock object shrinks (no writable setters, no `saveAndNotify`).

### Existing tests that must stay

- `settings.test.ts` — `saveAndNotify()` tests stay; the apply methods delegate to it.
- `settings.test.ts` — property setter normalization tests stay; apply methods delegate to setters.
- `agent-menu.test.ts` — settings navigation tests stay; only the assertions change.
- `agent-manager.test.ts` — `notifyConcurrencyChanged` / drain-queue tests stay unchanged.

## TDD Order

### Cycle 1: Add `onMaxConcurrentChanged` callback to SettingsManager constructor

1. Red: test that constructing with `onMaxConcurrentChanged` stores the callback (verified indirectly in cycle 2).
   Test that constructing without it does not throw.
2. Green: add optional `onMaxConcurrentChanged` to constructor deps, store as private field.
3. Commit: `feat: accept onMaxConcurrentChanged callback in SettingsManager constructor`

### Cycle 2: Add `applyMaxConcurrent` method

1. Red: test `applyMaxConcurrent(8)` — sets `maxConcurrent` to 8, calls `onMaxConcurrentChanged` spy, persists, emits event, returns info toast with "Max concurrency set to 8".
   Test `applyMaxConcurrent(0)` — normalizes to 1, toast says "set to 1".
   Test without callback — no throw, still persists and returns toast.
2. Green: implement `applyMaxConcurrent`.
3. Commit: `feat: add SettingsManager.applyMaxConcurrent method`

### Cycle 3: Add `applyDefaultMaxTurns` and `applyGraceTurns` methods

1. Red: test `applyDefaultMaxTurns(0)` — sets to unlimited, toast says "unlimited".
   Test `applyDefaultMaxTurns(10)` — sets to 10, toast says "set to 10".
   Test `applyGraceTurns(3)` — sets to 3, toast says "set to 3".
   Test that neither calls `onMaxConcurrentChanged`.
2. Green: implement both methods.
3. Commit: `feat: add SettingsManager.applyDefaultMaxTurns and applyGraceTurns methods`

### Cycle 4: Narrow `AgentMenuSettings` and `AgentMenuManager`, simplify `showSettings`

1. Red: update `makeDeps` in `agent-menu.test.ts` — replace writable settings properties + `saveAndNotify` with readonly properties + 3 `apply*` mocks; remove `notifyConcurrencyChanged` from manager mock.
   Update assertions: `expect(deps.settings.applyMaxConcurrent).toHaveBeenCalledWith(8)` instead of checking property + `saveAndNotify` + `notifyConcurrencyChanged`.
2. Green: update `AgentMenuSettings` interface (readonly getters + apply methods), update `AgentMenuManager` (remove `notifyConcurrencyChanged`), rewrite `showSettings` to use apply methods, remove `notifyApplied` helper.
3. Run `pnpm run check`.
4. Commit: `refactor: simplify showSettings to use SettingsManager apply methods`

### Cycle 5: Wire `onMaxConcurrentChanged` in index.ts

1. Update `SettingsManager` constructor in `index.ts` — add `onMaxConcurrentChanged: () => manager.notifyConcurrencyChanged()`.
2. Remove `notifyConcurrencyChanged` from the menu's manager dep object.
3. Run full test suite.
4. Commit: `refactor: wire onMaxConcurrentChanged callback in extension init (#118)`

## Risks and Mitigations

| Risk                                                                                                                               | Mitigation                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closure ordering: `onMaxConcurrentChanged` references `manager` before it's constructed                                            | The closure captures by reference; `manager` is assigned before any runtime invocation of the callback. Verified by the `index.ts` construction order (`settings` → `manager` → menu wiring). |
| Toast message drift: apply methods generate messages internally, so changes require updating `SettingsManager` instead of the menu | Each method has exactly one message template; the coupling is intentional — the owner of the setting knows how to describe the change.                                                        |
| Apply methods duplicate the 3-step pattern (set → callback → save)                                                                 | The duplication is incidental across 3 settings — extracting a shared helper would need a discriminator for the callback, adding complexity for 3 call sites.                                 |
| `saveAndNotify` remains public but is no longer in `AgentMenuSettings`                                                             | It's still useful for programmatic callers and tests; keeping it public is intentional.                                                                                                       |

## Open Questions

- Should the property setters on `SettingsManager` be demoted to `private` (with only apply methods for external mutation)?
  Defer — `load()` uses them internally, and narrowing is done via the `AgentMenuSettings` interface.
  If a future consumer needs direct set access, the setters are there.
