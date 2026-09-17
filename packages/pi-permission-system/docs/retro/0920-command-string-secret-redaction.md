---
issue: 920
issue_title: "Secret in a command string still reaches the review log; ADR 0010's reopen condition is met"
---

# Retro: #920 — Secret in a command string still reaches the review log; ADR 0010's reopen condition is met

## Stage: Planning (2026-09-15T04:20:53Z)

### Session summary

Verified the third-party report ([Radu0120]) against the shipped `src/logging/log-redaction.ts` and against a real 12 MB review log (16 524 records, 7 146 unique command strings), then planned a grammar-anchored masker that runs at `writeLine` ahead of the width cap.
The operator confirmed the direction, chose three binding forms (shell `variable_assignment`, `word`-shaped `env NAME=value`, and any argument of the form `<sensitive-name>: <value>`), and chose a best-effort failure posture over blanking the field on an unparseable command.
The plan is `packages/pi-permission-system/docs/plans/0920-command-string-secret-redaction.md`; follow-up [#923] was filed and dispositioned `out of scope for the roadmap` against Phase 15.

### Observations

- **The measurement that decided the design was regex-versus-node, not coverage.**
  A raw-string scan for a sensitively-named assignment matched 10 unique commands in the corpus and every one was a false positive — `key=lambda x: x[1]` and `keys=list(d.keys())` inside embedded Python, plus a `sed` pattern that was itself a redaction.
  The same rule anchored to a `variable_assignment` node matched 0.
  That single number is the whole argument for grammar anchoring, and it is also the reason inline-shell payloads and heredoc bodies are deferred: blanket recursion into string nodes re-admits exactly that class.
- **The report's suffix list is mostly already covered.**
  `token`, `secret`, `password`, and `credential` are already **substring** alternatives in the shipped pattern and so already wider than a suffix match.
  The only genuine widening is `key` with a name boundary.
  The plan keeps the shipped `api[-_]?key` / `private[-_]?key` alternatives anyway so the union is provably never narrower — a sweep over every `{prefix}{alternative}{suffix}` combination found 0 regressions, and `apikey` is the name that would have been lost otherwise.
- **A `/i` flag on the camel alternative would have silently masked `monkey`.**
  `[a-z0-9]Keys?` under `/i` matches `nkey`.
  The predicate is therefore split into a case-insensitive part and a case-sensitive camel part.
  My first corpus probe had this bug, so its false-positive counts are an upper bound rather than the final figure; the numbers in the plan are from a re-run with the corrected predicate.
- **A measured refinement arrived after the clarification gate and did not need a second one.**
  The operator chose the broad header rule (no `-H` anchor) on the stated premise that over-masking a log is safe.
  Measuring it afterwards found 5 hits, of which 2 were `grep "legalDirectionalKeys: readonly"`.
  An HTTP field name is hyphenated and never camelCase, so a one-clause guard drops those 2 and keeps all 3 genuine `Authorization:` hits — a refinement inside the chosen option, not a new decision.
- **Three independent producers write a `command` field**, which is what settles the placement at `writeLine`: `ToolPreviewFormatter.getPermissionLogContext`, `renderReviewLogFacts`'s `executedUnit`, and `recordGateError` on the fail-closed path, which borrows no gate context at all.
- **Stage ordering is a security property here.**
  Masking must run before `capLogFieldWidths`, or a 1000-character truncation cuts a secret in half and can make the tail unparseable; and unlike the cap it must apply to the debug stream too.
- **Disagreement with the Tidy-First assessor, recorded rather than resolved silently.**
  It rejected a recursive command-key walk as speculative generality, since all three producers write `command`/`executedUnit` at the top level.
  The plan takes recursion anyway: the writer's other two passes are both recursive, and an asymmetric third stage is what a later nested producer escapes unnoticed.
  Both of its **Recommended** tidyings were accepted as steps 1 and 2 — the `isSensitiveLogKey` → `isSensitiveName` rename, and extracting `writeLine`'s transform couplet into a named `prepareLogDetails`.
- **The boundary sentence lives in six places and one of them is deliberately left alone.**
  ADR 0010, `docs/configuration.md`, `docs/troubleshooting.md`, `README.md`'s non-goal, and the package SKILL all move together; `docs/migration/0746-review-log-fields.md` does not, because its sentence is a true statement about the release it documents.
- **ADR 0010 predicted its own reopen and the prediction held.**
  The alternative section names the exact condition ("should a report show a secret reaching the log through a command string"), which made triage a one-step verdict rather than a re-argument.
  It is worth noting that the ADR's *nominated remedy* was still wrong in a way only a real corpus exposed — the reporter's correction is the design contribution, and the plan's step 6 carries `Co-authored-by`.
- **The Windows half of the report answers itself.**
  Redaction does not depend on file modes, so after this lands Windows has one active remedy where the report correctly observed it had none.
  No new Windows mechanism is planned, and ADR 0010's reasoning against a per-session warning is unchanged.

#### Deferred tidyings

- `src/access-intent/bash/*.ts` — five modules hand-roll their own `for (i < childCount) child(i)` walk with different skip/collect rules; the assessor declined to unify them and the new masker's span-collecting walk is a sixth shape again.

## Stage: Implementation — TDD (2026-09-15T16:03:55Z)

### Session summary

Nine commits over the plan's seven steps plus two review fixes: two Tidy-First preparations, the predicate widening, the `TSNode.endIndex` addition, the masker module, the writer wiring, the doc sweep, a stale-doc correction, and a quote-balance correction.
The package suite went from 4191 to 4245 tests (+54).
The pre-completion reviewer returned WARN on the first pass with two non-blocking findings, both fixed, and PASS on the scoped delta re-review.

### Observations

- **The plan's mutation predictions held for seven of eight and the eighth was a real finding.**
  Every named killing mutation reddened exactly the equivalence class the plan said it would — the assignment class (8 tests), the `word` class (1), the camel guard (1), the span direction (1), the `maskCommandFields` call (4), the ordering (1), the review-only gate (1).
  The exception was the cold-parser mutation: the plan said to make `getWarmBashParser()` returning `null` throw, and nothing reddened, because the function's outer `catch` returns the input too.
  The mutation preserved the observable behavior by design, so it was never a killing mutation for the stated claim.
  Replacing it with a **value** mutation (`return ""` instead of `return command`) reddened the cold-parser test, which is the pin that matters.
  This is the `AGENTS.md` rule about preferring a changed literal over restructured control flow, arriving from the other direction: restructuring can also produce *too few* reds.
- **The `catch` itself is unpinned, and that is a deliberate call.**
  No input makes the warmed parser throw — the reviewer independently tried lone surrogates, NUL bytes, 20 000-deep nesting, and a 6 MB command and could not reach it.
  It is defense in depth against a WASM-binding failure on a fail-closed path, where a raised mask costs the whole log line.
  The reviewer agreed.
- **`command-redaction.test.ts` was written and then implemented without an intervening Red run**, so its 27 cases all passed on their first execution.
  That is precisely the case the template calls out as mandatory for mutation testing, and the mutations are what supplied the missing evidence.
  Worth doing in the other order next time: the file's import would have failed loudly and cost nothing.
- **The reviewer found a real defect the whole corpus could not.**
  `openingQuoteOf` read the closing quote off the argument node's first character, which is wrong when the field name straddles a quote boundary (`-H Auth"orization: "$TOKEN`) — it left a dangling `"` in the logged line.
  Zero occurrences in 7146 real commands, so measurement was never going to surface it; deriving adversarial inputs from the stated invariant was.
  The fix reads the quote state at the colon instead, and gates backslash escaping to double-quoted regions, because bash does not honor `\` inside `'…'`.
- **`isPlainRecord` moved to `value-guards.ts` against the Tidy-First assessor's advice.**
  It rejected a recursive command-key walk as speculative generality; the walk went in anyway, because the writer's other two stages are both recursive and an asymmetric third one is what a later nested producer escapes.
  Sharing the predicate is the consequence: two stages of one pipeline disagreeing about which records to descend into would be a silent hole.
- **A pre-existing flake surfaced and was proven pre-existing rather than assumed.**
  `composition-root.test.ts`'s forwarding-liveness test times out at Vitest's default 5 s under the root parallel run — it waits out the ~2 s serving grace window on real timers.
  Checking out the pre-implementation commit and re-running the same root command reproduced it, which is what made it safe to file ([#925]) rather than chase.
  The first baseline run of the session had passed, which is exactly how a flake hides.
- **Two commits correct code that never shipped**, and both are typed by what a user observes once the batch lands: the quote fix is `refactor:` because the masker it corrects is introduced three commits earlier in the same unpushed batch.
  Only the two `fix:` subjects reach the changelog, and both name an outcome rather than a seam.

Pre-completion reviewer: WARN on the first pass (stale `permissionReviewLog` knob row; the quote-balance defect), then PASS on the delta re-review after both were fixed.

## Stage: Final Retrospective (2026-09-15T16:16:43Z)

### Session summary

Planning, TDD, and ship ran end to end in one process: a third-party secret-exposure report became a grammar-anchored command masker, nine implementation commits, an ADR 0010 amendment, and `pi-permission-system` v32.0.3.
Two follow-up issues were filed and dispositioned ([#923], [#925]), and the pre-completion reviewer ran twice — WARN, then PASS on a scoped delta.

### Observations

#### What went well

- **The operator's own review log was used as a false-positive corpus at planning time, and that number carried the whole change.**
  The design question — regex scan or tree-sitter node — was settled by running both over 7146 real commands and getting 10 false positives against 0.
  The same measurement then justified the `ask_user` option set, the ADR amendment, the package SKILL paragraph, and the issue close comment.
  This is worth repeating on any redaction, matcher, or classifier change: the artifact the feature will run against usually exists on disk already.
- **A measurement taken *after* the clarification gate refined the chosen option instead of reversing it.**
  The operator picked the broad header rule (no `-H` anchor) on the stated premise that over-masking a log is safe.
  Measuring it afterwards found 5 hits, of which 2 were `grep "legalDirectionalKeys: readonly"`.
  An HTTP field name is hyphenated and never camel-cased, so a one-clause guard dropped both and kept all three genuine `Authorization:` hits — a refinement inside the chosen option, which needed no second gate.
- **The pre-completion reviewer found a defect the corpus could not.**
  `openingQuoteOf` read the closing quote off the argument node's first character, which is wrong when a field name straddles a quote boundary (`-H Auth"orization: "$TOKEN`).
  Zero occurrences in 7146 commands, so measurement was never going to surface it; deriving adversarial inputs from the stated invariant was.
  The dispatch prompt asked for exactly that ("derive your own adversarial inputs"), and it earned its keep.
- **Scoping the re-dispatch to the delta cut the second review 5.6×** — 306 s against 1714 s — while still re-deriving the quote property from its own inputs.

#### What caused friction (agent side)

1. `instruction-violation` (self-identified) — wrote `test/logging/command-redaction.test.ts` and implemented `command-redaction.ts` without an intervening Red run, so all 27 cases passed on their first execution.
   The template's Red step is explicit, and the file's import would have failed loudly at zero cost.
   Impact: no rework, but the step's only discrimination evidence came from the mutation pass, which is the fallback rather than the primary signal.
2. `instruction-violation` (self-identified) — used `oldText2`/`newText2` keys in an `Edit` call on `test/helpers/fake-ts-node.ts`.
   `AGENTS.md` names this trap verbatim ("Extra suffixed keys are silently ignored while the tool still reports `Successfully replaced N block(s)`"), and the rule had been read earlier in the same session.
   Impact: one extra `Read` to verify; no rework, because the correct second entry was also present in the same call.
3. `other` — the plan's killing mutation for the cold-parser path was wrong by construction.
   It said to make `getWarmBashParser()` returning `null` throw; nothing reddened, because the function's outer `catch` returns the input too, so the mutation preserved the observable behavior by design.
   Impact: one wasted mutation cycle, replaced with a value mutation (`return ""`) that reddened the pin.
4. `missing-context` — the plan enumerated five verbatim copies of ADR 0010's boundary sentence and moved all five, but missed `docs/configuration.md`'s Runtime Knobs row, which stated the same fact in different words ("Records bash command strings unredacted").
   The plan's grep was keyed on the sentence being replaced, so a paraphrase in a table cell was invisible to it.
   Impact: one extra `docs:` commit (`0664a6cf`) after the reviewer caught it.
5. `other` — the first green-baseline run passed, and `composition-root.test.ts` then flaked twice under the root parallel run.
   Proving it pre-existing meant checking out the pre-implementation commit and re-running the same root command.
   Impact: two extra full-suite runs (~2 min) before it was safe to file [#925] rather than chase it.

#### What caused friction (user side)

Nothing to report.
The two clarification gates were answered decisively, and the direction answer ("implement, with the report's predicate correction") plus the vector multi-select carried the whole design without a follow-up round.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5`, `/ship` on `anthropic/claude-sonnet-5`, and this retrospective on `anthropic/claude-opus-5`.
  The split matches the work: the ADR amendment, the predicate design, and the gate authoring are judgment-heavy, while `/ship` is a deterministic checklist over `git`, `ci_find`/`ci_watch`, and `next-version.sh`.
  No mismatch in either direction.
  Subagents: one `tidy-first-assessor` (both its Recommended tidyings were adopted as steps 1 and 2) and two `pre-completion-reviewer` dispatches.
- **Escalation-delay tracking** — no `rabbit-hole` friction points.
  The longest same-error sequence was a single lint failure (`@typescript-eslint/no-unnecessary-condition` on `match[1] ?? ""`), resolved in one edit.
- **Unused-tool detection** — `colgrep` was never dispatched; exploration was targeted `grep` against named modules, which the issue's own diagnosis made sufficient.
  No `Explore` dispatch was warranted: the report supplied a numbered diagnosis, and the prompt directs that verification inline rather than into a subagent.
- **Feedback-loop gap analysis** — `pnpm run check` plus a targeted `vitest run` ran after every step; the full suite ran at the baseline, after step 4, and at the end.
  The one gap is friction point 1 above: step 5's tests were written and implemented in the same turn, so its feedback loop opened at Green rather than at Red.

### Changes made

1. `.pi/prompts/tdd-plan.md` — extended the mutation-choice clause in the Verify step: a control-flow mutation can produce too *few* reds when a downstream `catch` returns the same value the mutated guard did.
2. `.pi/skills/pre-completion/SKILL.md` — the WARN path now says to re-dispatch scoped to the delta after fixing the findings, mirroring the rule the FAIL path already carries.

Two further proposals were declined by the operator and are recorded here rather than landed:

- A `/tdd-plan` baseline rule that a green baseline run does not make a later failure yours (re-run at the pre-implementation commit before treating it as a regression).
  The evidence is friction point 5 above.
- An `AGENTS.md` Module-Level Changes rule to grep a documented claim's property word (`unredacted`, `never`, `always`) rather than the sentence being replaced.
  The evidence is friction point 4 above; the section is already the file's longest, which is the cost that decided it.

[Radu0120]: https://github.com/Radu0120
[#923]: https://github.com/gotgenes/pi-packages/issues/923
[#925]: https://github.com/gotgenes/pi-packages/issues/925
