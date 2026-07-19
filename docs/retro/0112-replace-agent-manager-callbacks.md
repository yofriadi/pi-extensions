---
issue: 112
issue_title: "refactor(pi-subagents): replace AgentManager callbacks with observer interface"
---

# Retro: #112 — replace AgentManager callbacks with observer interface

## Final Retrospective (2026-05-21T21:00:00-04:00)

### Session summary

Replaced three fire-and-forget callback fields (`onStart`, `onComplete`, `onCompact`) on `AgentManagerOptions` with a single `AgentManagerObserver` interface.
The refactoring touched `agent-manager.ts`, `index.ts`, and `agent-manager.test.ts` with zero test-count delta (652/652).
Released as `pi-subagents-v6.8.2`.

### Observations

#### What went well

- The issue description was thorough and unambiguous — no `ask_user` needed during planning, and the design mapped directly to implementation.
- Self-identified the testing skill's single-call-site rule during execution: the plan split Steps 2 and 3 into separate commits, but `AgentManagerOptions` has one call site in `index.ts`, so both had to land together.
  Merged them without rework.
- Pre-existing lint issue (unused `ExecutionState` import in `agent-manager.ts`) caught and fixed proactively during the lint step.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — The plan wrote TDD Steps 2 and 3 as separate commits, but the testing skill says "when a TDD step changes an interface that has a single call site, the step must include updating that call site."
  The planning phase loaded the testing skill but didn't apply this specific rule when structuring the TDD order.
  Impact: added friction but no rework — caught during execution when `pnpm run check` surfaced the expected type error in `index.ts` after Step 2.
- `other` (tool interaction) — One `Edit` tool `oldText` match failure in `agent-manager.ts` because the selected block included a blank line that didn't exist between `subscribeRecordObserver` and `options.onSessionCreated`.
  Impact: one extra read + edit cycle (~30 seconds).

#### What caused friction (user side)

- Nothing — the session ran without user corrections or redirections.
