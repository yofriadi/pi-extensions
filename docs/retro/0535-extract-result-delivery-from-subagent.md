---
issue: 535
issue_title: "pi-subagents Phase 20 Step 1: extract result delivery from Subagent"
---

# Retro: #535 — pi-subagents Phase 20 Step 1: extract result delivery from Subagent

## Stage: Planning (2026-07-13T00:00:00Z)

### Session summary

Planned the extraction of the result-delivery domain out of the `Subagent` execution record.
The design dissolves `NotificationState`: `toolCallId` becomes a `Subagent.toolCallId` getter over `execution.parentSession`, and `resultConsumed` moves into `NotificationManager` as a `Set<string>` behind one tell operation, `consume(id)`, that also cancels the pending nudge.
Produced a three-step plan (prep getter → atomic core refactor → docs sync) filed at `docs/plans/0535-extract-result-delivery-from-subagent.md`.

### Observations

- The change is a clean Tell-Don't-Ask / Law-of-Demeter win: it collapses four `record.notification?.` reach-throughs (two in `get-result-tool`, one in the observer pre-check, one in `formatTaskNotification`) and a scattered two-object two-step reset (`markConsumed()` + `cancelNudge()`) into a single `notifications.consume(id)` tell.
- The core step is necessarily atomic — removing the `NotificationState` export and the `record.notification` surface breaks every importer and its tests at the type level in one commit — so the plan folds the manager change, both consumer updates, the file/interface deletions, and all consumer-test migrations into Step 2, with the `toolCallId` getter split out as a safe preparatory refactor (Step 1) to shrink it.
- The roadmap resolved the one design micro-decision (dissolve `NotificationState` into the manager vs. move it into the observation domain) explicitly toward the manager, so no `ask_user` gate was needed; the issue is the operator's own and refactor-only.
- Release is `mid-batch — defer`: Step 1 heads the `result-delivery` batch whose tail is Step 2 ([#536]); the `refactor:` commits cut no release on their own and batch into the next unhidden release.
- Preserved invariants flagged for the implementer: the "Bug 1" pre-await consumption ordering (pinned in `subagent-manager.test.ts`) and byte-identical `<task-notification>` XML (pinned by the `formatTaskNotification` tests).
- Found existing `notification-state.test.ts` and `notification.test.ts`; the former is deleted with the class, the latter gains manager-level `consume`/`consumed` coverage.

## Stage: Implementation — TDD (2026-07-13T00:00:00Z)

### Session summary

Implemented all three planned TDD steps: (1) added a `Subagent.toolCallId` getter and migrated `formatTaskNotification` to read it; (2) dissolved `NotificationState` entirely — `NotificationManager` now owns consumed-result state as a `Set<string>` behind one atomic `consume(id)` tell that adds to the set and cancels the pending nudge in a single call; (3) synced `docs/architecture/architecture.md` (class diagram, module tree, roadmap `✅` marker on Step 1) and `.pi/skills/package-pi-subagents/SKILL.md`.
Test count: 63 → 62 files (`notification-state.test.ts` deleted), 953 → 946 tests (net change from deleting redundant `NotificationState`-level tests and adding manager-level `consume`/`dispose` coverage).
Full monorepo `pnpm run check`, `pnpm run lint`, `pnpm run test`, and `pnpm fallow dead-code` all green; no lockfile changes.
Pre-completion reviewer: **PASS**.

### Observations

- **Design finding beyond the plan**: collapsing the old two-step reset (`markConsumed()` + `cancelNudge()`, called separately) into one atomic `consume(id)` tell doesn't just relocate the historical "Bug 1" race — it structurally eliminates it.
  The old design let code call `markConsumed()` without the paired `cancelNudge()`, leaving an armed timer; the new `consume(id)` always cancels the pending nudge as part of the same call, so that bug class is unrepresentable now (as long as `consume()` runs within the 200 ms nudge hold window).
  This meant the plan's "reproduces bug: consume() called after await" test (as literally specified) could no longer fail — rewrote it to pin both orderings (before and after awaiting) as passing invariants, with a comment explaining why post-await consumption is now also safe.
  The pre-completion reviewer independently hand-traced both rewritten tests against the real `NotificationManager`/`SubagentManager` wiring and confirmed the rewrite is a legitimate strengthening, not a coverage loss.
- The tidy-first-assessor found no preparatory refactoring needed — the plan's own Step 1 (lift `toolCallId` out first) already was the one legitimate tidy-first move, and Step 2's atomicity (the `NotificationState` deletion breaks every importer at once) argues against further splitting, not for it.
  It did flag two stale doc/title references to `NotificationState` outside the plan's file list (`test/helpers/make-subagent.ts`'s doc comment, and test titles in `background-spawner.test.ts` / `agent-tool.test.ts`) as "rejected as scope creep but directly caused by this change" — folded those one-line fixes into the Step 2 commit since they reference the deleted symbol.
- `NUDGE_HOLD_MS` (200 ms) is a load-bearing constant for the new `consume()`-after-await invariant: `consume()` only suppresses a nudge that hasn't fired yet, so any future increase to the hold window doesn't threaten correctness, but a *decrease* narrows the window in which `get-result-tool`'s post-await `consume()` call remains effective — worth a mental note if that constant ever moves.
- Session started with a `git pull --rebase` (not `--ff-only`) because a sibling worktree session was concurrently landing `pi-permission-system` work — confirmed with the operator before rebasing; the rebase was clean (2 local commits replayed onto new `origin/main`).
- Release remains `mid-batch — defer (batch "result-delivery")` per the plan; the release-please PR should stay open until Step 2 (#536) lands.

## Stage: Ship (worktree) (2026-07-14T03:11:43Z)

### Session summary

Pre-push checks passed clean: `pnpm run lint` (root) and `pnpm fallow dead-code` both succeeded with no findings; working tree had no lockfile drift.
The root will land via `/land-worktree 535`; the plan's `**Release:** mid-batch — defer (batch "result-delivery")` marker still applies — do not merge the release-please PR until Step 2 ([#536]) lands.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-535--/2026-07-14T01-13-22-838Z_019f5e2f-8e96-7cf5-b4b9-052ee1d0a14e.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No new findings at this stage — pre-completion review already ran PASS during the TDD stage.
Branch is about to be rebased onto `origin/main`; no conflicts expected (no other work has landed on `main` touching `packages/pi-subagents/` since this branch's baseline pull).

## Stage: Final Retrospective (2026-07-14T03:26:57Z)

### Session summary

Issue #535 (Phase 20 Step 1) landed cleanly through the parallel-worktree flow: planned on `claude-opus-4-8`, implemented via TDD on `claude-sonnet-5` in a peer worktree, then shipped by the peer and landed by the root.
The land session itself was textbook — sync `main`, ff-merge the peer branch, CI green, curated issue close, release correctly deferred per the plan's `mid-batch` marker, and worktree teardown, with no rework.
The standout across stages was a test-driven-**design** finding during TDD (see below).

### Observations

#### What went well

- **Textbook land** — the root `/land-worktree 535` ran end-to-end with zero corrections: ff-merge `c36307e7..87d30127`, CI `success`, issue closed with an implemented-in summary, release deferred per the plan's `**Release:** mid-batch — defer (batch "result-delivery")` marker, branch + worktree torn down.
- **Test-driven design win (novel)** — the plan's Step 2 specified a Red test that reproduces the historical "Bug 1" race by calling `markConsumed()` without the paired `cancelNudge()`.
  The new atomic `consume(id)` tell always cancels the pending nudge, so that test could no longer fail — the refactor made the bug *unrepresentable*, not merely reordered.
  The implementer (on sonnet) recognized this mid-cycle, rewrote the block to pin both orderings (consume before and after awaiting) as passing invariants, and the pre-completion reviewer independently hand-traced the rewrite against the real wiring and confirmed it a legitimate strengthening.
  This is the desirable shape of "a planned Red test can't go red" — treat it as a design signal, not a test to force-fail.
- **Release discipline** — the `mid-batch — defer` marker was honored at every stage (plan, TDD retro, ship breadcrumb, land), so the `result-delivery` batch stays open for Step 2 ([#536]) with no premature release.

#### What caused friction (agent side)

- `missing-context` (template gap) — `/tdd-plan`'s "Sync with remote" step is trunk-only (`git pull --ff-only`, stop on any failure).
  Run in the peer worktree after a sibling had landed `pi-permission-system` on `origin/main`, it hard-stopped on the *expected* divergence (peer turns 26–27), requiring an operator round-trip ("we're simultaneously developing pi-permission-system … `git pull --rebase`").
  The agent correctly followed the stop rule — the gap is the trunk-oriented template, which (unlike `/retro` and `/ship-worktree`) has no worktree-branch branch.
  Impact: one hard-stop + operator clarification; no rework.
- `other` (environment/tooling) — during `/ship-worktree`, `set_session_name` and the session-transcript-path capture command repeatedly stalled as `pending` (peer turns 140–160).
  On each "we should be good to ship" resume nudge the agent restarted from the pre-push checks, re-running `pnpm run lint` and `pnpm fallow dead-code` ~3 times on an already-green tree.
  Impact: redundant expensive re-runs; no rework.
  The transcript-path capture is optional (the root can recover it via `list_session_files`), so a stall there need not gate re-running the pre-push gates.

#### What caused friction (user side)

- The parallel-development context (`pi-permission-system` landing concurrently) surfaced only *after* the `/tdd-plan` sync hard-stop.
  Sharing it at worktree launch would have pre-empted the stop — but this is inherent to parallel work and the stop-then-clarify was low-cost.
  Framed as opportunity, not criticism.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `anthropic/claude-opus-4-8` (judgment-heavy design/decomposition — appropriate); TDD ran on `anthropic/claude-sonnet-5` (mechanical red→green→commit, with the one design finding handled well — appropriate).
  Subagents `tidy-first-assessor` and `pre-completion-reviewer` were dispatched during TDD; both read-only judgment tasks with no observed mismatch.
- **Feedback-loop gap analysis** — Verification ran incrementally: per-step `vitest run <file>`, `pnpm run check` before commits on type-changing steps, plus the full end gates (`test`/`check`/`lint`/`fallow`).
  Good cadence; the only anomaly was the ship-stage redundant re-runs from the tooling stall, which is not a feedback-loop gap.
- **Escalation-delay tracking** — No rabbit-hole exceeded 5 consecutive calls on one error; the sync hard-stop resolved in a single operator round-trip.

### Changes made

1. `.pi/prompts/tdd-plan.md` — made the "Sync with remote" step worktree-aware: on an `issue-*` branch, `git fetch origin` and proceed (a diverged `origin/main` is expected; `/ship-worktree` owns the rebase); `git pull --ff-only` and stop-on-failure now apply only on `main`.
2. `.pi/prompts/build-plan.md` — the same worktree-aware sync change, for parity.
3. `.pi/prompts/ship-worktree.md` — noted that the peer transcript-path capture (step 3.2) is optional and that a stall there must not trigger re-running the already-green pre-push gates; the root recovers the path via `list_session_files`.

[#536]: https://github.com/gotgenes/pi-packages/issues/536
