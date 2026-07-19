---
issue: 98
issue_title: "Extract AgentRecord state machine from scattered status transitions"
---

# Retro: #98 — Extract AgentRecord state machine

## Final Retrospective (2026-05-20T23:45:00Z)

### Session summary

Converted `AgentRecord` from a plain interface to a class with 7 encapsulated transition methods, centralizing the scattered status-transition logic from 6 locations in `agent-manager.ts`.
The prerequisite issue #102 (shared test factory) made the class conversion a 2-file change instead of an 8-file rewrite.
Released as `pi-subagents-v6.1.0`.

### Observations

#### What went well

- The "encapsulate last" TDD strategy (cycles 1–5 with public fields, cycle 6 makes them private) let the compiler verify migration completeness before locking down access.
  `get-result-tool.test.ts` and `make-record.test.ts` failures were caught immediately.
- The worktree-reorder design insight (compute final result including branch text before calling the transition method) avoided the need for an `appendToResult()` method and survived implementation unchanged.
- The prerequisite issue #102 (shared `createTestRecord` factory) proved essential — the class conversion touched only the factory and `agent-manager.ts`, not 8 individual test files.

#### What caused friction (agent side)

- `premature-convergence` — The initial plan proposed `MutableAgentRecord` alongside the existing interface, which was the lowest-friction path but the wrong abstraction.
  The user redirected twice ("It should definitely become a class" → "I meant encapsulate") before the design was right.
  Impact: full plan rewrite and an extra prerequisite issue (#102).
  The plan template's "use ask-user for ambiguous design choices" instruction applied (class vs wrapper was genuinely ambiguous), but I didn't invoke it.

- `missing-context` — The revised plan stated "No test files need updating (except the shared factory)" but missed `{ ...baseRecord, field }` spread patterns in `test/notification.test.ts`, `test/service-adapter.test.ts`, `test/tools/get-result-tool.test.ts`, and `test/helpers/make-record.test.ts`.
  Spreading a class instance produces a plain object that lacks the class's methods.
  Impact: 4 extra test files needed mechanical fixes in cycles 4 and 6; plan's "Unchanged files" list was wrong.
  The compiler caught all of them, so no behavioral risk, but the plan should have predicted the churn.

#### What caused friction (user side)

- The issue body was intentionally flexible ("onto AgentRecord (or a thin wrapper)"), which left the wrapper-vs-class decision open.
  The user's preference for a class with encapsulated state became clear only after seeing the initial plan.
  Earlier signal (e.g., labeling the issue with a "class conversion" tag or stating "must encapsulate" in the issue body) would have avoided the plan rewrite.

### Changes made

1. `.pi/skills/testing/SKILL.md` — Added interface→class spread-pattern rule to TDD planning rules.
2. `.pi/skills/package-pi-subagents/SKILL.md` — Added `agent-record.ts` to the Core engine module table and updated `types.ts` description.
