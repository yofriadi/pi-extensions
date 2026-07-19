---
issue: 230
issue_title: "Extract ConcurrencyQueue from AgentManager (Phase 15, Step 5)"
---

# Retro: #230 — Extract ConcurrencyQueue from AgentManager

## Stage: Planning (2026-05-28T20:00:00Z)

### Session summary

Produced a 3-step TDD plan for extracting the scheduling concern (3 fields, 3 methods) from `AgentManager` into a new `ConcurrencyQueue` class.
Both dependencies (#229 Agent.run(), #231 runner self-contained) are confirmed closed.

### Observations

- The issue's proposed API has `drain(start: (id: string) => void)` but also `markFinished()` as no-arg with "running--, drain()" semantics — a contradiction.
  Resolved by storing the `startAgent` callback at construction, making both `drain()` and `markFinished()` no-arg.
  This follows Tell-Don't-Ask and matches the established forward-reference-via-closure pattern already used for `onMaxConcurrentChanged`.
- `markFinished()` auto-drain changes the ordering from "decrement → observer → drain" to "decrement + drain → observer."
  Verified this is safe: observer notification only processes the completed agent and drain only starts promises without awaiting.
- `SettingsManager` does not change — only the callback wiring in `index.ts` changes target from `manager.notifyConcurrencyChanged()` to `queue.drain()`.
- The `agent.ts` `abort()` method has a comment referencing #230 that should be updated in the implementation step.

## Stage: Implementation — TDD (2026-05-28T21:35:00Z)

### Session summary

Implemented all 3 TDD steps: (1) `ConcurrencyQueue` class + 22 unit tests, (2) migrated `AgentManager` to use injected `ConcurrencyQueue` and updated `index.ts` wiring + test helper, (3) architecture docs and SKILL.md updates.
Test count delta: 1020 → 1042 (+22 new `ConcurrencyQueue` tests, 0 removed).

### Observations

- The `createManager` test helper required the forward-reference-via-closure pattern (`let mgr` then closure then assignment) with a `prefer-const` ESLint suppression — same pattern used in production `index.ts` for `onMaxConcurrentChanged`.
- Pre-completion reviewer returned WARN for one stale comment (`drainQueue` reference in `waitForAll`) — fixed by amending the docs commit.
- No plan deviations.
  All module-level changes matched the plan exactly.
- Pre-completion reviewer: WARN → fixed (stale comment).
