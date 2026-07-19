---
issue: 375
issue_title: "Extract run-listener and workspace-bracket collaborators from Subagent"
---

# Retro: #375 — Extract run-listener and workspace-bracket collaborators from Subagent

## Stage: Planning (2026-06-14T19:25:00Z)

### Session summary

Read issue #375 (Phase 17 Step 4 — core consolidation), loaded the package, code-design, design-review, testing, colgrep, and markdown skills, and explored `subagent.ts`, `workspace.ts`, `subagent-manager.ts`, and `subagent.test.ts`.
Produced a 4-step plan in `packages/pi-subagents/docs/plans/0375-extract-run-listener-workspace-bracket.md` extracting a `RunListeners` collaborator and a `WorkspaceBracket` collaborator out of the 488-LOC `Subagent` class.

### Observations

- The issue's first-cut `attach(unsub, detach)` sketch does not match the real call pattern: `wireSignal` fires at run-start and `attachObserver` after session creation, and `resume()` only attaches the observer — so `RunListeners` exposes the two attach points separately (`wireSignal` / `attachObserver` / `release`), not a single combined `attach`.
- The issue's "three dispose paths" is really **two** `dispose()` call sites (`completeRun`, `failRun`); `run()`'s prepare-failure catch has no prepared workspace to dispose.
- The two dispose sites have genuinely different lifecycle semantics — `completeRun` derives status from the result, folds the addendum, and lets a throw propagate; `failRun` hardcodes `"error"`, discards the addendum, and is best-effort `try/catch`.
  Per the code-design structural-duplication heuristic, I kept them separate: `WorkspaceBracket.dispose()` centralizes the *logic* (the `if (prepared)` guard + addendum unwrap) in one place but deliberately does **not** wrap `try/catch`, so each caller's error handling is preserved line-for-line.
  This honestly satisfies the issue's "disposal logic in exactly one place" without forcing a discriminator parameter.
- `WorkspaceBracket` captures the provider *resolver* (`execution.getWorkspaceProvider`), not the provider, so resolution stays at run-start — matching today's `getWorkspaceProvider?.()` timing — while letting the bracket be constructed in the `Subagent` constructor (construct-complete, preserving the Step 2 invariant).
- Per the #374 retro lesson, I added an "Invariants at risk" section: the three prior Phase 17 invariants (at-spawn `promise`, construct-complete, zero external field writes) are each already pinned by a named test and are low-risk here because this step does not touch `start`/`scheduleVia`/`_promise` or add optional init fields.
- Step 3 (wiring) must be atomic: removing the public `wireSignal`/`attachObserver`/`releaseListeners` methods breaks `subagent.test.ts` at the type level, so the `describe`-block deletions land in the same commit.
- Suite is at 982 tests (verified by running the suite); expect roughly +5 net (≈ −7 redundant `Subagent` listener tests, +6 each new collaborator suite).
- First-party issue (author `gotgenes` == gh user) with an unambiguous proposed change, so the `ask-user` gate was skipped.
- Commit types are `test:`/`refactor:`/`docs:` — internal-only, no release-please bump; release cadence is a ship-time decision flagged in Risks.

## Stage: Implementation — TDD (2026-06-14T21:40:00Z)

### Session summary

Implemented all 4 plan steps in 4 commits (2 `refactor:`, 1 additional `refactor:` for the wiring step, 1 `docs:`).
Test count went from 982 to 994 (+12: 7 `RunListeners` tests + 13 `WorkspaceBracket` tests − 8 redundant `Subagent` listener tests removed).
`subagent.ts` landed at 448 LOC (target was ≤ 450).
Pre-completion reviewer returned WARN (2 non-blocking findings; the doc metric rows were fixed inline before committing).

### Observations

- **Microtask-boundary deviation from plan**: the plan showed `const cwd = await this.workspaceBracket.prepare(...)` unconditionally in `run()`.
  `async` functions always create a microtask boundary even when they return immediately (no-provider path), which broke `subagent-manager.test.ts`'s synchronous assertion that `factory.toHaveBeenCalledOnce()` — the factory call had been deferred to the next microtask tick.
  Fix: added `WorkspaceBracket.hasProvider()` (a synchronous provider-existence check) and guarded the `await` with `if (this.workspaceBracket.hasProvider())`, restoring the original timing semantics.
  The `hasProvider()` method is a mild Tell-Don't-Ask trade-off (the caller queries bracket state to decide whether to call it), documented at the call site and noted as a WARN by the pre-completion reviewer.
  The underlying cause: `SubagentManager.spawn()` always injects `getWorkspaceProvider: () => this._workspaceProvider` as a function, even when no provider is registered, so the naïve `if (this.execution.getWorkspaceProvider)` guard was always true.
- **Step 3 collapsed into one commit as expected**: removing `wireSignal`/`attachObserver`/`releaseListeners` from `Subagent` broke `subagent.test.ts` at the type level; the redundant `describe` block deletions and the production wiring landed atomically.
- **LOC target met**: `subagent.ts` went from 488 → 448 (plan estimated ≤ 450; actual 448).
  The gap between estimated removal (≈ 40 lines) and actual (40 lines) was closed by trimming the stale module-level doc comment and redundant field-level comments.
- **Prior-step invariants held**: all three Phase 17 cross-step invariants (at-spawn `promise`, construct-complete, zero external field writes) passed grep-verification and the 994-test suite confirms no regressions.
- **Pre-completion reviewer WARN findings** (both addressed inline):
  1. `architecture.md` health-metric rows still carried "→ 59 after Step 4" annotations after landing — updated to actual counts (60 files, 8,356 LOC) and the docs commit amended.
  2. `WorkspaceBracket.hasProvider()` TDA trade-off — documented in the `run()` call-site comment; noted here for Phase 18 awareness.

## Stage: Final Retrospective (2026-06-15T02:04:42Z)

### Session summary

Shipped issue #375 (Phase 17 Step 4) cleanly across four stages in one continuous session: planning produced a 4-step plan, TDD implemented it in 4 commits (suite 982 → 994), shipping pushed/verified-CI/closed-the-issue and merged release-please PR #406 (`pi-subagents-v16.2.1`, which actually carried #374's `fix:` — #375's `refactor:`/`docs:` commits trigger no bump).
The only substantive friction was a single self-identified plan deviation in TDD (a microtask-boundary timing trap), resolved inside the same commit with no rework, reorder, or user correction.

### Observations

#### What went well

- **The cross-step-invariant discipline from the #374 retro paid off a second time.**
  The #374 process retro added the "Invariants at risk" plan section; the #375 plan used it to list the three prior Phase 17 invariants (at-spawn `promise`, construct-complete, zero external field writes), each already pinned by a named test.
  All three held through the extraction with a green suite — the regression class that bit #374 did not recur.
  This is the first time the new section was load-bearing on a *fresh* issue rather than as a post-hoc correction.
- **Planning corrected the issue's own design sketch instead of implementing it literally.**
  The issue proposed `RunListeners.attach(unsub, detach)` and "three dispose paths collapse into one"; the plan recognized the two handles attach at different lifecycle moments (so `attach` had to split into `wireSignal`/`attachObserver`/`release`) and that the two dispose sites have genuinely different error-handling semantics (so they stay separate per the structural-duplication heuristic).
  Treating the issue body as a hypothesis, not a spec, avoided a wrong abstraction.

#### What caused friction (agent side)

- `missing-context` — the plan's Design Overview sketched `const cwd = await this.workspaceBracket.prepare(...)` **unconditionally**, but the original `run()` only awaited inside `if (provider) { ... }`, keeping the no-provider path synchronous up to the factory call.
  An always-`async` helper adds a microtask boundary even when it returns immediately, so the queued-abort test in `subagent-manager.test.ts` ("abort removes a queued agent without ever running it") failed: it asserts `factory.toHaveBeenCalledOnce()` synchronously, and the factory call had been deferred a tick.
  The first fix attempt (`if (this.execution.getWorkspaceProvider)`) also failed because `SubagentManager.spawn()` always injects `getWorkspaceProvider: () => this._workspaceProvider` as a function regardless of whether a provider is registered, so the guard was always true.
  Resolved by adding `WorkspaceBracket.hasProvider()` (a synchronous predicate) and guarding the `await` with it.
  Impact: ~2 test-run cycles inside TDD step 3, one extra method (`hasProvider`) plus 2 unit tests not in the plan, and a mild Tell-Don't-Ask trade-off the pre-completion reviewer flagged as WARN.
  Self-identified via the failing test; no commit reorder, no rework beyond the in-commit fix.
- `other` (minor) — `subagent.ts` first landed at 469 LOC, above the plan's ≤ 450 gate; two trim passes (stale module-level doc comment, redundant field comments) brought it to 448.
  The trimmed comments were genuinely stale post-extraction, so the trim was legitimate, but the LOC estimate ("≈ 40 lines removed") was optimistic about the structural change alone.
  Impact: 2 extra edits, no rework.

#### What caused friction (user side)

- None.
  The four-stage flow ran end-to-end on prompt templates with zero mid-stream user corrections or strategic interventions — the work was clean enough that none were needed.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `anthropic/claude-opus-4-8` (pinned via `plan-issue.md`, appropriate for judgment-heavy design); TDD on `anthropic/claude-sonnet-4-6` (appropriate); the pre-completion reviewer subagent on its frontmatter default; Retro on `anthropic/claude-opus-4-8` (pinned).
  The **ship stage ran on `opencode-go/deepseek-v4-flash`** — the same weak-model-on-release-management pattern flagged in the #374 retro.
  It again executed cleanly, including the non-trivial reasoning that PR #406 mapped to #374 not #375 and the `UNSTABLE`/empty-rollup `GITHUB_TOKEN` diagnosis.
  Second consecutive clean run, so the risk remains theoretical (irreversible ops on a weak model) rather than demonstrated harm.
- **Escalation-delay tracking** — the microtask friction was not a rabbit hole: the diagnosis moved methodically (failing test → `concurrency-limiter.ts` → `subagent-manager.ts:156` injection point → root cause) across ~2 test-run cycles, under the 5-call flag threshold.
- **Unused-tool detection** — the friction was exact-symbol tracing (`grep` for `getWorkspaceProvider`), which `grep` handled correctly; no Explore/colgrep dispatch was warranted.
- **Feedback-loop gap analysis** — verification was incremental throughout: per-file `vitest` after each red/green, `pnpm run check` after the interface-change step, full suite + lint + `fallow dead-code` before the pre-completion review.
  No end-only-verification gap.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a bullet under `### Interface and type changes` on the conditional-`await` → always-`async` microtask-boundary trap (sibling to the existing runtime-vs-typecheck timing rule).
2. `packages/pi-subagents/docs/retro/0375-extract-run-listener-workspace-bracket.md` — added this Final Retrospective stage entry.
3. Considered but not landed (operator-declined or out of scope): pinning `/ship-issue` to a stronger model (recurrence of the #374 finding, no demonstrated harm this session), a `plan-issue` rule on preserving conditional awaits in extracted-method sketches, and a rule against trimming comments to hit a LOC gate.
