---
issue: 379
issue_title: "Consolidate UI and tools test fixtures"
---

# Consolidate UI and tools test fixtures

## Problem Statement

`pnpm fallow:dupes` reports clone families in the UI, tools, session, and service test suites that sit outside the lifecycle tree consolidated in Step 7 ([#378]).
These are independent of the `Subagent` refactoring and can be tidied at any time.
This is Phase 17 Step 8 (core consolidation) — the last non-lifecycle test-duplication cleanup before Step 9's cross-package production clone.

Measured against today's `main` (`fallow dupes -r packages/pi-subagents`), the package reports **32 clone groups / 512 duplicated lines (2.49%)**, with seven clone families.
Two of those families (`create-subagent-session.test.ts`, `subagent-manager.test.ts`) are the residual that Step 7 deliberately left as the visible system-under-test **act** — Non-Goals here.
The remaining five families are the UI/tools/session targets named in the issue, plus a sixth in `test/service/service-adapter.test.ts` (a repeated `SubagentManagerLike` stub) added to scope by operator decision during planning.

## Goals

- Consolidate the seven targeted test files' clone families by extracting **value-returning arrange builders** (or describe-scoped `beforeEach` setup), never by wrapping the system-under-test act.
- Promote genuinely cross-file duplication (the `ResolvedSpawnConfig` builder shared by the two tools tests) into `test/helpers/`; keep intra-file families as file-local helpers.
- Preserve every existing test assertion — the existing suite is the regression guard for this refactor.
- Keep the change non-breaking: test-only, no production-code, public-surface, or behavior change.
- Report the resulting `fallow dupes` group count and duplication percentage as the outcome (no binding numeric group target — see Open Questions).

## Non-Goals

- The two residual lifecycle families (`create-subagent-session.test.ts`, `subagent-manager.test.ts`).
  Step 7 ([#378]) intentionally left these as the repeated `await createSubagentSession(...)` / `spawn(...)` act with test-specific arrange; re-extracting them would hide the test subject behind a helper (the wrong abstraction Step 7's `Landed` note calls out).
- The 11-line **production** clone inside `src/ui/agent-config-editor.ts` (lines 125–135 / 163–173, the location-select-and-write block).
  This issue is test-only; the production clone is tracked separately in the architecture doc's "Production duplication" section.
- The cross-package settings-loader production clone — Step 9 ([#380]).
- The three overlapping session-mock builders ([#412]).
- Adding new behavioral test cases — this is duplication removal, not coverage expansion (helper self-tests are the only new `it` blocks).

## Background

The package already has substantial shared scaffolding under `test/helpers/`:

- `make-deps.ts` — `createToolDeps(overrides)` returns `{ manager, runtime, widget }` for the tools tests.
- `ui-stubs.ts` — `makeFileOps()`, `makeMenuUI(selectResults)`, `makeMenuManager()`, `createTestSubagentConfig(overrides)`.
- `make-subagent.ts` — `createTestSubagent(overrides)`.
- `mock-session.ts` — `createMockSession()`, `createSubagentSessionStub()`, `toSubagentSession()`.
- `manager-stubs.ts` — `createBlockingFactory()`, `createSessionFactory()` (session factories, **not** the `SubagentManagerLike` service stub).
- `stub-ctx.ts` — `STUB_SNAPSHOT`.

Convention: every shared helper module under `test/helpers/` has a companion `*.test.ts` (e.g. `subagent-session-io.test.ts`).
A new shared helper must ship its own companion test.

The seven clone families fallow reports today, and the repeated blocks driving each:

| File                                    | Family             | Repeated block                                                                                                                                               | Disposition                                                       |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `test/ui/agent-creation-wizard.test.ts` | 3 groups, 33 lines | `makeMenuUI([...selections])` + `ui.input = vi.fn()...` arrange, then `makeWizard(deps)` + `showCreateWizard(...)` act                                       | file-local arrange builders                                       |
| `test/ui/agent-config-editor.test.ts`   | 4 groups, 29 lines | disabled-config spy arrange + `setupDetail(...)`, then `showAgentDetail(...)` act and `ui.select.mock.calls[0][1]` menu assertions                           | file-local `disabledConfig` builder; `setupDetail` already exists |
| `test/ui/ui-observer.test.ts`           | 3 groups, 20 lines | `const session = createMockSession(); const tracker = new AgentActivityTracker();` setup, then `subscribeUIObserver(...)` + `session.emit(...)` act          | describe-scoped `beforeEach`                                      |
| `test/tools/foreground-runner.test.ts`  | 2 groups, 21 lines | a local `makeConfig`/`makeParams` builder (cross-file with background-spawner) + a `spawnAndWait.mockImplementation` observer-registering block (intra-file) | shared `createResolvedSpawnConfig`; file-local observer helper    |
| `test/tools/background-spawner.test.ts` | (cross-file group) | a near-identical local `makeConfig`/`makeParams` builder                                                                                                     | shared `createResolvedSpawnConfig`                                |
| `test/session/session-config.test.ts`   | 1 group, 16 lines  | `mockResolveAgentConfig.mockReturnValueOnce({ name: "Explore", ..., model })` arrange, then the 6-arg `assembleSessionConfig(...)` act                       | file-local `exploreConfig` builder                                |
| `test/service/service-adapter.test.ts`  | 2 groups, 13 lines | four near-identical 7-method `SubagentManagerLike` stub factories (`createMockManager`, `defaultManager`, `createTestManager`, an inline literal)            | file-local `createManagerStub` builder                            |

The cross-file group `dup:80ee2004` (background-spawner `5-16` ↔ foreground-runner `4-15`) is the `ResolvedSpawnConfig` skeleton head — the only genuine **cross-file** duplication and the sole promotion candidate.
Every other family fallow scores as "same file on both sides," so they stay file-local.

AGENTS.md / testing-skill / Step 7 constraints that apply:

- Do not wrap the system-under-test act in a helper to eliminate a duplication-metric clone — the repeated act is the test subject (testing skill; Step 7 `Landed` note; the act-wrapping helper was reverted in Step 7).
- When consolidating duplicate test factories, diff the default values across all copies before writing the shared factory — different defaults cause cascading assertion failures during migration.
- When a TDD step deletes a test helper, re-check the file's remaining imports for orphans — Biome's `noUnusedImports` is warning-level (exit 0).
- Run the full package suite (not just the touched file) after each shared-helper change.
- `Partial<T>` top-level spread does not deep-merge nested sub-objects — relevant to the `ResolvedSpawnConfig` builder (nested `identity`/`execution`/`presentation`).

## Design Overview

Guiding distinction, inherited from Step 7: **promote to `test/helpers/` only what is genuinely shared across files; keep intra-file families as file-local helpers or describe-scoped `beforeEach`; never extract the act.**

### 1. Shared: a `ResolvedSpawnConfig` builder for the tools tests

`foreground-runner.test.ts` and `background-spawner.test.ts` each hand-build a full `ResolvedSpawnConfig` with a local `makeConfig(overrides)` — the cross-file clone.
The two copies share the nested shape and differ only in a handful of scalars:

| Field                       | foreground      | background          |
| --------------------------- | --------------- | ------------------- |
| `identity.displayName`      | `"Agent"`       | `"General-purpose"` |
| `execution.prompt`          | `"do the task"` | `"do something"`    |
| `execution.description`     | `"fg task"`     | `"bg task"`         |
| `execution.runInBackground` | `false`         | `true`              |

Crucially, three regions of the config mirror the same scalars — `execution.runInBackground` mirrors into `execution.agentInvocation.runInBackground`; `identity.displayName`/`execution.description`/`identity.subagentType` mirror into `presentation.detailBase`.
The hand-built copies duplicate that mirroring.
Add a flat-options builder to a new `test/helpers/make-spawn-config.ts` that **derives** the mirrored regions, so the construction knowledge lives in one tested place:

```typescript
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";

export interface ResolvedSpawnConfigOptions {
  subagentType?: string;
  rawType?: string;
  fellBack?: boolean;
  displayName?: string;
  prompt?: string;
  description?: string;
  model?: string;
  runInBackground?: boolean;
}

export function createResolvedSpawnConfig(
  options: ResolvedSpawnConfigOptions = {},
): ResolvedSpawnConfig {
  const subagentType = options.subagentType ?? "general-purpose";
  const displayName = options.displayName ?? "Agent";
  const description = options.description ?? "task";
  const runInBackground = options.runInBackground ?? false;
  const agentInvocation = {
    modelName: options.model,
    thinking: undefined,
    maxTurns: undefined,
    inheritContext: false,
    runInBackground,
  };
  return {
    identity: {
      subagentType,
      rawType: options.rawType ?? subagentType,
      fellBack: options.fellBack ?? false,
      displayName,
    },
    execution: {
      prompt: options.prompt ?? "do the task",
      description,
      model: undefined,
      effectiveMaxTurns: undefined,
      thinking: undefined,
      inheritContext: false,
      runInBackground,
      agentInvocation,
    },
    presentation: {
      modelName: options.model,
      agentTags: [],
      detailBase: { displayName, description, subagentType, modelName: options.model, tags: undefined },
    },
  };
}
```

Flat options (rather than `Partial<ResolvedSpawnConfig>` nested overrides) sidestep the deep-merge trap and cover every override the two files use today: the foreground "fallback note" test (`fellBack: true`, `rawType: "unknown-type"`) and the background "my task" / queued tests (`description`, `runInBackground`).
Return type **is** annotated `ResolvedSpawnConfig` here because the builder returns a plain data object (no `Mock<...>` methods to preserve), unlike the mock-session factories.

Consumer call site (the act stays inline and explicit):

```typescript
const result = await runForeground(
  manager, widget, runtime.agentActivity,
  { config: createResolvedSpawnConfig({ fellBack: true, rawType: "unknown-type" }), snapshot: STUB_SNAPSHOT, parentSession },
  undefined, undefined,
);
expect(result.content[0].text).toContain('Unknown agent type "unknown-type"');
```

`makeParams(overrides)` stays file-local in each tools test (the `parentSession`/`settings` shapes differ between `ForegroundParams` and `BackgroundParams`); only its inner `config:` default switches to `createResolvedSpawnConfig(...)`.

### 2. File-local: tools observer-registering arrange

`foreground-runner.test.ts` repeats a `spawnAndWait.mockImplementation(async (...) => { ...register observer.onSessionCreated... })` block twice (`dup:fbdc0856`).
Extract a file-local helper that **returns** the mock implementation (a value), keeping the `createToolDeps(...)` wiring and the `runForeground(...)` act inline:

```typescript
function spawnAndWaitRegistering(record = createTestSubagent({ result: "done" })) {
  record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
  return vi.fn(async (_s, _t, _p, opts: { observer?: { onSessionCreated?: (r: Subagent) => void } }) => {
    opts.observer?.onSessionCreated?.(record);
    return record;
  });
}
```

### 3. File-local: `ui-observer.test.ts` describe-scoped `beforeEach`

Every test opens with `const session = createMockSession(); const tracker = new AgentActivityTracker();`.
Move both into a describe-scoped `beforeEach` (the Step 7 AAA pattern); keep `subscribeUIObserver(session, tracker[, onUpdate])` and `session.emit(...)` inline as the act.
For the update-counting tests, replace the closure `let updateCount = 0; () => updateCount++` with a `vi.fn()` onUpdate and assert `toHaveBeenCalledTimes(n)` — removing the repeated counter scaffolding without hiding the act.

### 4. File-local: `agent-creation-wizard.test.ts` arrange builders

The repeated arrange is the menu-selection arrays and the `ui.input = vi.fn().mockResolvedValueOnce(...)` chains; the act is `makeWizard(deps)` + `showCreateWizard(ui, STUB_SNAPSHOT)`.
Extract value-returning builders for the arrange only:

```typescript
function manualUI(opts: { location?: string; tools?: string; model?: string; thinking?: string }) {
  return makeMenuUI([opts.location ?? "Project (.pi/agents/)", "Manual configuration",
    opts.tools ?? "all", opts.model ?? "inherit (parent model)", opts.thinking ?? "inherit"]);
}
function withInputs(ui: ReturnType<typeof makeMenuUI>, ...values: (string | undefined)[]) {
  ui.input = vi.fn();
  for (const v of values) (ui.input as Mock).mockResolvedValueOnce(v);
  return ui;
}
```

`makeWizard(deps)` + `await wizard.showCreateWizard(...)` stay inline in every test.

### 5. File-local: `agent-config-editor.test.ts` disabled-config builder

This file is already well-factored (`setupDetail`, `makeEditor`).
The residual families are the `vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({ ...testXConfig, enabled: false })` arrange (5 sites) and the repeated `showAgentDetail(...)` act with `const options = ui.select.mock.calls[0][1] as string[]` menu assertions.
Extract a single value-returning `disabledConfig(base)` helper (`(base: AgentConfig) => ({ ...base, enabled: false })`) for the disabled-config arrange.
Leave the `showAgentDetail(...)` act and the menu-option assertions inline — they are the test subject (see Test Impact Analysis for the menu-structure redundancy note).

### 6. File-local: `session-config.test.ts` config builder

Extract a value-returning `exploreConfig(model?)` helper returning the `{ name: "Explore", description, systemPrompt, promptMode: "replace", model }` literal that `mockResolveAgentConfig.mockReturnValueOnce(...)` consumes across the model-resolution tests.
The 6-arg `assembleSessionConfig("Explore", ctx, {}, mockEnv, mockAgentLookup, mockIO)` act stays inline.

### 7. File-local: `service-adapter.test.ts` manager-stub builder

Four near-identical 7-method `SubagentManagerLike` stubs (`createMockManager`, `defaultManager`, `createTestManager`, and an inline literal) drive both families.
Diffed defaults: `hasRunning` is `true` in `createTestManager` and `false` elsewhere; `spawn` returns `"spawned-id"` / `"id"` / `"spawned-id"` variously; `getRecord`/`listAgents`/`abort` are typed in `createTestManager`.
Consolidate into one file-local builder with documented defaults and typed overrides:

```typescript
function createManagerStub(overrides: Partial<SubagentManagerLike> = {}): SubagentManagerLike {
  return {
    spawn: vi.fn(() => "spawned-id"),
    getRecord: vi.fn(),
    listAgents: vi.fn(() => []),
    abort: vi.fn(() => true),
    waitForAll: vi.fn(async () => {}),
    hasRunning: vi.fn(() => false),
    registerWorkspaceProvider: vi.fn(() => () => {}),
    ...overrides,
  };
}
```

Call sites pass the differing fields via `overrides` (`{ hasRunning: vi.fn(() => true) }`, `{ getRecord: vi.fn((id) => records.find(...)) }`, etc.).
This is file-local — `SubagentManagerLike` is service-adapter-specific and fallow scores the family same-file.

## Module-Level Changes

- `test/helpers/make-spawn-config.ts` — **new**: `createResolvedSpawnConfig(options)` + `ResolvedSpawnConfigOptions`.
- `test/helpers/make-spawn-config.test.ts` — **new** companion test: default shape, the four scalar overrides, and the derived-mirroring assertions (`agentInvocation.runInBackground`, `presentation.detailBase`).
- `test/tools/foreground-runner.test.ts` — delete local `makeConfig`; `makeParams` inner `config:` uses `createResolvedSpawnConfig(...)`; add file-local `spawnAndWaitRegistering()`; re-check imports for orphans.
- `test/tools/background-spawner.test.ts` — delete local `makeConfig`; `makeParams` inner `config:` uses `createResolvedSpawnConfig({ displayName: "General-purpose", prompt: "do something", description: "bg task", runInBackground: true })`; re-check imports.
- `test/ui/ui-observer.test.ts` — add describe-scoped `beforeEach` creating `session`/`tracker`; switch update-counting tests to `vi.fn()` onUpdate.
- `test/ui/agent-creation-wizard.test.ts` — add file-local `manualUI()` / `withInputs()` arrange builders; route cloned arrange through them; keep act inline.
- `test/ui/agent-config-editor.test.ts` — add file-local `disabledConfig(base)`; route the disabled-config spy arranges through it.
- `test/session/session-config.test.ts` — add file-local `exploreConfig(model?)`; route the model-resolution arranges through it.
- `test/service/service-adapter.test.ts` — add file-local `createManagerStub(overrides)`; replace the four stub factories/literal with it; re-check imports.
- `docs/architecture/architecture.md` — mark Step 8 ✅ Complete with a `Landed:` bullet (matching Step 7); add `test/service/service-adapter.test.ts` to the Step 8 `Targets` line with a note that it was added in planning; refresh the "Test duplication" current-state figure.

No `src/` files change.
No public surface changes, so `verify:public-types` and the type bundle are unaffected.
The `package-pi-subagents` SKILL.md test-count line ("994 tests across 63 files as of Phase 17 Step 4") is an explicitly point-in-time figure, not a Step-8 reference, and is left untouched.

## Test Impact Analysis

Inverted lens, per the test-refactoring nature of this issue:

1. **New tests the change enables.**
   Only one helper self-test file: `make-spawn-config.test.ts` (per the `test/helpers/` companion-test convention).
   No new behavioral tests — coverage must not change.
2. **Existing tests that become redundant.**
   The five menu-structure tests in `agent-config-editor.test.ts`'s `showAgentDetail` describe assert the same expected arrays as the five `buildMenuOptions` unit tests below them.
   They are **not** removed: the `showAgentDetail` variants verify the `resolveType` → `resolveAgentConfig` → `buildMenuOptions` wiring (an integration concern), whereas `buildMenuOptions` tests the pure function in isolation.
   Removing either layer is a coverage decision outside this issue's scope; flagged here, deferred.
3. **Tests that must stay as-is.**
   Every assertion in all seven files is the regression guard; migration is green-to-green.
   In particular the foreground spinner/timer assertions, the `spawnBackground` queued/output-file assertions, the `ui-observer` turn-count/unsubscribe assertions, and the `service-adapter` serialization-stripping assertions are unchanged — only their arrange scaffolding is consolidated.

## Invariants at risk

This step touches no production code and no surface a prior Phase 17 step refactored for behavior; the lifecycle invariants from Steps 1–6 (`.promise`/`.notification` encapsulation) live in `test/lifecycle/`, which this step does not touch.
The one cross-step continuity risk is **regressing Step 7's documented discipline** — "do not wrap the system-under-test act."
Mitigation: every builder extracted here returns a value or seeds `beforeEach` setup; the acts (`showCreateWizard`, `showAgentDetail`, `runForeground`, `spawnBackground`, `assembleSessionConfig`, `subscribeUIObserver` + `emit`, and the `svc.*` calls) stay inline and explicit in each test.
A reviewer can grep each migrated file to confirm no helper name wraps an act call.

## TDD Order

Lift-and-shift refactor of tests; the suite is green at every step (no red phase — the existing assertions are the spec).
Each migration step runs the **full** package suite before committing.
Steps 4–8 are independent of each other and order-insensitive; Steps 2–3 depend on Step 1.

1. **Add shared `createResolvedSpawnConfig` + helper test.**
   Surface: `test/helpers/make-spawn-config.ts`, `test/helpers/make-spawn-config.test.ts`.
   Covers: default shape, the four scalar overrides, derived `agentInvocation`/`presentation.detailBase` mirroring.
   Run the helper test, then `pnpm run check`.
   Commit: `test: add shared createResolvedSpawnConfig builder (#379)`.
2. **Migrate `foreground-runner.test.ts`.**
   Delete local `makeConfig`; point `makeParams` at the shared builder; add `spawnAndWaitRegistering()`; re-check imports; run full suite green.
   Commit: `test: consolidate foreground-runner spawn-config fixtures (#379)`.
3. **Migrate `background-spawner.test.ts`.**
   Delete local `makeConfig`; point `makeParams` at the shared builder with background defaults; re-check imports; run full suite green.
   Commit: `test: consolidate background-spawner spawn-config fixtures (#379)`.
4. **Consolidate `ui-observer.test.ts`.**
   Add describe-scoped `beforeEach`; switch counters to `vi.fn()` onUpdate; run full suite green.
   Commit: `test: consolidate ui-observer arrange into beforeEach (#379)`.
5. **Consolidate `agent-creation-wizard.test.ts`.**
   Add `manualUI()` / `withInputs()`; route cloned arrange; run full suite green.
   Commit: `test: consolidate agent-creation-wizard arrange builders (#379)`.
6. **Consolidate `agent-config-editor.test.ts`.**
   Add `disabledConfig(base)`; route the disabled-config arranges; run full suite green.
   Commit: `test: consolidate agent-config-editor disabled-config arrange (#379)`.
7. **Consolidate `session-config.test.ts`.**
   Add `exploreConfig(model?)`; route the model-resolution arranges; run full suite green.
   Commit: `test: consolidate session-config model fixtures (#379)`.
8. **Consolidate `service-adapter.test.ts`.**
   Add `createManagerStub(overrides)`; replace the four stub factories/literal; re-check imports; run full suite green.
   Commit: `test: consolidate service-adapter manager stubs (#379)`.
9. **Measure and record outcome.**
   Run `pnpm exec fallow dupes -r packages/pi-subagents` and record the resulting clone-group count and duplication percentage; run `pnpm run check && pnpm run lint && pnpm fallow dead-code`.
   Update `docs/architecture/architecture.md` Step 8 to ✅ Complete with a `Landed:` bullet (figures, what was extracted, what was intentionally left inline), add service-adapter to its `Targets`, and refresh the current-state "Test duplication" figure.
   Commit: `docs: mark Phase 17 Step 8 complete (#379)`.

## Risks and Mitigations

- **Over-extraction / procedure-splitting to chase the metric (the Step 7 lesson).**
  Mitigation: only value-returning arrange builders and `beforeEach` setup are extracted; every act stays inline; the "Invariants at risk" grep check confirms no helper wraps an act.
- **Divergent defaults across the consolidated factories cause assertion failures.**
  Mitigation: the differing scalars are tabulated in Design (tools `ResolvedSpawnConfig`; service-adapter manager stub) before writing each shared builder; migration sets the differing fields via overrides.
- **Deep-merge trap on the nested `ResolvedSpawnConfig`.**
  Mitigation: the builder takes **flat** options and assembles the nested structure internally, so no caller passes a partial nested object expecting a merge.
- **Orphaned imports after deleting local builders (Biome `noUnusedImports` is exit 0).**
  Mitigation: re-check each migrated file's imports as part of its step; the Step 9 `pnpm run lint` + `fallow dead-code` pass is the backstop.

## Open Questions

- The roadmap's stated Step 8 outcome ("clone groups 44 → ≤ 25; overall duplication ≤ 0.6%") predates Steps 1–7; today's baseline is 32 groups / 2.49% under a different fallow metric.
  Per the planning decision, acceptance is "each named family consolidated; resulting `fallow dupes` numbers reported," not a binding group target.
  Step 9's measurement (or a later metric reconciliation) can decide whether to restate the roadmap's numeric target.
- Whether the menu-structure `showAgentDetail` tests in `agent-config-editor.test.ts` should eventually collapse into the `buildMenuOptions` unit tests (Test Impact Analysis item 2) — deferred as a coverage decision, not duplication removal.

[#378]: https://github.com/gotgenes/pi-packages/issues/378
[#380]: https://github.com/gotgenes/pi-packages/issues/380
[#412]: https://github.com/gotgenes/pi-packages/issues/412
