---
issue: 542
issue_title: "pi-subagents Phase 20 Step 8: full-value SubagentStateInit"
---

# Full-value `SubagentStateInit`

## Release Recommendation

**Release:** ship independently

This is Phase 20 Step 8, tagged `Release: independent` in the architecture roadmap and listed under "Independently releasable" in the Phase 20 release-batch subsection.
It lands as a `refactor:`/`test:` commit — a hidden changelog type that cuts no release on its own and auto-batches into the next unhidden `pi-subagents` release.

## Problem Statement

`createTestSubagent` is the most complex function in the workspace (19 cyclomatic, 25 cognitive), but that complexity is a symptom of a narrow production surface.
`SubagentStateInit` accepts only transition fields (`status`, `result`, `error`, `startedAt`, `completedAt`), so any caller wanting a populated `SubagentState` must replay the accumulation history through mutation loops — `incrementToolUses()` × N, `addUsage(...)`, `incrementCompactions()` × N, `addActiveTool(...)` per entry, `appendResponseText(...)`.
A value object should be constructible at any point in its value space; the narrow init forces the replay.
This is a Category D "shared factory complexity" signal pointing back at the production init surface, not the test helper.

## Goals

- Extend `SubagentStateInit` to optionally seed the full value: `toolUses`, `lifetimeUsage`, `compactionCount`, `turnCount`, `activeTools`, `responseText`.
- Collapse the mutation loops in `createTestSubagent` into direct init, driving its cyclomatic complexity to ≤ 8 and off the fallow complexity list.
- Preserve all existing behavior — the accumulation methods stay; only a construction path is added.

## Non-Goals

- No change to the accumulation/transition methods (`incrementToolUses`, `addUsage`, `incrementCompactions`, `incrementTurnCount`, `addActiveTool`, `removeActiveTool`, `resetResponseText`, `appendResponseText`) — they remain the runtime path used by `record-observer`.
- Not the Step 9 test-clone consolidation ([#543]) — that reworks some of the same fixtures and runs last to avoid churning them twice.
- No change to the public service surface — `SubagentState` is an internal `#src` type, not a published export, so no `verify:public-types` run is needed.

## Background

Relevant modules:

- `src/lifecycle/subagent-state.ts` — the `SubagentState` value object and its `SubagentStateInit` interface.
  Fields split into three groups: transition state (`status`/`result`/`error`/`startedAt`/`completedAt`, already in init), stats (`toolUses`/`lifetimeUsage`/`compactionCount`), and live activity (`turnCount`/`activeTools`/`responseText`).
  `activeTools` is a `Map<string, string>` keyed `name_seq` via a private `_toolKeySeq` counter; `addActiveTool(name)` increments the counter and inserts.
- `test/helpers/make-subagent.ts` — `createTestSubagent`, which seeds every populated field through mutation loops after construction (the target of the collapse).
- `src/lifecycle/subagent-manager.ts:166` — the sole production `new SubagentState({...})` call, seeding only `status` + `startedAt` (unaffected: the new fields are optional).
- `src/lifecycle/subagent.ts:200` — `new SubagentState()` default construction (unaffected).
- `test/lifecycle/subagent-state.test.ts`, `test/lifecycle/subagent.test.ts`, `test/observation/record-observer.test.ts` — existing `new SubagentState(...)` call sites; all pass only transition fields, so the additive change leaves them compiling and green.

Roadmap constraint (from `docs/architecture/architecture.md`): every Phase 20 step lands as a `refactor:`/`test:` commit, and `/tdd-plan` lands the architecture-doc `✅` step-mark at implementation completion.

## Design Overview

`SubagentStateInit` becomes:

```typescript
export interface SubagentStateInit {
	status?: SubagentStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
	// Stats
	toolUses?: number;
	lifetimeUsage?: LifetimeUsage;
	compactionCount?: number;
	// Live activity
	turnCount?: number;
	activeTools?: string[];
	responseText?: string;
}
```

The constructor seeds each new field with a `?? default` that matches the current field-initializer defaults, so unspecified fields behave exactly as before:

```typescript
constructor(init: SubagentStateInit = {}) {
	this._status = init.status ?? "queued";
	this._result = init.result;
	this._error = init.error;
	this._startedAt = init.startedAt ?? Date.now();
	this._completedAt = init.completedAt;
	this._toolUses = init.toolUses ?? 0;
	this._lifetimeUsage = init.lifetimeUsage
		? { ...init.lifetimeUsage }
		: { input: 0, output: 0, cacheWrite: 0 };
	this._compactionCount = init.compactionCount ?? 0;
	this._turnCount = init.turnCount ?? 1;
	this._responseText = init.responseText ?? "";
	for (const name of init.activeTools ?? []) {
		this.addActiveTool(name);
	}
}
```

Design decisions:

- **`activeTools` is seeded by name (`string[]`), not by a full `Map`.**
  The `name_seq` map keys are an internal implementation detail, not part of the observable value.
  Seeding through `addActiveTool` reuses the existing keying path and preserves the `_toolKeySeq` invariant (a caller-supplied map with hand-picked keys could collide with a later `addActiveTool` call, since the seq counter starts at 0).
  This mirrors what `record-observer` and the current test helper already do.
- **`lifetimeUsage` is copied, not aliased.**
  `addUsage` mutates `_lifetimeUsage` in place; assigning `init.lifetimeUsage` directly would let a later accumulation mutate the caller's object (an output-argument smell).
  The spread copy keeps the value object owning its own state.
- **Default preservation.**
  Every `?? default` reproduces the current field-initializer value (`_toolUses = 0`, `_turnCount = 1`, `_responseText = ""`, `_lifetimeUsage = { input: 0, output: 0, cacheWrite: 0 }`).
  Existing default-construction tests pin these and stay green.

Extracted-module interaction — `createTestSubagent` after the collapse (the seeding moves from post-construction mutation into the init object):

```typescript
const state = new SubagentState({
	status: "completed",
	result: "All done.",
	startedAt: 1000,
	completedAt: 2000,
	toolUses: toolUses ?? 3,
	lifetimeUsage: lifetimeUsage ?? { input: 500, output: 500, cacheWrite: 0 },
	...(compactionCount !== undefined ? { compactionCount } : {}),
	...(turnCount !== undefined ? { turnCount } : {}),
	...(activeTools !== undefined ? { activeTools } : {}),
	...(responseText !== undefined ? { responseText } : {}),
	...stateOverrides,
});
```

The factory defaults (3 tool uses, `{ 500, 500, 0 }` usage) move into the init object; the branchy mutation loops after `new Subagent(...)` are deleted, which is what drops the cyclomatic count.
`createTestSubagent` no longer needs to reach for `state.incrementTurnCount()` / `state.addActiveTool()` / `state.appendResponseText()` directly.

## Module-Level Changes

- `src/lifecycle/subagent-state.ts` — add six optional fields to `SubagentStateInit`; extend the constructor to seed them (with the copy + name-seeding semantics above).
  Purely additive; no field or method removed.
- `test/helpers/make-subagent.ts` — collapse the post-construction mutation loops in `createTestSubagent` into the `SubagentState` init object; remove the now-unused direct `state.*` seeding.
  The `TestSubagentOptions` interface and its JSDoc shorthands stay (the factory still accepts the same overrides; only their application changes).
- `test/lifecycle/subagent-state.test.ts` — add unit tests for full-value construction (new behavior enabled by this change).
- `docs/architecture/architecture.md` — mark Step 8 complete: change the `#### Step 8 —` heading to `#### ✅ Step 8 —`, add a `Landed:` note under it, and prefix the Mermaid `S8` node label with `✅`.
  The `createTestSubagent` cyclomatic health-metric row already lists `≤ 8` as the Phase 20 target; no table edit is required beyond the step mark, but the `Landed:` note records the achieved value.

No removed or renamed exports, so no cross-file symbol grep for deletions is needed; `SubagentStateInit` and `SubagentState` keep their names and gain only optional members.

## Test Impact Analysis

1. **New tests enabled.**
   Full-value construction was previously impossible through init — it required post-construction mutation.
   Add `subagent-state.test.ts` cases asserting the constructor seeds `toolUses`, `lifetimeUsage` (including the copy semantics — mutating the source object after construction must not change the state's usage), `compactionCount`, `turnCount`, `activeTools` (by name, count reflected in the `activeTools` map), and `responseText`.
2. **Redundant tests.**
   None become redundant.
   The existing accumulation-method tests (`incrementToolUses`, `addUsage`, etc.) still exercise the runtime mutation path used by `record-observer` and must stay.
3. **Tests that must stay as-is.**
   The default-construction tests (`new SubagentState()` with no init) pin the field defaults the new `?? default` branches must preserve; keep them unchanged as the invariant guard.

## Invariants at risk

- **Phase 17 Step 2 (#373) — `SubagentState` extraction.**
  The value object's field defaults (`status "queued"`, `startedAt Date.now()`, `toolUses 0`, `turnCount 1`, `lifetimeUsage {0,0,0}`, `responseText ""`) are a documented outcome pinned by the "defaults" cases in `test/lifecycle/subagent-state.test.ts`.
  The `?? default` seeding must reproduce each; the existing tests fail loudly if a default drifts.
- **`record-observer` runtime path.**
  `test/observation/record-observer.test.ts` exercises accumulation via the mutation methods; unchanged and must stay green — this change adds a construction path, it does not reroute the observer.

## TDD Order

1. **Extend `SubagentStateInit` + constructor (with unit tests).**
   Red: add `subagent-state.test.ts` cases for full-value construction (all six new fields plus the `lifetimeUsage` copy-semantics case) — they fail because the fields are not on the init type / not seeded.
   Green: add the six optional fields and the constructor seeding.
   Run `pnpm run check` (interface change) and the `subagent-state` suite.
   Commit: `refactor(pi-subagents): seed full value via SubagentStateInit (#542)`.
2. **Collapse `createTestSubagent` mutation loops.**
   Move the factory defaults and override application into the `SubagentState` init object; delete the post-construction mutation loops and direct `state.*` seeding.
   Run the full package suite (shared test helper — `pnpm --filter @gotgenes/pi-subagents exec vitest run`) and confirm `createTestSubagent` cyclomatic ≤ 8 via `pnpm fallow` (the complexity target that motivated the step).
   Commit: `test(pi-subagents): collapse createTestSubagent mutation loops into init (#542)`.
3. **Land the architecture-doc step mark.**
   Mark Step 8 `✅` (heading + Mermaid `S8` node), add the `Landed:` note recording the achieved cyclomatic value.
   Commit: `docs(pi-subagents): mark Phase 20 Step 8 complete (#542)`.

## Risks and Mitigations

- **`lifetimeUsage` aliasing.**
  Assigning the init object directly would leak a mutable reference into the value object.
  Mitigation: spread-copy in the constructor; a dedicated test mutates the source after construction and asserts the state is unchanged.
- **`activeTools` key-seq collision.**
  Accepting a full `Map` with caller keys could collide with a later `addActiveTool`.
  Mitigation: seed by `string[]` through `addActiveTool`, preserving the seq invariant.
- **Silent wrong defaults in tests.**
  esbuild does not typecheck, and removed-field/added-field init mistakes surface as wrong runtime values, not failures.
  Mitigation: the additive change removes no field; the default-construction tests pin every default; run the full suite in Step 2.

## Open Questions

None.
The change is additive, internal, and behavior-preserving; the design is fully determined by the roadmap outcome (cyclomatic ≤ 8, no production behavior change).

[#543]: https://github.com/gotgenes/pi-packages/issues/543
