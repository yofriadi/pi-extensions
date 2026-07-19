---
issue: 214
issue_title: "Convert remaining closure factories to classes (Phase 13, Step 1)"
---

# Retro: #214 — Convert remaining closure factories to classes

## Stage: Planning (2026-05-25T20:00:00Z)

### Session summary

Produced a 4-step TDD plan to convert the three remaining closure factories (`createAgentConfigEditor`, `createAgentCreationWizard`, `createSubagentsService`) to classes.
Each conversion is one commit covering source, test, and consumer updates together.

### Observations

- The conversions are entirely mechanical — same pattern as Phase 11 (#195, #196).
  No design ambiguity requiring user input.
- `AgentCreationWizardDeps` is only used within its own file, so removing it is safe.
  The class dissolves the deps bag into positional constructor params for consistency with `AgentConfigEditor`.
- The `agent-creation-wizard.test.ts` has ~18 inline `createAgentCreationWizard(deps)` calls; the plan suggests adding a `makeWizard(deps)` helper to centralize construction and reduce the diff size.
- `SubagentsServiceAdapter` uses `implements SubagentsService` for compile-time verification, unlike the factory which relied on structural typing of the returned object literal.
- Pure helper functions (`buildMenuOptions`, `buildEjectContent`, `toSubagentRecord`) and narrow interfaces (`AgentManagerLike`, `ServiceRuntimeLike`, `WizardManager`, `WizardRegistry`) remain unchanged.

## Stage: Implementation — TDD (2026-05-25T21:00:00Z)

### Session summary

All 4 TDD steps completed in 4 commits.
Three closure factories converted to classes (`AgentConfigEditor`, `AgentCreationWizard`, `SubagentsServiceAdapter`) with tests and consumers updated in the same commit as each production change.
Test count held at 913 (57 files) — no new tests needed, no tests removed.

### Observations

- All three conversions were mechanical find-and-replace with no behavioral surprises.
- The `makeWizard(deps)` helper in `agent-creation-wizard.test.ts` centralized 14 inline `createAgentCreationWizard(deps)` calls, keeping the diff readable.
- `SubagentsServiceAdapter` uses `implements SubagentsService` — the TypeScript compiler confirmed the contract at compile time with no gaps.
- Adding the `SpawnOptions` import to `service-adapter.ts` was required for the `spawn` method signature; the plan anticipated this correctly.
- The `sed -i` command required the macOS `-i ''` form (no in-place backup extension) rather than the GNU `sed -i` form.
- Dead-code gate (`pnpm fallow dead-code`) passed cleanly from the repo root — no suppression needed.

## Stage: Final Retrospective (2026-05-25T22:00:00Z)

### Session summary

Shipped `pi-subagents-v7.3.2` with 3 refactor commits converting all remaining closure factories to classes.
All 4 lifecycle stages (plan → TDD → ship → retro) completed in a single day with zero rework and zero deviations from the plan.

### Observations

#### What went well

- Strong precedent from Phase 11 (#195, #196) made this issue zero-friction — the plan, implementation, and test updates all followed an established template.
- The plan's prediction of a `makeWizard(deps)` helper for `agent-creation-wizard.test.ts` kept the step-2 diff readable by centralizing 14 inline constructor calls.
- `SubagentsServiceAdapter implements SubagentsService` gave compile-time contract verification, catching any interface drift immediately via `pnpm run check`.
- The plan correctly anticipated the `SpawnOptions` import need in `service-adapter.ts`.

#### What caused friction (agent side)

- None.
  This was a textbook mechanical refactoring with no behavioral changes, no edge cases, and no test rework.

#### What caused friction (user side)

- None.
  The issue was well-scoped with explicit target files and a clear precedent to follow.
