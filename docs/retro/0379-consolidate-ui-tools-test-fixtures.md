---
issue: 379
issue_title: "Consolidate UI and tools test fixtures"
---

# Retro: #379 — Consolidate UI and tools test fixtures

## Stage: Planning (2026-06-16T00:00:00Z)

### Session summary

Produced a 9-step lift-and-shift plan for Phase 17 Step 8 — consolidating the non-lifecycle test clone families.
Measured the live baseline (`fallow dupes -r packages/pi-subagents`: 32 clone groups / 512 lines / 2.49%, seven families) and characterized each family by reading all seven test files, classifying each as genuine cross-file duplication (one) versus intra-file (six).

### Observations

- The only genuine cross-file duplication is the `ResolvedSpawnConfig` builder shared by `foreground-runner.test.ts` and `background-spawner.test.ts` (`dup:80ee2004`) — the one promotion to `test/helpers/` (`make-spawn-config.ts`).
  Everything else fallow scores same-file, so it stays file-local or moves into a describe-scoped `beforeEach`, per Step 7's ([#378]) discipline.
- The plan's central constraint is Step 7's hard-won lesson: never wrap the system-under-test **act** in a helper to chase a duplication metric.
  Every extracted helper returns a value (`createResolvedSpawnConfig`, `disabledConfig`, `exploreConfig`, `createManagerStub`, `spawnAndWaitRegistering`) or seeds `beforeEach`; the acts stay inline.
  Added an "Invariants at risk" grep check to enforce this at review.
- Scope was genuinely ambiguous and resolved via `ask_user`: the issue body names six files, but fallow reports a seventh non-lifecycle family in `test/service/service-adapter.test.ts` (four near-identical `SubagentManagerLike` stubs).
  Operator chose to include service-adapter (seven files total) and to **not** bind a numeric group target — acceptance is "each named family consolidated, resulting fallow numbers reported."
  My `ask_user` prompt incorrectly claimed the architecture roadmap's Step 8 `Targets` lists service-adapter; it does not (it lists the six issue-body files).
  The plan corrects this and notes service-adapter was added in planning.
- The roadmap's stated Step 8 outcome ("clone groups 44 → ≤ 25; overall duplication ≤ 0.6%") predates Steps 1–7 and does not match the current fallow metric (2.49%); flagged as an Open Question rather than treated as binding.
- Non-Goals call out the two residual lifecycle families (Step 7 left them as the visible act), the 11-line production clone inside `src/ui/agent-config-editor.ts` (test-only issue), and the three overlapping session-mock builders ([#412]).
- `ResolvedSpawnConfig` is deeply nested (`identity`/`execution`/`presentation` with mirrored scalars).
  Designed the shared builder to take **flat** options and assemble the nested structure internally — sidesteps the `Partial<T>` deep-merge trap and encapsulates the mirroring (`agentInvocation.runInBackground`, `presentation.detailBase`) the hand-built copies duplicate.

## Stage: Implementation — TDD (2026-06-16T13:10:00Z)

### Session summary

Executed all 9 plan steps as green-to-green lift-and-shift refactors (no red phase — the existing assertions were the spec), one commit per step plus the docs commit.
Promoted the shared `createResolvedSpawnConfig` builder to `test/helpers/` (+5 self-tests) and consolidated the six remaining families with file-local value-returning builders / `beforeEach` setup.
Test count 1010 → 1015; test files 63 → 64; clone groups 32 → 24; package test duplication 512 → 355 lines (2.49% → 1.73%).

### Observations

- The `agent-config-editor.test.ts` family did not collapse as the plan loosely estimated ("4 → ideally 2"): it stayed at 4 groups / 28 lines.
  The `disabledConfig` helper removed only the small `enabled: false` arrange; the residual clones are the repeated `await editor.showAgentDetail(...)` **act** plus its `setupDetail` arrange and `ui.select.mock.calls` menu assertion — left inline because wrapping the system-under-test is the wrong abstraction (Step 7 lesson).
  No `ask_user` was needed: acceptance was "consolidate and measure" (no binding numeric target), and the only way to force the number would violate the plan's stated discipline.
- `service-adapter.test.ts` had four near-identical `SubagentManagerLike` stub factories with diverging defaults (`hasRunning` true vs false, varying `spawn` returns).
  Consolidated into one file-local `createManagerStub()` with **unannotated** return (typed `vi.fn<SubagentManagerLike[...]>()` stubs) so callers retain `Mock<...>` methods — per the testing-skill rule that annotating the return with the production interface, or spreading `Partial<Interface>` overrides, erases mock methods.
  Dropped the overrides parameter entirely; per-test behavior is configured on the returned object (`mgr.getRecord.mockImplementation(...)`, `mgr.hasRunning.mockReturnValue(true)`).
  Used `sed` to swap the `defaultManager()` / `createTestManager()` call sites after deleting the factory definitions.
- `ui-observer` update-counting tests moved from closure `let updateCount` counters to `vi.fn()` onUpdate with `toHaveBeenCalledTimes` — removes the repeated scaffolding without hiding the `session.emit` act.
- Pre-completion reviewer: WARN — sole finding was this missing TDD retro entry (now written); all deterministic checks PASS, cross-step invariant ("don't wrap the act") verified upheld, 6 Mermaid blocks validated, dead-code clean.

[#378]: https://github.com/gotgenes/pi-packages/issues/378
[#412]: https://github.com/gotgenes/pi-packages/issues/412
