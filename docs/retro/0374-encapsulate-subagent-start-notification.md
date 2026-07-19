---
issue: 374
issue_title: "Encapsulate run start and notification attachment on Subagent"
---

# Retro: #374 — Encapsulate run start and notification attachment on Subagent

## Stage: Planning (2026-06-14T00:00:00Z)

### Session summary

Read issue #374 (Phase 17 Step 3 — output-argument encapsulation), loaded skills, explored `subagent.ts`, `subagent-manager.ts`, `notification-state.ts`, and all seven test files with external writes.
Produced a 4-step TDD plan in `packages/pi-subagents/docs/plans/0374-encapsulate-subagent-start-notification.md`.

### Observations

- The `notification` field was already constructor-wired in Phase 17 Step 2 (from `execution.parentSession?.toolCallId`); the remaining work is making both `promise` and `notification` externally read-only and updating the 7 + 3 test write sites.
- Steps 1 and 2 in the TDD order are effectively merged: introducing `private _promise` alongside the existing public `promise?` field is a TypeScript duplicate-identifier error, so the public field removal and all consumer updates must land in one atomic commit (`feat: make Subagent.promise read-only, add start() (#374)`).
- The status guard (`if (status !== "queued" && status !== "running")`) in `start()` allows foreground agents (constructed with `status: "running"`) to pass through cleanly, while stopping aborted-while-queued agents; this folds the inline guard out of the `SubagentManager` limiter callback.
- `service-adapter.test.ts` tests that set `record.promise = Promise.resolve()` only test that `toSubagentRecord()` strips the field — the setup is vestigial once `promise` becomes a getter; simply removing it is sufficient.
- The "waits for promise when wait=true" test in `get-result-tool.test.ts` needs a more realistic execution stub (`runTurnLoop` returning `{ responseText: "Finished after wait.", aborted: false, steered: false }`) so `record.start()` triggers the full run pipeline and calls `markCompleted()` internally.
- `TestSubagentOptions.toolCallId?: string` is the cleanest shorthand for the 5 test files that create passive records but need a `NotificationState`; it routes through `makeStubExecution({ parentSession: { toolCallId } })`, matching the production constructor path exactly.

## Stage: Implementation — TDD (2026-06-14T16:31:00Z)

### Session summary

Implemented all 4 plan steps in 2 substantive commits: one atomic `feat:` commit for `start()` + `promise`/`notification` read-only + all test site updates, and one `docs:` commit for the architecture doc.
Test count went from 975 to 981 (+6 new `start()` unit tests).
Pre-completion reviewer returned PASS with one WARN (stale test count in `package-pi-subagents` SKILL.md — fixed immediately).

### Observations

- Plan steps 1–3 landed in a single commit because making `notification` private required the same `subagent.ts` file as making `promise` private; splitting would have required complex partial staging.
- The `void record.start()` and `void this.limiter.schedule(...)` patterns were needed in `subagent-manager.ts` to satisfy `@typescript-eslint/no-floating-promises` — `start()` returns a `Promise<void>` but the manager stores the state internally; callers don't need to await it.
- The "waits for promise when wait=true" test in `get-result-tool.test.ts` required `void record.start()` (intentional fire-and-forget) for the same reason.
- Grep-verifiable outcome confirmed: `\.promise =` and `\.notification =` appear only inside `subagent.ts` (as `this._promise =` and `this._notification =`).
- Pre-completion reviewer: PASS (no FAIL findings; WARN on stale skill test count addressed inline).

## Stage: Final Retrospective (2026-06-14T17:30:00Z)

### Session summary

Shipped issue #374 (Phase 17 Step 3) cleanly across three stages: a planning session produced a 4-step plan, a TDD session implemented it in 2 substantive commits (test count 975 → 981), and a ship session pushed, verified CI, closed the issue, and released `pi-subagents-v16.2.0`.
No rework, no user corrections, no CI failures — the only mid-stream fixes were two self-identified lint adjustments inside the TDD session.

### Observations

#### What went well

- The cross-session retro bridge worked exactly as designed: the planning stage wrote three concrete breadcrumbs — steps 1+2 must merge (TypeScript duplicate-identifier), the `get-result-tool.test.ts` "waits for promise" test needs a realistic `runTurnLoop` stub, and `TestSubagentOptions.toolCallId` is the cleanest notification shorthand — and the TDD stage consumed all three directly without re-deriving them.
  This is the first time the breadcrumb-to-implementation handoff is visibly load-bearing rather than ceremonial.
- The grep-verifiable completion criterion (`\.promise =` and `\.notification =` appear only inside `subagent.ts`) gave an objective, one-command done-check (session turns 123–124) instead of a subjective "looks encapsulated."

#### What caused friction (agent side)

- `missing-context` — the plan did not anticipate that replacing `record.promise = record.run()` (assignment consumes the promise) with a bare `record.start()` call would trip `@typescript-eslint/no-floating-promises` at the two manager call sites and one test site.
  Self-identified via lint.
  Impact: two extra `void` edits (turns 106, 111) inside the same commit — no commit reorder, no rework beyond the fixups.
- `wrong-abstraction` (surfaced by operator pushback during the retro) — the `void this.limiter.schedule(() => record.start())` fix is safe but marks an unfinished design seam, not a tidy idiom.
  `run()`/`start()` carry a hard "always resolves, errors captured internally" contract, so `void` is the ESLint-sanctioned annotation (no unhandled-rejection risk).
  But the encapsulation regressed the promise-capture timing: before #374, `record.promise = this.limiter.schedule(...)` set the handle eagerly at spawn (even queued agents had `.promise`); after #374, `.promise` stays undefined until the limiter fires the thunk and `start()` runs, so promise ownership is now split between `Subagent._promise` and the limiter's internal completion handle (which the `void` discards).
  `waitForAll()` still worked only via `pendingPromises()`'s `null`-filter plus re-poll loop, so the in-code comment "a single `allSettled` covers the queued case" became inaccurate.
  This regressed Step 1's (#381) documented invariant "every spawned agent has a `promise` at spawn" — a cross-step regression within the same phase, not (as first claimed in this retro) work deferred to a future domain split.
  Corrected in a follow-up `fix:` (see the second retrospective stage below): `Subagent.scheduleVia(schedule)` captures the limiter promise eagerly inside the agent, restoring the invariant without reintroducing an external `.promise =` write.
  Impact: one follow-up `fix:` commit (+1 regression test, +2 `scheduleVia` unit tests).
- `wrong-abstraction` — the plan decomposed the work into 3 TDD steps (promise read-only, notification read-only, doc) but steps 1–3 collapsed into a single atomic commit because both fields live in `subagent.ts` and making each read-only is one type-level change.
  The planning retro half-anticipated this (it flagged steps 1+2 merging) but did not extend the reasoning to step 3.
  Impact: plan/reality granularity mismatch, documented as a deviation; no rework.

#### What caused friction (user side)

- None.
  User involvement was a single well-placed strategic decision (the batch-vs-release-now `ask_user` gate in the ship stage), not mechanical oversight.

### Diagnostic details

- **Model-performance correlation** — Planning and TDD ran on `claude-sonnet-4-6` (appropriate); the pre-completion reviewer subagent ran on its frontmatter default; the final retro ran on `claude-opus-4-8` (appropriate for judgment-heavy synthesis).
  The **ship stage ran on `opencode-go/deepseek-v4-flash`** — a weak model driving release management (interpreting the `UNSTABLE` merge state, the batch-vs-release decision, merging the release PR, closing the issue).
  It executed cleanly this time, but these are irreversible high-stakes operations; pinning a stronger model for `/ship-issue` would de-risk them.
- **Escalation-delay tracking** — no rabbit-holes; each lint failure resolved within 1–2 tool calls.
- **Unused-tool detection** — exploration used `cat`/`grep` via `bash` rather than the `Read` tool or `colgrep`; for finding exact `.promise =` write sites, grep is the correct choice (exact-pattern matching), so colgrep non-use was appropriate.
  The `cat`-via-`bash` habit (vs `Read`) added no harm here but bypasses structured-read benefits.
- **Feedback-loop gap analysis** — verification was incremental: affected-file tests after the first edits (turn 81), full suite + `check` + `lint` mid-cycle (turns 102–113), and the `fallow dead-code` gate before review.
  No end-only-verification gap.

### Follow-ups

1. The `start()` / limiter promise-ownership split was reclassified as a regression and **fixed** via `scheduleVia` (see the second retrospective stage), not deferred.

### Considered but not proposed

1. **Floating-promise ESLint rule** (proposed, then retracted on operator pushback): codifying "replace the assignment with `void record.start()`" as a `code-design` idiom would train reflexive lint suppression without checking the always-resolves contract.
   The `void` is correct here but signals unfinished domain work; the lesson lives in this retro, not in the skill.
2. **Pin a stronger model for `/ship-issue`**: an operator model-selection choice, not an `AGENTS.md`/prompt rule; noted in Diagnostic details for awareness.

### Changes made

1. `packages/pi-subagents/docs/retro/0374-encapsulate-subagent-start-notification.md` — added the Final Retrospective stage entry (session summary, friction points, diagnostic lenses, follow-ups); no skill or prompt edits landed (the sole proposal was retracted on operator pushback).

## Stage: Regression Correction — Process Retrospective (2026-06-14T18:00:00Z)

### Session summary

Operator pushback on the first retro's "`void` is safe, defer it" framing surfaced that #374 had **regressed a sibling step's invariant**: Step 1 (#381) guaranteed "every spawned agent has a `promise` at spawn," and #374's `void limiter.schedule(() => record.start())` made a queued agent's promise lazy.
Fixed via `Subagent.scheduleVia` (eager capture, control inverted so no external `.promise =` write returns) in commit `4f08c6c3` (+1 regression test, +2 unit tests; suite 981 → 982), then ran this process retrospective on how the regression slipped through plan, implementation, and review.

### How the regression happened (root-cause chain)

1. **Planning blind spot.**
   The #374 plan's acceptance criterion was grep-verifiable encapsulation (`\.promise =` only in `subagent.ts`).
   That measured the *goal* (hide the field) but never the *invariant at risk* (the field is an awaitable handle with an at-spawn timing contract that #381 established).
   The plan treated `promise` as a field to hide, not as a contract to preserve.
2. **Implementation masked the semantics.**
   Converting `record.promise = limiter.schedule(...)` to a bare `limiter.schedule(() => record.start())` tripped `no-floating-promises`; the reflexive `void` fix silenced the lint *and* discarded the eager handle in the same stroke.
   The lint fix was the exact site of the behavior change, which made it feel mechanical rather than semantic.
3. **No executable guard.**
   The #381 invariant lived only in an architecture-doc "Outcome:" bullet (prose).
   No test pinned "a queued agent has a `promise` at spawn," so the full suite stayed green through the regression.
4. **Review inherited the blind spot.**
   The pre-completion reviewer checks deterministic gates + the plan's acceptance criteria; since the criteria never named the cross-step invariant, criteria-driven review could not flag its loss.

The through-line: in a phased refactor, each step's "Outcome:" bullets establish invariants later steps inherit implicitly, and nothing converts those prose invariants into executable guards — so a later step regresses an earlier one with a green suite and a passing review.

### Observations

#### What caused friction (agent side)

- `missing-context` — the plan did not enumerate the invariants that prior Phase 17 steps had established on the shared `Subagent`/limiter surface, so the at-spawn-promise contract was invisible during both planning and implementation.
  Impact: a shipped regression (latent — `waitForAll` re-polls — but a real invariant break), caught only by operator pushback during the retro, requiring a follow-up `fix:`.
- `wrong-abstraction` — the proximate trigger was treating a `void` lint fix as mechanical.
  `void` on a promise-returning call discards whatever the promise carried (here: the eager capture handle); it deserves a semantic check, not a reflex.

#### What went well

- Operator pushback ("I'm sure that rule exists for a reason… are we heading toward a better design, or an awkward intermediary state?") was the single intervention that converted a rationalized smell into a found regression.
  This is the bidirectional-feedback ideal: a redirecting question, not a correction, that reframed the agent's own analysis.

### Diagnostic details

- **Feedback-loop gap analysis** — every gate (check, lint, test, fallow, pre-completion review) was green across #374; none could see the regression because the invariant was prose, never a test.
  The gap is upstream of the gates: the invariant was never made executable.

### Diagnostic details — model assignment

- Operator pushback also corrected a misconception: planning was assumed to run on Opus, but session turns 2–45 (`/plan-issue`) ran on `claude-sonnet-4-6`, and `.pi/prompts/plan-issue.md` had **no `model:` directive** — so planning silently inherited the session model.
  The judgment-heaviest, highest-leverage stage (where this regression originated) was running on an inherited, weaker model by default.
  Resolved by pinning `/plan-issue` and `/retro` to Opus via frontmatter (the `pi-prompt-template-model` extension was already loaded but unused for model selection).
  Caveat recorded: a stronger planner raises the odds of noticing an unstated invariant but is not a substitute for the explicit rule — the rule is the dependable fix, the model is a complementary lever.

### Proposals (all accepted and implemented)

1. `/plan-issue` prompt — "Invariants at risk" plan section: list prior phase steps' documented invariants (roadmap `Outcome:`/`Landed:` bullets) and pin each with a named test.
2. `code-design` skill (ESLint section) — "void on a promise-returning call" guard: before `void`-ing to silence `no-floating-promises`, confirm the discarded promise carried no semantics.
3. `pre-completion-reviewer` agent — new section `2h. Cross-step invariant preservation`: FAIL on a regressed prior-step invariant, WARN when an invariant holds but is pinned only by prose.
4. Model pinning — `/plan-issue` and `/retro` pinned to `anthropic/claude-opus-4-8`.

### Changes made

1. `packages/pi-subagents/src/lifecycle/subagent.ts` — added `scheduleVia(schedule)` (eager limiter-promise capture) and `guardedRun()` (shared abort-while-queued guard); `start()` now returns `void`.
2. `packages/pi-subagents/src/lifecycle/subagent-manager.ts` — `spawn()` queued path uses `record.scheduleVia(...)`; removed the `void` workarounds.
3. `packages/pi-subagents/test/lifecycle/subagent-manager.test.ts` — added regression test (queued agent has a `promise` at spawn).
4. `packages/pi-subagents/test/lifecycle/subagent.test.ts` — rewrote `start()` tests for the `void` return; added two `scheduleVia` unit tests.
5. `packages/pi-subagents/test/helpers/make-subagent.test.ts`, `packages/pi-subagents/test/tools/get-result-tool.test.ts` — updated for the `void`-returning `start()`.
6. `packages/pi-subagents/docs/architecture/architecture.md` — Step 3 `Landed`/`Correction` notes record the regression and `scheduleVia` fix.
7. `.pi/prompts/plan-issue.md` — added the "Invariants at risk" section and pinned `model: anthropic/claude-opus-4-8`.
8. `.pi/prompts/retro.md` — pinned `model: anthropic/claude-opus-4-8`.
9. `.pi/skills/code-design/SKILL.md` — added the "void on a promise-returning call" ESLint guard.
10. `.pi/agents/pre-completion-reviewer.md` — added section `2h`, its output block, and severity-model entries.
11. `AGENTS.md` — added cross-step invariant preservation to the reviewer's documented coverage.
12. The regression fix landed in commit `4f08c6c3` (`fix:`); these retro/process changes land in the `docs(retro):` commit.
