---
issue: 875
issue_title: "pi-permission-system: a partial bash parse can drop a command unit, so an explicit deny never fires"
---

# Retro: #875 — pi-permission-system: a partial bash parse can drop a command unit, so an explicit deny never fires

## Stage: Planning (2026-09-15T18:50:21Z)

### Session summary

Traced the defect against the real `tree-sitter-bash` parse and the real `BashProgram` / `resolveBashCommandCheck` pipeline, measured it over 6911 intact bash commands from the local review log, and found a **fourth** remedy neither the issue nor ADR 0013's 2026-09-04 amendment lists: re-parse the smallest unresolved node's own text standalone and accept the result only when that re-parse is clean.
The operator chose it at the clarification gate, with scope covering both the command units and the path slices.
Committed the plan at `packages/pi-permission-system/docs/plans/0875-salvage-a-dropped-bash-command.md`.

### Observations

- **The issue understates the defect, and so does the triage.**
  The dropped region's *path operands* reach neither `path` nor `external_directory` either — measured: `cat <<'MSG' 2>&1 | cat /etc/shadow` yields `externalAccesses() === []` and `pathRuleCandidates() === []`.
  That is a violation of `docs/decisions/0009-bash-path-projection-completeness-contract.md`, whose "What the projection deliberately omits" list covers no such case, so ADR 0009 needs an amendment alongside ADR 0013's.
- **The three candidate directions the issue and ADR 0013 both enumerate were each refuted or discounted on measured facts.**
  The heredoc pre-pass in particular: eliding only the heredoc *body* does not help, because `<<TAG` + `2>&1` + `|` is what defeats the grammar — `<<'MSG' | rm -rf /tmp/x` parses clean and `<<'MSG' 2>&1 | rm -rf /tmp/x` does not.
  A record's enumeration of remedies is a snapshot of what its author considered, not a closed set.
- **The clean-re-parse guard is measurable in the absent direction**, which is what the Risks section needed.
  Dropping it makes `cat <> rw.txt` emit a command unit whose text is `">"`, and `cat $(( > out.txt` emit a duplicate `cat` plus `"$(("`.
  Probed by running both variants over the corpus and every malformed shape rather than arguing the guard's value.
- **Rejected: resolving a salvaged region against a known effective base.**
  For `cd /outside && cat <<'M' 2>&1 | cat rel.txt` the candidate is the `file_redirect`, and the `cd` state in force there is not recoverable from the fragment.
  A known base would resolve `rel.txt` to the wrong file and could match an `allow` rule for it — a fail-open.
  Salvaged roots walk under `UNKNOWN_BASE`, matching [#393]'s conservatism; the residual (a relative token in a salvaged region stays unprojected) is recorded in ADR 0009 rather than filed.
- **`src/handlers/gates/bash-command.ts` needs no change**, which is the shape of the fix worth remembering: [#840] built the floor to read one field on `BashCommand`, so restoring enumeration is entirely upstream of the verdict fold.
- **`#875` was deferred twice by the roadmap sweep** (Phase 14 and Phase 15) as "an enumeration residual with no verdict-fold lever".
  That rationale was correct about the verdict fold and wrong about the absence of a lever — the lever is in enumeration, one layer up.
  The plan's doc list amends the Phase 15 disposition the way [#899]'s was amended when it was pulled forward.
- No follow-up issues filed: every deferral is either an operator decision from the gate or an accepted residual written into ADR 0009.
  The `roadmap-fit` skill was therefore not exercised.

#### Deferred tidyings

- `packages/pi-permission-system/test/access-intent/bash/program.test.ts` — 2093 lines, third-largest test file in the package; the Tidy-First assessor declined a split as scope creep, since the salvage cases fit the file's existing per-issue `describe` convention.

[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#840]: https://github.com/gotgenes/pi-packages/issues/840
[#899]: https://github.com/gotgenes/pi-packages/issues/899

## Stage: Implementation — TDD (2026-09-16T00:15:09Z)

### Session summary

Executed all five planned TDD cycles — the salvage walk, the command-surface wiring, the path-surface wiring, the property table, and the docs — then a sixth `fix:` commit closing a never-weaker violation the pre-completion reviewer found.
Test count in `pi-permission-system` went 4245 → 4337 (+92) across 162 → 163 files.
The pre-completion reviewer returned FAIL on the first round and PASS on the delta re-review.

### Observations

- **The reviewer's blocking finding was a genuine fail-open the plan had explicitly predicted could not exist.**
  The plan's Invariants table said a salvage could not make `resolveBashCommandCheck`'s zero-unit branch unreachable, citing a corpus measurement.
  It can: a body-less leading redirect ahead of the grammar gap (`> f <<'M' 2>&1 | rm -rf /tmp/x`, valid bash that really runs) yields **zero** primary units and one salvaged one, so the whole-command `deny` probe — the only surface a context-naming rule such as `"* rm -rf *"` can match — was skipped, and `deny` became `ask`.
  The plan's claim rested on the corpus holding no such shape, which prices a change rather than enumerating a mechanism's inputs — the lesson ADR 0009's 2026-08-29 amendment already records, re-learned here.
  Fixed by adding `BashCommand.salvaged` (narrower than `parseUnresolved`, which a primary unit also carries when its statement failed) and keying the branch on the **primary** parse having matched nothing.
- **Two of the plan's named killing mutations did not kill what it predicted**, and both were findings rather than passes.
  Unmarking `SALVAGED_SCOPE` was predicted to flip a metamorphic `ask` row to `allow`; it does not, because a command carrying a salvaged region normally has marked primary siblings — except in the zero-primary-unit case above, where the marker turns out to be load-bearing after all.
  Restricting the candidate to `node.type === "file_redirect"` leaves the entire suite green: 25 probed spellings of the grammar gap all produce a `file_redirect` candidate, including the gap nested in a control-flow body, a subshell, and a substitution.
  The rule stays keyed on the parse's health (ADR 0013's own framing), and a stub-node test pins the distinction the corpus cannot.
- **One planned test was vacuous as written.**
  `cd /outside && … cat rel.txt` does not discriminate the unknown base from the cwd base, because a *bare* token needs the existence probe under either and `/cwd/rel.txt` does not exist.
  Replaced with `cat ../secret`, whose `..` shape passes the classifier and whose `matchValues()` differ between the two bases.
  A probe's shape has to match the guard's own predicate, not merely the scenario's prose.
- **The salvaged root is a re-parsed `program`, not the candidate node**, which invalidated the first draft of the salvage unit tests (they asserted `file_redirect`).
  Caught at Red, but it is the kind of shape assumption worth writing down.
- **Reviewer's non-blocking note, not filed as an issue.**
  An all-salvaged unit list containing a nested execution context is unreachable for the one known grammar gap — the primary parse independently finds a nested substitution inside the dropped fragment, so a residual primary unit always survives.
  No test pins that interaction; it becomes worth one only if a future grammar gap makes the combination reachable.
  Recorded here rather than filed, since nothing concrete names it today.
- **Baseline note for a future session**: the two `test/authority/approval-escalator.test.ts` / `test/composition-root.test.ts` failures in the first full-suite run were the documented host-load flake (900 s durations on sub-second tests) and passed on a re-run of those files alone.

## Stage: Sync (worktree) (2026-09-16T02:45:36Z)

### Session summary

Pre-push checks pass clean from the worktree root: `pnpm run lint` (1168 files, no issues) and `pnpm fallow dead-code` (345 entry points, no issues).
No deferred work rides this branch beyond what the TDD stage note already records; the plan's `**Release:** ship independently` marker stands — no roadmap batch to check at ship time.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-875--/2026-09-15T16-49-52-993Z_01a0a5f9-9761-76c3-a6dd-87e0fcf2b646.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The pre-completion reviewer's round-1 FAIL and round-2 PASS, and the six-commit implementation history, are already fully recorded in this file's TDD stage entry above — nothing new to add here beyond confirming the tree is green and ready for `/ship 875`.

## Stage: Sync (worktree) (2026-09-16T03:33:00Z)

### Session summary

Re-ran `/sync-worktree 875`: local `main` had advanced by one commit (a `pi-subagents` release, unrelated to this issue) since the prior sync entry above, which is why the earlier ff-merge prediction no longer held.
`pnpm run lint` and `pnpm fallow dead-code` both re-verified clean, then the branch rebased onto the new local `main` with no conflicts.

**Peer session transcript:** unchanged from the entry above.

### Observations

No new observations — this is the "whoever lands second rebases first" case AGENTS.md documents, triggered by an unrelated sibling package's release landing on `main` between sync attempts, not by any conflicting work on this issue.
Ready for `/ship 875`.

## Stage: Final Retrospective (2026-09-16T04:28:26Z)

### Session summary

Shipped #875 through the worktree lane: fast-forwarded eleven commits onto `main`, verified CI, closed the issue with a three-SHA close comment, and released `pi-permission-system-v32.0.4`.
The ship session itself ran 38 tool calls with zero corrections and zero rework — every prompt step executed once.
The retrospective below spans all four stages (planning, TDD, two sync runs, ship), since the friction worth recording is concentrated upstream of the ship.

### Observations

#### What went well

- **The pre-completion reviewer refuted a claim the plan had measured and asserted.**
  The plan's Invariants table discharged the [#452] zero-unit row with "no such shape exists (measured — the one zero-unit-shaped candidate is root-only)".
  The reviewer produced `> f <<'M' 2>&1 | rm -rf /tmp/x` — a body-less leading redirect, valid bash that really runs — which yields zero primary units and one salvaged one, turning a context-naming `deny` into `ask`.
  This is the single highest-value event across the four stages: an adversarial fresh-context read overturned a conclusion backed by a 6911-command corpus measurement.
- **Killing-mutation verification earned its cost twice over, and both times as a finding rather than a pass.**
  The plan's step-4 mutation (`node.type === "file_redirect"`) left the entire suite green across 25 probed spellings of the grammar gap, so the rule was re-pinned with a stub-node test instead.
  The plan's `cd /outside && … cat rel.txt` probe was vacuous — a bare token needs the existence probe under either base — and was replaced with `cat ../secret`, whose `..` shape discriminates.
  Neither would have surfaced from the Red step's own evidence.
- **Planning measured rather than argued, and found a fourth remedy.**
  Re-parsing the smallest unresolved node standalone appears in neither the issue nor ADR 0013's 2026-09-04 amendment, both of which enumerate the same three directions.
  Probing the clean-re-parse guard in the **absent** direction (dropping it emits `">"` and `"$(("` as command units) is what made the Risks section evidence rather than assertion.
- **`/ship`'s step 2 worked exactly as designed.**
  Reading the plan's `**Release:** ship independently` marker and the full retro off the branch — before any irreversible action — meant the release decision needed no operator gate and no close target was missed.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — during TDD, an `Edit` was addressed to `/Users/chris/development/pi/pi-permission-system/src/access-intent/bash/unresolved-salvage.ts`, a hand-built absolute path missing the `pi-packages-worktrees/issue-875/packages/` segment.
  `AGENTS.md` states the rule verbatim ("Pass file tool paths repo-relative … a mistyped absolute path trips the `external_directory` gate instead of failing fast", Refs #726).
  Impact: one rejected tool call; the next call used a repo-relative path and succeeded.
  Self-identified, so this is a salience issue rather than a missing rule — no change proposed.
- `other` — a `git commit -F -` fed from a heredoc whose body itself contained `<<'MSG'` failed, after the identical construction had succeeded for the previous commit.
  Impact: two tool calls (write `/tmp/msg2.txt`, re-commit); every later commit in the session used `-F <file>`.
  `AGENTS.md` says such a body "belongs in a file passed with `-F`", which `-F -` reads as satisfying.
- `other` — a disposable spike test's `console.log` output did not survive the vitest reporter, costing two tool calls in planning before the probe was rewritten to `writeFileSync("/tmp/probe875-out.txt", …)`.
  The TDD stage reached for `writeFileSync` immediately, so the lesson transferred within the issue but is not written down anywhere.
  Impact: two calls, no rework.
- `other` — the second `/sync-worktree` run appended a **full** second `## Stage: Sync (worktree)` block, after the session had stated it would annotate the existing entry instead.
  Impact: cosmetic — the retro carries two sync entries whose content largely overlaps.
  The prompt's step 3 says "Append a stage entry" unconditionally and says nothing about a re-run, which the same prompt elsewhere treats as expected.

#### What caused friction (user side)

- **An unrelated `pi-subagents` release landed on `main` between the peer's first and second `/sync-worktree` runs**, invalidating a completed rebase and forcing a full re-sync — two `pnpm run lint` + `pnpm fallow dead-code` cycles and roughly eight tool calls.
  `AGENTS.md` already records the rule ("Land a pending worktree branch before committing unrelated work to `main`"), so this is an application gap rather than a documentation one.
  Worth noting as the concrete cost of the ordering: the peer had already reported a clean handoff once.
- The peer session recovered from it correctly and without prompting — it diagnosed the failed `git merge-base --is-ancestor` rather than assuming a stale check — so no intervention was needed, only the re-run.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5` (judgment-heavy: corpus measurement, a remedy neither prior record listed, mutation triage); both sync runs and the ship ran on `anthropic/claude-sonnet-5` (deterministic prompt execution); this retrospective runs on `anthropic/claude-opus-5`.
  No mismatch: the two subagent dispatches (`tidy-first-assessor`, `pre-completion-reviewer` ×2) carried the reviewing judgment, and the reviewer's round-1 FAIL is direct evidence its model was adequate.
- **Escalation-delay tracking** — no `rabbit-hole` friction points; no sequence exceeded two consecutive tool calls on the same error.
- **Unused-tool detection** — not applicable; no `rabbit-hole` or `missing-context` points to check.
- **Feedback-loop gap analysis** — verification ran incrementally throughout: `pnpm run check` after each interface-touching Green step, the affected test files after every Red and Green, and full `check`/`lint`/`test`/`fallow` at the end of each of the six commits.
  The ship stage re-ran `lint` and `fallow` on the post-merge tree per `/ship` step 5, catching the gap `/sync-worktree`'s pre-rebase checks leave.
  No gaps found.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a bullet line to `**Invariants at risk**`: an invariant discharged by "no input of this shape exists" is unproven, because a corpus bounds observed frequency rather than reachability.
   Written from this issue's [#452] row, which the pre-completion reviewer refuted with a shape the 6911-command corpus did not contain.
2. `.pi/prompts/sync-worktree.md` — step 3 now says a re-run appends a dated line to the existing entry instead of a second `## Stage: Sync (worktree)` block.
3. `AGENTS.md` — tightened the commit-body rule to `-F <file>`, explicitly excluding `-F -` from a heredoc, and split it into two sentences.
4. Declined: a `testing`-skill note about spike tests reporting through a file rather than `console.log`.
   The vitest cause was never re-derived, so the evidence did not support a rule.
