---
issue: 381
issue_title: "Replace ConcurrencyQueue with a thunk-based ConcurrencyLimiter"
---

# Retro: #381 — Replace ConcurrencyQueue with a thunk-based ConcurrencyLimiter

## Stage: Planning (2026-06-13T00:00:00Z)

### Session summary

Produced a 3-step TDD plan to replace the ID-registry `ConcurrencyQueue` (with its `startAgent` back-edge and `markStarted`/`markFinished` relays) with a pure `ConcurrencyLimiter` that schedules thunks FIFO against a dynamic limit.
The design follows the architecture doc's Phase 17 Step 1 entry and the issue's revised framing closely; the plan adds concrete code sketches for `schedule`/`recheck`/`clear`, the manager call site, the simplified `waitForAll`, and `index.ts` wiring.

### Observations

- Author is `gotgenes` (matches the gh CLI user), so the well-specified proposal was treated as the working hypothesis; the design is unambiguous (down to the architecture-doc Step 1), so the `ask_user` gate was skipped.
- Classified non-breaking: `ConcurrencyQueue`/`ConcurrencyLimiter` are internal — no public API, config, or observable behavior change.
  The FIFO admission gate against `maxConcurrent` is preserved.
- Key design decision beyond the issue sketch: `clear()` must *settle* dropped pending promises (resolve them), not just drop the thunks.
  Every `schedule()` promise becomes `record.promise`, and the post-spawn contract is that it always settles — dropping without resolving would strand a promise.
  This costs a small `settle` handle per pending entry (a few lines beyond the issue's "~40 lines").
- Verified no production caller awaits a *queued* agent's promise in a blocking way (`get-result-tool.ts` guards on `status === "running"`; `spawnAndWait` is foreground/direct; `waitForAll` filters by status), confirming it is safe to give queued agents a real promise.
- Sequencing decision: the `SubagentManagerOptions.queue` → `limiter` swap breaks both call sites (`index.ts` + the manager test helper) and the old test file imports the deleted source, so step 2 is one atomic commit (migrate consumers + delete queue + delete old test).
- `bypassQueue` is kept as-is — it is in the published `SubagentsService` type bundle, so renaming would be breaking; deferred to Open Questions.
- Doc inventory: grep confirmed current-state references to update are the Mermaid lifecycle node, the layout listing, the "What the core owns" bullet, the Step 7 ([#378]) target filename, and the `package-pi-subagents` SKILL lifecycle-domain table.
  `SKILL.md` line 80 (Phase 15 history) keeps `ConcurrencyQueue` as a historical record.

## Stage: Implementation — TDD (2026-06-13T22:15:00Z)

### Session summary

Executed all 3 planned TDD cycles: (1) added `ConcurrencyLimiter` + 13 unit tests, (2) migrated `SubagentManager`, `index.ts`, `subagent.ts` docstring, and the manager test helper to the limiter while deleting `concurrency-queue.ts` + its test in the same atomic commit, (3) updated `architecture.md` and the package SKILL.
Test count went 975 → 966 (−22 deleted queue tests, +13 new limiter tests); the full suite, `check`, `lint`, and `pnpm fallow dead-code` are all green.

### Observations

- The plan held up cleanly — no surprises in the manager integration tests.
  The `queueing and concurrency` describe block passed unchanged after only the `createManager` helper swap (real `ConcurrencyLimiter` instead of `ConcurrencyQueue` + forward-ref start callback), confirming those tests exercise behavior, not queue internals.
- One deviation: a 4th commit (`90135005`, `refactor:`) fixes a stale `// before startAgent / queue drain` comment at `src/index.ts:125` that the plan's grep inventory missed (it named no removed symbol, just deleted concepts).
  The pre-completion reviewer caught it.
  Committed separately rather than amending the non-HEAD refactor commit, since AGENTS.md discourages interactive rebase in this environment.
- ESLint `@typescript-eslint/no-floating-promises` fired on every bare `limiter.schedule(...)` in the limiter test (the queue's `enqueue` returned `void`; `schedule` returns a promise).
  Resolved by prefixing unawaited calls with `void` — all such tasks either stay pending or resolve, so no unhandled rejection.
- The `clear()`-settles-pending-promises decision (made at planning) proved correct and is covered by a dedicated test ("resolves the promises of dropped pending tasks").
- Pre-completion reviewer: WARN (no FAILs).
  Reviewer warnings: the single stale-comment finding at `index.ts:125` — now fixed in commit `90135005`.

## Stage: Final Retrospective (2026-06-14T00:30:00Z)

### Session summary

Shipped #381 across planning, TDD, and release: `pi-subagents` `16.0.0` → `16.1.0`, tag `pi-subagents-v16.1.0`.
Four commits landed (one `feat`, two `refactor`, one `docs`) plus two `docs(retro)` notes; CI passed first try, the issue was closed with an implemented-in summary, and the release-please PR was merged.
The plan — written down to code sketches — held up across all three TDD cycles with no design rework.

### Observations

#### What went well

- The plan's fidelity paid off: the `clear()`-settles-pending-promises decision, the atomic step-2 sequencing (migrate consumers + delete queue + delete old test in one commit), and the `void`-prefix prediction for floating promises were all made at planning time and executed without surprise.
  The `queueing and concurrency` manager tests passed unchanged after only the `createManager` helper swap, validating the planning claim that they exercise behavior, not queue internals.
- The pre-completion-reviewer (on `anthropic/claude-sonnet-4-6`, 161s, 21 tool uses) caught a stale comment at `src/index.ts:125` that all four deterministic gates (`check`, `lint`, `test`, `fallow dead-code`) passed over.
  This is the backstop working exactly as intended — a judgment-model review surfacing residue that pattern-matchers cannot.
- Verification cadence was incremental, not end-loaded: file-scoped `vitest` + `biome` + `eslint` after step 1, `pnpm run check` immediately after the shared-interface change mid-step-2 (per the plan's own instruction), then lifecycle suite → full suite → full lint, then `rumdl` for the docs step, then the full gates + `fallow` before push.

#### What caused friction (agent side)

- `missing-context` (self/reviewer-caught) — the stale comment `// before startAgent / queue drain` at `src/index.ts:125` referenced two deleted concepts but was not cataloged in the plan's Module-Level Changes, despite the planning grep output having surfaced that exact line.
  The grep hit was visible but never converted into a plan action or an explicit leave-as-is.
  Impact: one small follow-up commit (`90135005`, `refactor:`); no rework, no design impact — the reviewer backstop absorbed it before ship.

#### What caused friction (user side)

- None.
  The single user touchpoint — the release-timing gate in `/ship-issue` (release now vs. batch the Phase 17 sequence) — was strategic judgment the agent correctly deferred, not mechanical oversight.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch (`pre-completion-reviewer`) on `anthropic/claude-sonnet-4-6`; appropriate match for judgment-heavy review, and it returned the session's only actionable finding.
- **Escalation-delay tracking** — no rabbit-holes; the lone lint error (`@typescript-eslint/no-floating-promises`, 18 sites) was resolved in a single test-file rewrite, far under the 5-call escalation threshold.
- **Unused-tool detection** — nothing under-tooled; `colgrep`/`grep` were used during planning exploration and the reviewer subagent was dispatched as designed.
- **Feedback-loop gap analysis** — no gap; verification ran after every cycle, with `pnpm run check` correctly invoked right after the shared-interface change rather than at end-of-session.

#### Process note (no inline change)

- The release-please PR merge required the documented `UNSTABLE` → `gh pr merge` fallback (step 6.4 of `/ship-issue`) because default-`GITHUB_TOKEN` release PRs never get checks.
  This recurs every release; the prompt already handles it, so it is recorded here only as a standing pattern, not a friction point.

### Changes made

1. Added this Final Retrospective stage entry to `packages/pi-subagents/docs/retro/0381-replace-concurrency-queue-with-limiter.md`.
2. No prompt or `AGENTS.md` changes — the operator chose retro-file-only, since the single friction (the stale `src/index.ts:125` comment) was a one-off execution slip already caught by the pre-completion-reviewer backstop, and the candidate grep-hit rule was judged not worth the prompt verbosity.

[#378]: https://github.com/gotgenes/pi-packages/issues/378
