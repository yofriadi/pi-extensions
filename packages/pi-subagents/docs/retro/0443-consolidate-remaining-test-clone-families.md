---
issue: 443
issue_title: "pi-subagents: consolidate remaining test clone families"
---

# Retro: #443 — pi-subagents: consolidate remaining test clone families

## Stage: Planning (2026-06-23T00:00:00Z)

### Session summary

Planned Phase 19 Step 7 (test-clone consolidation) for `pi-subagents`.
Re-ran `fallow dupes` against current `main` and found the live state diverged from the issue's Phase-18-era snapshot: line numbers shifted after the terminal cut ([#441]/[#442]) and new Phase-19 UI test files added clones the issue never named.
Wrote `packages/pi-subagents/docs/plans/0443-consolidate-remaining-test-clone-families.md` and committed it.

### Observations

- The issue is the operator's own, but the proposed "extract a shared fixture" list was substantially invalidated by live evidence: several named targets (`resolveSpawnConfig`, `assembleSessionConfig`, `schedule`) are the repeated *system-under-test act*, which the `testing` skill says not to wrap to clear a clone metric.
- `ask_user` gate settled two decisions: **guardrail-first** (leave act-clones, extract only genuine fixtures) and **full live set** (include the new Phase-19 UI clones, notably the byte-identical `makeNavigable` factory duplicated across `session-navigation.test.ts` and `session-navigator.test.ts`).
- Eight genuine extraction targets identified; clearing them drops the count from 16 to 8 — below the issue's `≤ 10` target — without wrapping any act.
  The four primary UI/lifecycle extractions alone reach 10.
- Six residual families are documented as intentional act-clones in Non-Goals so a future fallow pass reads them as deliberate, not oversight.
- Convention confirmed: cross-file helpers go in `test/helpers/<name>.ts` (imported via `#test/helpers/<name>`) with a companion `<name>.test.ts`; single-file helpers stay local.
- Invariants at risk flagged: the `#423` reactive-consumer assertion in `session-navigator.test.ts` must stay in the test body (not absorbed by the `renderCapturedOverlay` helper), and the resume-events emitter must preserve exact usage/compaction payloads.
- `Release: independent` — ships on its own; no batch coupling.

[#441]: https://github.com/gotgenes/pi-packages/issues/441

## Stage: Implementation — TDD (2026-06-23T22:45:00Z)

### Session summary

Executed all 7 TDD steps: extracted `makeNavigable` (shared `test/helpers/make-navigable.ts`) and `emitResumeUsageAndCompaction` (shared `mock-session.ts`), plus local helpers for `makeWidget`, `renderCapturedOverlay`, `seedResultConsumedObserver`, `makeReadySubagent`, and `preparedBracket`, then reconciled the architecture Step 7 Outcome.
Test count went from 950 to 953 (+2 from the `make-navigable` companion, +1 from the `mock-session` case); 63 test files.
The full suite, `pnpm run check`, root `pnpm run lint`, and `pnpm fallow dead-code` are all green.

### Observations

- Clone count dropped from 16 to 9 — the issue's `≤ 10` target was met, but the plan's *predicted* 8 missed by one.
  `dup:ea0a1bce` was pre-classified as captured-overlay boilerplate; once `renderCapturedOverlay` extracted the boilerplate, the surviving fingerprint proved to be the `evicted` arrange + the `SessionNavigatorHandler.handle` SUT act — an act-clone.
  Per the operator's guardrail-first decision, it was left intact and documented rather than wrapped.
  Treated as a documented deviation, not a re-decision, because the governing guardrail (leave act-clones) was already chosen in planning.
- All 9 residual families are genuine repeated SUT calls (`resolveSpawnConfig`, `assembleSessionConfig`, `schedule`, `handle`, `spawnBg`+`await`, `agent.run()`, `execute`) — recorded in the plan's Non-Goals.
- `makeNavigable` was byte-identical across the two UI files (verified with `diff`), so the shared extraction was a pure lift; the `NavigableSubagent` type import had to stay in `session-navigation.test.ts` (still used at line 91) but was removed from `session-navigator.test.ts`.
- The cross-file `dup:5d8dbd48` only cleared after *both* halves (manager + subagent resume tests) adopted `emitResumeUsageAndCompaction` — split across Steps 4 and 5.
- Pre-completion reviewer: PASS (deterministic checks green; all three plan invariants verified held; residual act-clones confirmed legitimate).

[#442]: https://github.com/gotgenes/pi-packages/issues/442

## Stage: Final Retrospective (2026-06-23T23:30:00Z)

### Session summary

One continuous session carried issue #443 through Planning, TDD, and Ship for the `pi-subagents` test-clone consolidation (Phase 19 Step 7).
Eight genuine fixture/arrange/helper families were extracted across six commits, dropping the clone count from 16 to 9 (issue's `≤ 10` target met), and the work shipped to `main` with green CI; no release was cut because every commit is a non-releasing type.
The session was notably clean — no rework, no user corrections, and the single recurring friction was a self-caught tool-input slip.

### Observations

#### What went well

- The planning `ask_user` (guardrail-first + full-live-set) pre-empted a TDD-stage judgment call: when the clone count came out 9 instead of the predicted 8 because `dup:ea0a1bce` proved to be an act-clone, the pre-established guardrail made it a *documented deviation* rather than a scramble to force the metric.
  This is the "do not escalate abstraction to force a number" discipline working exactly as the prompt intends — a planning decision paying off two stages later.
- Reconciling against live `fallow dupes` output at plan time (rather than trusting the issue's Phase-18-era line numbers) caught that several named "extract a fixture" targets were actually the repeated system-under-test act.
  Planning around the stale issue list would have produced leaky test helpers that the `testing` guardrail forbids.
- Incremental verification held throughout TDD: `pnpm run check` ran after every shared-type-changing step (1, 3, 4, 5, 6) plus a per-step affected-file `vitest` run, with the full suite + root `lint` + `fallow dead-code` at the end.
  No type error or broken consumer surfaced late.
- The cross-file clone `dup:5d8dbd48` only cleared once *both* resume-test halves adopted `emitResumeUsageAndCompaction`; sequencing the manager half (Step 4) and subagent half (Step 5) into adjacent commits kept each commit green.

#### What caused friction (agent side)

- `other` (tool-input slip) — three `Edit` batches were rejected by the schema validator for carrying a stray key on one edit object (`newText_unused` in the Step 4 `subagent-manager.test.ts` edit; `newText_unused2` then `newText2` in the Step 7 `architecture.md` edit).
  Each rejection is atomic, so the whole batch had to be re-sent.
  Impact: ~3 extra tool calls, no rework to committed code — the validator caught every instance immediately (self-identified).
  Not doc-fixable: this is a JSON-construction slip, not a missing convention; `AGENTS.md` already covers atomic `Edit` batches.

#### What caused friction (user side)

- None.
  The `ask_user` answers were decisive and the session ran autonomously end-to-end; no mechanical oversight or late-context handoff to flag.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (its frontmatter), appropriate for judgment-heavy review.
  Ship ran on `sonnet-4-6`, the retro on `opus-4-8`.
  The transient `opencode-go/deepseek-v4-flash`, `glm-5.2`, and `kimi-k2.6` `model_change` events between the Ship report and the retro prompt ran zero assistant turns (the next turn is `opus-4-8`), so they never executed work — no reasoning-weak-model-on-hard-task mismatch.
- **Escalation-delay** — no `rabbit-hole` friction; the `Edit` rejections each resolved on the first retry, never approaching the 5-consecutive-call threshold.
- **Feedback-loop gap** — none; verification was incremental, not end-loaded (see What went well).

### Changes made

1. Recorded this Final Retrospective stage entry in `packages/pi-subagents/docs/retro/0443-consolidate-remaining-test-clone-families.md`.
2. No `AGENTS.md` or `.pi/prompts/` changes — the session validated existing guardrails (the `testing` act-clone rule and the `/tdd-plan` "don't force the metric" discipline); proposed tweaks were considered and rejected as already-covered or not doc-fixable.
