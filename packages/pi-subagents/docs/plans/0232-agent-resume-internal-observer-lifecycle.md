---
issue: 232
issue_title: "Agent.resume() with internal observer lifecycle (Phase 15, Step 6)"
---

# Agent.resume() with internal observer lifecycle

## Problem Statement

After #229 (`Agent.run()` absorbs `startAgent`), the agent owns its entire run lifecycle but `AgentManager.resume()` still duplicates the observer subscribe/use/release pattern that `run()` handles internally.
The manager manually calls `subscribeAgentObserver`, wraps `runner.resume()` in a try/catch/finally, marks completion/error, and unsubscribes — the same acquire → use → release resource shape `Agent.run()` already encapsulates.
This is the last "manager reaches into Agent" duplication in the Phase 15 roadmap (priority 8, smell A: redundant pattern).

## Goals

- Add `Agent.resume(prompt, signal?)` that owns its observer subscription lifecycle, mirroring `run()`'s internal wiring.
- Reduce `AgentManager.resume()` to a guard-plus-delegation method (no `subscribeAgentObserver`, no try/finally).
- Preserve the existing public contract of `AgentManager.resume()` exactly: same signature, same `Agent | undefined` return, same behavior when the record or session is missing.
- Keep the change non-breaking (`feat:`, not `feat!:`).

## Non-Goals

- No change to `runner.resume()` / `resumeAgent()` in `agent-runner.ts`.
- No change to the abort semantics of resume — the parent `signal` continues to flow straight through to `runner.resume({ signal })` (resume does not route through the agent's `abortController`, matching today's behavior).
- No queue interaction on resume — resume is not subject to the concurrency queue, so `onStarted`/`onRunFinished` are not fired (unchanged from today).
- No full rewrite of the stale `AgentManager`/`Agent` class diagram in `architecture.md` — that diagram already diverged in #229 (missing `run()`, stale `setupWorktree`/`completeRun`/`setOnRunFinished` signatures); a comprehensive diagram refresh is out of scope here.

## Background

Relevant modules (all under `packages/pi-subagents/src/`):

- `lifecycle/agent.ts` — the `Agent` class.
  Already owns the per-run listener state (`_unsub`, `_detachFn`), the `attachObserver(unsub)` / `releaseListeners()` pair, `resetForResume(startedAt)` (which calls `releaseListeners()`), and `markCompleted` / `markError`.
  Holds `_runner` and `observer` (an `AgentLifecycleObserver`) from construction (#229).
  `Agent.run()` is the template to follow: it wires the observer via `attachObserver(subscribeAgentObserver(session, this, { onCompact: (r, info) => this.observer?.onCompacted?.(r, info) }))`.
- `lifecycle/agent-manager.ts` — `AgentManager.resume()` currently does the manual subscribe/try-finally dance and imports `subscribeAgentObserver` solely for that.
- `observation/record-observer.ts` — `subscribeAgentObserver(session, record, options)` returns an unsubscribe function; observes `tool_execution_end`, `message_end`, `compaction_end`.
- `lifecycle/agent-runner.ts` — `AgentRunner.resume(session, prompt, options?)` returns `Promise<string>` (the response text).

Constraint from AGENTS.md / `package-pi-subagents` skill: pi-subagents is a narrow core; this is a pure internal refactor (Tell-Don't-Ask, "state owns its mutations") with no policy or API-surface change.

### Observer routing equivalence

The manager's old resume wired compaction to the `AgentManagerObserver`:

```typescript
subscribeAgentObserver(session, record, {
  onCompact: (r, info) => this.observer?.onAgentCompacted(r, info),
});
```

`Agent.resume()` instead routes through the per-agent `AgentLifecycleObserver` (`this.observer?.onCompacted?.`), exactly as `run()` does.
That lifecycle observer is built by `AgentManager.buildObserver()`, whose `onCompacted` forwards to `this.observer?.onAgentCompacted(agent, info)`.
Net routing is identical — compaction events still reach the manager-level `AgentManagerObserver.onAgentCompacted`.

## Design Overview

### `Agent.resume()`

```typescript
async resume(prompt: string, signal?: AbortSignal): Promise<void> {
  if (!this._runner) {
    throw new Error("Agent not configured for execution — missing runner");
  }
  const session = this.session;
  if (!session) {
    throw new Error("Agent not configured for resume — missing session");
  }

  this.resetForResume(Date.now()); // sets running, clears result/error, releases stale listeners
  this.attachObserver(subscribeAgentObserver(session, this, {
    onCompact: (r, info) => this.observer?.onCompacted?.(r, info),
  }));

  try {
    const responseText = await this._runner.resume(session, prompt, { signal });
    this.markCompleted(responseText);
  } catch (err) {
    this.markError(err);
  } finally {
    this.releaseListeners();
  }
}
```

Decision model:

- `resetForResume()` already calls `releaseListeners()`, so any leftover handle from a prior run/resume is cleared before the new subscription is attached.
- The new subscription handle is stored via `attachObserver()` (reusing the `_unsub` slot shared with `run()`), and released in `finally` via `releaseListeners()`.
- Errors are captured (`markError`) rather than rethrown — `resume()` resolves like `run()`.
- The two guards (missing runner, missing session) mirror `run()`'s guard style.
  They are defensive: the manager guards `agent?.session` before delegating, so the session guard is unreachable in normal flow but protects the invariant for direct `Agent.resume()` callers/tests.

### `AgentManager.resume()` (delegation)

```typescript
async resume(id: string, prompt: string, signal?: AbortSignal): Promise<Agent | undefined> {
  const agent = this.agents.get(id);
  if (!agent?.session) return undefined;
  await agent.resume(prompt, signal);
  return agent;
}
```

Edge cases preserved:

- Missing record → `undefined` (no throw).
- Record present but no session → `undefined` (no throw).
- Session present → delegate, return the agent.

After this change `agent-manager.ts` no longer references `subscribeAgentObserver` — that import must be removed.
`this.runner` is still used by `spawn()` (passed to the `Agent` constructor), so the `runner` field stays.

## Module-Level Changes

- `src/lifecycle/agent.ts`
  - Add the public async method `resume(prompt: string, signal?: AbortSignal): Promise<void>` (placed near `run()` per the stepdown rule).
  - No new imports — `subscribeAgentObserver` is already imported for `run()`.
- `src/lifecycle/agent-manager.ts`
  - Replace the body of `resume()` with the guard-plus-delegation form above.
  - Remove the now-unused `import { subscribeAgentObserver } from "#src/observation/record-observer";`.
  - No other methods change.
- `src/lifecycle/agent-runner.ts` — unchanged.
- `src/observation/record-observer.ts` — unchanged.
- `docs/architecture/architecture.md` — light doc touch:
  - In the class diagram, update `AgentManager.resume(id, snapshot, exec)` → `resume(id, prompt, signal)` and add `Agent.resume(prompt, signal)` (and, while there, `Agent.run()`, which #229 omitted).
  - Mark Step 6 in the Phase 15 roadmap table/section as complete (`✅`).
  - Note: the class diagram has pre-existing staleness from #229; this touch only corrects the resume-related entries, not the whole diagram.

Symbol-removal check: the only removed symbol is the `subscribeAgentObserver` import in `agent-manager.ts`.
`grep` confirms `subscribeAgentObserver` is still imported and used in `agent.ts` and defined in `record-observer.ts`, so the export stays live.

No file in Module-Level Changes is claimed unchanged in Non-Goals (the Non-Goals list `agent-runner.ts` and `record-observer.ts`, which are genuinely untouched).

## Test Impact Analysis

This is an extraction/relocation of behavior from the manager into the agent.

1. New unit tests enabled — `Agent.resume()` can now be tested directly on `Agent` (file `test/lifecycle/agent.test.ts`), which was previously impossible because resume logic lived only in the manager.
   New direct coverage:
   - `resume()` transitions to `completed` and sets `result` from the runner's response text.
   - `resume()` transitions to `error` (and does not throw) when `runner.resume()` rejects.
   - `resume()` subscribes the record-observer to the session (usage/compaction events accumulate on the agent) and releases the subscription in `finally` (handle cleared after completion and after error).
   - `resume()` throws on missing runner / missing session (guard symmetry with `run()`).
   - Compaction during resume forwards through `this.observer?.onCompacted?.`.

2. Existing tests that become redundant — none should be deleted.
   The two manager-level resume tests in `test/lifecycle/agent-manager.test.ts` (`resume() also accumulates usage and increments compactions on the same record` and `calls injected runner.resume when resuming an agent`) now exercise the delegation + observer-forwarding integration rather than the inlined logic.
   They stay as integration coverage of `AgentManager.resume()` → `Agent.resume()` and the `onCompacted` → `onAgentCompacted` routing.
   `test/helpers/make-deps.test.ts` (calls `manager.resume(...)`) stays.

3. Existing tests that must stay as-is — the manager-level resume tests above genuinely exercise the manager's guard + delegation seam and the observer routing through `buildObserver`, which the agent-level tests do not cover.

## TDD Order

1. `test/lifecycle/agent.test.ts` — add `Agent.resume()` happy-path + error + guard tests, then implement `Agent.resume()` in `agent.ts`.
   Covers: completed/result on success, error (no throw) on rejection, observer subscribe + `releaseListeners()` in `finally`, compaction forwarding via `onCompacted`, and the missing-runner / missing-session guards.
   At this point both the new `Agent.resume()` and the old `AgentManager.resume()` body coexist (lift-and-shift: introduce the new method alongside the old logic).
   Commit: `feat: add Agent.resume() with internal observer lifecycle`
2. `test/lifecycle/agent-manager.test.ts` — keep the existing resume tests green, then collapse `AgentManager.resume()` to the guard-plus-delegation form and remove the unused `subscribeAgentObserver` import in the same commit.
   Removing the import and rewriting the body must land together — the type checker flags the unused import immediately, and the existing manager-level resume tests verify the delegation still satisfies the same contract.
   Commit: `refactor: delegate AgentManager.resume() to Agent.resume()`
3. `docs/architecture/architecture.md` — update the class diagram resume entries (and add `Agent.run()`/`Agent.resume()`), mark Step 6 complete.
   Commit: `docs: mark Phase 15 Step 6 (Agent.resume) complete`

## Risks and Mitigations

- Risk: observer routing diverges (compaction events stop reaching `onAgentCompacted`).
  Mitigation: the existing manager-level test `resume() also accumulates usage and increments compactions on the same record` asserts `compactionCount` after resume; it stays green only if routing is preserved.
- Risk: listener leak if `releaseListeners()` is missed on the error path.
  Mitigation: `releaseListeners()` is in `finally`; a dedicated agent-level test asserts the unsub handle is released after both success and error.
- Risk: behavior change in abort handling if resume is rerouted through `abortController`.
  Mitigation: explicitly keep `signal` flowing straight to `runner.resume({ signal })` (Non-Goal), identical to today.
- Risk: removing the `subscribeAgentObserver` import while another caller still needs it.
  Mitigation: `grep` confirms `agent.ts` is the only other importer and `record-observer.ts` still exports it.

## Open Questions

- Whether to later refresh the full `AgentManager`/`Agent` class diagram in `architecture.md` (stale since #229).
  Deferred — out of scope for this issue; a focused follow-up can resync the whole diagram.
