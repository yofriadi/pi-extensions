---
issue: 118
issue_title: "refactor(pi-subagents): SettingsManager apply methods — eliminate cross-collaborator orchestration"
---

# Retro: #118 — SettingsManager apply methods

## Final Retrospective (2026-05-21T21:00:00Z)

### Session summary

Planned and implemented 3 `apply*` methods on `SettingsManager` (`applyMaxConcurrent`, `applyDefaultMaxTurns`, `applyGraceTurns`) across 5 TDD cycles plus doc updates, released as `pi-subagents-v6.6.0`.
Each method owns the full consequence chain (normalize → set → callback → persist → emit → return toast), eliminating the LoD/Tell-Don't-Ask violation in `showSettings` that was identified during the #109 retro.
`notifyConcurrencyChanged` was removed from `AgentMenuManager`; the menu no longer coordinates between settings and the agent manager.

### Observations

#### What went well

- **Retro-driven improvement validated.**
  Issue #118 was filed during the #109 retro as a LoD/Tell-Don't-Ask follow-up, and the plan-issue prompt's consumer call-site sketch heuristic (added in #109's retro) was already in the plan template.
  The plan for #118 included concrete before/after call-site sketches that made the design unambiguous — no `ask-user` decision needed.
- **Interface-then-wiring TDD order worked cleanly.**
  The #109 retro noted that interface changes propagate to `index.ts` immediately, forcing unplanned bridge edits.
  This time the plan accounted for it: Cycle 4 committed only menu files (leaving a known `index.ts` type error), and Cycle 5 fixed the wiring in a separate commit.
  The intermediate type error was contained and expected.
- **`defaultMaxTurns` branch consolidation.**
  During Cycle 4, the separate `n === 0` and `n >= 1` branches in `showSettings` were consolidated to a single `n >= 0` check, since `applyDefaultMaxTurns` handles the 0→unlimited mapping internally.
  This was a minor but correct simplification that emerged naturally from the Tell-Don't-Ask refactor.

#### What caused friction (agent side)

- No material friction.
  All 5 TDD cycles completed without rework, failed edits, or unexpected test failures.
  The plan was tight and the issue's "Proposed change" section was unambiguous.

#### What caused friction (user side)

- No material friction observed.
  The session ran end-to-end (plan → implement → ship → release) without user intervention.
