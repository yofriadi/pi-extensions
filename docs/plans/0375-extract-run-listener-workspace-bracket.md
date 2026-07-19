---
issue: 375
issue_title: "Extract run-listener and workspace-bracket collaborators from Subagent"
---

# Extract run-listener and workspace-bracket collaborators from Subagent

## Problem Statement

`subagent.ts` is the largest source file in `pi-subagents` and an accelerating churn hotspot.
Two concerns inflate the `Subagent` class beyond its core responsibility (own a child's execution lifecycle):

1. The per-run listener handles (`_unsub`, `_detachFn`) are raw nullable fields declared mid-class, with `wireSignal`/`attachObserver`/`releaseListeners` scattered around them.
2. Workspace teardown logic appears at two run-completion call sites — `completeRun` (success/abort/steer) and `failRun` (error) — each re-deriving the `if (this._workspace) … dispose() … resultAddendum` shape.

This is Phase 17 Step 4 (core consolidation).
The goal is to lift both concerns into small owned collaborators so the class shrinks and the dispose logic lives in one place.

## Goals

- Extract a `RunListeners` collaborator that owns the observer-unsubscribe and signal-detach handles, so the two listener handles stop being raw nullable fields on `Subagent`.
- Extract a `WorkspaceBracket` collaborator that owns prepare-at-run-start and dispose-with-result-addendum, so the workspace-disposal *logic* lives in exactly one place.
- Bring `subagent.ts` to ≤ 450 LOC (currently 488).
- Preserve all observable run/resume behavior exactly: observer-callback order, listener release on complete/fail/resume, workspace dispose status mapping, addendum folding, and the distinct error-handling semantics of the two dispose call sites.

This change is **not breaking**: it is a pure internal restructuring with no change to observable behavior, output shape, public service surface, or defaults.
`RunListeners` and `WorkspaceBracket` are internal lifecycle collaborators, not part of the published `dist/public.d.ts` surface.

## Non-Goals

- No change to `SubagentState`, `SubagentExecution`, the `WorkspaceProvider`/`Workspace` seam interfaces (`src/lifecycle/workspace.ts`), or `subagent-manager.ts` wiring.
- No change to the run/resume control flow, the abort path, the steer buffer, or the notification field.
- No unification of the two dispose call sites' *error-handling* semantics (see Design Overview — they are intentionally different lifecycle contexts).
- Phase 17 Steps 5–9 (manager observer extraction, widget delegation split, test-fixture consolidation, cross-package settings-loader duplication) are separate issues.

## Background

Relevant modules:

- `src/lifecycle/subagent.ts` — the `Subagent` class.
  After Phase 17 Step 2 ([#373]) extracted `SubagentState` and Step 3 ([#374]) encapsulated `start`/`promise`/`notification`, the remaining structural debt is the listener fields and the workspace dispose duplication.
- `src/lifecycle/workspace.ts` — the generative workspace seam (ADR 0002): `WorkspaceProvider.prepare(ctx)` returns a `Workspace` (a `cwd` plus a `dispose(outcome)` hook returning an optional `resultAddendum`).
- `src/lifecycle/subagent-manager.ts` — the only production constructor of `Subagent` (`spawn`); it resolves the registered provider lazily via `getWorkspaceProvider: () => this._workspaceProvider`.
  It calls `record.disposeSession()` but none of the listener/workspace methods being moved.
- `test/lifecycle/subagent.test.ts` — directly tests `wireSignal`, `attachObserver`, `releaseListeners` (3 `describe` blocks) and the workspace dispose paths via `run()`.

Current listener fields and methods on `Subagent`:

```typescript
private _unsub?: () => void;
private _detachFn?: () => void;
wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void { … } // sets _detachFn
attachObserver(unsub: () => void): void { … }                                // sets _unsub
releaseListeners(): void { … }                                               // clears both
```

The two handles are attached at different moments: `wireSignal` at run start, `attachObserver` after the session is created; `resume()` only attaches the observer.
So a single combined `attach(unsub, detach)` (the issue's first-cut sketch) does not match the real call pattern — the collaborator must expose the two attach points separately.

Current workspace state and dispose call sites:

```typescript
private _workspace?: Workspace;
// run(): const provider = this.execution.getWorkspaceProvider?.(); if (provider) { this._workspace = await provider.prepare({…}); cwd = this._workspace?.cwd; }
// completeRun(): if (this._workspace) { finalStatus = …; const r = this._workspace.dispose({status, description}); if (r?.resultAddendum) finalResult += r.resultAddendum; }
// failRun():     try { if (this._workspace) this._workspace.dispose({status:"error", description}); } catch (e) { debugLog(…); }
```

Note: the issue's "three places" wording counts `run()`'s prepare-failure catch as a teardown path, but that catch has no prepared workspace to dispose — it only releases listeners and notifies.
The actual `dispose()` call appears at **two** sites (`completeRun`, `failRun`).

Constraint from AGENTS.md / code-design: business-logic modules stay SDK-free.
Both new collaborators use only globals (`AbortSignal`) and the local `workspace.ts` types — no Pi SDK imports.
Import siblings via `#src/...` aliases.

### Invariants from prior Phase 17 steps (must not regress)

Per the [#374] retro lesson — a later phase step must not regress an earlier step's documented `Outcome:` with a green suite.
This step touches the `Subagent` run/resume surface, so the at-risk invariants are:

- **Step 1 ([#381]) — "every spawned agent has a `promise` at spawn."**
  Pinned by the regression test in `test/lifecycle/subagent-manager.test.ts` (queued agent has a `promise` at spawn) and `scheduleVia` unit tests in `subagent.test.ts`.
  This step does **not** touch `start`/`scheduleVia`/`guardedRun`/`_promise` — low risk, but the suite pins it.
- **Step 2 ([#373]) — "`Subagent` is construct-complete; no 'not configured for execution' throws."**
  Pinned by the grep check (no "not configured for execution" in `subagent.ts`) and the constructor tests.
  Both new collaborators are constructed **inside** the `Subagent` constructor (no new optional init fields), so construct-completeness is preserved.
- **Step 3 ([#374]) — "zero external writes to `Subagent` fields outside its own methods."**
  Pinned by the grep check (`\.promise =` / `\.notification =` only in `subagent.ts`).
  The removed `_unsub`/`_detachFn`/`_workspace` fields had no external writers; removing the public `wireSignal`/`attachObserver`/`releaseListeners` methods reduces the surface further.

## Design Overview

Two small owned value objects, each owning state plus the behavior that reads/writes it (principle 9 — state and behavior in a class, not raw fields scattered through a host).
Neither is procedure-splitting: each owns mutable state and returns a value (`prepare` → cwd, `dispose` → addendum) or encapsulates lifecycle handles.

### `RunListeners` — `src/lifecycle/run-listeners.ts`

Owns the two per-run teardown handles and the wire/release behavior.

```typescript
export class RunListeners {
	private unsub?: () => void;
	private detach?: () => void;

	/** Wire a parent AbortSignal so it stops the run when fired. No-op when no signal. */
	wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void {
		if (!signal) return;
		const listener = () => onAbort();
		signal.addEventListener("abort", listener, { once: true });
		this.detach = () => signal.removeEventListener("abort", listener);
	}

	/** Store the record-observer unsubscribe handle. */
	attachObserver(unsub: () => void): void {
		this.unsub = unsub;
	}

	/** Release the observer + signal handles. Idempotent. */
	release(): void {
		this.unsub?.();
		this.unsub = undefined;
		this.detach?.();
		this.detach = undefined;
	}
}
```

### `WorkspaceBracket` — `src/lifecycle/workspace-bracket.ts`

Owns the prepared `Workspace` and the prepare/dispose logic.
It captures the provider *resolver* (not the provider) so resolution stays at run-start, matching today's `getWorkspaceProvider?.()` timing.

```typescript
import type {
	Workspace,
	WorkspaceDisposeOutcome,
	WorkspacePrepareContext,
	WorkspaceProvider,
} from "#src/lifecycle/workspace";

export class WorkspaceBracket {
	private prepared?: Workspace;

	constructor(private readonly resolveProvider: () => WorkspaceProvider | undefined) {}

	/** Resolve the registered provider and prepare the child workspace; returns its cwd (undefined when none). */
	async prepare(ctx: WorkspacePrepareContext): Promise<string | undefined> {
		const provider = this.resolveProvider();
		if (!provider) return undefined;
		this.prepared = await provider.prepare(ctx);
		return this.prepared?.cwd;
	}

	/** Dispose the prepared workspace (if any); returns the result addendum verbatim ("" when none). */
	dispose(outcome: WorkspaceDisposeOutcome): string {
		if (!this.prepared) return "";
		return this.prepared.dispose(outcome)?.resultAddendum ?? "";
	}
}
```

### `Subagent` interaction with the collaborators

Constructed in the `Subagent` constructor (construct-complete):

```typescript
private readonly listeners = new RunListeners();
private readonly workspaceBracket: WorkspaceBracket;
// in constructor:
this.workspaceBracket = new WorkspaceBracket(this.execution.getWorkspaceProvider ?? (() => undefined));
```

Call sites in `run()` / `resume()` / `completeRun()` / `failRun()`:

```typescript
// run() start:
this.listeners.wireSignal(this.execution.signal, () => this.abort());
const cwd = await this.workspaceBracket.prepare({ agentId: this.id, agentType: this.type, baseCwd: this.execution.baseCwd, invocation: this.invocation });
// run() after session created:
this.listeners.attachObserver(subscribeSubagentObserver(this.subagentSession, this.state, { onCompact: … }));

// completeRun():
const finalStatus: SubagentStatus = result.aborted ? "aborted" : result.steered ? "steered" : "completed";
let finalResult = result.responseText + this.workspaceBracket.dispose({ status: finalStatus, description: this.description });
// failRun():
try { this.workspaceBracket.dispose({ status: "error", description: this.description }); }
catch (cleanupErr) { debugLog("workspace dispose on agent error", cleanupErr); }
```

This follows Tell-Don't-Ask: callers tell the bracket to `dispose(outcome)` and receive the addendum string; they do not reach through to `workspace.dispose(…).resultAddendum` (the prior Law-of-Demeter reach-through is absorbed into the bracket).

### Why the two dispose call sites stay separate (structural-duplication check)

The issue asks to "collapse the three dispose paths into one."
Tracing why the two `dispose()` calls differ (per the code-design "structural reasons before extracting duplication" heuristic) shows they are **different lifecycle contexts**, not incidental duplication:

| Call site     | Status source                                     | Addendum                    | Error handling                                                    |
| ------------- | ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `completeRun` | derived from `result` (completed/aborted/steered) | folded into the result text | propagates (a dispose throw flows to `run()`'s catch → `failRun`) |
| `failRun`     | hardcoded `"error"`                               | discarded                   | best-effort `try/catch` + `debugLog`                              |

So the resolution is: the dispose **logic** (the `if (prepared)` guard, the `.dispose()` call, the addendum unwrap) centralizes into `WorkspaceBracket.dispose()` — exactly one place, satisfying the issue's "disposal logic in exactly one place" outcome.
The two callers retain their distinct status derivation and error handling, because forcing them into one call would require a discriminator parameter that papers over a real lifecycle difference (Sandi Metz: "duplication is cheaper than the wrong abstraction").
`WorkspaceBracket.dispose()` deliberately does **not** wrap in `try/catch` — the best-effort behavior stays at `failRun`'s call site, preserving the existing semantics line-for-line (including the pre-existing success-path-throw → `failRun` re-dispose behavior).

## Module-Level Changes

- **Added** `src/lifecycle/run-listeners.ts` — `RunListeners` class (`wireSignal`, `attachObserver`, `release`).
- **Added** `src/lifecycle/workspace-bracket.ts` — `WorkspaceBracket` class (`prepare`, `dispose`).
- **Added** `test/lifecycle/run-listeners.test.ts` — direct unit tests for `RunListeners`.
- **Added** `test/lifecycle/workspace-bracket.test.ts` — direct unit tests for `WorkspaceBracket`.
- **Changed** `src/lifecycle/subagent.ts`:
  - Remove fields `_unsub`, `_detachFn`, `_workspace` and the public methods `wireSignal`, `attachObserver`, `releaseListeners`.
  - Add `private readonly listeners = new RunListeners()` and `private readonly workspaceBracket: WorkspaceBracket` (constructed from `execution.getWorkspaceProvider`).
  - Rewire `run()`, `resume()`, `resetForResume()`, `completeRun()`, `failRun()` to call `this.listeners.*` and `this.workspaceBracket.*`.
  - Add imports for the two new modules; drop the now-unused `Workspace` type import if no longer referenced (keep `WorkspaceProvider` only if still referenced — verify with the type checker).
- **Changed** `test/lifecycle/subagent.test.ts`:
  - Remove the `wireSignal`, `attachObserver / releaseListeners`, and `resetForResume releases listeners` `describe` blocks (their coverage moves to `run-listeners.test.ts`); the `run()`/`completeRun`/`failRun`/`resume` behavioral tests stay and continue to exercise the wired collaborators.
  - Remove the `attachObserver(unsub)` calls inside the `completeRun`/`failRun` "releases listeners" tests — assert listener release via the run/resume path instead, or via a `RunListeners` unit test.

Doc updates (architecture references the moved symbols and module count):

- **Changed** `docs/architecture/architecture.md`:
  - File-tree listing (`lifecycle/` block) — add `run-listeners.ts` and `workspace-bracket.ts` entries.
  - `Subagent` class diagram (key domain types) — remove `+wireSignal`, `+attachObserver`, `+releaseListeners`; optionally add `RunListeners` / `WorkspaceBracket` classes with composition edges.
  - Findings/health tables — bump `57 files` → `59 files` (lines ~650 and ~897).
  - Phase 17 Step 4 entry — append a `Landed:` note recording the two collaborators and the final `subagent.ts` LOC.
- **Changed** `.pi/skills/package-pi-subagents/SKILL.md` — "seven domains (57 files)" → "(59 files)"; Lifecycle domain module count `11` → `13` and add the two modules to the directory list; update the test count if it is cited.

Grep confirmation done while planning: `wireSignal`/`attachObserver`/`releaseListeners`/`_workspace`/`_unsub`/`_detachFn` appear only in `subagent.ts` and `subagent.test.ts` (plus the architecture class diagram); the SKILL does not name them.
`disposeSession` (the one listener-adjacent method used by `subagent-manager.ts`) is **not** part of this change.

## Test Impact Analysis

1. **New unit tests the extraction enables.**
   `RunListeners` and `WorkspaceBracket` become directly constructible and testable without booting a `Subagent` or a full `run()`:
   - `run-listeners.test.ts` — `wireSignal` attaches and `release()` detaches the abort listener; `wireSignal(undefined, …)` is a no-op; `attachObserver` + `release()` calls and clears the unsub; `release()` is idempotent (double-call safe).
   - `workspace-bracket.test.ts` — `prepare` with no provider returns `undefined`; with a provider returns `workspace.cwd`; with a provider resolving `undefined` returns `undefined`; `dispose` with no prepared workspace returns `""`; `dispose` returns the `resultAddendum` verbatim; `dispose` returns `""` when the workspace returns no addendum; a throwing `dispose` propagates (not swallowed).
2. **Existing tests that become redundant.**
   The `wireSignal`, `attachObserver / releaseListeners`, and `resetForResume releases listeners` `describe` blocks in `subagent.test.ts` (~7 tests) duplicate what `run-listeners.test.ts` now covers at a lower level — remove them.
3. **Existing tests that must stay as-is.**
   The `run()` workspace tests (prepare threads cwd into the factory, dispose status mapping for completed/error, addendum folding, no-provider path, prepare-failure path) genuinely exercise the *integration* of the bracket into the run lifecycle — they stay and verify the wiring preserved behavior.
   The `completeRun`/`failRun`/`resume`/`abort` behavioral tests stay.

## Invariants at risk

| Invariant (prior step)                                                                                       | Pinning test                                                                      | Risk from this step                                                                   |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every spawned agent has a `promise` at spawn ([#381])                                                        | `subagent-manager.test.ts` queued-agent regression test; `scheduleVia` unit tests | None — `start`/`scheduleVia`/`_promise` untouched                                     |
| `Subagent` construct-complete; no "not configured for execution" throws ([#373])                             | `subagent.test.ts` constructor tests + grep check                                 | None — both collaborators constructed in the constructor, no new optional init fields |
| Zero external writes to `Subagent` fields ([#374])                                                           | grep check (`\.promise =` / `\.notification =` only in `subagent.ts`)             | None — removes fields/methods, adds no external writers                               |
| Listener release on complete/fail/resume; observer-callback order; dispose status mapping + addendum folding | `subagent.test.ts` `run()`/`completeRun`/`failRun`/`resume` blocks                | Preserved by keeping the call sequence identical; run-suite pins it                   |

No invariant lives only in prose here — each is already pinned by a named test, and the run-lifecycle tests stay green through the wiring step.

## TDD Order

1. **Add `RunListeners` (red → green → commit).**
   Write `test/lifecycle/run-listeners.test.ts` (fails — module absent), then implement `src/lifecycle/run-listeners.ts`.
   Pure addition; `Subagent` not yet touched, suite otherwise unchanged.
   Commit: `test: add RunListeners with wire/attach/release behavior (#375)` (or a single `refactor:` if test+impl land together — prefer the red/green split).
2. **Add `WorkspaceBracket` (red → green → commit).**
   Write `test/lifecycle/workspace-bracket.test.ts` (fails — module absent), then implement `src/lifecycle/workspace-bracket.ts`.
   Pure addition.
   Commit: `test: add WorkspaceBracket prepare/dispose behavior (#375)` then `refactor: add WorkspaceBracket collaborator (#375)` — or one `refactor:` commit for the red/green pair.
3. **Wire both into `Subagent`; remove the raw fields/methods (atomic).**
   Rewire `run`/`resume`/`resetForResume`/`completeRun`/`failRun` to the collaborators; remove `_unsub`/`_detachFn`/`_workspace` and the public `wireSignal`/`attachObserver`/`releaseListeners`; construct `listeners` and `workspaceBracket` in the constructor.
   In the **same commit**, update `test/lifecycle/subagent.test.ts`: removing the three public methods breaks that file at the type level, so the deletion of the redundant `describe` blocks and the construction/wiring change must land together.
   Run `pnpm run check` immediately after (interface-shape change).
   Commit: `refactor: extract RunListeners and WorkspaceBracket from Subagent (#375)`.
4. **Update docs (commit).**
   `architecture.md` (file tree, class diagram, `57 → 59` file counts, Step 4 `Landed:` note with final LOC) and `package-pi-subagents` SKILL.md (file count, Lifecycle module list/count, test count if cited).
   Commit: `docs: record run-listener and workspace-bracket extraction (#375)`.

Verification gates after step 3 and before review: `pnpm run check`, `pnpm run lint`, `pnpm -r run test`, `pnpm fallow dead-code` (confirm no orphaned imports in `subagent.test.ts` after the `describe` removals), and `wc -l src/lifecycle/subagent.ts` (assert ≤ 450).

## Risks and Mitigations

- **Risk: the wiring step silently changes dispose error semantics.**
  Mitigation: `WorkspaceBracket.dispose()` deliberately does not `try/catch`; the best-effort wrapper stays at `failRun`'s call site, preserving the success-path-throw → `failRun` behavior line-for-line.
  A `workspace-bracket.test.ts` case asserts a throwing `dispose` propagates.
- **Risk: `subagent.ts` does not reach ≤ 450 LOC.**
  Mitigation: removing 3 fields + 3 methods (≈ 25 lines incl. comments) and simplifying the two dispose blocks nets ≈ 40 lines below the current 488; `wc -l` is a gate.
  If it lands at 451–455, that is an acceptable near-miss to note, not a blocker.
- **Risk: orphaned imports in `subagent.test.ts` after removing `describe` blocks.**
  Mitigation: Biome `noUnusedImports` is warning-level (exit 0), so run `pnpm fallow dead-code` and re-check imports manually as part of step 3.
- **Risk: release cadence.**
  This issue is internal-only; with `refactor:`/`docs:`/`test:` commits it will not trigger a release-please version bump — it ships bundled with the next feature release.
  If a standalone release is desired (matching prior Phase 17 per-step cadence), that is a ship-time decision, not a planning one.

## Open Questions

- Whether to add `RunListeners` / `WorkspaceBracket` as classes with composition edges to the architecture class diagram, or only update the file tree.
  Defer to the doc step — add them if the diagram stays readable.
- The pre-existing untested success-path-`dispose`-throw → `failRun` re-dispose behavior is preserved but remains unpinned by a `Subagent`-level test.
  Defer pinning it unless the implementer finds it cheap to add — the extraction does not change it.

[#373]: https://github.com/gotgenes/pi-packages/issues/373
[#374]: https://github.com/gotgenes/pi-packages/issues/374
[#381]: https://github.com/gotgenes/pi-packages/issues/381
