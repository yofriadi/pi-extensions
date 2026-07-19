---
issue: 196
issue_title: "Convert AgentRunner and AgentsMenuHandler to classes, simplify index.ts"
---

# Retro: #196 — Convert AgentRunner and AgentsMenuHandler to classes, simplify index.ts

## Stage: Planning (2026-05-25T14:35:46Z)

### Session summary

Produced a 6-step TDD plan covering the final two closure-factory-to-class conversions (`createAgentRunner` → `ConcreteAgentRunner`, `createAgentsMenuHandler` → `AgentsMenuHandler`) and the subsequent `index.ts` simplification.
Confirmed that `AgentManager` structurally satisfies `AgentMenuManager`, enabling direct pass-through without adapter closures.

### Observations

- The issue's proposed `AgentsMenuHandler` constructor omits `agentActivity`, but the class needs it for `viewAgentConversation`.
  Plan includes it as a constructor param — minimal deviation from the issue.
- `getModelLabel` can be internalized into `AgentsMenuHandler` since it only uses two pure imported functions (`resolveModel`, `getModelLabelFromConfig`) plus the registry (already a constructor param).
  This eliminates a 7-line closure from `index.ts`.
- Tests for `agent-runner` call `runAgent`/`resumeAgent` directly — no test uses `createAgentRunner`, so the runner conversion has zero test impact.
- The `agent-menu.test.ts` file is 215 lines and needs call-site updates (factory → class constructor + `.handle()`), but no logic changes.
- After both conversions, `index.ts` loses ~5 imports and ~4 adapter closures.
  The remaining ~15 closures are structural (event registrations, SDK factory callbacks) and cannot be eliminated.

## Stage: Implementation — TDD (2026-05-25T14:56:11Z)

### Session summary

Completed all 6 plan steps (collapsed into 5 commits: steps 3 and 5 merged).
Baseline was 854 tests across 53 files; final suite is 856 tests across 54 files (+2 tests, +1 file for `concrete-agent-runner.test.ts`).
All type-check, lint, and dead-code gates pass clean.

### Observations

- Plan steps 3 and 5 had to be merged into a single commit: removing `createAgentsMenuHandler` immediately broke `index.ts` imports, so the `index.ts` update could not wait for a separate commit.
  This is a known coupling when a factory's only call site is in `index.ts`.
- The `AgentsMenuHandler` class constructor includes `agentActivity` as planned (the issue's proposed signature omitted it; the plan's deviation was correct).
- `getModelLabel` internalization was clean: `resolveModel` and `getModelLabelFromConfig` are pure functions the class imports directly.
- `AgentManager` structurally satisfies `AgentMenuManager` with no adapter closures — confirmed by `pnpm run check` passing immediately.
- The `agent-menu.test.ts` refactor replaced `Partial<AgentMenuDeps>` overrides with a `makeHandler(opts)` helper that returns both the handler and collaborator stubs, which is cleaner for assertion.
- `rumdl` emitted 3 warnings in `pnpm run lint` — these are pre-existing and unrelated to this change (lint passes for markdown linting, the warnings are from biome/eslint steps that auto-fixed nothing).

## Stage: Final Retrospective (2026-05-25T15:04:47Z)

### Session summary

Completed all three stages (planning, TDD, shipping) in one sitting.
Issue #196 shipped as `pi-subagents-v7.2.5`.
All closure factories in pi-subagents are now classes; Phase 11 (Layers 3 + 4) is complete.

### Observations

#### What went well

- The three-session lifecycle (plan → TDD → ship) completed cleanly in a single sitting with no user corrections.
- Structural typing confirmation during planning paid off — `AgentManager` satisfied `AgentMenuManager` without adapter closures, and `pnpm run check` passed immediately after the wiring change.
- The `makeHandler(opts)` test helper pattern (returning handler + collaborator stubs) was cleaner than the `Partial<AgentMenuDeps>` spread approach it replaced.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan separated factory removal (step 3) from call-site update (step 5), even though the testing skill already has a rule: "When a TDD step changes an interface that has a single call site, the step must include updating that call site."
  The planner treated this as a testing concern and didn't apply it during plan authoring.
  Impact: steps 3 and 5 had to be merged at implementation time, producing a commit message explaining the deviation.
  Added a cross-reference to `plan-issue.md`.

#### What caused friction (user side)

Nothing notable — the user's issue was well-specified and the three `/` commands ran without intervention.

### Changes made

1. Added single-call-site rule to `.pi/prompts/plan-issue.md` TDD Order section: when a step removes a factory/export with one call site, include the call-site update in the same step.
