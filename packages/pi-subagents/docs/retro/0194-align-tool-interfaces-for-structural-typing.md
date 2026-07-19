---
issue: 194
issue_title: "Align tool interfaces for structural typing"
---

# Retro: #194 — Align tool interfaces for structural typing

## Stage: Planning (2026-05-24T12:00:00Z)

### Session summary

Produced an implementation plan for three targeted alignment changes: moving `getMaxConcurrent` off manager interfaces to the settings accessor, renaming `SubagentRuntime.updateWidget()` → `update()`, and removing the dead `getToolCallName` re-export.
The plan includes a 4-step TDD order with type-check gates after each refactoring step.

### Observations

- Issue #193 (Layer 1) is already closed/implemented, confirming this layer can proceed immediately.

## Stage: Implementation — TDD (2026-05-24T21:00:00Z)

### Session summary

Completed all 4 TDD steps: renamed `SubagentRuntime.updateWidget()` → `update()`, moved `getMaxConcurrent` from manager interfaces to the `settings` narrow type, removed the dead `getToolCallName` re-export, and updated the architecture doc.
Test count stayed flat at 854 (53 files) — all green.
The `pnpm run check` type-gate caught a previously-unnoticed `test/helpers/make-deps.test.ts` that also validated `getMaxConcurrent` and the old `settings` shape; this file was updated as part of step 2.

### Observations

- An unexpected file `test/helpers/make-deps.test.ts` had three type errors after removing `getMaxConcurrent` (one test asserting `manager.getMaxConcurrent()`, one structural compatibility check referencing it, and one settings override that only passed `defaultMaxTurns`).
  All three were fixed in the same commit as step 2 — no deviation from the plan.
- Adding `settings` to `BackgroundParams` (instead of as a 5th function parameter) was the right call: it keeps `spawnBackground` at 4 arguments and groups all spawn-context values together.
- The health metric update: dead exports 1 → 0, adapter closures 41 → 40 (only `getMaxConcurrent` was removed in this layer; the remaining 8 widget/manager adapter closures need #195 class conversion to collapse).
- The `background-spawner.ts` module is the only consumer of `getMaxConcurrent` — grep confirms no other call sites beyond `agent-tool.ts`'s interface definition.
- The `NotificationManager` constructor takes `updateWidget` as a positional callback parameter name — this does NOT need renaming (it's not a structural interface member).
- The rename from `updateWidget` → `update` is safe because the `WidgetLike` interface in `runtime.ts` already uses `update()` — no naming conflict within the class.
- All three changes are independent of each other and could be committed in any order, but the plan sequences them for clean `pnpm run check` passes at each step.

## Stage: Final Retrospective (2026-05-24T21:15:00Z)

### Session summary

Planning, TDD implementation, and shipping completed in one continuous session.
Released as `pi-subagents-v7.2.1` with zero rework or deviations from the plan.

### Observations

#### What went well

- Clean execution end-to-end: 3 refactor commits + 1 docs commit, all planned in advance.
- The `pnpm run check` gate after step 2 caught `test/helpers/make-deps.test.ts` — a file the plan didn't list — preventing a broken intermediate state.
  This validates the "run type-check after each step" pattern for interface-alignment work.
- Phased architecture approach paid off: Layers 0 and 1 being done made Layer 2 entirely mechanical.

#### What caused friction (agent side)

- None identified.
  The issue scope was tight, the plan was unambiguous, and no rabbit-holes arose.

#### What caused friction (user side)

- None identified.
  The issue body and architecture doc provided complete context with no ambiguity.
