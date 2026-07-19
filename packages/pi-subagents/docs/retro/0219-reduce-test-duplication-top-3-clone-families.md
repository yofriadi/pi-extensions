---
issue: 219
issue_title: "Reduce test duplication — top 3 clone families (Phase 13, Step 6)"
---

# Retro: #219 — Reduce test duplication — top 3 clone families

## Stage: Planning (2026-05-26T20:00:00Z)

### Session summary

Analyzed duplication patterns in the three target test files (`agent-manager.test.ts`, `conversation-viewer.test.ts`, `agent-config-editor.test.ts`).
Produced a 5-step TDD plan with shared `manager-stubs.ts` helper for runner/worktree factories, plus inline factories for the two UI test files.

### Observations

- The agent-manager test has the most diverse clone families (runner stubs, worktree stubs, run-result shapes) — these benefit from a shared helper file since the patterns are reused across 15+ describe blocks.
- The conversation-viewer and config-editor duplication is more localized — inline factories within each test file are the right granularity to avoid over-extraction.
- Gated runners (using `Promise.withResolvers`) were deliberately kept inline since they encode test-specific flow control that a factory would obscure.
- Both dependencies (#214, #216) are closed, so the production code is stable and the tests won't shift under us during implementation.

## Stage: Implementation — TDD (2026-05-26T17:42:41Z)

### Session summary

Completed all 4 TDD cycles: created `test/helpers/manager-stubs.ts` + `manager-stubs.test.ts` (13 smoke tests), migrated `agent-manager.test.ts`, `conversation-viewer.test.ts`, and `agent-config-editor.test.ts`.
Test count delta: 970 → 983 (+13 from smoke tests).
All 4 commits landed cleanly; full suite green at every step.

### Observations

- Target file line savings: `agent-manager.test.ts` −63, `conversation-viewer.test.ts` −58, `agent-config-editor.test.ts` −16; offset by +211 for the new helper files.
  Net LOC is positive, but the _clone_ lines fallow detects are eliminated — the metric the issue targets.
- The `createSessionRunner` + `createRunResult` chain required careful identity-check verification: `createRunResult(sess)` calls `toAgentSession(sess)` which casts without creating a new object, so `toBe(session)` assertions in the execution-state tests still pass. ✓
- ESLint auto-fixed two cosmetic issues on commit (`activity = undefined` → `activity` destructuring, `session as unknown` cast removal) — caught by pre-commit hooks, not a problem in practice.
- The `assertRenderFitsWidths` helper in `conversation-viewer.test.ts` reduced the 10 render-safety tests from ~8 lines each to 1–4 lines each; the `setupDetail` helper in `agent-config-editor.test.ts` eliminated 3 repeated setup lines per test across 18 `showAgentDetail` tests.

## Stage: Final Retrospective (2026-05-26T17:50:31Z)

### Session summary

All three stages (planning, TDD, ship) completed in a single session with zero user corrections.
Four TDD commits landed cleanly, CI passed on first push, issue #219 closed, and `pi-subagents-v7.8.1` released.

### Observations

#### What went well

- Clean incremental verification: `pnpm vitest run <file>` ran after every code change, full suite at the end.
  No regressions at any step.
- The plan's decision to keep gated runners inline proved correct — tests with `Promise.withResolvers` flow control stayed readable without abstraction.
- The `write` tool was the right choice for `conversation-viewer.test.ts` and `agent-config-editor.test.ts` (pervasive changes), while `edit` with 16 targeted replacements worked cleanly for `agent-manager.test.ts` (scattered but formulaic substitutions).
- Ship stage used `deepseek-v4-flash` for purely mechanical CI/release steps — appropriate model-task alignment.

#### What caused friction (agent side)

- `other` — ESLint pre-commit hooks auto-fixed two cosmetic patterns (`activity = undefined` → bare destructuring; `session as unknown` cast removal), requiring re-stage + re-commit.
  Impact: ~10 seconds per occurrence, no rework.
  This is routine and inherent to the workflow.

#### What caused friction (user side)

- None observed.
  The user's three-stage prompt chain (`/plan-issue` → `/tdd-plan` → `/ship-issue`) provided sufficient context at each stage with no manual intervention needed.
