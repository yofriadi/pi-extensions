---
issue: 403
issue_title: "Pressing Escape does not stop subagent/background agent"
---

# Retro: #403 — Pressing Escape does not stop subagent/background agent

## Stage: Planning (2026-06-14T00:00:00Z)

### Session summary

Investigated the third-party bug report that ESC does not stop subagents and traced the abort path through both the package and the pinned Pi SDK peer deps.
Found that foreground subagents already receive the parent abort signal end-to-end, while background subagents are detached with no interrupt wiring — the reproducible bug.
Confirmed direction with the operator via `ask_user` (third-party gate): implement ESC-to-abort for both modes, with a foreground guard test, aborting all running and queued background agents.
Wrote and committed plan `0403-abort-subagents-on-interrupt.md`.

### Observations

- Key SDK fact that de-risks the design: in `pi-agent-core` `agent.js`, each run creates a fresh `AbortController` and `finishRun()` discards it **without** aborting on normal completion.
  So the parent signal's `abort` event fires only on a real ESC interrupt — latching `abortAll()` to it will not spuriously kill background agents at turn end.
- Chosen mechanism: a small `InterruptHandler` driven by `pi.on("turn_start", ...)`, re-latching `ctx.signal` each turn so the latch tracks the live per-run signal even across runs and tool-less turns.
  `turn_start` was preferred over `tool_execution_start` because a background agent can outlive the run that spawned it; a turn-level latch still holds the current run's signal when the user interrupts a later tool-less turn.
- Reused the existing `manager.abortAll()` rather than adding `abortBackground()`.
  Foreground agents are already aborted via their own `wireSignal`, so `abortAll()`'s overlap is redundant-but-harmless (status-guarded `abort()`, idempotent `markStopped`).
  The manager does not store `isBackground` on the record, so distinguishing modes would need extra state — deferred as an Open Question.
- Classified as a non-breaking `fix:` (not `fix!:`): no config key, default, or output shape changes; detached-survives-ESC was a limitation, not a contract.
  Noted the behavior change explicitly in Goals.
- Foreground path is believed already-correct from the code trace; the plan adds a regression guard in `subagent-session.test.ts` (`forwardAbortSignal` is currently untested for the parent-signal path) and will fix only if the guard fails.

## Stage: Implementation — TDD (2026-06-14T18:00:00Z)

### Session summary

Completed all three TDD cycles against a green baseline (967 tests).
Added the foreground-abort guard, implemented `InterruptHandler` + `turn_start` wiring, and updated the architecture doc.
Test count went from 967 to 975 (+8: 6 `InterruptHandler` unit tests, 2 foreground guard tests); `check`, `lint`, `test`, and `fallow dead-code` all pass.

### Observations

- The foreground guard (Step 1) passed on the first run, confirming the planning-stage code trace: the parent signal already reaches the child `session.abort()` via `forwardAbortSignal`.
  No code fix was needed, so it landed as `test:` exactly as the plan anticipated.
- `InterruptHandler` came out clean against the `code-design` heuristics — one field read from `ctx`, one method on a one-method `InterruptManager` interface, latch state owned internally, `{ once: true }` listener.
  The reviewer's code-design check was PASS with no structural concerns.
- `abortAll()` gained a second narrow-interface consumer (the new handler) on top of the shutdown path; `fallow dead-code` stayed green, so its existing `fallow-ignore-next-line unused-class-member` comment was left untouched.
- Pre-completion reviewer: **WARN**.
- Reviewer warnings: stale source-file counts in `architecture.md`.
  Fixed the current-state prose claim (`56` → `58` source files).
  Left the fallow health-metrics snapshot rows (line ~650, `7,778 (57 files)`) intact — those are point-in-time analysis tables where the file count was computed alongside LOC and other metrics, so bumping one cell in isolation would desync the snapshot.
  Amended the fix into the docs commit (not yet pushed).

## Stage: Final Retrospective (2026-06-14T20:00:00Z)

### Session summary

Shipped issue #403 end-to-end across four stages (plan → TDD → ship → live verification): root-caused the bug, implemented the `InterruptHandler` (single `fix:` commit), guarded the already-working foreground path, and released `pi-subagents-v16.1.1`.
The operator then live-tested all three abort paths (background subagent, foreground subagent, main agent) and confirmed a single Escape aborts each immediately.
Near-zero rework: one reviewer WARN (stale doc file count) fixed by amend, no follow-up commits, no failed CI.

### Observations

#### What went well

1. The planning-stage SDK trace paid dividends two stages later.
   When the operator asked during live testing "is it supposed to take two Escapes or just one?", the answer came straight from the `restoreQueuedMessagesToEditor → agent.abort()` trace captured at planning time — no re-investigation.
   The same trace explained the main-agent and foreground-subagent abort paths immediately.
2. The keystone de-risking finding (`finishRun()` discards the per-run `AbortController` without aborting it, so the `abort` event fires only on a real interrupt) held up in practice — no spurious turn-end aborts were observed in live testing.
3. The foreground guard test passed on its first run, confirming the planning trace, so the plan's pre-typed `test:` commit type was correct and the whole implementation landed with zero rework.
4. Verification was incremental throughout TDD: green baseline first, per-step affected-file runs, `pnpm run check` after the interface-touching step, and full `test`/`check`/`lint`/`fallow` at the end.

#### What caused friction (agent side)

1. `missing-context` — when adding the new source file `interrupt.ts`, I updated the `handlers/` directory listing in `architecture.md` but not the prose total-file count at line 277 (which was already stale: `56` vs the pre-change actual of `57`).
   Impact: one pre-completion reviewer WARN, fixed by amending the docs commit before push — no rework, no extra commit, no CI cost.

#### What caused friction (user side)

1. None.
   The operator's involvement was high-value: the third-party-issue direction gate (planning) and the live three-path abort verification (post-ship) validated behavior that unit tests cannot reach (real ESC keypress through the interactive TUI).

### Diagnostic details

1. Model-performance correlation — ship stage and the `pre-completion-reviewer` subagent both ran on `claude-sonnet-4-6` (mechanical orchestration and checklist review — appropriate); retro synthesis on `claude-opus-4-8` (judgment — appropriate).
   No mismatch.
2. Escalation-delay tracking — no `rabbit-hole` friction points; the planning SDK dig was productive forward exploration, not repeated calls against one error.
3. Unused-tool detection — the planning SDK trace navigated minified `node_modules/.pnpm` dist files by hand; `colgrep` (project-code semantic search) and an Explore subagent (project-code understanding) were not suited to reverse-engineering pinned third-party `dist` JS, so no tool was wrongly skipped.
4. Feedback-loop gap analysis — no gap; verification ran incrementally per TDD step, not only at the end.

### Changes made

1. Added an "Abort / interrupt signal lifecycle" section to `.pi/skills/pi-extension-lifecycle/SKILL.md` documenting the per-run `AbortController`, the ESC → `agent.abort()` path, the `finishRun()` discard-without-abort behavior, and the `ctx.signal` / `tool.execute(signal)` exposure — so future interrupt-timing work need not re-derive it from the pinned SDK `dist` files.
