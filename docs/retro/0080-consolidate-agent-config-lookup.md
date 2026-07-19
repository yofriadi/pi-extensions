---
issue: 80
issue_title: "refactor: consolidate getConfig / getAgentConfig into a single resolution path"
---

# Retro: #80 — consolidate getConfig / getAgentConfig

## Final Retrospective (2026-05-20T00:35:00Z)

### Session summary

Consolidated two overlapping agent config lookup functions (`getConfig` and `getAgentConfig`) into a single `resolveAgentConfig(type): AgentConfig` with a guaranteed-non-null return and internal fallback chain.
Migrated all 6 source callers and 5 test files across 6 TDD commits, then shipped as `pi-subagents-v5.4.0`.

### Observations

#### What went well

- The lift-and-shift migration strategy (add new function → migrate callers incrementally → remove old functions) kept every commit green.
  No intermediate step broke the test suite.
- The planning phase correctly identified an under-documented scope question (callers beyond the two mentioned in the issue) and used `ask-user` to resolve it before writing the plan.
- The `test/prompts.test.ts` caller, missed by the plan, was caught cleanly during the final grep sweep in step 6 — no rework needed, just an additional edit in the same commit.

#### What caused friction (agent side)

- `missing-context` — The plan specified that `resolveAgentConfig` should fall back for disabled types (matching `getConfig`'s semantics), but didn't trace what `agent-menu.ts` actually reads from disabled configs.
  `agent-menu.ts` iterates `getAllTypes()` (including disabled agents) and needs the real config to render `✕` indicators, source badges, and `(disabled)` descriptions.
  With fallback-for-disabled semantics, disabled agents would silently display as general-purpose.
  Caught during step 4 while editing `agent-menu.ts`, before any wrong test assertions ran.
  Impact: required changing `resolveAgentConfig` semantics (only fall back for unknown types, not disabled) and updating the step 1 test — a ~5 minute fix folded into the step 4 commit.

#### What caused friction (user side)

- Nothing notable.
  The user's `ask-user` response during planning ("remove both, migrate all callers") was clear and included a useful directional note about computing values earlier.
