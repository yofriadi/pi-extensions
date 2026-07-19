---
issue: 537
issue_title: "pi-subagents Phase 20 Step 3: Subagent.steer returns an outcome"
---

# Subagent.steer owns the non-running rejection and returns an outcome

## Release Recommendation

**Release:** ship independently

Architecture roadmap Phase 20 Step 3 tags this issue `Release: independent` (the "Release batches" subsection lists Steps 3–9 as independently releasable).
The change is refactor-only — every step in Phase 20 lands as a `refactor:`/`test:` commit, hidden changelog types that cut no release on their own; this work auto-batches into the next unhidden release.
So this plan does not itself trigger a release; the `ship independently` marker means it needs no batch coordination at ship time.

## Problem Statement

`Subagent.steer(message)` today answers only "delivered or buffered" and leaves the non-running rejection rule to its callers.
Both `SteerTool.execute` and `SubagentsServiceAdapter.steer` pre-check `record.status !== "running"` before calling `record.steer()` — the ask-then-tell smell (Category C).
The target architecture's behavior interface is "tell by id, with outcomes": a coordinator tells the agent to steer and reacts to the outcome, rather than asking its status and then telling.
Moving the rejection rule inside `steer` removes the two scattered status pre-checks and lets `steer` report a single discriminated outcome the callers switch on.

## Goals

- `Subagent.steer` owns the non-running rejection rule and returns a discriminated `SteerOutcome` (`delivered` / `buffered` / `rejected` with the observed status).
- `SteerTool.execute` and `SubagentsServiceAdapter.steer` drop their `status !== "running"` pre-checks and switch on the outcome.
- The published `SubagentsService.steer(id, message): Promise<boolean>` contract is unchanged — the adapter maps the outcome to the existing boolean.
- Not a breaking change: `Subagent` and `SteerOutcome` are internal; no public surface or observable behavior changes.

## Non-Goals

- No change to `SubagentSession.steer` (stays `Promise<void>`) or the steer-buffer flush path (`flushPendingSteers`).
- No change to the `subagents:steered` event payload or the user-facing steer-tool message text.
- No change to the public `SubagentsService.steer` boolean signature.
- The remaining Phase 20 steps (model boundary #538, tui/theme #539, settings handler #540, notification renderer #541, `SubagentStateInit` #542, test-clone consolidation #543) are out of scope.

## Background

Relevant modules:

- `src/lifecycle/subagent.ts` — `Subagent.steer(message): Promise<boolean>` currently buffers when no session (`false`) and delivers to `subagentSession.steer` otherwise (`true`); it carries no status guard.
- `src/tools/steer-tool.ts` — `SteerTool.execute` pre-checks `record.status !== "running"`, then calls `record.steer`, emits `subagents:steered`, and renders a stats-laden success message.
- `src/service/service-adapter.ts` — `SubagentsServiceAdapter.steer` pre-checks `record?.status !== "running"` (returning `false`), then calls `record.steer` and returns `true`.
- `src/lifecycle/subagent-state.ts` — owns `SubagentStatus`; `Subagent` re-exports it.
- `src/types.ts` — barrel that re-exports `Subagent` from `#src/lifecycle/subagent`; both callers import `Subagent` from `#src/types`.

Roadmap alignment: `docs/architecture/architecture.md` line 618 already states the target ("a non-running agent rejects a steer from inside `steer`, not via a caller's status pre-check"), and the Phase 20 health-metrics table targets "Steer status pre-checks outside `Subagent.steer`" 2 → 0.
`docs/architecture/architecture.md` is in `release-please-config.json` `exclude-paths`, so a doc edit there cuts no release.

## Design Overview

Introduce a discriminated union describing the outcome of a steer attempt, exported from `subagent.ts` alongside the class:

```typescript
export type SteerOutcome =
	| { kind: "delivered" }
	| { kind: "buffered" }
	| { kind: "rejected"; status: SubagentStatus };
```

`Subagent.steer` gains the rejection rule as its first guard, preserving the existing buffer-or-deliver ordering:

```typescript
async steer(message: string): Promise<SteerOutcome> {
	if (this.status !== "running") {
		return { kind: "rejected", status: this.status };
	}
	if (!this.subagentSession) {
		this.queueSteer(message);
		return { kind: "buffered" };
	}
	await this.subagentSession.steer(message);
	return { kind: "delivered" };
}
```

This preserves today's exact semantics: the callers only ever reached `record.steer` for a running agent, and a running-but-sessionless agent still buffers.
The status guard runs first, so a non-running agent (regardless of a stale session) rejects — matching the pre-check it replaces.

### Consumer call sites

`SubagentsServiceAdapter.steer` keeps only the `undefined`-record guard (it cannot call `.steer` on nothing) and maps the outcome to the boolean:

```typescript
async steer(id: string, message: string): Promise<boolean> {
	const record = this.manager.getRecord(id);
	if (!record) return false;
	const outcome = await record.steer(message);
	return outcome.kind !== "rejected";
}
```

Mapping check against today's booleans: unknown → `false`; rejected (non-running) → `false`; buffered (queued) → `true`; delivered → `true`.
Identical to the current contract.

`SteerTool.execute` drops the status pre-check and switches on the outcome inside its existing try/catch (only the delivered path can throw, from `subagentSession.steer`):

```typescript
const record = this.manager.getRecord(params.agent_id);
if (!record) return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);

let outcome: SteerOutcome;
try {
	outcome = await record.steer(params.message);
} catch (err) {
	return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
}

switch (outcome.kind) {
	case "rejected":
		return textResult(`Agent "${params.agent_id}" is not running (status: ${outcome.status}). Cannot steer a non-running agent.`);
	case "buffered":
		this.events.emit("subagents:steered", { id: record.id, message: params.message });
		return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
	case "delivered":
		this.events.emit("subagents:steered", { id: record.id, message: params.message });
		return this.renderDelivered(record);
}
```

Behavior parity: the `subagents:steered` event fires for `buffered` and `delivered` but not `rejected` — matching today (the pre-check returned before the emit).
The stats-rendering block (tokens, tool uses, context percent, compactions) moves verbatim into a private `renderDelivered(record): ToolResult` helper.
This keeps `execute`'s cyclomatic complexity below 10 (its decision points reduce to: record guard, try/catch, and the three-arm switch), satisfying the issue's stated outcome without leaving the stats branching inline.

### Where `SteerOutcome` lives

`SteerOutcome` references `SubagentStatus`, which `subagent.ts` already re-exports; define and export `SteerOutcome` from `subagent.ts` and re-export it from `src/types.ts` on the existing `Subagent` re-export line.
Both callers already import `Subagent` from `#src/types`, so they import `SteerOutcome` from the same barrel — no new import source, and the barrel re-export has real consumers (not speculative).

### Edge cases

- Running agent, no session yet (queued→running window): buffered — unchanged.
- Non-running agent with a stale session reference: rejected (status guard is first) — matches the replaced pre-check.
- `subagentSession.steer` throws: surfaces on the delivered path; `SteerTool` catches it ("Failed to steer agent"), the adapter propagates it (as today — the adapter never wrapped steer in try/catch).

## Module-Level Changes

- `src/lifecycle/subagent.ts` — add and export `SteerOutcome`; change `steer` return type to `Promise<SteerOutcome>` and add the non-running rejection guard; update the method JSDoc.
- `src/types.ts` — re-export `SteerOutcome` alongside `Subagent` (`export { Subagent, type SteerOutcome } from "#src/lifecycle/subagent"` — verify the exact re-export form).
- `src/tools/steer-tool.ts` — drop the `status !== "running"` pre-check; switch on the `SteerOutcome`; extract the delivered-path stats rendering into a private `renderDelivered` helper.
- `src/service/service-adapter.ts` — drop the `record?.status !== "running"` pre-check; keep the `undefined`-record guard; map `outcome.kind !== "rejected"` to the boolean.
- `docs/architecture/architecture.md` — update the `Subagent` class-diagram line `+steer(message): Promise~boolean~` → `+steer(message): Promise~SteerOutcome~`; mark Step 3 `✅` and add a `Landed:` note (excluded path — no release impact).

### Doc/reference sweep

- `.pi/skills/package-pi-subagents/SKILL.md` — mentions `steer` only in the domain table and public-exports rows (no return-type prose); no edit needed.
- Historical plan docs (`0277-*`, `0214-*`, `0048-*`, `0265-*`) and retros record `Promise<boolean>` as of their time; they are frozen records — do not edit.
- `docs/architecture/client-server-opportunities.md` describes the target ("`Subagent.steer` rejecting when not running") and needs no change.

## Test Impact Analysis

This is a Tell-Don't-Ask refactor, not an extraction; the rejection logic moves from two consumers into `Subagent.steer`.

1. New tests enabled: `Subagent.steer` now has a testable rejected outcome — add a unit test asserting `{ kind: "rejected", status }` for a non-running record, tested directly on the class rather than only through the two consumers.
2. Redundant tests: the consumer tests that asserted the non-running rejection at the consumer level (`steer-tool` "rejects steering a non-running agent"; `service-adapter` "returns false for non-running agent") stay as coverage of the consumer's mapping of the rejected outcome, but their fixtures change — the `service-adapter` non-running test must use a real `createTestSubagent({ status: "completed" })` (which owns the real `steer`) instead of a bare `{ id, status } as Subagent` stub, because the adapter now calls `record.steer` unconditionally.
3. Tests that stay: the buffered/delivered `Subagent.steer` tests (updated to assert `SteerOutcome` shapes instead of booleans), the steer-tool queued/sent/error tests, and the adapter queued/delivered tests all genuinely exercise the paths and remain.

## Invariants at risk

Phase 20 Step 1 (#535) reworked the steer/notification neighborhood; its documented invariant (consumed-state suppression of the completion nudge) is orthogonal to the steer rejection rule and is not touched here.
The steer-relevant invariant this step must preserve is the `subagents:steered` emission policy (fires for buffered + delivered, not rejected) and the queued-when-sessionless buffering — both pinned by existing `steer-tool.test.ts` cases ("queues steer when session is not ready", "rejects steering a non-running agent") and the `subagent.test.ts` steer describe block.
No invariant lives only in prose; no new pinning test is required beyond the updated assertions.

## TDD Order

The `Subagent.steer` return-type change from `boolean` to `SteerOutcome` breaks both consumers and their tests at the type/assertion level in one commit, so the class change, both consumer updates, and all three affected test files land together (per the plan-guidance rule for a return-type change with multiple consumers).

1. **Red → Green → Commit — `Subagent.steer` returns an outcome; consumers switch on it.**
   - Red: in `test/lifecycle/subagent.test.ts`, rewrite the `steer` describe block to assert `SteerOutcome` shapes — `{ kind: "buffered" }` when session not ready, `{ kind: "delivered" }` when ready — and add a `{ kind: "rejected", status: "completed" }` case for a non-running record.
   - Green: add `SteerOutcome` to `subagent.ts`, change `steer` to return it with the non-running guard, re-export from `types.ts`; update `steer-tool.ts` (switch + `renderDelivered` helper) and `service-adapter.ts` (drop pre-check, map to boolean); update `test/tools/steer-tool.test.ts` and `test/service/service-adapter.test.ts` (non-running fixture → `createTestSubagent`) to match; run `pnpm --filter @gotgenes/pi-subagents run test` and `pnpm run check`.
   - Verify: `grep -rn 'status !== "running"' src` returns no site outside `subagent.ts`; `steer-tool.execute` off the fallow high-complexity list (cyclomatic < 10).
   - Commit: `refactor(pi-subagents): Subagent.steer owns rejection, returns outcome (#537)`.

2. **Docs — mark the step landed and update the class diagram.**
   - Update `docs/architecture/architecture.md`: the `Subagent` class-diagram `steer` signature to `Promise~SteerOutcome~`, mark Step 3 `✅`, and add a `Landed:` note mirroring Steps 1–2.
   - `docs/architecture/` is an excluded path — no release impact; this may fold into commit 1 instead of a separate commit at the implementer's discretion.
   - Commit (if separate): `docs(pi-subagents): mark Phase 20 Step 3 landed (#537)`.

## Risks and Mitigations

- **Behavior drift in the steer-tool message or event.**
  Mitigation: the stats block moves verbatim into `renderDelivered`; the event emission arms (buffered + delivered, not rejected) are asserted by the existing steer-tool tests, kept green.
- **Adapter boolean contract regression.**
  Mitigation: the outcome→boolean mapping table is verified against today's four cases; the adapter's public signature is unchanged and its tests are kept green.
- **A missed consumer of `Subagent.steer`.**
  Mitigation: the grep sweep confirms only `steer-tool.ts` and `service-adapter.ts` call `Subagent.steer` in `src/`; `subagentSession.steer` and `session.steer` are a different method left untouched.

## Open Questions

None — the change is fully specified by the Phase 20 roadmap and the target-architecture behavior interface.
No follow-up issues are filed; the remaining Phase 20 steps already have their own issues (#538–#543).
