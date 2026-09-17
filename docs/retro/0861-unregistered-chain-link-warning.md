---
issue: 861
issue_title: "pi-permission-system: a locally-adjudicating child silently skips a configured chain link whose provider is excluded"
---

# Retro: #861 — a locally-adjudicating child silently skips a configured chain link whose provider is excluded

## Stage: Planning (2026-09-16T05:29:00Z)

### Session summary

Planned the fix for the silence around a skipped `authorizerChain` link: a new `AuthorizerChainAudit` in `src/authority/`, modelled on [#792]'s `ChildNodeAudit`, that owns both the existing per-ask `authorizer_chain_unregistered_link` review entry and a new visible warning latched once per session per link name.
The operator confirmed three decisions at the clarification gate — report at the first ask that skips (not at turn prep, not in `/permission-system show`), name all three causes unbranched, and latch per name.
The plan is `packages/pi-permission-system/docs/plans/0861-unregistered-chain-link-warning.md`, with four steps: a Tidy-First type extraction, the unwired audit module, the wiring `fix:`, and the docs commit.

### Observations

- The issue's resolution (the skip stays; no link inheritance across a node boundary) was never in question — ADR 0012 decision 1, ADR 0007 §7, and the `fact-shaping inheritance stops at live authority` composition-root test all converge on it.
  The whole design question was the reporting surface.
- Measured the defect in the operator's own review log rather than arguing it: **48 genuine `authorizer_chain_unregistered_link` events across 13 days**, all naming `model-judge`.
  Two traps in that measurement, both worth repeating — a raw `grep -c` reports 54 because the string appears inside a logged `bash` heredoc, and 44 of the 48 predate the `requestId` field, so a `requestId`-keyed scan under-counts them (the schema-drift hazard the package skill names).
- Two facts settled the option set and neither was inferable from the issue.
  First, an `Explore` trace of the Pi checkout established that `ctx.ui.notify(msg, "warning")` appends durably to `chatContainer` (scrollback), and that the permission dialog's `ui.select` swaps the editor area rather than compositing an overlay — so a warning emitted immediately before the prompt cannot be covered by it.
  That refuted the main UX objection to reporting at the ask.
  Second, `pi-permission-model-judge`'s ready handler opens with `if (dispose || !config) return;` — a session with no provider config *deliberately* registers nothing — so an absent link is not always the operator contradiction the issue frames it as, and the message had to admit three causes instead of two.
- Rejected turn-prep reporting on a citable ground rather than taste: ADR 0007 §4 only requires a link to register *before the session's first ask*, so a prep-time check is a prediction that can falsely accuse a conforming async registrar.
  Reporting at the skip reports a fact.
- Accepted two residuals rather than filing them, because the mechanisms that would cover them were put to the operator and declined: a headless locally-adjudicating node gets no visible warning (`noOpUIContext.notify` is literally `() => {}`), and a session where no ask ever escalates (notably under `yoloMode`) never learns its chain is broken.
- The Tidy-First assessor returned one recommendation (name the anonymous constructor-deps intersection that `test/helpers/authorizer-fixtures.ts` hand-copies, so step 3 adds its field once instead of twice) and one useful correction: the new audit's tests should use `makeLogger()` from `session-fixtures.ts`, since `makeAuthorizerLog()` returns no `warn`.
  It also flagged that `test/composition-root.test.ts` already asserts on `authorizer_chain_unregistered_link` in a block that drives this issue's exact scenario end to end — the natural place to pin the wiring.
- The assessor explicitly rejected a shared base with `ChildNodeAudit`: the two latch differently (per instance vs. per name) because their cause sets have different bounds, and a shared base would need a strategy parameter existing only to hide that.
  Recorded in the plan as a deliberate duplication.

#### Deferred tidyings

- `packages/pi-permission-system/test/helpers/authorizer-log-fixtures.ts` — `makeAuthorizerLog()`'s docstring claims its `{ review, debug }` return "structurally satisfies the session logger", but `SessionLogger` also requires `warn`.
  Rejected as out of scope: the file is not a target of this change.
- `packages/pi-permission-system/test/authority/authorizer-selection.test.ts` — the flat `describe("chain resolution")` block holds ~10 sibling `it`s; a nested `describe("unregistered configured links")` would group the ones this change touches.
  Cosmetic rather than change-shrinking, so left out.

## Stage: Implementation — TDD (2026-09-16T16:09:39Z)

### Session summary

Four TDD cycles, all as planned: the Tidy-First extraction of `AuthorizerSelectionConstructorDeps`, the unwired `AuthorizerChainAudit` module, the wiring `fix:`, and the docs commit.
The `pi-permission-system` suite went from 4337 to 4346 tests (+9: 8 in the new `test/authority/authorizer-chain-audit.test.ts`, 1 new selection test; two existing selection tests and one composition-root block migrated their assertions rather than being added).
Pre-completion reviewer returned WARN on one stale comment, which was fixed, and PASS on the delta re-review.

### Observations

- No deviations from the plan's design or module list.
  Every file the plan named was touched, and every file it predicted unchanged (`README.md`, ADR 0007, `config-schema.ts`, `schemas/permissions.schema.json`) stayed unchanged.
- The plan named three killing mutations for the audit module and three for the wiring step, and every one killed exactly the predicted equivalence class and no more — 1, 1, 1 for the audit (latch guarding the review write, guard never firing, boolean latch in place of the per-name `Set`) and 3, 1, 2 for the wiring.
- The wiring step's relaying-node test (`does not report an unregistrable link as an unregistered one`) **stayed green through Red**, which is the case the template flags: a deliberate regression pin and a vacuous probe look identical there.
  Its mutation — hoisting the audit call above `linksFor`'s `adjudicatesLocally` early return — reddened it alone, so it discriminates.
- One planned mutation was substituted.
  "Construct the audit inside the constructor instead of injecting it" does not compile (`deps.logger` is a `DebugReviewLogger` with no `warn`) and at run time would crash on an undefined method, which the template warns is not a discrimination signal.
  Replaced with a payload mutation (a constant `requestId` in the relayed `UnregisteredLink`), which reddened the two assertions that pin the payload.
- The `Edit` tool's first attempt used a hand-built absolute path missing the worktree prefix, and `pi-permission-model-judge` denied it with the corrected location — the `external_directory` gate catching exactly the typo class ADR 0007 use case 1 describes.
  Repo-relative paths avoid it, as `AGENTS.md` says.
- Reviewer WARN: the `fact-shaping inheritance stops at live authority` block in `test/composition-root.test.ts` still called the skip's loudness an open question, in the very block the change modified to pin the warning.
  The plan's grep sweep covered `src/`, `test/`, docs, and `.pi/skills/` for `authorizer_chain_unregistered_link` and `861`, and this line matches the second pattern — it was in the sweep's output at planning time and did not make it into the plan's file list.
  Worth remembering that a sweep's *output* and the plan's *list* are different artifacts.
- Both invariants the reviewer was asked to re-derive held under independent derivation: `auditUnregisteredLink` has exactly one call site, reachable only through `linksFor`'s locally-adjudicating branch (including via `ForwardedRequestServer`, which escalates on a serving node), and the review record's event name, field set, field order, and per-ask cadence are identical to the pre-change inline write.

## Stage: Sync (worktree) (2026-09-16T16:34:18Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) both passed clean with no fixes needed.
The plan's `**Release:** ship independently` marker stands — nothing to defer, no batch to join.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-861--/2026-09-16T04-47-38-631Z_01a0a88a-b887-7300-83e9-fe6b2eccb196.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No deferred work.
The TDD stage's one reviewer WARN was fixed and re-reviewed to PASS before this sync; nothing carries forward.

## Stage: Final Retrospective (2026-09-16T16:43:28Z)

### Session summary

Shipped #861 through the worktree lane: fast-forward-merged `issue-861-pi-permission-system-a-locally-adjudicat` into `main`, ran the pre-push gates, pushed, verified CI, closed the issue, dispatched and verified the release (`pi-permission-system-v32.0.5`), and tore down the worktree.
The whole four-stage arc — planning, TDD, sync, ship — ran without a single operator correction, and the ship half took 36 tool calls with zero rework.

### Observations

#### What went well

- The planning session's measurement of the defect **iterated until it was right**, and the two traps it caught are the novel part.
  A raw `grep -c` on the review log reported 54 `authorizer_chain_unregistered_link` hits; six were the string appearing inside a logged `bash` heredoc, leaving 48 genuine events.
  And 44 of the 48 predate the `requestId` field, so the natural `requestId`-keyed dedup under-counted them.
  Four tool calls (planning turns 25–28) turned a plausible-looking number into a defensible one, and the 48-events-across-13-days figure is what grounded the whole gate.
- The TDD session **substituted a planned killing mutation on a reasoned ground** rather than either skipping it or forcing it.
  The plan named "construct the audit inside the constructor instead of injecting it"; that does not compile (`deps.logger` is a `DebugReviewLogger` with no `warn`) and at run time would crash, which `/tdd-plan` explicitly warns is not a discrimination signal.
  It was replaced with a payload mutation (a constant `requestId` in the relayed `UnregisteredLink`), which reddened the two assertions that pin the payload.
- `/tdd-plan`'s "a new test stayed green during Red" case fired for real and was handled as designed.
  The relaying-node test (`does not report an unregistrable link as an unregistered one`) never went red, so Red produced no evidence it discriminates; hoisting the audit call above `linksFor`'s `adjudicatesLocally` early return reddened it alone and proved it does.
- Every mutation cycle used the `cp <file> /tmp/green-*.ts` save/restore discipline rather than `git checkout -- <file>`, which would have discarded the step's own uncommitted green edit.
  Six mutations across two steps, no lost work.
- The `external_directory` permission gate caught the one bad file path in the session (see below) and named the corrected location in its denial — the exact use case ADR 0007 describes, working on the first try.

#### What caused friction (agent side)

- `missing-context` — the planning session hunted for the slash-command registration through five consecutive greps (`addCommand`, `registerCommand`, `pi.command`, `commands\b`, `slash`) across turns 11–15 before finding it in `src/config/config-modal.ts`.
  The `colgrep` skill was loaded in that same session and never used, and this is precisely its case: the symbol name was unknown, which is what makes an exact-match grep a guessing game.
  Impact: about five extra tool calls in the planning session; no rework, and the answer only fed Option C, which the operator did not choose.
- `instruction-violation` (self-identified, gate-caught) — TDD turn 84 called `Edit` with a hand-built absolute path (`/Users/chris/development/pi-permission-system/test/...`) that omitted the worktree prefix, and `pi-permission-model-judge` denied it.
  `AGENTS.md` says to pass file tool paths repo-relative for exactly this reason (Refs #726).
  The session had been mixing both conventions — several earlier calls used full worktree-absolute paths successfully — so the hand-built path had precedent in the same transcript.
  Impact: one denied tool call, corrected on the next turn.
- `other` — the ship session drafted the close comment into `/tmp/close-861.md` with a shell heredoc, verified the five SHAs **against that file**, and then published a **retyped** copy of the body through `issue_close`, which takes a string.
  The scratch file was never consumed by anything.
  So the artifact that was verified and the artifact that was published were two different strings; they happened to agree, but nothing enforced that.
  This is the `/ship` "verify the draft, not your intent to cite" rule defeated by staging the draft somewhere the publishing call does not read from.
  Impact: one wasted tool call and a verification gap that did not bite.
- `missing-context` (planning, surfaced by the reviewer) — the pre-completion reviewer's single WARN was a comment in `test/composition-root.test.ts` still calling the skip's loudness an open question, in the very block the change modified to pin the warning.
  The rule that would have caught this already exists in `/plan-issue` ("a predicted-unchanged file is a falsifiable claim; an omitted one is invisible", Refs #878), and the planning grep sweep's output contained the line.
  It was not a missing rule but an unapplied one: a sweep's *output* and a plan's *file list* are different artifacts, and nothing reconciles them.
  Impact: one extra `docs:` commit (`docs(pi-permission-system): state the resolved skip in the boundary test comment`) after the main work, plus a second reviewer dispatch.

#### What caused friction (user side)

- Nothing to flag — the clarification gate was answered in one pass with three sub-decisions settled at once (report at the first ask that skips, name all three causes unbranched, latch per name), and no stage needed a correction.
- Light opportunity: the operator's own `authorizerChain: ["model-judge"]` config and the 13-day history of the defect in their review log were the evidence that grounded the design, and neither was in the issue body.
  An issue that ships its own measurement would save the planning session the four-call excavation — though in this case the excavation itself surfaced the two counting traps, so the cost bought something.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5`; sync and ship ran on `anthropic/claude-sonnet-5`.
  The split matches the work: planning carried the ADR reconciliation, the cross-node design, and the mutation reasoning, while sync and ship are deterministic gate-running, merging, and dispatching.
  No mismatch found in either direction.
  Subagent dispatches were all in planning and TDD — `Explore` for the `ui.notify` trace in the Pi checkout, `tidy-first-assessor` for the preparatory refactor, and `pre-completion-reviewer` twice.
  Dispatching `Explore` for the Pi-checkout trace kept a multi-hop read out of the planning session's context, as `AGENTS.md` prescribes.
- **Escalation-delay tracking** — the slash-command hunt above ran five consecutive tool calls on the same unknown, which is at the flagging threshold.
  A `colgrep` query would have been the cheaper first move; an `Explore` dispatch would have been overkill for a single-package question.
  No other sequence exceeded two calls on the same error.
- **Feedback-loop gap analysis** — no gap.
  The TDD session established a four-gate green baseline (`check`, `lint`, `test`, `fallow dead-code`) before the first cycle, ran `pnpm run check` immediately after the step that changed a shared type (the `AuthorizerSelectionConstructorDeps` extraction), and ran the affected test file at every Red and Green.
  Lint ran after each step rather than only at the end.
  The ship session re-ran `lint` and `fallow dead-code` on the merged tree, which is the tree neither the peer's pre-rebase check nor CI had seen at that point.

### Changes made

1. `packages/pi-permission-system/docs/retro/0861-unregistered-chain-link-warning.md` — appended this Final Retrospective stage entry.
2. `.pi/prompts/ship.md` — added one sentence to step 9, after the existing "verify the draft" rule: compose the close comment in the `issue_close` call itself rather than in a scratch file, since the tool takes a string and a staged file is verified and then retyped.

Considered and rejected, all as duplicates of rules that already exist and were simply not applied: a `/plan-issue` rule reconciling a grep sweep's output against the plan's file list (Refs #878 covers it), a colgrep-before-symbol-guessing rule (`AGENTS.md` § Shell and search covers it), and a repo-relative-path reminder for worktree sessions (Refs #726 covers it, and the permission gate enforces it).

[#792]: https://github.com/gotgenes/pi-packages/issues/792
