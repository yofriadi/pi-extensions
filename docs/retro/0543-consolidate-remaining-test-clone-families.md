---
issue: 543
issue_title: "pi-subagents Phase 20 Step 9: consolidate remaining test clone families"
---

# Retro: #543 — pi-subagents Phase 20 Step 9: consolidate remaining test clone families

## Stage: Planning (2026-07-17T01:28:26Z)

### Session summary

Planned Phase 20 Step 9.
Discovery surfaced that the issue's premise has shifted: fallow 3.2.0 now excludes `**/*.test.*` from duplication detection by default, so `fallow dupes --workspace @gotgenes/pi-subagents` reports zero test clones and the "9 in-package clone groups / 81 lines" baseline is no longer measurable.
The residual duplication in the three named files is the repeated system-under-test *act* call, which the `testing` skill explicitly forbids wrapping.
The operator chose (planning `ask-user`) the **narrow arrange-only tidy + metric update** direction, so the plan retires the health metric and lands only the one genuine describe-scoped arrange hoist.

### Observations

- fallow 3.2.0's `duplicates.ignoreDefaults` is all-or-nothing: `duplicates.ignore` only *adds* patterns, so the only way to re-include test files is `ignoreDefaults: false`, which drops every built-in framework ignore repo-wide across all six packages.
  Rejected as out of scope — restoring one package's metric isn't worth repo-wide clone noise.
- The arrange for all three suites was already factored by prior steps (#378, #379 in Phase 17; Step 8 / #542 in Phase 20) — `createManager`, `arrangeQueuedPair`, `manager-stubs.ts`, `mock-session.ts`, `makeModel`, `exploreConfig`.
  The one un-hoisted arrange is the `lifecycle observer forwarding` describe in `subagent-manager.test.ts` (two tests sharing an identical 3-line setup) — the only concrete tidy in the plan.
- The plan is deliberately docs-forward: the substantive deliverable is correcting the architecture health-metrics table (retire the stale, now-unmeasurable row) and recording Step 9's real outcome, not manufacturing test churn to hit a number the tool no longer produces.
- No follow-up issue filed — nothing is deferred; the direction is confirmed and the scope is closed.

## Stage: Implementation — TDD (2026-07-17T01:37:00Z)

### Session summary

Executed the two-step plan: one behavior-preserving refactor commit (hoist the `lifecycle observer forwarding` describe's shared arrange into a describe-scoped `beforeEach`) and one docs commit (retire the Phase 20 test-clone health-metric row with a rationale note, rewrite the Step 9 `Outcome:`/`Landed:`, mark Step 9 ✅ in the heading and Mermaid `S9` node).
No red→green cycle — the change is a refactor plus doc reconciliation.
Test count unchanged (996 pass); the two observer-forwarding tests kept their explicit acts.

### Observations

- The `tidy-first-assessor` found no preparatory tidying warranted — the target describe was already small and isolated, with the file's standard `let manager` / `afterEach(dispose)` scaffolding in place.
  Its scope boundary held (its rejected list stayed within the change's touched code).
- Minor deviation from the plan sketch: kept `factory` as a local `const` inside `beforeEach` rather than a describe-level `let factory` binding, since `factory` is never referenced outside the arrange — a scope-narrowing simplification the reviewer confirmed as legitimate.
- All 9 Phase 20 steps are now ✅.
  Full phase closeout (archiving the roadmap to `docs/architecture/history/` and flipping the phase heading to complete) is a separate later editorial commit per the Phase 19 precedent, deliberately not bundled here.
- The dated 2026-07-03 discovery-findings list (finding #6, "9 in-package clone groups") was left untouched — it is a historical snapshot, not a current-behavior metric.
- Pre-completion reviewer: PASS.
  No warnings; deterministic checks all green (`check`, `lint`, full `test` suite, `fallow dead-code`); Mermaid diagrams parse; no earlier phase-step invariant regressed.

## Stage: Final Retrospective (2026-07-17T16:24:57Z)

### Session summary

Single continuous session spanning Planning → TDD → Ship → Retro for Phase 20 Step 9.
The defining moment was in planning: discovery established that the issue's premise had gone stale (fallow 3.2.0 excludes `**/*.test.*` from `dupes` by default, and the residual duplication is the system-under-test act call the `testing` skill forbids wrapping), so the `Decide` gate + `ask-user` reframed the work from "extract helpers to hit a clone number" to "retire an unmeasurable metric and land the one genuine arrange hoist."
Execution was clean: two commits (one `test:` refactor, one `docs:`), pre-completion PASS, CI green, issue closed, no release (all hidden types auto-batch).

### Observations

#### What went well

- The planning `Decide` gate did exactly its job: it treated the issue's "Proposed change" as a hypothesis, discovery falsified the premise, and `ask-user` surfaced the direction change to the operator instead of mechanically implementing a stale spec.
  This is the process working as designed on a genuinely ambiguous case — the shifted-premise catch the gate exists for.
- The `tidy-first-assessor` and `pre-completion-reviewer` both returned cleanly and their scope held; the reviewer independently confirmed the one plan deviation (`const factory` inside `beforeEach` vs. the plan's `let factory`) as a legitimate scope-narrowing simplification, so no rework was needed.

#### What caused friction (agent side)

- `other` (tooling-diagnosis, minor) — confirming why `fallow dupes` reported zero test clones took ~6 planning tool calls (two JSON `dupes` runs, then the human-readable run whose `skipped 235 files matching default duplicates ignores` note revealed the `**/*.test.*` default, then `--explain-skipped`, `--help`, and a schema read for `ignoreDefaults`).
  Running the human-readable `dupes` output first would have surfaced the skip note immediately.
  Impact: a few extra tool calls in planning; no rework — the investigation produced the finding that reframed the issue.

#### What caused friction (user side)

- None.
  The operator's single `ask-user` answer (narrow arrange-only tidy + metric update) was decisive and drove the rest of the work without further correction.

### Diagnostic details

- **Feedback-loop gap analysis** — no gap.
  Verification ran incrementally: the affected test file after the refactor, `check`/`lint` before each commit, and the full suite + `fallow dead-code` at the end.
- **Model-performance / escalation-delay / unused-tool lenses** — nothing notable.
  No `rabbit-hole` friction (the fallow diagnosis was a bounded, productive investigation, not a symptom chase); the subagent dispatches (`tidy-first-assessor`, `pre-completion-reviewer`) matched their read-only judgment tasks.

### Changes made

1. `.pi/skills/improvement-discovery/SKILL.md` — updated the fallow-capture line to note `fallow dupes` excludes test files by default (was "duplication (production vs. test)").
2. `.pi/skills/improvement-discovery/SKILL.md` — updated the Category D "Test duplication (high)" row: evidence source is now `craftsmanship-scout` reading test files (not `fallow dupes in test/`), and the fix note adds "never wrap the SUT act."
