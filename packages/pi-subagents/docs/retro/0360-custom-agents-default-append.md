---
issue: 360
issue_title: "fix(pi-subagents): custom agents default to replace mode instead of append"
---

# Retro: #360 — fix(pi-subagents): custom agents default to replace mode instead of append

## Stage: Planning (2026-06-09T02:42:19Z)

### Session summary

Planned the one-line fix flipping the `promptMode` ternary in `custom-agents.ts` so custom agents without an explicit `prompt_mode` default to `append` (matching the built-in default) instead of `replace`.
Enumerated the full change surface: the source line, two existing tests in `test/config/custom-agents.test.ts`, the wizard frontmatter doc comment, and the `README.md` defaults table.

### Observations

- The issue's proposed fix is unambiguous, so no `ask_user` round was needed.
- `grep` confirmed the only default-asserting tests live in `test/config/custom-agents.test.ts`; the broader upstream regression suite uses explicit `promptMode` values and is unaffected.
- Unknown `prompt_mode` values (e.g. `merge`) now resolve to `append` rather than `replace` — flagged as the safer fallback (inheriting a superset of context rather than silently dropping project context).
- Source fix and test updates are coupled into one TDD cycle because the assertions and the changed line move together; docs split into a separate `docs:` commit.
- **Breaking change**: flipping the default alters the runtime behavior of existing `.pi/agents/*.md` files that omit `prompt_mode` (they switch from `replace` to `append` on upgrade with no config edit).
  The plan was corrected mid-session to use `fix!:` with a `BREAKING CHANGE:` footer so release-please cuts a major — the initial draft incorrectly used a plain `fix:`.
- No `docs/architecture/` references to the default value exist; `CHANGELOG.md` is release-please-owned and untouched.

## Stage: Implementation — TDD (2026-06-09T02:48:38Z)

### Session summary

Completed both TDD cycles from the plan in a single session.
Step 1 flipped the ternary in `src/config/custom-agents.ts` and updated three assertions in `test/config/custom-agents.test.ts` (empty-frontmatter default, no-frontmatter assertion added, unknown-mode renamed and flipped).
Step 2 updated the inline doc comment in `src/ui/agent-creation-wizard.ts` and the `README.md` defaults table.
Test count: 973 (unchanged — no new tests added, three assertions updated in-place).

### Observations

- No deviations from the plan; all three test mutations landed exactly as specified.
- Full suite (59 test files, 973 tests) stayed green after the source change — the planning analysis that the broader upstream regression suite uses explicit `promptMode` values was confirmed correct.
- `pnpm fallow dead-code` and `pnpm run check` both passed with no findings.
- Pre-completion reviewer verdict: **PASS** — no warnings or findings raised.

## Stage: Final Retrospective (2026-06-09T03:04:21Z)

### Session summary

Shipped the breaking-default fix end to end across four staged sessions (plan → TDD → ship → retro), cutting `pi-subagents@15.0.0`.
The change flips the `promptMode` default for custom agents that omit `prompt_mode` from `replace` to `append`.
Execution was clean except for one significant miss in planning: the change was initially classified as a non-breaking `fix:` and corrected only after the user intervened.

### Observations

#### What went well

- The multi-model pipeline matched models to stage complexity: planning and retro on `claude-opus-4-8`, TDD on `claude-sonnet-4-6`, and the mechanical ship stage (push, CI watch, close, merge) on a cheaper `deepseek-v4-flash` — all stages completed their work correctly.
- The breaking-change correction propagated cleanly across the stage boundary: once the plan was fixed to `fix!:` with a `BREAKING CHANGE:` footer, the TDD stage (different model, different session) picked it up from the plan and committed the footer verbatim without re-deciding.
- TDD verification was incremental, not end-loaded: green baseline (`check`/`lint`/test) before any edit, red confirmation after the test edit, green after the source edit, then full suite + `check` + `lint` + `fallow` before the reviewer dispatch.

#### What caused friction (agent side)

- `instruction-violation` (user-caught) — the planning stage classified a changed-default bug fix as a non-breaking `fix:`, producing a plan with `fix:` commit messages.
  The plan template line "If the change is breaking, say so explicitly in Goals and use `feat!:`" was available but never triggered, because the agent conflated "the fix is unambiguous" (turn 8) with "the change is non-breaking" and skipped the breaking determination entirely.
  Impact: the user had to intervene ("This is a breaking change, right?"); three corrective edits (plan Goals, plan TDD commit block, retro Planning notes) plus one extra commit (`docs: mark issue #360 change as breaking`).
  Caught before TDD, so no code rework — but a wrong `fix:` that reached `/ship-issue` would have cut a patch release for a breaking change.

#### What caused friction (user side)

- None on the #360 work.
  The single redirecting question ("This is a breaking change, right?") was a near-optimal intervention: minimal, Socratic, and it let the agent reason to the correct classification itself rather than dictating the fix.
- Environment note (not #360-specific): the retro session opened with local `main` detached onto a stale `#332` side-branch after an aborted rebase (2 duplicate commits, 36 behind `origin/main`).
  `origin/main` was intact; recovery was a verified `git reset --hard origin/main` after confirming the 2 local commits were byte-identical duplicates of work already on origin.

### Diagnostic details

- **Model-performance correlation** — the breaking-change miss happened on the *strongest* model in the pipeline (`claude-opus-4-8`) during the judgment-heaviest stage (planning).
  This rules out model capability as the cause and points to a salience gap in the plan-issue prompt: the breaking determination is framed only as an `ask-user` ambiguity, conditional on the change being "ambiguous," with no unconditional classification step.
- **Feedback-loop gap analysis** — no gap; the TDD stage ran `check`/`lint`/test/`fallow` incrementally rather than only at the end.
- Escalation-delay and unused-tool lenses found nothing notable (no rabbit-holes or tool-availability misses).

### Changes made

1. `.pi/prompts/plan-issue.md` — added an unconditional breaking-change classification step to the `## Decide` section (before the ambiguity paragraph), so the breaking determination no longer hides behind the `ask-user` ambiguity gate.
   Names the non-obvious case explicitly: a bug fix that changes a default is breaking.
