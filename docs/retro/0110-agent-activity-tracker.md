---
issue: 110
issue_title: "refactor(pi-subagents): wrap AgentActivity in AgentActivityTracker class"
---

# Retro: #110 — wrap AgentActivity in AgentActivityTracker class

## Final Retrospective (2026-05-21T23:30:00Z)

### Session summary

Planned and implemented `AgentActivityTracker` class across 6 TDD cycles plus doc updates, released as `pi-subagents-v6.7.0`.
The 7-field mutable `AgentActivity` interface was replaced with a class exposing explicit transition methods (`onToolStart`, `onToolEnd`, `onMessageStart`, `onMessageUpdate`, `onTurnEnd`, `onUsageUpdate`, `setSession`) and read-only accessors.
All 7 source files and 3 test files were migrated incrementally without any big-bang commit.

### Observations

#### What went well

- **TDD Red phase caught all three implementation bugs.**
  1. `onToolEnd` initially incremented `toolUses` unconditionally (ported from original code), but the plan specified no-op defensive behavior.
     The Red phase test `"onToolEnd with no matching tool is a no-op"` caught it instantly.
  2. `Date.now()` key collision in `activeTools` Map — two `onToolStart("Read")` calls in the same millisecond produced identical keys, so the second overwrote the first.
     The Red phase test `"multiple concurrent tools with same name tracked independently"` caught it.
  3. `describeActivity` signature needed `ReadonlyMap<string, string>` after the accessor change — caught by `pnpm run check` in step 3.
  All three were fixed immediately with no cascading rework.
- **Incremental migration avoided type breakage.**
  The plan kept `AgentActivity` alive in `agent-widget.ts` until step 3, so steps 1–2 compiled without touching downstream files.
  Each step only broke the files it was about to migrate, keeping intermediate states valid.
- **Monotonic counter is strictly better than `Date.now()` for tool keys.**
  The extraction enabled replacing the `toolName + "_" + Date.now()` key strategy with `toolName + "_" + (++this._toolKeySeq)`, which never collides regardless of timing.
  This is a concrete improvement the original inline code couldn't easily adopt.

#### What caused friction (agent side)

- `missing-context` — The plan specified the `Date.now()` key strategy from the original code, but didn't account for same-millisecond collisions in test execution.
  Impact: ~1 minute debugging in step 1; trivial fix to monotonic counter.
- `premature-convergence` — Initial `onToolEnd` implementation copied the original's unconditional `toolUses++` before checking the plan's specified no-op behavior.
  Impact: caught immediately by the Red phase test, single-line fix.

#### What caused friction (user side)

- No material friction observed.
  The session ran end-to-end (plan → implement → ship → release) without user intervention.
