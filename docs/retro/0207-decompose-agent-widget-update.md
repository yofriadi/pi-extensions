---
issue: 207
issue_title: "Decompose update in agent-widget.ts (cognitive 31)"
---

# Retro: #207 — Decompose `update` in `agent-widget.ts`

## Stage: Planning (2026-05-25T04:12:00Z)

### Session summary

Planned the decomposition of `update` (cognitive complexity 31) into an exported pure `assembleWidgetState` function, a `clearWidget` method, and an `updateStatusBar` method.
The plan follows the Phase 12 pattern established by Steps 1 and 2 (#205, #206) — extract pure functions where possible, otherwise extract methods, and simplify the original function to a thin orchestrator.

### Observations

- The sibling plans (#205, #206) provided a clear template for this plan — structure, section ordering, and test impact analysis all followed the established pattern.
- There are **no existing tests** for `AgentWidget` — the only testable concern is the newly extracted `assembleWidgetState` pure function.
  The rest of the refactoring is a mechanical extraction verified by the type checker.
- `categorizeAgents` in `widget-renderer.ts` does a similar filter but returns full arrays (for rendering), while `assembleWidgetState` returns lightweight counts (for lifecycle decisions).
  Different outputs for different consumers — no duplication concern.
- No `ask_user` was needed — the issue's "Proposed change" section was unambiguous and the design pattern was well-established by the two preceding Phase 12 steps.

## Stage: Planning — revision (2026-05-25T16:00:00Z)

### Session summary

Reviewed and revised the prior plan after a thorough code audit of `agent-widget.ts`, `widget-renderer.ts`, `agent-record.ts`, and `runtime.ts`.
Three design changes were made to the original plan.

### Observations

- **Narrowed the input type:** Changed `assembleWidgetState` from accepting `WidgetAgent[]` (10+ fields) to a local `AgentSummary` interface (3 fields: `id`, `status`, `completedAt?`).
  The original plan violated ISP — the function only reads 3 fields, so requiring full `WidgetAgent` fixtures in tests would be needless friction.
  `AgentRecord` satisfies `AgentSummary` structurally, so no adapter is needed at the call site.
- **Kept `dispose` independent:** The original plan made `dispose` delegate to `clearWidget`, but `dispose` and `update`'s idle path have different lifecycle semantics — `dispose` uses unconditional teardown (correctness guarantee), while `update`'s idle path uses guarded calls (avoiding redundant SDK calls during repeated ticks).
  `dispose` also skips stale-entry cleanup (the Map is about to be GC'd).
  Per the code-design skill's Sandi Metz principle, this is structural duplication that should not be extracted.
- **Added complexity budget table:** Explicitly estimated cognitive complexity for each extracted function to verify the < 10 target is achievable across the board.

## Stage: Implementation — TDD (2026-05-25T13:10:00Z)

### Session summary

Completed all three TDD steps from the plan.
`assembleWidgetState` was extracted and tested with 16 unit tests covering all status combinations; `clearWidget` and `updateStatusBar` were extracted as private methods simplifying `update` to a thin orchestrator.
Test count went from 868 to 884 (+16 tests across 55 files, up from 54).

### Observations

- No deviations from the plan.
  The non-null assertion (`this.uiCtx!`) in `clearWidget` and `updateStatusBar` is safe because both methods are only called from `update` after the `if (!this.uiCtx) return` guard.
- The `AgentSummary` interface and narrow test fixtures worked exactly as planned — test objects are plain 3-field literals, no `createTestRecord` needed.
- The complexity hotspots table in `architecture.md` now has no rows (both `renderWidgetLines` from #205 and `update` from this issue are resolved).
  The section note was updated to reflect that Phase 12 cleared all critical hotspots.
- `pnpm fallow dead-code` (from repo root) passed with no issues.

## Stage: Final Retrospective (2026-05-25T13:15:00Z)

### Session summary

Issue #207 shipped as `pi-subagents-v7.3.0` with zero deviations from the revised plan.
The session covered plan revision, TDD implementation (16 new tests, 868 → 884), shipping, and CI verification.

### Observations

#### What went well

- The plan revision caught three real design issues before implementation started: ISP violation in the function parameter type, incorrect `dispose` → `clearWidget` delegation, and missing complexity budget.
  Fixing these upfront meant the TDD execution had zero deviations and zero rework.
- The narrow `AgentSummary` type (3 fields) made test fixtures trivial plain objects — no `createTestRecord` or factory infrastructure needed.
  This validated the ISP improvement concretely.
- The `dispose` independence decision (Sandi Metz principle applied to lifecycle semantics) kept `dispose` at its current 10-line simplicity while `clearWidget` got its own guarded teardown logic.

#### What caused friction (agent side)

- `missing-context` — The original planning session (prior to this one) used `WidgetAgent[]` as the input type without checking which fields `assembleWidgetState` actually reads.
  The `code-design` skill already says "do not pass a shared dependency bag to functions that only use a subset of it" but the principle wasn't applied to the proposed function signature.
  Impact: required a full plan revision session; no rework in implementation because it was caught before TDD started.
- `wrong-abstraction` — The original plan proposed `dispose` → `clearWidget` delegation as "eliminating duplication" without evaluating whether the two methods have the same lifecycle semantics.
  `dispose` uses unconditional teardown (shutdown correctness); `clearWidget` uses guarded calls (avoiding redundant SDK calls during repeated timer ticks).
  Impact: same as above — caught in revision, no implementation rework.

#### What caused friction (user side)

- The user's "I don't yet trust the plan" intervention was the key moment that improved the design.
  Without it, the plan would have been implemented with the wider type and the `dispose` delegation.
  This was effective judgment — the user identified that a mechanical plan for a mechanical refactoring still warranted critical design review.

### Changes made

1. Added two sentences to `.pi/prompts/plan-issue.md` Design Overview section: ISP check for new function parameter types, and structural-duplication check when consolidating methods into a shared helper.
