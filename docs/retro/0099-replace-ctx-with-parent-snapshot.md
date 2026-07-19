---
issue: 99
issue_title: "Replace live `ctx` capture with ParentSnapshot in AgentManager"
---

# Retro: #99 — Replace live ctx capture with ParentSnapshot

## Final Retrospective (2026-05-20T20:30:00-04:00)

### Session summary

Implemented the `ParentSnapshot` extraction — Step 2 of the AgentManager internal decomposition.
The user prompted a mid-planning restructure using Kent Beck's "make the change that makes the change easy" principle, which split the work into two clean phases: pi-elimination prep (cycles 1–2), then snapshot introduction (cycles 3–5).
All 5 cycles landed first-try with no rework, releasing as `pi-subagents-v6.2.0`.

### Observations

#### What went well

- The two-phase plan structure (prep then payload) kept each cycle focused on one concern.
  Cycle 5 was particularly clean — only 2 files changed because `buildParentSnapshot` was mocked in agent-manager tests.
- `sed` for mechanical bulk replacements (27 `spawn(mockPi,` → `spawn(mockCtx,`) was the right tool — faster and less error-prone than 27 individual edits.
- The `pnpm run check` after cycle 4 caught exactly the expected type error in `agent-manager.ts`, confirming the incremental approach was working as designed.

#### What caused friction (agent side)

- `wrong-abstraction` — Initial plan (before user intervention) interleaved pi-elimination and snapshot concerns across all 5 cycles.
  The user had to invoke Kent Beck's principle to trigger the restructure.
  Impact: one plan rewrite (amend commit), but no implementation rework since it happened before coding started.

- `missing-context` — Used `Parameters<typeof createAgentSession>[0]["modelRegistry"]` as a type cast without checking that the SDK's `createAgentSession` parameter type is a union including `undefined`.
  Impact: minimal — caught immediately by `pnpm run check`, fixed with a simple `as any` in the same cycle.

#### What caused friction (user side)

- The user's "make the change easy" prompt was well-timed — after the plan was written but before implementation.
  No suggestions for improvement here; the intervention was strategic and well-placed.
