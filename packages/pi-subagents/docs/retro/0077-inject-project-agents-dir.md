---
issue: 77
issue_title: "refactor: add projectAgentsDir to AgentMenuDeps instead of reading process.cwd() inline"
---

# Retro: #77 — inject projectAgentsDir into AgentMenuDeps

## Final Retrospective (2026-05-20T16:15:00Z)

### Session summary

Planned, implemented, and shipped a refactoring that adds `projectAgentsDir: string` to `AgentMenuDeps`, replacing the inline `process.cwd()` lambda in `createAgentsMenuHandler`.
The change mirrors the existing `personalAgentsDir` injection pattern.
Released as `pi-subagents-v5.8.2`.

### Observations

#### What went well

- Clean end-to-end execution: plan → TDD → ship with zero corrections or rework.
- The Red test was well-targeted: exercised `findAgentFile` through the menu navigation path and naturally failed because `process.cwd()` produced a different path than the injected `/test-project/.pi/agents`.
- Correctly identified at execution time that the plan's two-step TDD split was impractical (interface change is atomic) and combined into a single `refactor:` commit.

#### What caused friction (agent side)

- `instruction-violation` — The plan listed two TDD commits (step 1: `test:`, step 2: `refactor:`) but adding a required field to `AgentMenuDeps` is an atomic change — the test references the new field, so both must land together.
  The testing skill's shared-type-definition rule ("changing that type in step N breaks steps N+1…N+k — fold them into one step") should have been applied during planning.
  Impact: added friction but no rework — the deviation was self-identified at execution time and the steps were combined.
  Self-identified.

#### What caused friction (user side)

- None observed.
