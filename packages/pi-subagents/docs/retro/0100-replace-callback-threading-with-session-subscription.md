---
issue: 100
issue_title: "Replace callback threading with direct session-event subscription"
---

# Retro: #100 — Replace callback threading with direct session-event subscription

## Final Retrospective (2026-05-20T22:30:00-04:00)

### Session summary

Implemented Step 3 of the AgentManager internal decomposition — replacing the 3-layer callback-threading pattern with two independent session observers (`subscribeRecordObserver` and `subscribeUIObserver`).
Five TDD cycles landed with only one unanticipated test breakage, releasing as `pi-subagents-v6.3.0`.
`SpawnOptions` dropped 5 `on*` fields, `RunOptions` dropped 5, and `ResumeOptions` dropped 3, with net −220 lines of source code removed.

### Observations

#### What went well

- The phased plan structure (extract observers → wire AgentManager → wire agent-tool → simplify runner) created clean isolation between cycles.
  Each cycle touched 1–2 source files and 1 test file, making changes easy to review.
- Upgrading `mockSession()` once in cycle 3 to support `subscribe()` and `emit()` was a one-time investment that made the stat-verification tests more realistic — events now drive record state instead of manually calling callbacks on `RunOptions`.
- The `resume()` simplification was particularly clean: 10 lines of callback wiring reduced to 2 lines (`subscribeRecordObserver` + `runner.resume` with only `{ signal }`).
- All 5 TDD cycles except one landed first-try with no rework.

#### What caused friction (agent side)

- `missing-context` — The plan listed `bindExtensions({ onError })` as part of the unchanged runner code, but the `onError` handler called `options.onToolActivity` which was removed in cycle 5.
  The plan said "grep for `ToolActivity`" but the reference was inside a function literal passed to `bindExtensions`, not a type import.
  Impact: one unexpected test failure in cycle 5 (`bindExtensions` test expected `onError`), caught immediately and fixed in the same commit.
  Noted in commit body as a plan deviation.

#### What caused friction (user side)

- No friction observed.
  The issue description was thorough and unambiguous, and the user's involvement was limited to triggering each phase (`/plan-issue`, `/tdd-plan`, `/ship-issue`).
