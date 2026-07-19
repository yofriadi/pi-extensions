---
issue: 237
issue_title: "Remove disallowed_tools from pi-subagents (Phase 14, Step 1)"
---

# Retro: #237 — Remove disallowed_tools from pi-subagents

## Stage: Planning (2026-05-27T00:52:26Z)

### Session summary

Produced a 6-step TDD plan to remove `disallowedTools` from `AgentConfig`, `disallowedSet` from `ToolFilterConfig`, and all parsing/serialization/UI/test code that references them.
The plan covers 7 source files, 4 test files, README, and the architecture doc.

### Observations

- The issue label `pkg:pi-permission-system` was incorrect — all target files live in `packages/pi-subagents`.
  Confirmed with the user that the plan targets pi-subagents.
- The README still references `disallowed_tools` in the context of memory write-capability detection, but memory was already removed in #185.
  The plan treats this as a stale reference to clean up.
- After removing `disallowedSet`, the `filterActiveTools` `extensions === false` branch simplifies to a trivial passthrough (`return activeTools`), and both guard conditions at the call sites drop the `|| cfg.toolFilter.disallowedSet` arm.
  This leaves the function in the exact shape that Step 3 (#239) expects.
- The plan orders steps to follow the type dependency chain: `AgentConfig` first (surfaces all downstream errors), then `ToolFilterConfig`, then `filterActiveTools`, then UI, then docs.

## Stage: Implementation — TDD (2026-05-27T00:59:19Z)

### Session summary

All 6 TDD steps completed in one session, producing 7 commits (6 planned + 1 fixup for dead code).
Test count dropped from 983 to 978 (5 tests removed: 2 from `custom-agents.test.ts`, 1 from `session-config.test.ts`, 2 from `agent-runner-extension-tools.test.ts` after renaming one deleted test into a retained form).
All checks (type check, lint, fallow dead-code gate) pass clean.

### Observations

- `csvListOptional` in `custom-agents.ts` was left dead after removing the `disallowedTools` parsing call; Biome flagged it as unused.
  Removed as a separate `refactor:` commit since it couldn't be amended into the `feat!:` commit (later commits already on top of it).
- One of the three deleted `agent-runner-extension-tools.test.ts` denylist tests ("extensions: false with no disallowedTools skips the filter") was reformulated into a new test ("extensions: false skips the filter entirely") rather than simply deleted, because it covers genuinely different behavior after the simplification: `extensions: false` now always skips the filter, not just when no denylist is present.
  This adds coverage for the simplified code path.
- The `filterActiveTools` `extensions === false` branch simplified from "apply denylist to built-in tools" to `return activeTools`, exactly as the plan specified.
  Both guard conditions at the call sites simplified to `cfg.toolFilter.extensions !== false`.
- No deviations from the plan's module-level changes list; all 7 source files and 4 test files were touched as specified.

## Stage: Final Retrospective (2026-05-27T01:12:34Z)

### Session summary

Three-stage lifecycle (planning → TDD → ship) completed in one session for Phase 14, Step 1.
All 6 TDD steps landed in 7 commits (6 planned + 1 fixup for dead `csvListOptional`).
Test count: 983 → 978 (−5).
Released as `pi-subagents-v8.0.0` (major bump from the `feat!:` breaking change).

### Observations

#### What went well

- The plan's type-dependency-chain ordering (AgentConfig → ToolFilterConfig → `filterActiveTools` → UI → docs) meant each step produced the exact downstream type errors expected for the next step, with zero surprises.
  This ordering pattern is worth preserving for future removal issues.
- Incremental verification ran after every step: `pnpm run check` after type changes, `pnpm vitest run <file>` after logic changes, full suite + lint + fallow at the end.
  No regressions discovered at the final sweep.
- The reformulation of one deleted test into "extensions: false skips the filter entirely" added coverage for the simplified code path rather than just deleting it.
  Good judgment call during implementation.

#### What caused friction (agent side)

- `missing-context` — The plan said "remove `disallowedTools: csvListOptional(fm.disallowed_tools)`" from `custom-agents.ts` but did not check whether `csvListOptional` had other callers.
  It was the sole call site, so the function became dead code.
  Biome caught it at the final lint sweep, requiring a separate `refactor:` commit (`f1ee7c1`).
  Impact: one unplanned commit; no rework but added friction.
  Self-identified at final lint.
  Root cause: the `plan-issue.md` template had a rule for grepping removed *exports* but not for checking private-function orphans.

#### What caused friction (user side)

- No friction observed — the user's involvement was limited to confirming the target package (pi-subagents vs pi-permission-system) during planning, which was an appropriate clarification given the incorrect `pkg:` label on the issue.

### Changes made

1. `.pi/prompts/plan-issue.md` — Added rule: when a step removes a call to a private function, grep the file for other callers and list the function for removal if the removed call was the sole call site.
