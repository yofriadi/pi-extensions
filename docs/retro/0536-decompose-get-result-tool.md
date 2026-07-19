---
issue: 536
issue_title: "pi-subagents Phase 20 Step 2: decompose get-result-tool.execute"
---

# Retro: #536 — pi-subagents Phase 20 Step 2: decompose get-result-tool.execute

## Stage: Planning (2026-07-13T00:00:00Z)

### Session summary

Planned the decomposition of `GetResultTool.execute` (61 lines, 15 cyclomatic, CRAP 63.6) into a thin wait/consume shell plus a pure report formatter in a new `src/tools/get-result-report.ts`, mirroring the existing `result-renderer.ts` pure-formatter pattern.
The formatter takes a narrow `AgentReport` value object (12 fields, all read) and exposes `renderStatsParts` / `renderReportBody` / `formatAgentReport`; the shell gathers the report via a private `buildReport` and delegates.
Produced a two-step plan (atomic extract-and-rewire refactor → docs/skill sync) filed at `docs/plans/0536-decompose-get-result-tool.md`.

### Observations

- Confirmed Step 1 ([#535]) has landed — the current `get-result-tool.ts` already calls `this.notifications.consume(id)` (no `record.notification?.` reach-through), so this step builds cleanly on the delivered Step 1 interface.
- Release is the batch tail: `Release: batch "result-delivery"` with Step 2 as the tail, so `**Release:** ship now — batch tail` — the batched release-please PR (Step 1 + Step 2) merges at ship time.
- The extraction is a genuine design improvement (not procedure-splitting): the formatter returns a value, owns the stats/body assembly as a testable unit, and is fed a narrow ISP value object rather than the full `Subagent` — the whole point is collapsing the CRAP score by making the assembly directly unit-testable.
- Key mechanical constraint flagged for TDD: the new formatter export **must** be wired into `execute` in the same commit it is added, or `pnpm fallow dead-code` (a CI gate) trips on the unused export — so extract-and-rewire is one atomic step, not two.
- Behavior-preservation is the dominant risk: the formatter body is a line-for-line transcription of today's inline assembly (separators, `Math.round`, `?? "No output."`, conversation header), pinned by new character-level formatter tests plus the retained `get-result-tool.test.ts` body/verbose assertions.
- Preserved invariants carried from Step 1: the pre-await "Bug 1" consume ordering and the single `consume(id)` tell (no record reach-through); the shell keeps both consume sites verbatim.
  Moving the terminal consume ahead of `buildReport` is behavior-neutral (consume mutates `notifications`; report building only reads the record).
- No `ask_user` gate: the issue is the operator's own, refactor-only, and the decomposition is roadmap-specified with no design ambiguity.

## Stage: Implementation — TDD (2026-07-13T23:50:00Z)

### Session summary

Implemented both planned TDD steps: (1) extracted the pure report formatter into `src/tools/get-result-report.ts` (`AgentReport` value object plus `renderStatsParts` / `renderReportBody` / `formatAgentReport`) and rewired `GetResultTool.execute` to gather the report via a new private `buildReport` method and delegate to the formatter, in one atomic commit; (2) synced `docs/architecture/architecture.md` (module tree, Step 2 `✅` heading + `Landed:` bullet, roadmap Mermaid `S2` tick, discovery-finding-4 prose) and `.pi/skills/package-pi-subagents/SKILL.md` (Tools domain row 8 → 9, file total 56 → 57).
Test count: 62 → 63 files, 946 → 960 tests (14 new formatter unit tests; `test/tools/get-result-tool.test.ts` unchanged, matching the plan's "no structural rewrite" expectation).
Full monorepo `pnpm run check`, `pnpm run lint`, `pnpm run test`, and `pnpm fallow dead-code` all green; no lockfile changes.
Pre-completion reviewer: **PASS** on all sections (deterministic checks, code design, docs forward/reverse, test artifacts, Mermaid, cross-step invariants, follow-up issues).

### Observations

- The `tidy-first-assessor` found no preparatory tidying warranted — `execute` was already organized into clearly comment-delimited sections that mapped 1:1 onto the plan's extracted pieces, and the plan's own `fallow dead-code` constraint (formatter must be wired in the same commit it's added) forbids splitting the extraction into two commits, so there was no legitimate tidy-first move available.
- The extraction landed exactly as planned — no deviations.
  The plan's code sketches were transcribed near-verbatim; the only judgment call was ordering the terminal `consume()` call before `buildReport()` in the shell (both plan and implementation agree this is behavior-neutral since `buildReport` only reads the record).
- Confirmed via `fallow health --complexity` that `get-result-tool.execute` no longer appears in the complexity findings, verifying the plan's Goal ("off the fallow high-complexity list") — the monorepo-wide `fallow health` still exits non-zero on pre-existing unrelated findings in other packages (`pi-permission-system`, `pi-autoformat`), which is expected and out of scope.
- Release remains `ship now — batch "result-delivery" tail`; this issue completes the batch opened by Step 1 (#535), so the batched release-please PR should be merged at ship time.

## Stage: Ship (worktree) (2026-07-14T03:35:00Z)

### Session summary

Pre-push checks passed clean: `pnpm run lint` (root) and `pnpm fallow dead-code` (root) both succeeded with no findings.
The plan's `**Release:** ship now — batch "result-delivery" tail (this issue completes the batch)` marker still applies — this step completes the batch opened by Step 1 (#535), so the batched release-please PR should be merged at land/ship time, not deferred further.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-536--/2026-07-14T03-30-27-749Z_019f5ead-0f25-7fe6-87b8-9f59f0c7834a.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No new findings at this stage — pre-completion review already ran PASS during the TDD stage.
Branch is about to be rebased onto `origin/main`; no conflicts expected (no other work has landed on `main` touching `packages/pi-subagents/` since this branch's baseline fetch, per the Step 1 (#535) retro's own ship-stage note).

## Stage: Final Retrospective (2026-07-14T18:46:24Z)

### Session summary

Four sessions across the parallel-worktree flow (Planning → TDD → Ship (worktree) → Land) shipped Phase 20 Step 2: `GetResultTool.execute` decomposed into a thin wait/consume shell plus a pure `get-result-report.ts` formatter, released as `pi-subagents-v18.0.2` completing the `result-delivery` batch (#535 + #536).
The land session (`/land-worktree 536`) ran the flow clean — ff-merge, push, CI PASS, issue close, release-please PR #589 merged by rebase, worktree torn down — with zero rework across all four stages.
The execution was notably friction-free: pre-completion review PASSed on the first pass, the rebase and ff-merge were clean, and the release bumped only the expected package.

### Observations

#### What went well

- The whole multi-session flow landed with no deviations from the plan and no rework — the plan's code sketches transcribed near-verbatim, the extraction hit its CRAP target, and every gate (pre-completion PASS, clean rebase, clean ff-merge, single-package release) passed first try.
- The `tidy-first-assessor` correctly recognized there was *no* legitimate preparatory move: `execute` was already comment-delimited into sections mapping 1:1 onto the plan's extracted pieces, and the `fallow dead-code` same-commit-wiring constraint forbade splitting the extraction — so it recommended nothing rather than inventing busywork.
- The land session's judgment checkpoints were all navigated correctly despite running on a reasoning-weak model (see Diagnostic details): it identified that only #536 was open (checking #535/#443/#470 states), read the plan's `**Release:** ship now` marker, and verified PR #589 bumped only `pi-subagents` before merging.

#### What caused friction (agent side)

- `other` — the land session's issue-range sweep used `grep -oP` (call 17), which fails on macOS BSD `grep` (no `-P`/PCRE support), then self-corrected to `grep -Eo` on the next call (call 18).
  Impact: one wasted tool call, self-corrected immediately, no rework.

#### What caused friction (user side)

- None.
  The operator's involvement was routine oversight of an autonomous flow; no earlier context-sharing or redirecting question would have changed the outcome.

### Diagnostic details

- **Model-performance correlation** — stage-to-model assignments were well-matched at the judgment-heavy ends and defensible in the middle: Planning ran on `anthropic/claude-opus-4-8` (design evaluation — procedure-splitting vs. genuine improvement, ISP value-object shape, invariant preservation), TDD + Ship ran on `anthropic/claude-sonnet-5` (implementation + mechanical git), and this Final Retrospective on `anthropic/claude-opus-4-8` (synthesis).
  The **Land** session ran on `opencode-go/deepseek-v4-flash`, a reasoning-weak model.
  The land flow is predominantly mechanical (ff-merge, push, CI watch, teardown), but it carries three judgment checkpoints — which issues to close, constructing the close comment, and interpreting the plan's `**Release:**` marker to release-vs-defer — all navigated correctly here.
  No quality mismatch materialized, but the land flow's judgment content is a latent risk on a weak model; worth watching if a future land involves a deferred-release marker or a multi-issue close.
- **Feedback-loop gap analysis** — no gap.
  The TDD session verified incrementally: `pnpm run check` after the interface change (per the `testing` skill's type-check-before-commit rule), the affected test file after each Red/Green, then the full suite + root lint + `fallow dead-code` after the last step — not a single end-of-session batch.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-subagents/docs/retro/0536-decompose-get-result-tool.md`.
   No `AGENTS.md` or `.pi/prompts/` changes — the session was friction-free and produced no process-change proposals (a single self-corrected `grep -oP` slip and a model-selection observation, neither warranting a rule).

[#535]: https://github.com/gotgenes/pi-packages/issues/535
