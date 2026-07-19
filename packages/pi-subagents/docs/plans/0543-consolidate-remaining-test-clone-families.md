---
issue: 543
issue_title: "pi-subagents Phase 20 Step 9: consolidate remaining test clone families"
---

# Phase 20 Step 9 — Reconcile the residual-test-clone metric with fallow's test-ignore

## Release Recommendation

**Release:** ship independently

The architecture roadmap marks Step 9 `Release: independent`, and it is not a member of any `Release batches` entry (the only batch is "result-delivery" = Steps 1–2).
The change lands as `test:`/`docs:` commits — hidden changelog types that cut no release on their own and auto-batch into the next unhidden release.

## Problem Statement

Issue [#543] (Phase 20 Step 9) proposes extracting shared arrange helpers to cut in-package test clone groups from 9 (81 lines) to at most 5 (40 lines), naming `spawn-config.test.ts` (2 groups / 21 lines), `subagent-manager.test.ts` (2 groups / 15 lines), and a `session-config.test.ts` pair (16 lines).
Step 9 was deliberately sequenced last because Phase 20 Steps 1–3 and 8 rewrite portions of these suites.

Two facts, established during planning, undercut the premise:

1. **fallow 3.2.0 excludes test files from duplication detection by default.**
   `pnpm fallow dupes --workspace @gotgenes/pi-subagents` reports **zero** clones and prints `skipped 235 files matching default duplicates ignores: 235 **/*.test.*`.
   The "in-package test clone groups" metric (9 / 81 lines) is no longer produced by the standard command the roadmap and CI use — the tool now treats test-file token runs as expected scaffolding, not copy-paste.
2. **The residual duplication in all three files is the repeated system-under-test *act* call, not arrange setup.**
   The flagged families are the repeated `resolveSpawnConfig(...)`, `assembleSessionConfig(...)`, and `manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {…})` invocations — the test subject itself.
   The `testing` skill is explicit: "Do not wrap the system-under-test call in a helper to eliminate a duplication-metric clone — the repeated act is the test subject, not duplication to remove."
   The arrange for these suites is already well-factored (`createManager`, `arrangeQueuedPair`, `manager-stubs.ts`, `mock-session.ts`, `makeModel`, `makeAgentConfig`, `exploreConfig`) by prior Phase 17 (#378, #379) and Phase 20 steps.

The operator confirmed the direction (planning `ask-user`): **narrow arrange-only tidy plus a metric correction** — hoist only genuine arrange duplication that keeps the act explicit, skip all act-call wrapping, and update the architecture health metric to reflect fallow's test-ignore.

## Goals

- Correct the Phase 20 health-metrics table: retire the "Test clone groups (in-package)" row, annotating why (fallow 3.2.0 no longer surfaces test-file clones via the standard `dupes` command).
- Record Step 9's actual outcome in the roadmap: the arrange helpers are already adequate; the residual is act-repetition that stays by design.
- Land the one genuine arrange consolidation found — hoist the shared 3-line arrange in the `SubagentManager — lifecycle observer forwarding` describe into a describe-scoped `beforeEach`, keeping each `spawn`/`spawnAndWait` act explicit.
- Mark Step 9 complete in the roadmap (heading `✅`, Mermaid `S9` node, `Landed:` note).

## Non-Goals

- **No act-call wrapping.**
  The repeated `resolveSpawnConfig` / `assembleSessionConfig` / `manager.spawn` invocations are the test subject and stay explicit per the `testing` skill.
- **No repo-wide fallow config change.**
  Setting `duplicates.ignoreDefaults: false` in `.fallowrc.json` would re-include test files but also re-admit every generated/framework file across all six packages (the default ignore is all-or-nothing, not subtractable — `duplicates.ignore` only *adds* patterns).
  Restoring a package-scoped test-clone metric is not worth reintroducing repo-wide noise; considered and rejected (see Design Overview).
- **No changes to `spawn-config.test.ts`.**
  Its arrange (`testRegistry`, `makeModelInfo()`, `defaultSettings`, `makeAgentConfig`, `makeDisabledPlanRegistry`) is already module-level; the only repetition is the act.
- **No new `test/helpers/` module.**
  The one hoist is describe-local; nothing is reused across files.

## Background

Relevant existing structure:

- `packages/pi-subagents/docs/architecture/architecture.md` — the Phase 20 roadmap.
  The health-metrics table (line 791) carries `| Test clone groups (in-package) | 9 (81 lines) | ≤ 5 (≤ 40 lines) |`.
  The Step 9 entry (`#### Step 9 — Consolidate remaining test clone families ([#543])`) states the `Outcome:` in the same clone-group terms, and the step-dependency Mermaid names `S9["Step 9 (#543)<br/>Consolidate test clones"]`.
- `test/lifecycle/subagent-manager.test.ts` — 835 lines, arrange fully factored into `createManager(overrides?)` and `arrangeQueuedPair()`, with stubs in `test/helpers/manager-stubs.ts` and `test/helpers/mock-session.ts`.
  The `lifecycle observer forwarding` describe (two tests) is the one block where identical arrange (`createMockSession` → `createSessionFactory` → `createManager({ createSubagentSession: factory })`) repeats verbatim.
- `test/session/session-config.test.ts` and `test/tools/spawn-config.test.ts` — arrange is module-level; the repeated multi-arg calls are the act.

AGENTS.md constraints that apply:

- Architecture-doc module-tree / metric entries describe **current behavior**; a metric the tool no longer produces is stale and should be retired, not left aspirational.
- `test:`/`docs:` are hidden changelog types — they cut no release alone (`Release: ship independently` is honored by auto-batching).
- The `testing` skill's act-wrapping prohibition is the governing rule for the "consolidation" the issue names.

## Design Overview

### Why the metric is retired, not restored

fallow 3.2.0's `duplicates` config exposes `ignore` (additional patterns, default `[]`), `ignoreDefaults` (merge built-in framework ignores, default `true`), and `ignoreImports` (default `true`).
The built-in defaults now include `**/*.test.*`.
There is no way to subtract a single default pattern: the only lever is `ignoreDefaults: false`, which drops **all** built-in ignores at once — re-admitting generated and framework files across every package into clone detection.
`.fallowrc.json` is a single repo-root file shared by all six packages, so this is a repo-wide blast radius for one package's metric.
The metric is therefore retired: the roadmap row is annotated as no longer measured, and the qualitative outcome (arrange already factored; residual is act-repetition) replaces the numeric target.

### The one genuine arrange hoist

The `lifecycle observer forwarding` describe currently repeats, in both tests:

```typescript
const session = createMockSession();
const received: { agent: Subagent | undefined } = { agent: undefined };
const { factory } = createSessionFactory(session);
({ manager } = createManager({ createSubagentSession: factory }));
```

`session` exists only to feed `createSessionFactory`; `factory` and `manager` are shared arrange; `received` is per-test mutable state.
Hoist the arrange to a describe-scoped `beforeEach`, leaving each test's `const received = …` and the `spawn`/`spawnAndWait` act explicit:

```typescript
describe("SubagentManager — lifecycle observer forwarding", () => {
  let manager: SubagentManager;
  let factory: ReturnType<typeof createSessionFactory>["factory"];

  beforeEach(() => {
    ({ factory } = createSessionFactory(createMockSession()));
    ({ manager } = createManager({ createSubagentSession: factory }));
  });

  afterEach(() => {
    manager.dispose();
  });

  it("forwards onSessionCreated from spawn options observer to Agent", async () => {
    const received: { agent: Subagent | undefined } = { agent: undefined };
    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", { /* … act stays explicit … */ });
    // …
  });
});
```

This is the describe-scoped-`beforeEach` pattern the `testing` skill endorses ("group the shared setup in a describe-scoped `beforeEach` and keep the act … explicit in each test").
It touches no act call and no other describe block.

### Why the other flagged families are left alone

- `spawn-config.test.ts` — every test independently calls `resolveSpawnConfig({…}, testRegistry, makeModelInfo(), defaultSettings)`.
  The three trailing args are already single module-level values; the only remaining repetition is the act plus its `if ("error" in result) return;` narrowing guard.
  Nothing extractable without wrapping the act.
- `session-config.test.ts` — the model-resolution tests repeat `assembleSessionConfig("Explore", { …ctx, parentModel }, {}, mockEnv, mockAgentLookup, mockIO)`, but each is preceded by a *different* `mockResolveAgentConfig.mockReturnValueOnce(exploreConfig({…}))` / `mockRegistry` setup that documents a distinct fallback branch.
  The identical part is the act; the varying part is per-test arrange.
  A top-level `beforeEach` already resets the mocks.
  Nothing extractable without wrapping the act.

## Module-Level Changes

- `packages/pi-subagents/test/lifecycle/subagent-manager.test.ts` — in the `lifecycle observer forwarding` describe only, add a describe-scoped `beforeEach` that builds `factory` (via `createSessionFactory(createMockSession())`) and `manager` (via `createManager({ createSubagentSession: factory })`); remove the duplicated arrange lines from both `it` bodies; keep each act (`spawn`/`spawnAndWait`) and its `received` state explicit.
  Add a `let factory` binding alongside the existing `let manager`.
  No other describe block changes.
  After the edit, re-check the file's imports for orphans (Biome `noUnusedImports` is warning-level): `createMockSession`, `createSessionFactory`, `createManager`, `STUB_SNAPSHOT` all remain used elsewhere, so no import removal is expected — verify with `pnpm run lint`.
- `packages/pi-subagents/docs/architecture/architecture.md`:
  - Health-metrics table (line 791): replace the `Test clone groups (in-package)` row's target with a retirement annotation (e.g. `— (retired: fallow 3.2.0 excludes `**/ *.test.*
    `from dupes)`), or move the note to prose directly under the table.
    Keep the row's Phase 19 baseline for history.
  - Step 9 entry: rewrite `Outcome:` from the numeric clone-group target to the actual outcome (arrange already factored by #378/#379/Step 8; residual is act-repetition retained per the `testing` skill; one describe-scoped `beforeEach` hoist landed).
    Add the `✅` heading mark and a `Landed:` note (matching the Steps 1–8 convention).
  - Step-dependency Mermaid: change `S9["Step 9 (#543)<br/>Consolidate test clones"]` to `S9["✅ Step 9 (#543)<br/>…"]`.
  - `Release batches` / `Steps` prose that lists Step 9 as pending: no wording change needed beyond the `✅` marks above (Step 9 is already "independently releasable").

No `src/` symbols are added, removed, or renamed, so no `src`/`test` symbol grep, README, or skill prose is affected.
The metric string "clone groups" appears in prior plans (`0426`, `0217`, `0379`) but those are historical plan records describing their own snapshots — not current-behavior docs — so they are left untouched.

## Test Impact Analysis

This is a refactor/docs change, not an extraction that enables new unit tests.

1. **New tests enabled:** none — no production seam is extracted.
2. **Tests made redundant:** none — the two observer-forwarding tests remain (they assert distinct behavior: background vs. foreground `onSessionCreated` forwarding); only their shared arrange moves to `beforeEach`.
3. **Tests that must stay as-is:** the `spawn-config.test.ts` and `session-config.test.ts` act-repetition — each call documents a distinct branch of the SUT and is the test subject.

## Invariants at risk

The hoisted describe touches surface that Phase 20 Step 1 (#535) and Step 8 (#542) already refactored (the manager's spawn/notification wiring and `SubagentStateInit`).
The relevant invariants and their pins:

- **`onSessionCreated` fires for background spawns and not for foreground `spawnAndWait`** — pinned by the two `lifecycle observer forwarding` tests themselves; the hoist preserves both act calls verbatim, so the pins stay green.
- **The pre-await consumption ordering ("Bug 1" race) from Step 1** — pinned by the race tests elsewhere in `subagent-manager.test.ts`; untouched by this change.

The full suite staying green after the hoist confirms no earlier step's `Outcome:` is regressed.

## TDD Order

This is a behavior-preserving refactor plus a doc update — no red→green cycle.

1. **Refactor — hoist observer-forwarding arrange.**
   In `test/lifecycle/subagent-manager.test.ts`, add the describe-scoped `beforeEach` and remove the duplicated arrange from both `it` bodies (keep acts explicit).
   Verify: `pnpm --filter @gotgenes/pi-subagents exec vitest run test/lifecycle/subagent-manager.test.ts` green; `pnpm run check`; `pnpm run lint` (no orphaned imports).
   Commit: `test(pi-subagents): hoist observer-forwarding arrange to a beforeEach`.
2. **Docs — reconcile the metric and mark Step 9 complete.**
   Update `docs/architecture/architecture.md`: retire the health-metric row with rationale, rewrite the Step 9 `Outcome:`, add the `✅` heading + Mermaid marks and the `Landed:` note.
   Verify: `pnpm exec rumdl check packages/pi-subagents/docs/architecture/architecture.md`.
   Commit: `docs(pi-subagents): retire test-clone metric; complete Phase 20 Step 9 (#543)`.
3. **Final verification.**
   Run the full suite (`pnpm --filter @gotgenes/pi-subagents exec vitest run`), `pnpm run check`, `pnpm run lint`, and `pnpm fallow dead-code`.
   Confirm no orphaned imports and the suite is green.

## Risks and Mitigations

- **Risk: the hoist changes test isolation** (shared `factory`/`manager` across the describe's two tests).
  Mitigation: `beforeEach` re-runs per test, so each gets a fresh `manager`/`factory`; `afterEach` still disposes.
  The `received` state stays per-test.
- **Risk: retiring the metric hides a real future regression** (test duplication could grow unnoticed).
  Mitigation: fallow still detects *production* clones; test-clone growth is now a review-time judgment, consistent with the tool's own stance that test token runs are scaffolding.
  The architecture note records the decision so a future maintainer understands why the metric is gone.
- **Risk: a later fallow release re-includes test files**, reviving the metric.
  Mitigation: the retirement note is explicit about the tool version and mechanism, so it can be revisited if the default changes.

## Open Questions

- None blocking.
  The direction (narrow tidy + metric retirement) is confirmed by the planning `ask-user`; no follow-up issue is warranted (nothing is deferred).

[#543]: https://github.com/gotgenes/pi-packages/issues/543
