---
issue: 87
issue_title: "refactor: evolve SubagentRuntime from data bag to object with methods"
---

# Retro: #87 — evolve SubagentRuntime from data bag to object with methods

## Final Retrospective (2026-05-20T18:00:00Z)

### Session summary

Planned, implemented, and shipped #87 — converting `SubagentRuntime` from a plain interface + factory into a class with session-context methods (`setSessionContext`, `clearSessionContext`) and widget delegation methods (`setUICtx`, `onTurnStart`, `markFinished`, `updateWidget`, `ensureTimer`).
All 10 call sites in `index.ts` were migrated, eliminating raw `currentCtx` field writes and `runtime.widget!` reach-throughs.
Released as `pi-subagents-v5.7.0`.

### Observations

#### What went well

- The 3-step TDD cycle executed cleanly with zero rework or deviations from the plan.
  Test count went from 5 → 16 in `runtime.test.ts`; all 512 package tests stayed green throughout.
- The user identified a missing architecture update and a pre-existing hallucination (`@earendil-works/pi-subagents` → `@gotgenes/pi-subagents`) after the plan commit.
  The fix was a single well-scoped commit (`ddee1a0`) that corrected 10 scope references, updated the dependency graph to include #87 as a precursor to #70, and fixed list numbering per phase heading.
- The plan's "Call sites to migrate" tables with exact line numbers and before/after code made step 3 (the refactoring commit) purely mechanical — no design decisions at implementation time.

#### What caused friction (agent side)

- `missing-context` — In TDD step 2, the new `describe` block used `vi.fn()` but the test file's import was `{ describe, expect, it }` without `vi`.
  The first red run surfaced this immediately (`ReferenceError: vi is not defined`) and it was fixed before the green step.
  Impact: one extra test run, no rework commits.
- `scope-drift` — The `/plan-issue` prompt does not instruct updating `architecture.md`, but the user noticed #87 was missing from the roadmap's dependency graph.
  The agent hadn't checked `architecture.md` during planning even though #87 is explicitly listed as a precursor to #70 in the #70 plan.
  Impact: user-caught; required a follow-up edit pass after the plan commit.

#### What caused friction (user side)

No friction observed.
The user's correction about `architecture.md` was well-targeted and caught a real gap.

### Changes made

1. Retro file created at `packages/pi-subagents/docs/retro/0087-evolve-subagent-runtime-methods.md`.
