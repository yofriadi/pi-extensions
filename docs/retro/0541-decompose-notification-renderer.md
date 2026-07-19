---
issue: 541
issue_title: "pi-subagents Phase 20 Step 7: decompose the notification renderer"
---

# Retro: #541 — pi-subagents Phase 20 Step 7: decompose the notification renderer

## Stage: Planning (2025-06-16T00:00:00Z)

### Session summary

Planned the decomposition of the `createNotificationRenderer` arrow in `src/observation/renderer.ts` into three pure, theme-free helpers (`resolveStatusPresentation`, `buildStatsParts`, `buildPreviewLines`) with the arrow reduced to a thin composing wrapper.
The plan is a behavior-neutral `refactor:` landing across four TDD steps, filed at `packages/pi-subagents/docs/plans/0541-decompose-notification-renderer.md`.

### Observations

- Verified each extracted helper returns a value and owns a real decision (status→presentation OCP dispatch, stat selection, truncation) — not procedure-splitting, per the `code-design` gate.
- `buildStatsParts` takes an ISP-narrowed `Pick<NotificationDetails, …>` (`StatsSource`) rather than the full details type, matching the file's existing narrow-interface discipline from Step 5 (`#539`).
- Chose to keep the `⎿` marker, indentation, and `theme.fg` styling in the wrapper (presentation) so the exact whitespace layout is preserved; helpers return only content lines.
- Release marker is `ship independently`; noted explicitly that a `refactor:`-only plan cuts no release on its own and auto-batches into the next unhidden release (per AGENTS.md, so as not to over-claim).
- Flagged the Step 5 narrow-`RendererTheme` invariant as at-risk, pinned by the two-method `stubTheme()` in the existing test — the refactor strengthens it (helpers need no theme) and must not widen the interface.
- Architecture-doc step-mark (heading `✅`, Mermaid `S7` node, `Landed:` note) is listed as an expected doc update landed by `/tdd-plan` at completion, not deferred.
- No follow-up issues filed — nothing deferred.

## Stage: Implementation — TDD (2025-06-16T01:00:00Z)

### Session summary

Executed all four TDD steps from the plan: extracted `resolveStatusPresentation`, `buildStatsParts`, and `buildPreviewLines` as pure, exported helpers from the `createNotificationRenderer` arrow in `src/observation/renderer.ts`, then pruned one redundant wrapper test.
Each helper landed in its own red→green→commit cycle; the `tidy-first-assessor` found no preparatory refactoring warranted before starting.
Package test count went `975 → 991`; the pre-completion reviewer returned PASS.

### Observations

- `tidy-first-assessor` recommended no preparatory commits — the arrow was already visually segmented by `// Line 1:`–`// Line 4:` comments that mapped 1:1 onto the plan's three helpers, so the extraction itself was the tidying.
- Had to correct the `buildStatsParts` test's expected format strings during Red: `formatTurns` returns `⟳5≤10` (not `5/10 turns`), `formatTokens` returns `1.0k token` (singular), and `formatMs` returns `5.0s` (not `5s`) — worth re-reading a formatter's actual output before writing assertions against it, rather than inferring the shape from its name.
- In TDD step 4, pruned the `renders steered status as completed (steered)` wrapper test as fully subsumed by the new `resolveStatusPresentation` steered-case unit test (no unique composition detail beyond what the `completed`/`error` wrapper tests already establish for theme wrapping).
  All other wrapper tests were kept — each exercises genuine multi-piece theme composition (icon + bold description + dim status, or the per-line `theme.fg` loop in expanded mode) that the theme-free pure helpers cannot cover.
- Verified the plan's quantitative claim (`renderer.ts` off the fallow triage list) directly via `fallow health --targets --format json` (empty `targets` array covering the file) and `fallow dead-code` (zero issues), rather than trusting the human-readable output.
- Architecture-doc update (✅ Step 7 heading, `Landed:` note, Mermaid `S7` node) landed as its own `docs:` commit at completion, per the roadmap step-mark convention — Phase 20's phase-status row was correctly left unflipped since Steps 8–9 remain incomplete.
- Pre-completion reviewer: **PASS** — all deterministic checks, doc updates, design review, Mermaid rendering, dead-code gate, and the Step 5 (`#539`) narrow-`RendererTheme` invariant (strengthened, not just preserved) confirmed clean.
  No WARN findings.

## Stage: Final Retrospective (2026-07-16T13:32:19Z)

### Session summary

Shipped issue #541 end-to-end across four stages (plan → TDD → ship → retro) in a single continuous session with zero rework and zero deviations from the plan.
The `createNotificationRenderer` arrow was decomposed into three pure, exported helpers over four `refactor:`/`test:` commits; the pre-completion reviewer returned PASS on first dispatch, CI passed, and the issue closed with no release cut (all commits hidden/excluded types, auto-batching forward).

### Observations

#### What went well

- Exceptionally clean end-to-end execution: the plan's Module-Level Changes matched the actually-touched files exactly (`renderer.ts` + `renderer.test.ts`), every TDD step landed red→green→commit without a downstream break, and the pre-completion reviewer passed on the first dispatch.
  The plan was precise enough that implementation carried no surprises.
- The `tidy-first-assessor` correctly judged "the extraction itself is the tidying" and recommended zero preparatory commits, avoiding busywork churn on code about to be rewritten — good scope discipline from the subagent.
- Quantitative claims were verified via `fallow health --targets --format json` (empty `targets` array) and `fallow dead-code --format json` rather than grepping human-readable output, exactly per the Refs #537 rule — confirming `renderer.ts` left the triage list rather than asserting it.
- Feedback loops ran incrementally and by the book: the affected test file after every Red and Green, `pnpm run check` immediately after each shared-type change (turns 33/41/46), and the full suite + lint + fallow only at the end.
  No end-of-session verification pileup.

#### What caused friction (agent side)

- `missing-context` (self-caught, near-zero impact) — in TDD step 2, the `buildStatsParts` test expectations were first written by inferring formatter output from names (`5/10 turns`, `1.0k tokens`, `5s`).
  Caught before running Red by reading `src/ui/display.ts`, which revealed the real shapes (`⟳5≤10`, `1.0k token` singular, `5.0s`), then corrected in one edit.
  Impact: one extra `Read` + one extra `Edit`; no failed test run, no rework of committed code.
- `other` (tool portability, self-corrected in one step) — the stacked-release scan used `grep -oP` (turn 93), which BSD/macOS `grep` rejects (`invalid option -- P`); re-run as `grep -oE` (turn 94) succeeded.
  Impact: one wasted tool call.

#### What caused friction (user side)

- None.
  The operator drove the four slash commands in sequence; the plan was clear and the execution clean, so no strategic intervention or earlier context-sharing was called for — the ideal case for a well-scoped refactor.

### Diagnostic details

- **Model-performance correlation** — all four stages and both subagents were model-matched to task difficulty: planning and retro (judgment-heavy) on `claude-opus-4-8`; TDD (implementation) on `claude-sonnet-5`; both read-only subagents (`tidy-first-assessor`, `pre-completion-reviewer`) on `claude-sonnet-5`.
  The ship stage ran on `opencode-go/deepseek-v4-flash` (a lighter model) — mostly mechanical (git/CI/close), but it also handled the one judgment step (reasoning through `exclude-paths` and hidden changelog types to conclude no release cuts) correctly.
  No mismatch; the `grep -oP` slip above was the only visible cost and was self-corrected.
- **Escalation-delay tracking** — no `rabbit-hole` friction; the one tool error (`grep -oP`) resolved on the next call.
  Nothing approached the 5-call escalation threshold.
- **Unused-tool detection** — no `missing-context`/`rabbit-hole` gap a subagent or `colgrep` would have closed; the single missing-context slip was resolved by one direct `Read` of the formatter source.
- **Feedback-loop gap analysis** — no gap; verification was incremental throughout (per-step test runs, per-type-change `pnpm run check`), with the full suite/lint/fallow reserved for the end.

### Changes made

1. No prompt or `AGENTS.md` changes — the operator chose retro-file-only.
   Both friction points were self-caught with near-zero impact, and the one candidate rule (read a helper's implementation before asserting its exact formatted output) was judged too low-value to add to the `testing` skill.
   The observation is preserved here as a breadcrumb instead.
