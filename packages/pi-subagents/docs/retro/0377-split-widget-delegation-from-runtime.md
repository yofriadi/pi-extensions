---
issue: 377
issue_title: "Split widget delegation out of SubagentRuntime"
---

# Retro: #377 — Split widget delegation out of SubagentRuntime

## Stage: Planning (2026-06-15T23:16:29Z)

### Session summary

Produced the implementation plan for removing the `widget` field and five relay methods from `SubagentRuntime`.
Investigation surfaced that the issue's stated approach ("construct the widget before its consumers, pass the handle to `NotificationManager`") is infeasible as written — `NotificationManager` is a transitive *dependency* of the widget, forming a genuine construction cycle (`NotificationManager → widget → manager → observer → NotificationManager`).
The plan dissolves the cycle instead of relocating its late seam.

### Observations

- **Operator steer #1 (seam placement):** rejected both a setter on the observer and a forward-referenced `let widget` closure, citing "no setters, instantiate ready-to-work, constructor DI" (principle 8).
  The forward-ref option would also have trip `prefer-const` and reintroduced the exact eslint-disable smell Phase 17 Step 1 deleted.
- **Operator steer #2 (tidy-first, Kent Beck):** prompted the prep/easy decomposition.
  The hard, cycle-breaking work (dissolve `NotificationManager`'s widget dependency by giving `AgentWidget` self-seeding of `finishedTurnAge`) lands first as a behavior-preserving commit; the relay-method removal then becomes a mechanical "easy change."
- **Behavior-preservation argument:** the widget's 80ms timer is always running at a background completion (the agent was active), and linger expiry is turn-based, so seeding ≤80ms later lands in the same turn — rendered outcome is identical.
  This is the load-bearing claim; the new `agent-widget.test.ts` self-seed test pins it.
- **Three seam options recorded** in the plan's Design Overview for traceability: late-observer setter (rejected), forward-ref closure (rejected), dissolve (chosen).
- **Scope guard:** kept foreground-runner's explicit `markFinished` (idempotent) rather than removing it, and deferred the event-subscription widget model to Phase 18.
  Two open questions logged (single `AgentToolWidget` vs. split deps; redundancy of foreground `markFinished`).
- **Not breaking / not public:** `runtime.ts` is internal (not in the rolled `service.ts` type bundle), so `verify:public-types` is not required.
- **Invariants at risk** flagged against Phase 17 Steps 1 and 5 (forward-ref dance, `index.ts` line budget); grep acceptance checks fold into the final implementation step.

## Stage: Implementation — TDD (2026-06-15T20:19:00Z)

### Session summary

Executed all four planned steps in order: widget self-seeding (`feat`), `NotificationManager` widget-dependency dissolve (`refactor`), direct widget injection + relay-method removal (`refactor`), and the architecture-roadmap update (`docs`).
Test count went 1009 → 1005 (+3 widget self-seed tests, −7 removed relay/field tests).
All deterministic checks green; pre-completion reviewer returned WARN (non-blocking).

### Observations

- The tidy-first sequencing held up exactly as planned: Step 2 broke the cycle while the runtime relay methods were still in place (repo stayed green), making Step 3's export/field removal a clean atomic change.
- The cycle dissolve produced two **stale fallow suppressions** on `AgentWidget.setUICtx`/`onTurnStart` — they were `unused-class-member`-suppressed because the methods were previously reached only through the runtime relay; direct injection made them visibly used.
  Removed both; amended into the Step 3 refactor commit.
- Widget-class testing required constructing `AgentWidget` with a cast manager stub (`as unknown as SubagentManager`) and a recording `UICtx`; observability of the private `finishedTurnAge` is via the `setWidget` clear-vs-register signal, which cleanly distinguishes seeded-then-aged-out from never-seeded.
- `sed` was needed for the runner/spawner test files because the widget arg appeared both inline and as standalone multiline-call lines; a `^\s*runtime,$` line match safely retargeted only the widget positional arg (never `runtime.agentActivity`).
- Two commit-hygiene corrections: an `index.ts` comment-trim fixup was first amended into the `docs` commit by mistake, then moved into the Step 3 `refactor` commit via `reset --soft` + selective re-stage (fixups must not land in `docs:` commits).
- **Reviewer verdict: WARN.**
  Sole finding: `index.ts` is 177 lines (Step 5's aspirational "<170" was already overshot at its own landing, 177); the comment trim kept Step 6 net-neutral.
  Cosmetic, prose-pinned only, non-blocking.
- Cross-step invariants verified by grep: no `let widget` / `prefer-const` forward-ref (Step 1), no `runtime.widget` / `.widget =` / `WidgetLike` anywhere (the issue's core outcome).

## Stage: Final Retrospective (2026-06-16T00:30:08Z)

### Session summary

The issue shipped cleanly across plan → TDD → ship as `pi-subagents-v16.3.0`, closing #377 and resolving Phase 17 Step 6.
The design arc was the highlight: an operator-driven pivot from the issue's stated approach (relocate the late seam) to dissolving the construction cycle entirely, sequenced tidy-first so the hard cycle-break landed before the mechanical relay removal.
The friction was concentrated in mechanical `Edit`-tool execution, not in design or verification.

### Observations

#### What went well

- **Operator design steers compounded into the right architecture.**
  The planning `ask_user` surfaced the construction cycle; the operator's "no setters, instantiate ready-to-work" steer eliminated two of three seam options, and the Kent Beck "make the change easy" prompt (turn 21) produced the tidy-first decomposition.
  This is the pattern working as intended: the agent finds the constraint, the operator picks the principle, the agent verifies feasibility before committing.
- **Behavior-preservation was argued before it was coded.**
  The ≤80ms-within-same-turn linger argument was established in planning and pinned by three new `agent-widget.test.ts` tests in TDD — no trial-and-error on the load-bearing claim.
- **Tidy-first sequencing kept the repo green at every commit.**
  Step 2 broke the cycle while the relay methods still existed, making Step 3's export removal a clean atomic change.
- **Cheap model handled ship correctly.**
  Ship ran on `opencode-go/deepseek-v4-flash` and executed the full mechanical sequence (push, CI watch, release-now `ask_user`, the `UNSTABLE` merge-state edge case via `gh pr merge`) with zero errors — an appropriate model-task match, not a mismatch.

#### What caused friction (agent side)

- `other` (tool friction) — `Edit` on `runtime.ts` failed twice (turns 45, 47) trying to delete the widget-delegation block bounded by a decorative `// ── Widget delegation methods ────` comment rule; the long run of `─` could not be reproduced exactly.
  Fell back to `sed -i '' '75,104d'`, which over-deleted the class-closing brace and the next doc-comment opener (turn 51), needing a repair edit (turn 52).
  Impact: ~5 extra tool calls and a near-miss structural breakage on a single block deletion.
- `instruction-violation` (user-caught) — the operator interjected "Use unicode literal characters, not escapes, per system prompt" (turn 49).
  The system prompt already carries an "Edit Tool and Unicode Characters" section; the box-drawing match failures read to the operator as escape misuse.
  Impact: one user correction; reinforced the same `Edit`-matching friction above.
- `other` (malformed payload) — the first `architecture.md` Step 6 edit was rejected for an invalid `oldText_unused` property I invented (turn 87), followed by empty assistant turns and two operator "Try again" nudges (turns 89, 94) before a clean single edit landed (turn 95).
  Impact: ~4 turns + 2 user nudges on one prose edit.
- `other` (commit hygiene) — the `index.ts` comment-trim fixup was first amended into the `docs` commit (turn 108), then moved into the `refactor` commit via `reset --soft` (turn 109); separately, the stale-suppression fixup required the same maneuver during TDD.
  Both self-identified and corrected.
  Impact: two extra `reset --soft` + re-stage cycles; no rework to shipped code.

#### What caused friction (user side)

- The "no setters, instantiate ready-to-work" principle that drove the entire design only surfaced when the planning `ask_user` forced it.
  Stated in the issue body or a standing design note, it would have let planning reach the dissolve approach without the round-trip — though the round-trip was cheap and the outcome correct.

### Diagnostic details

- **Model-performance correlation** — Planning and TDD ran on `anthropic/claude-opus-4-8` (judgment-heavy design + implementation; appropriate).
  The pre-completion-reviewer subagent ran on `anthropic/claude-sonnet-4-6` per its frontmatter (appropriate for review).
  Ship ran on `opencode-go/deepseek-v4-flash` — a cheap model on mechanical orchestration, completed without error.
  No mismatch found.
- **Escalation-delay tracking** — no `rabbit-hole` exceeded the 5-consecutive-call threshold; the `Edit`/`sed` friction was 2–3 calls per location and self-resolved.
- **Unused-tool detection** — nothing notable; the friction points were mechanical edits, not missing context, so no Explore/`colgrep` dispatch would have helped.
- **Feedback-loop gap analysis** — verification was incremental and exemplary: `pnpm run check` after the shared-interface change in Step 2 (turn 43) and again mid-Step-3 (turns 69, 75, 78, 81); per-file `vitest run` after each Red and Green; `fallow dead-code` from repo root before ship.
  No end-only verification anti-pattern.

### Changes made

1. `AGENTS.md` — appended two sentences to the "Edit tool batches" subsection: anchor edits on adjacent unique code lines rather than decorative `─`/`═` comment rules, and re-read after a `sed` line-number deletion to confirm an enclosing brace survived.
