---
issue: 420
issue_title: "pi-subagents: fold subagent run metrics and live activity onto the core record"
---

# Retro: #420 — pi-subagents: fold subagent run metrics and live activity onto the core record

## Stage: Planning (2026-06-17T00:00:00Z)

### Session summary

Produced a 3-step TDD plan (`docs/plans/0420-fold-run-metrics-live-activity-onto-record.md`) for Phase 18 Step 1: fold `turnCount`, active tools, and response text onto `SubagentState`, have `record-observer` populate them, and expose read-only getters on `Subagent`.
The change is a pure addition / tidy-first — both observers keep running and no consumer reads the new getters until Step 2 ([#421]).
Operator-authored, unambiguous proposal matching the architecture roadmap, so the `ask-user` gate was skipped.

### Observations

- The `maxTurns` getter is the one getter that does **not** delegate to `SubagentState` — it delegates to `this.execution.maxTurns`.
  Verified both spawners pass `execution.effectiveMaxTurns` as `options.maxTurns` (threaded into `SubagentExecution.maxTurns` by `SubagentManager.spawn`), so the record getter returns the same value `AgentActivityTracker` was constructed with.
- Semantics must be copied field-for-field from `AgentActivityTracker` so Step 2's reader swap is behavior-preserving: `turnCount` starts at **1** (readers assume the at-least-1 invariant — `notification.ts` uses `?? 0`, `result-renderer.ts` gates on `> 0`); `activeTools` uses `name_seq` keying for concurrent same-name tools; `removeActiveTool` deletes the first match; `responseText` resets at `message_start` and appends each text delta.
- Decided to leave `resetForResume` **unchanged** (the new fields are not reset on resume).
  Rationale: the tracker is not reconstructed/reset on resume today, so the surviving `SubagentState` accumulating across a resume preserves parity.
  Touching it would violate the pure-addition contract; flagged in Open Questions for Step 2 to revisit against observable reader behavior.
- The tracker's `_session`/`setSession` is deliberately **not** folded — it exists only for UI polling reads and is migrated/removed in Steps 2–3.
- No symbol is removed or renamed, so no `package-pi-subagents` SKILL or architecture-doc prose update is needed; the Phase 18 Step 1 roadmap entry already describes this work.

[#421]: https://github.com/gotgenes/pi-packages/issues/421

## Stage: Implementation — TDD (2026-06-17T13:10:00Z)

### Session summary

Executed all 3 TDD steps from the plan: (1) added `turnCount`/`activeTools`/`responseText` fields plus 5 transition methods to `SubagentState`; (2) extended `record-observer` with 4 new event branches (`tool_execution_start`, `turn_end`, `message_start`, `message_update` text_delta) plus paired `removeActiveTool` on `tool_execution_end`; (3) added 4 read-only getters to `Subagent` (`turnCount`, `activeTools`, `responseText`, `maxTurns`).
Test count: 1031 → 1058 (+27 across 3 test files).
Full suite green; type check and lint clean; zero dead code.

### Observations

- The first pre-completion reviewer run returned **FAIL** due to 3 pre-existing `MD051` broken-fragment links in `docs/architecture/history/phase-17-core-consolidation.md` (fragment `#first-principles-refinement-the-deeper-target` was missing `-and-`; correct anchor is `#first-principles-refinement-and-the-deeper-target`).
  Fixed in a separate `docs:` commit; re-run returned **WARN**.
- 3 Biome `useTemplate` infos in `packages/pi-permission-system/` are informational only (marked unsafe fix, `biome check --write` skips them) and do not cause a non-zero lint exit.
- The 3 "vacuously-passing" new observer tests (paired `tool_execution_end` removal, `message_start` reset, non-text_delta ignore) pass before the observer handles the events because the state starts in the default/empty state — they correctly verify absence-of-mutation and fully exercise the code path after the observer is implemented.
- WARN finding: `package-pi-subagents` SKILL.md `Observation` domain row description ("Session-event stats") is now slightly incomplete for `record-observer` (it also accumulates live-activity fields).
  Intentionally deferred per the planning-stage decision — no symbol removed, and the description will be updated in Step 2 ([#421]) when the observer's role is fully defined after the reader migration.
- Pre-completion reviewer verdict: **WARN** (one non-blocking finding, deferred per retro).

## Stage: Final Retrospective (2026-06-17T17:40:39Z)

### Session summary

Shipped Phase 18 Step 1 across planning, TDD (3 red→green→commit cycles, +27 tests), and release (`pi-subagents` v16.5.0).
The code work was clean and rework-free; all friction was in markdown-lint surfacing late — two separate doc-lint failures (one pre-existing, one introduced) escaped the baseline and post-TDD gates and were caught only by the pre-completion reviewer and the ship-stage lint, each requiring a fix commit.

### Observations

#### What went well

- The `pre-completion-reviewer` safety net earned its keep: it caught the pre-existing `MD051` broken-fragment links in `phase-17-core-consolidation.md` (introduced earlier by `e4d92535`, unrelated to this issue) before the push, returning FAIL on the first run.
  Without it the broken links would have shipped.
- TDD execution was textbook: each of the 3 steps followed red→green→commit with no rework to production code, the `maxTurns`-via-`execution` delegation decision from planning held, and the "vacuously-passing" observer tests (verified in the retro) correctly converted to real assertions once the observer was implemented.

#### What caused friction (agent side)

- `instruction-violation` (gate-caught, at ship) — wrote a second `[#421]:` link-reference definition into the retro file when appending the TDD stage entry via `Write` full-content, tripping `MD053` (duplicate definition).
  The `markdown-conventions` skill states this rule verbatim ("Link reference definitions are file-scoped … a duplicate trips MD053").
  Impact: one fix commit at ship time (`80d4d050`), caught by the root `pnpm run lint` pre-push gate rather than during TDD (no lint runs after stage-notes writing).
- `missing-context` (self-identified during ship investigation) — the TDD green-baseline lint was run package-scoped (`pnpm --filter @gotgenes/pi-subagents run lint`), which **silently passes** on `MD051` cross-file fragment failures.
  Verified empirically: package `lint:md` (`rumdl check *.md docs/**/*.md`) returns "No issues" on the broken fragment, while root `rumdl check .` exits 1 on it — the cross-file fragment target (`../architecture.md`) is only resolved on a repo-root tree walk.
  Impact: the pre-existing `MD051` failure slipped past the baseline gate (whose job is to catch exactly that) and surfaced mid-TDD via the reviewer, costing a fix commit (`86ed0c81`) and a reviewer FAIL/re-dispatch cycle.

#### What caused friction (user side)

- None.
  The session ran end-to-end without user correction; the operator-authored, roadmap-aligned issue meant no clarification was needed.

### Diagnostic details

- **Model-performance correlation** — two `pre-completion-reviewer` subagent dispatches ran on the agent's configured reviewer model and performed judgment-heavy review work (acceptance criteria, design review, cross-step invariants); appropriate match.
  No high-cost model was spent on mechanical work and no reasoning-weak model on judgment work.
- **Feedback-loop gap analysis** — the lint feedback loop fired at the wrong scope and the wrong time: package-scoped at baseline (missed `MD051`), and absent after retro stage-notes writing (missed `MD053` until ship).
  `pnpm run check` and `pnpm run test` were run incrementally per step and caught everything they should; only the markdown-lint loop was misconfigured.
- **Escalation-delay / unused-tool** — no `rabbit-hole` friction; no lens-2 or lens-3 findings.

### Changes made

1. `.pi/prompts/tdd-plan.md` — "Verify green baseline" step 2 and "After the last TDD step" step 3 now specify `pnpm run lint` runs **from the repo root**, with a one-clause rationale that package-scoped lint silently passes on `MD051` cross-file fragments and cross-package issues (Proposal 1).
2. Proposal 2 (an `MD053` duplicate-link-definition reminder in the retro-writing prompts) was declined — the rule already exists verbatim in the `markdown-conventions` skill, so a prompt clause would duplicate it.
3. Follow-up (post-retro): `#420` completed Phase 18 Step 1 but the roadmap Steps section was not marked done until the operator noticed.
   Added a roadmap-step-status check so this is caught going forward: a WARN bullet in `pre-completion-reviewer.md` §2c (backstop), and a proactive step in `.pi/prompts/tdd-plan.md` step 7 and `.pi/prompts/build-plan.md` "After the last step" — mark the completed roadmap step done (`✅`/`Landed:`) and update the phase status row.
   Also marked Step 1 complete in `architecture.md` (Steps list, dependency diagram node, phase table row → "In progress").
