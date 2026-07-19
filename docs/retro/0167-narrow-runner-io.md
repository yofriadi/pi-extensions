---
issue: 167
issue_title: "refactor(pi-subagents): narrow RunnerIO (9 methods → 2 focused interfaces)"
---

# Retro: #167 — narrow RunnerIO (9 methods → 2 focused interfaces)

## Stage: Planning (2026-05-24T20:00:00Z)

### Session summary

Produced a plan to split the `RunnerIO` interface in `agent-runner.ts` into two focused sub-interfaces (`EnvironmentIO` and `SessionFactoryIO`) while keeping `RunnerIO` as a backward-compatible type alias for their intersection.
The change is a pure refactoring with zero runtime behavior change.

### Observations

- The split is mechanical and low-risk: `RunnerIO` becomes `type RunnerIO = EnvironmentIO & SessionFactoryIO`, and all existing consumers (production code and test factories) continue to compile via structural typing.
- Dependency #164 (reorganize into domain directories) is already closed, so file paths are current.
- The two test `createRunnerIO()` factories are unannotated (intentionally, per testing skill guidelines), so they don't need type-level updates — only comment updates for documentation.
- This is a two-commit TDD plan, suitable for `/build-plan` rather than full TDD cycles since no new tests are required.

## Stage: Implementation — TDD (2026-05-24T20:45:00Z)

### Session summary

Completed both TDD steps in full.
Step 1 added `EnvironmentIO` and `SessionFactoryIO` interfaces and converted `RunnerIO` to a type alias in `agent-runner.ts`; step 2 updated comments in both test factories.
Test count held steady at 805/805 (50 files) — no behavioral changes.

### Observations

- The type check (`pnpm run check`) passed immediately after the interface split — structural typing meant zero call-site changes in `index.ts` or test factories.
- `RunnerIO` JSDoc was split: `EnvironmentIO` got the environment-discovery description, `SessionFactoryIO` got the original "decouples from Pi SDK imports" description, and `RunnerIO` itself got a short backward-compatibility note.
- Architecture doc updated: wide-interface table row and Step 4 roadmap entry both marked done.
- No deviations from the plan.

## Stage: Final Retrospective (2026-05-24T21:30:00Z)

### Session summary

Issue #167 completed across three sessions: planning, TDD implementation, and ship.
The `RunnerIO` interface was split into `EnvironmentIO` and `SessionFactoryIO` with a backward-compatible type alias.
Released as `pi-subagents-v6.18.4`.

### Observations

#### What went well

- The plan correctly identified that structural typing would make this zero-friction — no call-site changes were needed in `index.ts` or either test factory.
- The two-step TDD plan was right-sized for a pure refactoring: step 1 for the interface split, step 2 for comment updates.
  No new tests were needed, and the existing 805 tests validated the change without modification.
- Ship session was clean: CI passed first try, release-please PR merged, issue closed.

#### What caused friction (agent side)

- `missing-context` — The TDD session's architecture doc update (`824fd72`) only touched the `RunnerIO`-specific table row and Step 4 roadmap entry.
  It missed that the same file's "Current layout" section still showed the pre-#164 flat file structure and retained a redundant "Proposed directory restructuring" section.
  The user had to request a follow-up update (`d4a98aa`) in the ship session.
  Impact: one extra commit and user prompt; no rework of prior commits.

#### What caused friction (user side)

- No friction observed.
