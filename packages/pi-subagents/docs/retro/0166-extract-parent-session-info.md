---
issue: 166
issue_title: "refactor(pi-subagents): extract ParentSessionInfo from AgentSpawnConfig (13 fields)"
---

# Retro: #166 — Extract ParentSessionInfo from AgentSpawnConfig

## Stage: Planning (2026-05-24T16:00:00Z)

### Session summary

Produced a 6-step TDD plan to extract `ParentSessionInfo` from `AgentSpawnConfig`.
The refactoring groups three co-traveling fields (`parentSessionFile`, `parentSessionId`, `toolCallId`) into a named value object, reducing `AgentSpawnConfig` from 13 to 11 fields.

### Observations

- The `SubagentsService` boundary (`service-adapter.ts`) does not pass any of the three fields, so this is a purely internal refactoring with no public API impact.
- `getSessionInfo` in `AgentToolDeps` returns only `parentSessionFile` and `parentSessionId`; `toolCallId` comes from the `execute` callback's first argument — the plan keeps this separation and merges them at the `agent-tool.ts` boundary.
- `RunOptions` in `agent-runner.ts` never carried `toolCallId` (it was consumed in `AgentManager.spawn` before reaching the runner), so the nested `parentSession` on `RunOptions` only holds the two session fields.
- The deep-merge trap from the testing skill is relevant: `background-spawner.test.ts` has a `makeParams` factory that spreads flat fields — must be converted to nested `parentSession` construction.
- Issue #165 (decompose `ResolvedSpawnConfig`) is closed, so this plan builds on stable ground.

## Stage: Implementation — TDD (2026-05-24T17:00:00Z)

### Session summary

All 5 TDD cycles completed across `agent-manager.ts`, `agent-runner.ts`, `background-spawner.ts`, `foreground-runner.ts`, and `agent-tool.ts`.
Test count held steady at 805 (no net new tests — refactor only).
Type check and lint both clean after all steps.

### Observations

- The `AgentSpawnConfig` field count went from 15 to 13 (not 13 → 10 as originally estimated) — the architecture doc quoted the issue's stale count; the actual pre-refactor interface had 15 fields (`bypassQueue` and others were already present).
  The architecture doc was updated to reflect "done" with a note about the nested group rather than a specific before/after number.
- The deep-merge trap (noted in planning) did materialise: `background-spawner.test.ts`'s `makeParams` spread `Partial<BackgroundParams>` with flat fields.
  Fixed by replacing the three flat fields with a single `parentSession` object at the factory level — top-level spread still works correctly since `parentSession` is one field.
- `RunOptions` in `agent-runner.ts` needed a new import of `ParentSessionInfo` from `agent-manager.ts`; no circular dependency since `agent-runner.ts` already imports from `agent-manager.ts`.
- `agent-tool.ts` still imports `AgentSpawnConfig` (needed by `AgentToolManager` interface) — the new `ParentSessionInfo` import was added alongside it.
- All 5 commits are clean `refactor:` messages; architecture doc update is a separate `docs:` commit.

## Stage: Final Retrospective (2026-05-24T18:00:00Z)

### Session summary

Planning, TDD implementation (5 steps), shipping, and CI verification all completed in a single session.
Released as `pi-subagents-v6.18.2`.
Zero rework — every TDD step went green on first attempt.

### Observations

#### What went well

- The planning session's identification of the deep-merge trap in `background-spawner.test.ts`'s `makeParams` factory paid off — the TDD implementation handled it without friction because the risk was anticipated.
- The 5-step inside-out TDD order (manager → runner → background → foreground → agent-tool) was the right sequence.
  Each step only introduced type errors in files that subsequent steps would fix, with no circular breakage.
- Clean mechanical execution — 805 tests before and after, zero rework commits, lint and type-check clean throughout.

#### What caused friction (agent side)

- `missing-context` — The plan repeated the issue body's stale "13 fields" count without verifying against the actual `AgentSpawnConfig` interface (which had 15 fields after `bypassQueue` was added in a prior issue).
  The plan also inconsistently claimed the extraction would reduce the count to both "11" and "10" in different places.
  Impact: required corrections in the architecture doc update, but no implementation rework.

#### What caused friction (user side)

- None observed — the user let the session run autonomously through all stages without intervention.
