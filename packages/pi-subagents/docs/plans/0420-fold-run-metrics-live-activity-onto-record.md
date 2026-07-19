---
issue: 420
issue_title: "pi-subagents: fold subagent run metrics and live activity onto the core record"
---

# Fold subagent run metrics and live activity onto the core record

## Problem Statement

The run-metric domain is split across two parallel observers, each subscribed to every child session.
`record-observer` accumulates `SubagentState` (tool uses, lifetime usage, compaction count); `ui-observer` accumulates a separate `AgentActivityTracker` (active tools, response text, turn count).
`turnCount` is a genuine run metric that lives only in the UI tracker, so `notification.ts` and the foreground result text reach into the tracker to recover it (Phase 18 Finding 4).
Consolidating the live-activity fields onto the single owned run-state value object (`SubagentState`) removes the duplication and is the first move in disentangling the UI's activity tier from the core.

This is Phase 18 Step 1 of the architecture roadmap (`docs/architecture/architecture.md`).
It is a **pure addition, tidy-first**: `AgentActivityTracker` and `ui-observer` still exist, both observers still run, and nothing reads the new getters yet.
The reader migration is Step 2 ([#421]) and the tracker deletion is Step 3 ([#422]).

## Goals

- Extend `SubagentState` (`src/lifecycle/subagent-state.ts`) with the live-activity fields — `turnCount`, `activeTools`, `responseText` — and their transition methods, behind read-only getters, owning all their own mutations (no field written from outside).
- Have `subscribeSubagentObserver` (`src/observation/record-observer.ts`) handle `turn_end`, `tool_execution_start`, `message_start`, and `message_update` (text_delta) alongside the events it already handles, mutating the same `SubagentState`.
- Add read-only `turnCount` / `maxTurns` / `activeTools` / `responseText` getters to `Subagent` (`src/lifecycle/subagent.ts`); the first three plus `responseText` delegate to the owned state, `maxTurns` delegates to `this.execution.maxTurns` (the effective max-turns already wired at spawn).
- Preserve the `AgentActivityTracker` semantics the readers depend on so Step 2 is a clean swap: `turnCount` starts at 1 and increments on each `turn_end`; `activeTools` is a `ReadonlyMap<string, string>` keyed `name_seq` to disambiguate concurrent same-name tools; `responseText` resets at each `message_start` and appends each text delta.

This change is **not breaking**.
The published service surface (`src/service/service.ts`) exposes `SubagentRecord`/`SubagentStatus`, not `SubagentState` or the `Subagent` constructor; the change only adds getters and value-object fields.
No observable behavior changes — both observers still run and no consumer reads the new getters.

## Non-Goals

- Migrating any reader (`widget-renderer`, `conversation-viewer`, `agent-menu`, `foreground-runner`, `notification`) off `AgentActivityTracker` — Step 2 ([#421]).
- Deleting `AgentActivityTracker` / `ui-observer` or dropping `SubagentRuntime.agentActivity` — Step 3 ([#422]).
- Removing the second (`ui-observer`) session subscription — Step 3.
- Adding a `session` reference to `SubagentState` — the tracker's `_session`/`setSession` exists only for the UI's polling reads and is migrated/removed in Steps 2–3, not folded here.
- The deeper "metrics as a pure observer projection" target — deliberately deferred per the architecture doc's first-principles refinement; folding onto the record (consistent with Phase 17's `SubagentState`) avoids inventing an asynchronous-observation seam.
- Resetting the new live-activity fields in `resetForResume` — see Design Overview; left unchanged to preserve tracker parity.

## Background

Relevant modules and how they relate:

- `src/lifecycle/subagent-state.ts` — the value object under change.
  Already owns status/result/error/timestamps and stats (`toolUses`, `lifetimeUsage`, `compactionCount`) behind getters, mutated only via transition/accumulation methods (`markRunning`, `incrementToolUses`, `addUsage`, `incrementCompactions`).
  Pure value object — imports only `LifetimeUsage`/`addUsage` from `usage.ts`; no Pi SDK imports (keep it that way).
- `src/observation/record-observer.ts` — `subscribeSubagentObserver(session, state, { onCompact })` subscribes once and currently handles `tool_execution_end`, `message_end` (assistant), and `compaction_end`.
- `src/ui/agent-activity-tracker.ts` — the parallel `AgentActivityTracker` whose live fields (`_activeTools`, `_toolKeySeq`, `_responseText`, `_turnCount` starting at 1) and transition methods (`onToolStart`, `onToolDone`, `onMessageStart`, `onMessageUpdate`, `onTurnEnd`) are the behavior being folded onto `SubagentState`.
  It also carries `_session`/`setSession` and `maxTurns` — `maxTurns` is folded (via `execution`), `_session` is not.
- `src/ui/ui-observer.ts` — `subscribeUIObserver` maps `tool_execution_start`/`tool_execution_end`/`message_start`/`message_update`/`turn_end` onto the tracker.
  The event-shape reference for the new `record-observer` branches (`event.toolName`; `event.assistantMessageEvent.type === "text_delta"` → `event.assistantMessageEvent.delta`).
- `src/lifecycle/subagent.ts` — holds one private `SubagentState`; its getters and mutation methods are one-line delegations.
  `run()` and `resume()` both attach `subscribeSubagentObserver(session, this.state, …)`.
  `this.execution.maxTurns` is the effective max-turns (both spawners pass `execution.effectiveMaxTurns` as `options.maxTurns`, threaded into `SubagentExecution.maxTurns` by `SubagentManager.spawn`).
- `src/tools/spawn-config.ts` — `effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? settings.defaultMaxTurns)`.
  `AgentActivityTracker` is constructed with `effectiveMaxTurns`; `SubagentExecution.maxTurns` carries the same value, so the new `maxTurns` getter matches the tracker.

AGENTS.md / code-design constraints that apply:

- Keep Pi SDK imports out of `SubagentState` — the new fields and methods stay SDK-free.
- The new `record-observer` branches consume SDK event payloads via the existing lean structural reads (`event.toolName`, `event.assistantMessageEvent`) — no new SDK type imports needed.
- `SubagentState` and `Subagent` are reached through the `types.ts`/internal barrels; adding getters does not change any export.

## Design Overview

### `SubagentState` additions

Three new private fields with read-only getters and five transition methods, mirroring the `AgentActivityTracker` semantics exactly so the Step 2 swap is byte-equivalent:

```typescript
// Live activity — accumulated via transition methods, readable via getters
private _turnCount = 1;
get turnCount(): number { return this._turnCount; }

private _activeTools = new Map<string, string>();
get activeTools(): ReadonlyMap<string, string> { return this._activeTools; }

private _toolKeySeq = 0;

private _responseText = "";
get responseText(): string { return this._responseText; }

/** Record a turn boundary. Called by record-observer on turn_end. */
incrementTurnCount(): void { this._turnCount++; }

/** Record a tool starting. Called by record-observer on tool_execution_start. */
addActiveTool(toolName: string): void {
	this._activeTools.set(toolName + "_" + (++this._toolKeySeq), toolName);
}

/** Remove one active tool by name (first match). Called by record-observer on tool_execution_end. */
removeActiveTool(toolName: string): void {
	for (const [key, name] of this._activeTools) {
		if (name === toolName) { this._activeTools.delete(key); break; }
	}
}

/** Reset the current response text. Called by record-observer on message_start. */
resetResponseText(): void { this._responseText = ""; }

/** Append a text delta to the current response text. Called by record-observer on message_update. */
appendResponseText(delta: string): void { this._responseText += delta; }
```

The `_toolKeySeq` counter has no getter — it is internal disambiguation state, exactly as in the tracker.
`turnCount` initializes to `1` (not `0`) to match the tracker; the readers (`notification.ts` `turnCount ?? 0`, `result-renderer.ts` `turnCount > 0`) already assume the at-least-1 invariant once an agent exists.

`resetForResume` is left **unchanged**.
The tracker is not reset on resume today (the resume path in `agent-tool.ts` does not reconstruct it), so the record-observer accumulating onto the surviving `SubagentState` across a resume preserves parity (turn count continues, response text carries the last message, active tools are empty after a completed run).
Touching `resetForResume` here would be a behavior change, contradicting the pure-addition contract.
Flagged in Risks for Step 2 to revisit if a reader demands a reset.

### `record-observer` additions

Three new branches alongside the existing ones, reading the same SDK payload shapes `ui-observer` reads:

```typescript
if (event.type === "tool_execution_start") state.addActiveTool(event.toolName);
if (event.type === "turn_end") state.incrementTurnCount();
if (event.type === "message_start") state.resetResponseText();
if (
	event.type === "message_update" &&
	event.assistantMessageEvent.type === "text_delta"
) {
	state.appendResponseText(event.assistantMessageEvent.delta);
}
```

The existing `tool_execution_end` branch already fires `state.incrementToolUses()`; it gains a paired `state.removeActiveTool(event.toolName)` so the active-tool map drains symmetrically (the tracker did this in `onToolDone`).
The observer takes no new options and emits no callbacks for these branches — the live fields are read-only state, polled by consumers later.

### `Subagent` getters

Four one-line getters added next to the existing `toolUses`/`lifetimeUsage`/`compactionCount` delegations:

```typescript
get turnCount(): number { return this.state.turnCount; }
get activeTools(): ReadonlyMap<string, string> { return this.state.activeTools; }
get responseText(): string { return this.state.responseText; }
get maxTurns(): number | undefined { return this.execution.maxTurns; }
```

`maxTurns` is the one getter that does not delegate to `state` — max-turns is execution config, not accumulated run state, and `this.execution.maxTurns` already holds the effective value (`effectiveMaxTurns`) the tracker was constructed with.

### Extracted-module interaction check (record-observer ↔ SubagentState)

The observer already targets `SubagentState` directly (Phase 17) and carries no `Subagent` dependency.
The new branches are Tell-Don't-Ask: the observer tells the state to mutate (`addActiveTool`, `incrementTurnCount`, …) and never reads-then-writes a field on the state.
No output arguments, no reach-through, no reverse search — the same shape as the existing three branches.

## Module-Level Changes

- `src/lifecycle/subagent-state.ts` — add `_turnCount`/`_activeTools`/`_toolKeySeq`/`_responseText` fields, their getters (`turnCount`, `activeTools`, `responseText`), and five transition methods (`incrementTurnCount`, `addActiveTool`, `removeActiveTool`, `resetResponseText`, `appendResponseText`).
  Update the file header doc comment to note the live-activity fields.
- `src/observation/record-observer.ts` — add `tool_execution_start`, `turn_end`, `message_start`, `message_update` (text_delta) branches; add `removeActiveTool` to the existing `tool_execution_end` branch.
  Update the JSDoc "Handles:" list.
- `src/lifecycle/subagent.ts` — add `turnCount`, `activeTools`, `responseText`, `maxTurns` getters.
- `src/lifecycle/subagent-state.ts` is referenced in `.pi/skills/package-pi-subagents/SKILL.md` and `docs/architecture/architecture.md` only as a value object / domain entry; no symbol is removed or renamed, so no skill/doc prose update is required.
  The architecture doc's Phase 18 Step 1 entry already describes this work — no edit needed.

No existing export is removed or renamed; no call site changes.
The `AgentActivityTracker` / `ui-observer` modules are untouched (they are deleted in Step 3).

## Test Impact Analysis

This is an additive change, so the analysis is mostly about new coverage:

1. **New unit tests enabled.**
   `subagent-state.test.ts` gains direct tests for the new fields/methods (turn count starts at 1 and increments; active-tool add/remove with concurrent same-name handling; response-text reset/append) — testable on a bare `SubagentState` with no session or executor.
   `record-observer.test.ts` gains tests that emitting `tool_execution_start`/`turn_end`/`message_start`/`message_update`/`tool_execution_end` drives the new state fields, using the existing `createMockSession` `emit` harness.
2. **Tests that become redundant.**
   None yet — `ui-observer.test.ts` and the tracker tests still pin live behavior until Step 3 deletes those modules.
   The new tests overlap conceptually with `ui-observer.test.ts` but exercise a different module (`record-observer` → `SubagentState`), so both stay until the tracker is removed.
3. **Tests that must stay as-is.**
   All existing `record-observer.test.ts` cases (tool uses, lifetime usage, compaction) genuinely exercise the observer→state path being extended and must keep passing unchanged.
   `subagent.test.ts` getter/delegation tests stay; new getter tests are added beside them.

## Invariants at risk

Phase 17 Step 1 ([#373]) established that `SubagentState` owns all its own mutations (no field written from outside) and that `record-observer` targets `SubagentState` directly with no `Subagent` dependency.

- **Invariant: the value object owns every mutation** — pinned by the encapsulation tests in `subagent-state.test.ts` (fields are read-only getters; mutation only via methods).
  The new fields follow the same private-field/getter/transition-method shape; new tests assert mutation flows only through the new methods.
- **Invariant: `record-observer` carries no `Subagent` dependency** — pinned by `record-observer.test.ts` constructing a bare `SubagentState` (never a `Subagent`).
  The new branches keep that property (they call `state.*` only); the existing test setup (`makeState()` returns `new SubagentState(...)`) already guards it.

No earlier phase step's `Outcome:` is regressed — this step only adds to the record both prior steps consolidated onto.

## TDD Order

1. **`SubagentState` live-activity fields and transition methods.**
   Surface: `test/lifecycle/subagent-state.test.ts`.
   Red→green: new `describe` blocks for turn count (defaults to 1, `incrementTurnCount` increments), active tools (`addActiveTool` adds with unique keys for concurrent same-name tools, `removeActiveTool` removes first match and is a no-op when absent, getter is read-only), and response text (defaults to `""`, `resetResponseText` clears, `appendResponseText` concatenates).
   Implement the fields/getters/methods in `src/lifecycle/subagent-state.ts`.
   Commit: `feat: add live-activity fields to SubagentState (#420)`.
2. **`record-observer` populates the live-activity fields.**
   Surface: `test/observation/record-observer.test.ts`.
   Red→green: new tests that `tool_execution_start` adds an active tool, paired `tool_execution_end` removes it (extending the existing tool-uses test or a sibling case), `turn_end` increments `turnCount`, `message_start` resets `responseText`, and `message_update` text_delta appends; assert non-text_delta `message_update` is ignored.
   Implement the new branches in `src/observation/record-observer.ts` and the `removeActiveTool` call in the existing `tool_execution_end` branch.
   Commit: `feat: accumulate live activity in record-observer (#420)`.
3. **`Subagent` exposes the live-activity getters.**
   Surface: `test/lifecycle/subagent.test.ts`.
   Red→green: tests that `turnCount`/`activeTools`/`responseText` delegate to the owned state (seed via a supplied `SubagentState` or by driving the attached observer), and `maxTurns` returns `execution.maxTurns`.
   Implement the four getters in `src/lifecycle/subagent.ts`.
   Run `pnpm run check` after this commit — the getters are the public-facing surface this step adds.
   Commit: `feat: expose live-activity getters on Subagent (#420)`.

Each step is independently green: the field exists before the observer writes it, and the observer writes it before `Subagent` exposes it.
No existing test breaks at any step (pure addition, no removed/renamed symbol).

## Risks and Mitigations

- **Risk: the folded fields drift from `AgentActivityTracker` semantics, making Step 2's swap not behavior-preserving.**
  Mitigation: the transition methods are copied field-for-field (turn count starts at 1, `name_seq` keying, first-match removal, reset-then-append response text); Step 2's reader-migration tests will compare record getters against the tracker before deletion.
- **Risk: resume parity — the surviving `SubagentState` accumulates turn count across a resume while a fresh tracker would not.**
  Mitigation: the tracker is *not* reset on resume today either (it is not reconstructed), so the record matches.
  `resetForResume` is left unchanged and the decision is documented; Step 2 revisits if a reader needs a per-resume reset.
- **Risk: a second observer now writes the same conceptual fields (record-observer + ui-observer), briefly duplicating active-tool/turn-count bookkeeping.**
  Mitigation: this is the intended tidy-first overlap; the duplicate (`ui-observer`) is removed in Step 3 ([#422]).
  No consumer reads the record's copy yet, so the duplication is inert.

## Open Questions

- Whether `resetForResume` should clear the live-activity fields is deferred to Step 2 ([#421]), where the actual reader behavior on resume is observable.
  Resolving it now would be speculative and would break the pure-addition contract.

[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#373]: https://github.com/gotgenes/pi-packages/issues/373
