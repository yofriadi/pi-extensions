---
issue: 109
issue_title: "refactor(pi-subagents): extract SettingsManager class"
---

# Retro: #109 — extract SettingsManager class

## Final Retrospective (2026-05-21T17:30:00Z)

### Session summary

Planned and implemented the `SettingsManager` class extraction across 8 TDD cycles plus doc updates.
The class owns `defaultMaxTurns`, `graceTurns`, and `maxConcurrent` with normalizing property accessors, a `load()` method for merged config, and `saveAndNotify()` for persistence + lifecycle events.
Six settings-related callback fields in `AgentMenuDeps` collapsed to a single `settings` collaborator (13 → 8 fields), and `SettingsAppliers`, `applySettings`, `applyAndEmitLoaded`, `saveAndEmitChanged` were removed.
A follow-up issue (#118) was filed for a LoD/Tell-Don't-Ask violation the user identified in the post-implementation review.

### Observations

#### What went well

- The lift-and-shift TDD approach worked cleanly: the new class was built and tested in isolation (cycles 1–2), consumers migrated one at a time (cycles 3–5), wiring consolidated (cycle 6), and old code removed last (cycles 7–8).
  Each commit left the repo in a valid state.
- The user's design critique (LoD / Tell-Don't-Ask on `deps.settings.saveAndNotify()` orchestration) was sharp and led to a concrete follow-up issue (#118) with a clear fix.
  The session handled it well — acknowledged, designed the fix, filed the issue, updated the architecture doc, and stopped without scope-creeping into implementation.

#### What caused friction (agent side)

1. `wrong-abstraction` — The plan did not anticipate that changing `AgentMenuDeps` (cycle 3) would immediately break `index.ts` type-checking.
   Each interface change in cycles 3, 4, and 5 required a same-commit bridge fix in `index.ts` to keep `pnpm run check` clean.
   The plan's separation of "migrate consumers" (cycles 3–5) from "wire in index.ts" (cycle 6) was too coarse — interface changes propagate to the call site immediately.
   Impact: three unplanned bridge edits in `index.ts`, each small but requiring context-switching mid-cycle.

2. `missing-context` — The `sed` command in cycle 5 (`sed -i '' 's/maxConcurrent: 1,/getMaxConcurrent: () => 1,/g'`) missed two call sites where `maxConcurrent: 1` had no trailing comma (end of object literal).
   A `grep` check after the `sed` would have caught this immediately.
   Impact: two tests failed unexpectedly; required a follow-up read + manual edit before the cycle could complete.

3. `missing-context` — The Edit tool failed on `runtime.ts` because the file uses `─` (U+2500, BOX DRAWINGS LIGHT HORIZONTAL) in section separators, not `—` (U+2014, EM DASH).
   The Unicode characters looked identical in the terminal, and the Edit tool's exact-match requirement meant the mismatch was silent until the replacement failed.
   Impact: three failed Edit attempts before falling back to a Python script for the replacement.
   This is the same class of issue seen in previous sessions with Unicode characters in source files.

4. `premature-convergence` — The plan designed `SettingsManager` as a data holder with persistence methods but didn't consider whether the menu should orchestrate across `settings` and `manager` or whether `SettingsManager` should own the full consequence chain.
   The user caught this as a LoD/Tell-Don't-Ask violation in post-implementation review.
   Impact: no rework (filed as follow-up #118), but the design could have been better from the start if the plan had applied the design-review checklist's LoD check to the proposed `showSettings` interaction pattern.

#### What caused friction (user side)

- The user's LoD critique was well-timed — after implementation was complete, avoiding mid-stream rework.
  If the critique had surfaced during planning (e.g., by the agent applying the design-review checklist to the proposed consumer interaction pattern), the follow-up issue might have been part of the original scope.
  This is an opportunity for the planning step to simulate the consumer's call sites before finalizing the design, not just the class interface.

### Changes made

1. `.pi/prompts/plan-issue.md` — Added consumer call-site sketch heuristic to the "Design Overview" section: when a new collaborator is introduced, sketch 3–5 lines of consumer pseudocode to verify Tell-Don't-Ask and LoD.
2. `.pi/skills/testing/SKILL.md` — Added TDD planning rule: when a step changes an interface with a single call site, the step must include updating that call site (type checker enforces co-location).
