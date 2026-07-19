---
issue: 443
issue_title: "pi-subagents: consolidate remaining test clone families"
---

# Consolidate remaining test clone families

## Release Recommendation

**Release:** ship independently

This is Phase 19 Step 7 (Track C — test health), tagged `Release: independent` in the architecture roadmap.
It depends only on the terminal cut (Steps 5–6, [#441] / [#442], both closed) having landed, which it has.
No other roadmap step is gated on it, so it ships on its own.

## Problem Statement

`fallow dupes` reports test clone families in `pi-subagents`.
The issue (written at the Phase 18 end) named five files and a "≤ 10 clone groups (from 16)" target, on the premise that each clone is an extractable shared fixture.

Re-running fallow against current `main` (after the terminal cut shifted line numbers and the Phase-19 UI surfaces added new test files) shows the live picture differs from the issue's snapshot.
There are **16** `pi-subagents` test clone families today, but they split into two kinds:

1. Genuine *arrange / fixture / helper* duplication — safe to extract.
2. The repeated *system-under-test call* (`resolveSpawnConfig`, `assembleSessionConfig`, `schedule`) — which the `testing` skill explicitly says **not** to wrap in a helper just to clear a duplication metric, because the repeated act *is* the test subject.

Several of the issue's five named targets fall into category 2.
The operator confirmed (planning `ask_user`) a **guardrail-first** approach over the **full live set** of clones: extract only genuine fixtures, leave act-clones in place and documented, and address the new Phase-19 UI clones the issue never anticipated.

## Goals

- Extract genuine (non-act) test duplication into shared or hoisted helpers, following the package's `test/helpers/*.ts` convention.
- Clear the clone families that are legitimately arrange/fixture/result-extraction boilerplate.
- Keep the full suite green at every step — the existing tests are the safety net for their own refactor.
- Reach the issue's `≤ 10` clone-group target *honestly*, without wrapping any system-under-test call.
- Document the residual act-clones as intentional in the plan, so a future fallow pass does not re-flag them as oversight.

## Non-Goals

- Do **not** wrap or extract the repeated system-under-test call to clear a clone metric (the `testing`-skill guardrail).
  These act-clones are left in place by design:
  - `test/tools/spawn-config.test.ts` — repeated `resolveSpawnConfig(...)` calls (`dup:9b42a569`, `dup:ef875c08`).
  - `test/session/session-config.test.ts` — repeated `assembleSessionConfig(...)` calls (`dup:539a8ca2`).
  - `test/lifecycle/concurrency-limiter.test.ts` — repeated `schedule(...)` sequences (`dup:ff841f05`).
  - `test/lifecycle/subagent-manager.test.ts` — `spawnBg` + `await promise` act blocks (`dup:29158516`, `dup:082c007e`).
  - `test/lifecycle/subagent.test.ts` — `agent.run()` act block (`dup:a3814745`).
  - `test/tools/get-result-tool.test.ts` — `execute(...)` act block (`dup:230828a8`, 5 lines, marginal).
- No production-source changes — this is test-only.
- No change to test *assertions* or behavior coverage; only the arrange/setup ceremony is consolidated.
- No new fallow rule or config change.

## Background

- Phase 19 Step 7 in `packages/pi-subagents/docs/architecture/architecture.md` ([#443]) — the roadmap entry, `Release: independent`.
- The terminal cut ([#441], [#442]) removed `agent-menu.ts`, the conversation viewer, and the definition-management subtree, deleting ~4 of the Phase-18 clone groups automatically and shifting the line numbers in the issue's target list.
- The Phase-19 replacement surfaces added new test files the issue could not have named: `test/ui/session-navigation.test.ts` and `test/ui/session-navigator.test.ts` ([#445], [#462], [#463]), which carry the largest genuine clone (an identical `makeNavigable` factory duplicated across both files).
- Shared-fixture convention: `test/helpers/<name>.ts` exporting named helpers, imported via the `#test/helpers/<name>` path alias, each with a companion `<name>.test.ts` (e.g. `make-subagent.ts` + `make-subagent.test.ts`).
- The `testing` skill rule that drives the guardrail: "Do not wrap the system-under-test call in a helper to eliminate a duplication-metric clone — the repeated act is the test subject, not duplication to remove."

## Design Overview

### Clone classification (live fallow output vs. issue)

| Fingerprint    | Location                                                                      | Kind                                           | Disposition                 |
| -------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| `dup:1d5dc276` | `ui/agent-widget.test.ts` :229 / :292                                         | duplicated `makeWidget` helper                 | **Extract** (hoist)         |
| `dup:e29e4749` | `ui/session-navigation.test.ts` :23 / `ui/session-navigator.test.ts` :47      | duplicated `makeNavigable` factory (identical) | **Extract** (shared helper) |
| `dup:6268a42f` | `ui/session-navigator.test.ts` :201 / :229                                    | captured-overlay invocation boilerplate        | **Extract** (local helper)  |
| `dup:ea0a1bce` | `ui/session-navigator.test.ts` :220 / :243                                    | captured-overlay invocation boilerplate        | **Extract** (local helper)  |
| `dup:b0d55079` | `lifecycle/subagent-manager.test.ts` :92 / :109                               | `resultConsumed`-observer arrange              | **Extract** (local helper)  |
| `dup:080c5017` | `lifecycle/subagent.test.ts` :257 / :273                                      | "ready subagent" arrange                       | **Extract** (local helper)  |
| `dup:5d8dbd48` | `lifecycle/subagent-manager.test.ts` :376 / `lifecycle/subagent.test.ts` :717 | resume-events mock body (cross-file)           | **Extract** (shared helper) |
| `dup:f4c08c00` | `lifecycle/workspace-bracket.test.ts` :90 / :97                               | prepared-bracket arrange                       | **Extract** (local helper)  |
| `dup:9b42a569` | `tools/spawn-config.test.ts` :43 / :56                                        | `resolveSpawnConfig` act                       | Leave (Non-Goal)            |
| `dup:ef875c08` | `tools/spawn-config.test.ts` :81 / :95                                        | `resolveSpawnConfig` act                       | Leave (Non-Goal)            |
| `dup:539a8ca2` | `session/session-config.test.ts` :131 / :151                                  | `assembleSessionConfig` act                    | Leave (Non-Goal)            |
| `dup:ff841f05` | `lifecycle/concurrency-limiter.test.ts` :21 / :148                            | `schedule` act                                 | Leave (Non-Goal)            |
| `dup:29158516` | `lifecycle/subagent-manager.test.ts` :335 / :383                              | `spawnBg` + await act                          | Leave (Non-Goal)            |
| `dup:082c007e` | `lifecycle/subagent-manager.test.ts` :410 / :422                              | `spawnBg` + await act                          | Leave (Non-Goal)            |
| `dup:a3814745` | `lifecycle/subagent.test.ts` :504 / :533                                      | `agent.run()` act                              | Leave (Non-Goal)            |
| `dup:230828a8` | `tools/get-result-tool.test.ts` :81 / :89                                     | `execute` act (5 lines)                        | Leave (Non-Goal)            |

Extracting the eight **Extract** families clears those fingerprints and drops the count from 16 to **8** — below the issue's `≤ 10` target — with no act-clone wrapped. (The four primary UI/lifecycle extractions alone reach 10; the cross-file and workspace-bracket arrange extractions take it to 8.)

### Shared-helper extractions (cross-file → `test/helpers/`)

Two clones span two files each, so their helpers must live in `test/helpers/` (the package convention for shared fixtures, with a companion test):

`test/helpers/make-navigable.ts`:

```typescript
import type { NavigableSubagent } from "#src/ui/session-navigation";

export function makeNavigable(overrides: Partial<NavigableSubagent> = {}): NavigableSubagent {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "Test task",
    status: "completed",
    startedAt: 1000,
    completedAt: 4000,
    toolUses: 2,
    activeTools: new Map(),
    responseText: "",
    agentMessages: [],
    isSessionReady: () => true,
    subscribeToUpdates: vi.fn(() => () => {}),
    getToolDefinition: vi.fn(() => undefined),
    ...overrides,
  };
}
```

The two source copies are byte-identical (verified with `diff`), so this is a pure lift with no reconciliation.
Both call sites import it: `import { makeNavigable } from "#test/helpers/make-navigable";`.

`test/helpers/mock-session.ts` (extend the existing helper) — add a resume-events emitter for `dup:5d8dbd48`:

```typescript
export function emitResumeUsageAndCompaction(session: MockSession): void {
  session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 70, output: 30, cacheWrite: 5 } } });
  session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 999 }, reason: "overflow" });
}
```

Both `subagent-manager.test.ts` and `subagent.test.ts` set this inside a `mockImplementation(async () => { …; return "second"; })`, so the helper emits the events and each call site keeps its own `mockImplementation` wrapper and `return`. (Adding to the already-shared `mock-session.ts` avoids a one-function new module; its companion `mock-session.test.ts` gains a case.)

### Local-helper extractions (single-file)

These stay file-local (the convention reserves `test/helpers/` for cross-file sharing); each is a `function` declared once at the top of its `describe`/module and called from each test, with the **act left explicit** in every test:

- `ui/agent-widget.test.ts` — the `makeWidget(agents)` helper is currently declared *twice* (one per `describe`).
  Hoist a single copy to module scope (above the first `describe`) and delete the second.
  The second `describe` uses `vi.useFakeTimers()` in `beforeEach`, but `makeWidget` does not touch timers, so a module-scope definition serves both.
- `ui/session-navigator.test.ts` — extract a `renderCapturedOverlay(ui): string[]` helper that performs the repeated `const factory = ui.custom.mock.calls[0][0] as (…) => Component; return factory(mockTui(), ansiTheme(), undefined, vi.fn()).render(80);`.
  This is *result extraction* (reading what the SUT produced), not the act (`new SessionNavigatorHandler().handle(…)` stays explicit in each test).
  The `#423` reactive-consumer invariant assertion (`expect(record.getToolDefinition).not.toHaveBeenCalled()`) lives in the test body, untouched by the helper.
- `lifecycle/subagent-manager.test.ts` — extract a local `seedResultConsumedObserver()` returning `{ manager, record, seenConsumed: () => boolean | undefined }` for the two Bug-1 tests; the act (`markConsumed()` before/after `await record.promise`) stays in each test.
- `lifecycle/subagent.test.ts` — extract a local `makeReadySubagent()` returning `{ agent }` (build `makeSubagent()`, push a message onto a `createMockSession()`, wire `createSubagentSessionStub`/`toSubagentSession`); the act (reading `agent.messages` vs `agent.agentMessages`) stays in each test.
- `lifecycle/workspace-bracket.test.ts` — extract a local `preparedBracket(addendum?)` async helper that builds the workspace, constructs the `WorkspaceBracket`, and awaits `prepare(ctx)`, returning the bracket; the act (`bracket.dispose(outcome)`) stays in each test.

### Guardrail rationale (why the act-clones stay)

`spawn-config.test.ts` already extracts its arrange (`makeModelInfo`, `testRegistry`, `defaultSettings`); the only remaining duplication is the four-argument `resolveSpawnConfig(...)` call — the SUT.
`session-config.test.ts`'s clone is the six-argument `assembleSessionConfig(...)` SUT call.
`concurrency-limiter.test.ts`'s clone is the `schedule(...)` act sequence.
Wrapping any of these would hide the test subject behind a helper, exactly the anti-pattern the `testing` skill names.
They are recorded in Non-Goals so a later fallow pass reads them as deliberate.

### Design-review check

The `design-review` checklist (dependency width, Law of Demeter, output arguments, shared-interface changes) targets production wiring.
This change touches only test arrange code and introduces no production collaborator or shared-interface change, so the checklist finds nothing applicable.
The new `makeNavigable` helper follows ISP — it returns a full `NavigableSubagent` because both consumers (`listNavigableAgents` fixtures and `SessionNavigatorHandler` records) need the whole shape; there is no unused-field smell.

## Module-Level Changes

New files:

- `packages/pi-subagents/test/helpers/make-navigable.ts` — shared `makeNavigable` factory.
- `packages/pi-subagents/test/helpers/make-navigable.test.ts` — companion test (per convention).

Changed files:

- `packages/pi-subagents/test/helpers/mock-session.ts` — add `emitResumeUsageAndCompaction(session)`.
- `packages/pi-subagents/test/helpers/mock-session.test.ts` — add a case for the new emitter.
- `packages/pi-subagents/test/ui/session-navigation.test.ts` — delete local `makeNavigable`, import the shared one.
- `packages/pi-subagents/test/ui/session-navigator.test.ts` — delete local `makeNavigable`, import the shared one; add `renderCapturedOverlay` local helper and migrate its two clone sites.
- `packages/pi-subagents/test/ui/agent-widget.test.ts` — hoist `makeWidget` to a single module-scope definition; delete the duplicate.
- `packages/pi-subagents/test/lifecycle/subagent-manager.test.ts` — add `seedResultConsumedObserver` local helper (migrate `:92`/`:109`); migrate the `dup:5d8dbd48` resume-mock site to `emitResumeUsageAndCompaction`.
- `packages/pi-subagents/test/lifecycle/subagent.test.ts` — add `makeReadySubagent` local helper (migrate `:257`/`:273`); migrate the `dup:5d8dbd48` resume-mock site to `emitResumeUsageAndCompaction`.
- `packages/pi-subagents/test/lifecycle/workspace-bracket.test.ts` — add `preparedBracket` local helper; migrate the four construct-and-prepare sites.

Documentation:

- `packages/pi-subagents/docs/architecture/architecture.md` — Phase 19 Step 7 currently states "Outcome: test clone groups ≤ 10 (from 16); `subagent-manager.test.ts` uses shared factory helpers."
  Update the Outcome to record the achieved count (8) and that the residual six families are intentional act-clones (left per the `testing` guardrail), so the roadmap and fallow stay reconciled.
  No layout/complexity table references these test files, so no other architecture edit is needed.
- No `package-pi-subagents` SKILL.md reference to these helpers or counts — grep confirms no doc symbol to update beyond the architecture Outcome line.

## Test Impact Analysis

1. **New lower-level tests enabled.**
   `make-navigable.test.ts` and the new `mock-session.test.ts` case pin the shared helpers' default shapes directly — previously each consumer test re-encoded the defaults inline.
   These are the only genuinely new tests; the rest is arrange consolidation.
2. **Tests made redundant.**
   None are removed.
   The behavior assertions in every migrated test stay exactly as-is; only their arrange/setup lines collapse into a helper call.
   The local copies of `makeNavigable`/`makeWidget` are deleted (duplication removed), not their tests.
3. **Tests that must stay as-is.**
   All act-clone tests (Non-Goals list) keep their explicit SUT call.
   The `session-navigator.test.ts` `#423` reactive-consumer assertions stay in the test body; `renderCapturedOverlay` only factors out the overlay-rendering boilerplate, not the assertions.

## Invariants at risk

- **`#423` reactive-consumer invariant** (`SessionNavigatorHandler` sources the transcript and never reads tool definitions off the record): pinned by `expect(record.getToolDefinition).not.toHaveBeenCalled()` in `session-navigator.test.ts`.
  The `renderCapturedOverlay` extraction must leave that assertion in the test body, not absorb it.
- **Resume usage/compaction accumulation** (`#420`/`#421`/Phase 17 observer lifecycle): pinned by the resume tests in both `subagent-manager.test.ts` and `subagent.test.ts`.
  `emitResumeUsageAndCompaction` must emit the identical event payloads (`input:70 output:30 cacheWrite:5`, `tokensBefore:999`, `reason:"overflow"`); the migrated tests assert on these exact numbers, so a value drift would surface as a red test in the same step.
- **Widget background-only filter** (`#444`/`#423`): the hoisted `makeWidget` must keep the `runInBackground: true` default merge (`{ invocation: { runInBackground: true }, ...a }`) — both `describe` copies already share it, so the hoist preserves it verbatim.

Each invariant is already covered by an existing assertion; no new pinning test is required beyond the helper companion tests.

## TDD Order

This is a test-only refactor: there is no new product behavior, so the "green" gate at each step is the **existing suite staying green** after the arrange is consolidated.
Each step is independently committable and leaves the suite green.
Run the affected file(s) with `pnpm --filter @gotgenes/pi-subagents exec vitest run <path>` and the full suite before the final commit (shared `test/helpers` changes touch multiple files).

1. **Shared `makeNavigable` fixture.**
   Add `test/helpers/make-navigable.ts` and `make-navigable.test.ts` (companion: assert default shape + an override).
   Delete the two local copies in `session-navigation.test.ts` / `session-navigator.test.ts` and import from `#test/helpers/make-navigable`.
   Run both UI files green.
   Commit: `test(pi-subagents): extract shared makeNavigable test fixture`.
2. **`agent-widget` makeWidget hoist.**
   Hoist one `makeWidget` to module scope; delete the duplicate in the second `describe`.
   Run `agent-widget.test.ts` green.
   Commit: `test(pi-subagents): hoist duplicated makeWidget helper`.
3. **`session-navigator` captured-overlay helper.**
   Add `renderCapturedOverlay(ui)` and migrate the two clone sites (`dup:6268a42f`, `dup:ea0a1bce`), keeping the `#423` assertions inline.
   Run `session-navigator.test.ts` green.
   Commit: `test(pi-subagents): extract captured-overlay render helper`.
4. **`subagent-manager` resultConsumed arrange + resume-events emitter.**
   Add `emitResumeUsageAndCompaction` to `mock-session.ts` (+ companion case).
   Add local `seedResultConsumedObserver` and migrate `:92`/`:109`.
   Migrate the resume-mock site (`dup:5d8dbd48` manager half) to the emitter.
   Run `subagent-manager.test.ts` + `mock-session.test.ts` green.
   Commit: `test(pi-subagents): consolidate subagent-manager arrange helpers`.
5. **`subagent` ready-subagent arrange + resume-events emitter.**
   Add local `makeReadySubagent` and migrate `:257`/`:273`.
   Migrate the resume-mock site (`dup:5d8dbd48` subagent half) to `emitResumeUsageAndCompaction`.
   Run `subagent.test.ts` green (this clears the cross-file `dup:5d8dbd48` once both halves use the emitter).
   Commit: `test(pi-subagents): consolidate subagent ready-state arrange`.
6. **`workspace-bracket` prepared-bracket arrange.**
   Add local `preparedBracket(addendum?)` and migrate the four construct-and-prepare sites.
   Run `workspace-bracket.test.ts` green.
   Commit: `test(pi-subagents): extract preparedBracket setup helper`.
7. **Verify + document.**
   Run the full suite, `pnpm run check`, `pnpm run lint`, and `pnpm fallow dupes --workspace @gotgenes/pi-subagents` to confirm the eight target fingerprints are gone and the count is ≤ 10.
   Update the Phase 19 Step 7 Outcome line in `architecture.md` to the achieved count and the intentional-residual note.
   Commit: `docs(pi-subagents): reconcile Phase 19 Step 7 outcome with achieved clone count`.

## Risks and Mitigations

- **Risk: hoisting `makeWidget` past the fake-timers `beforeEach` changes timing.**
  Mitigation: `makeWidget` constructs objects only (no timer calls); the `vi.useFakeTimers()` lives in the second `describe`'s `beforeEach`, unaffected by where the helper is declared.
  Step 2 runs the file green to confirm.
- **Risk: the resume-events emitter drifts from one of the two call sites' expected numbers.**
  Mitigation: both sites currently use identical payloads (verified); the migrated tests assert the exact numbers, so any drift fails red in steps 4–5.
- **Risk: a `test/helpers` change silently breaks an unrelated importer.**
  Mitigation: `mock-session.ts` is widely imported; the change is purely additive (new export), and step 4 runs the full suite.
- **Risk: orphaned imports after deleting local helpers (Biome `noUnusedImports` is warning-level).**
  Mitigation: after each deletion, re-check the file's imports (e.g. `vi` may still be used elsewhere; `NavigableSubagent` import in the UI files is type-only and still referenced).
  The step 7 `pnpm run lint` is the backstop.
- **Risk: fallow re-flags the intentional act-clones in a future audit.**
  Mitigation: the Non-Goals list and the architecture Outcome note record them as deliberate.

## Open Questions

- None.
  The guardrail-first / full-live-set scope was settled via the planning `ask_user`; no follow-up issue is warranted because the residual act-clones are intentional, not deferred work.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#443]: https://github.com/gotgenes/pi-packages/issues/443
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#462]: https://github.com/gotgenes/pi-packages/issues/462
[#463]: https://github.com/gotgenes/pi-packages/issues/463
