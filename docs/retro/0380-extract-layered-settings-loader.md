---
issue: 380
issue_title: "Resolve the cross-package settings-loader duplication"
---

# Retro: #380 — Resolve the cross-package settings-loader duplication

## Stage: Planning (2026-06-16T00:00:00Z)

### Session summary

Planned the resolution of the 23-line cross-package production clone between `src/settings.ts` and `@gotgenes/pi-subagents-worktrees`'s `src/config.ts`.
Issue #380 posed a binary: extract a shared loader vs. document-and-suppress.
The operator chose extraction, delivered as a dedicated subpath export `@gotgenes/pi-subagents/settings`, sequenced as two stages (this plan lands the helper in pi-subagents; a follow-up migrates worktrees).
The plan is a single-package TDD plan in `packages/pi-subagents/docs/plans/0380-extract-layered-settings-loader.md`.

### Observations

- The issue is the operator's own (author `gotgenes` == gh user), so the "Proposed change" was a hypothesis.
  Used `ask_user` twice: first to confirm Option 1 vs Option 2 (operator picked extract, then asked for explicit for/against), then to pin API placement (`./settings` subpath, recommended) and release sequencing (two-stage, follow-up for worktrees).
- Key mechanism finding that shaped the framing: fallow's `code-duplication` suppression is **file-scoped only** (`// fallow-ignore-file code-duplication`) — there is no line-level next-line directive, contrary to the issue's "rationale on the line above" phrasing for Option 2.
  This would have mattered had Option 2 been chosen.
- The shared idiom is the read-sanitize-warn-merge mechanism; the per-package `sanitize` (numeric ceilings vs `string[]`) is the genuinely-different part.
  A generic `loadLayeredSettings<T>({ sanitize, warnLabel, filename, agentDir, cwd })` is a clean extraction with no discriminator parameter.
- Honest Outcome caveat captured in the plan: because worktrees keeps its copy until the follow-up, `fallow:dupes` may still report a residual (or dissolve below `min-lines: 5`, since the generic helper's tokens diverge).
  Definitive elimination is the follow-up's outcome, not a hard gate on this plan.
- Followed the `0270-type-consumable-public-surface.md` plan as the template for the `.d.ts`-bundle + `verify:public-types` machinery; the new subpath extends that rather than introducing a new mechanism.
- `loadSettings`'s `process.cwd()` default is dropped per the code-design "no `process.*` in library functions" rule; the sole caller (`SettingsManager.load`) already passes `this.cwd` (verified by grep).
- The worktrees-migration follow-up issue should be created at ship time and back-referenced from the architecture Step 9 roadmap entry.

## Stage: Implementation — TDD (2026-06-16T16:00:00Z)

### Session summary

Completed all 4 TDD steps from the plan: added `src/layered-settings.ts` with 15 unit tests, refactored `settings.ts` to delegate through the helper (removing `readSettingsFile` and `globalPath`), published the `@gotgenes/pi-subagents/settings` subpath export with a rolled `dist/settings.d.ts` and extended `verify:public-types` harness, and recorded the decision in the architecture doc.
Test count grew from 1015 to 1030 (+15).
Pre-completion reviewer returned **PASS**.
Follow-up issue [#415] created for the worktrees migration.

### Observations

- The plan's "Outcome caveat" resolved favourably: `pnpm fallow:dupes --skip-local` no longer reports the `settings.ts` ↔ `config.ts` pair after the extraction.
  The parametrised helper's token sequence diverged enough that the contiguous identical run dropped below the reporting threshold — a better outcome than the plan's hedged prediction.
- ESLint's pre-commit hook removed `!` non-null assertions from `spy.mock.calls[0]![0]` in the test file (typed `vi.spyOn` mock calls are non-optional tuples; the assertions were redundant).
  Staged the auto-fix into the same commit without issue.
- The `rollup.dts.config.mjs` array-of-configs approach worked without incident: both bundles (`dist/public.d.ts` and `dist/settings.d.ts`) are self-contained and `verify:public-types` confirmed both probes type-check against the packaged tarball.
- The `satisfies LayeredSettingsSource<SubagentsSettings>` annotation at the `loadSettings` call site serves double duty: validates the object literal and keeps `LayeredSettingsSource` referenced for fallow dead-code (fallow confirmed: 0 issues).
- Follow-up issue [#415] created before the TDD stage notes were written (operator requested it during the session); architecture doc updated with the `[#415]` reference and link definition.

## Stage: Final Retrospective (2026-06-16T18:00:00Z)

### Session summary

Shipped issue #380 end-to-end across four stages (plan → TDD → ship) in one session: extracted `loadLayeredSettings<T>` into `src/layered-settings.ts`, published it at the `@gotgenes/pi-subagents/settings` subpath, and adopted it internally in `settings.ts`.
Released as `pi-subagents-v16.4.0`; CI passed first try; pre-completion reviewer returned PASS.
Notably clean run — no rework, no failed commits, no rabbit-holes.

### Observations

#### What went well

- The two-stage `ask_user` planning gate worked as designed: it surfaced the binary (extract vs. suppress) neutrally, the operator engaged deeply (asked for explicit for/against before committing), and the answers drove the plan's Goals rather than the issue body.
  This is the intended use of `ask_user` for an operator-authored issue framed as "weigh two options."
- Proactive tool-mechanism research paid off: `web_search` + `fetch_content` on the fallow docs during planning revealed that `code-duplication` suppression is **file-scoped only** (no line-level directive), which would have changed Option 2's shape had it been chosen.
  Checking the tool's real surface before planning around it caught a latent wrong assumption.
- The plan's honestly-hedged "Outcome caveat" (clone might persist until the worktrees follow-up) resolved favourably — the parametrised helper diverged below fallow's threshold immediately.
  Hedging a quantitative prediction rather than over-promising left no credibility gap when the better outcome landed.
- Incremental verification cadence: `pnpm run check` ran right after the interface-adjacent Step 2, vitest ran per-file in each Red/Green, and `build:types` + `verify:public-types` ran inside Step 3 — not deferred to the end.
  No feedback-loop gaps.

#### What caused friction (agent side)

- `missing-context` (process gap) — the plan's Open Questions flagged the worktrees follow-up issue as "created at ship time," but the `ship-issue` prompt has no step for creating a deferred follow-up.
  During shipping I went straight to close + release; the operator had to prompt ("What about the follow up issue…") to trigger #415's creation.
  Impact: one extra user turn, no rework — but the #380 close comment references #415, so the follow-up had to exist before close, making the ordering load-bearing.
- `instruction-violation` (self-identified, no rework) — the new test used `String(spy.mock.calls[0]![0])`, which the `testing` skill explicitly warns against ("Assert mock calls with `expect(fn).toHaveBeenCalledWith(...)`, not `fn.mock.calls[0]![0]`").
  ESLint's pre-commit hook auto-stripped the redundant `!`, leaving `spy.mock.calls[0][0]`; tests stayed green.
  I mirrored the pre-existing pattern in `settings.test.ts` rather than the skill's recommended `toHaveBeenCalledWith(expect.stringMatching(...))`.
  Impact: none (auto-fixed, matches existing file style); the rule already exists in the skill, so this is a salience note, not a gap.

#### What caused friction (user side)

- None material.
  The operator's one mid-ship intervention (asking about the follow-up issue) was a good catch that compensated for the prompt gap above, not a correction of a mistake.

### Diagnostic details

- **Model-performance correlation** — the single subagent dispatch (`pre-completion-reviewer`) ran on `anthropic/claude-sonnet-4-6`, appropriate for judgment-heavy review; no mismatch.
  Parent-session `model_change` entries toggled among `sonnet-4-6`, `deepseek-v4-flash`, and `opus-4-8`, but these are operator model selections, not quality-relevant task assignments.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no error sequence exceeded one or two tool calls before resolution.
- **Unused-tool detection** — nothing missed; `web_search`/`fetch_content` were dispatched proactively during planning for the fallow-mechanism question.
- **Feedback-loop gap analysis** — verification ran incrementally (per-step `check`/vitest, in-step `verify:public-types`), not just at the end.
  No gap.

### Changes made

1. `.pi/prompts/ship-issue.md` — added `## 4c. Create planned follow-up issues` between the stacked-release check (§4b) and the close step (§5): if the plan or retro defers work to a follow-up issue, create it with `gh issue create` before closing so the close comment can reference its number.
