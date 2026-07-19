---
issue: 194
issue_title: "Align tool interfaces for structural typing"
---

# Align tool interfaces for structural typing

## Problem Statement

The narrow interfaces that tool factories accept don't structurally match the real objects (`AgentManager`, `SubagentRuntime`, `SettingsManager`).
This forces `index.ts` to build adapter closures bridging the gap — each a one-liner that exists only because names or ownership don't align.
Three specific mismatches prevent structural typing from connecting real objects to tool interfaces directly.

## Goals

- Remove `getMaxConcurrent()` from `AgentToolManager` — it belongs on the settings accessor.
- Rename `SubagentRuntime.updateWidget()` → `update()` so `SubagentRuntime` structurally satisfies `AgentToolWidget`.
- Remove the dead `getToolCallName` re-export from `ui/message-formatters.ts`.
- After these changes, `AgentManager` structurally satisfies `AgentToolManager` and `SubagentRuntime` structurally satisfies `AgentToolWidget` — no adapter closures needed in `index.ts`.

## Non-Goals

- Converting tool factories to classes (that's #195).
- Simplifying `index.ts` wiring (that's #195/#196, after this layer).
- Changing `NotificationManager`'s constructor parameter name (`updateWidget` callback) — it's a positional callback, not a structural interface member.

## Background

This is Phase 11, Layer 2 in `docs/architecture/architecture.md`.
Layer 0 (#192, done) and Layer 1 (#193, done) established the typed `SessionContext` and moved context queries onto `SubagentRuntime`.
Layer 2 (this issue) aligns the remaining structural mismatches.
Layer 3 (#195) depends on this layer.

Relevant modules:

- `src/tools/agent-tool.ts` — defines `AgentToolManager` and `AgentToolWidget` interfaces.
- `src/tools/background-spawner.ts` — defines `BackgroundManagerDeps` with `getMaxConcurrent()`.
- `src/runtime.ts` — defines `SubagentRuntime` class with `updateWidget()` delegation method.
- `src/ui/message-formatters.ts` — has the dead `getToolCallName` re-export.
- `src/index.ts` — composition root that builds adapter closures.
- `src/settings.ts` — `SettingsManager` owns `maxConcurrent`.

## Design Overview

### 1. Move `getMaxConcurrent` off manager interfaces → settings

The `BackgroundManagerDeps` and `AgentToolManager` interfaces both declare `getMaxConcurrent(): number`.
In reality, the value comes from `SettingsManager.maxConcurrent`.
The fix:

- Remove `getMaxConcurrent` from `AgentToolManager`.
- Remove `getMaxConcurrent` from `BackgroundManagerDeps`.
- Widen `AgentToolDeps.settings` from `{ readonly defaultMaxTurns: number | undefined }` to also include `readonly maxConcurrent: number`.
- Pass `settings` (or a narrow settings interface) to `spawnBackground` so it can read `maxConcurrent` directly.
- `SettingsManager` already exposes a `get maxConcurrent(): number` property, so it structurally satisfies the widened interface.

After this, `AgentManager` (which has `spawn`, `spawnAndWait`, `resume`, `getRecord` but NOT `getMaxConcurrent`) structurally satisfies `AgentToolManager`.

### 2. Rename `SubagentRuntime.updateWidget()` → `update()`

The `AgentToolWidget` interface declares `update(): void`.
`SubagentRuntime` has `updateWidget(): void` which delegates to `this.widget?.update()`.
Renaming the delegation method to `update()` makes `SubagentRuntime` structurally satisfy `AgentToolWidget` (it already has `setUICtx`, `ensureTimer`, and `markFinished`).

Callers of `runtime.updateWidget()`:

- `src/index.ts` line 70: `() => runtime.updateWidget()` → `() => runtime.update()`
- `src/index.ts` line 199: `update: () => runtime.updateWidget()` → can now pass `runtime` directly (but that's a #195 concern — for now just rename the call).

The `WidgetLike` interface in `runtime.ts` already uses `update()` — no conflict.

### 3. Remove dead re-export

`src/ui/message-formatters.ts` line 24 exports `getToolCallName` from `#src/session/content-items`.
No consumer imports `getToolCallName` from `message-formatters` — all uses go directly to `content-items.ts`.
Delete the re-export line.

### After all three changes

```typescript
// AgentToolManager (after removing getMaxConcurrent):
interface AgentToolManager {
  spawn(...): string;
  spawnAndWait(...): Promise<AgentRecord>;
  resume(...): Promise<AgentRecord | undefined>;
  getRecord(id: string): AgentRecord | undefined;
}
// AgentManager has all four methods → structural match ✓

// AgentToolWidget (unchanged):
interface AgentToolWidget {
  setUICtx(ctx: unknown): void;
  ensureTimer(): void;
  update(): void;
  markFinished(id: string): void;
}
// SubagentRuntime has all four methods (after rename) → structural match ✓
```

## Module-Level Changes

| File                                    | Change                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/agent-tool.ts`               | Remove `getMaxConcurrent` from `AgentToolManager`. Widen `settings` type in `AgentToolDeps` to include `readonly maxConcurrent: number`.                                                                                          |
| `src/tools/background-spawner.ts`       | Remove `getMaxConcurrent` from `BackgroundManagerDeps`. Add a `settings: { readonly maxConcurrent: number }` parameter (or add to `BackgroundParams`). Read `settings.maxConcurrent` instead of `manager.getMaxConcurrent()`.     |
| `src/runtime.ts`                        | Rename `updateWidget()` → `update()`.                                                                                                                                                                                             |
| `src/ui/message-formatters.ts`          | Remove the `export { getToolCallName } from ...` line.                                                                                                                                                                            |
| `src/index.ts`                          | Update `runtime.updateWidget()` → `runtime.update()` at both call sites. Remove `getMaxConcurrent` from the `manager` adapter object passed to `createAgentTool`. Pass `settings` through to `spawnBackground` via the tool deps. |
| `test/tools/background-spawner.test.ts` | Remove `getMaxConcurrent` from mock manager objects. Add `settings` mock with `maxConcurrent`.                                                                                                                                    |
| `test/runtime.test.ts`                  | Rename `updateWidget` → `update` in test descriptions and call sites.                                                                                                                                                             |
| `docs/architecture/architecture.md`     | Update Layer 2 status and health metrics (adapter closures count, dead exports count).                                                                                                                                            |

## Test Impact Analysis

1. No new unit tests are strictly needed — this is interface alignment, not new behavior.
2. `test/tools/background-spawner.test.ts` needs mock shape updates (remove `getMaxConcurrent` from manager mock, add settings mock).
3. `test/runtime.test.ts` needs the method name updated from `updateWidget` to `update`.
4. Existing tests for `agent-tool`, `notification`, and `message-formatters` remain as-is (no behavior change).

## TDD Order

1. `refactor:` Rename `SubagentRuntime.updateWidget()` → `update()` — update `runtime.ts`, `test/runtime.test.ts`, and both call sites in `index.ts`.
   Run `pnpm run check` to verify no type errors remain.
2. `refactor:` Move `getMaxConcurrent` off manager interfaces — remove from `AgentToolManager` and `BackgroundManagerDeps`, widen `AgentToolDeps.settings`, add settings parameter to `spawnBackground`, update `index.ts` call site and `test/tools/background-spawner.test.ts`.
   Run `pnpm run check`.
3. `refactor:` Remove dead `getToolCallName` re-export from `ui/message-formatters.ts`.
4. `docs:` Update architecture doc — mark Layer 2 as done, update health metrics (dead exports: 0, adapter closures reduced).

## Risks and Mitigations

| Risk                                                                                                 | Mitigation                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update()` is a generic name on `SubagentRuntime` — could confuse readers about what's being updated | The method is a documented widget delegation like its siblings (`markFinished`, `ensureTimer`); the JSDoc comment clarifies it delegates to `widget.update()`. |
| `background-spawner` signature change could break other callers                                      | Grep confirms only `agent-tool.ts` calls `spawnBackground` — no other consumers.                                                                               |
| Renaming method in runtime could miss a call site                                                    | Grep and `pnpm run check` after each step catch all references.                                                                                                |

## Open Questions

None — the issue's proposed direction is unambiguous and the architecture doc confirms the design.
