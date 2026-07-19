# Phase 15: Domain model evolution

## Summary

Phase 15 evolved `Agent` from a passive state machine (`AgentRecord`) into an object that **owns its entire execution lifecycle**.
Before Phase 15, `AgentManager` orchestrated everything: calling the runner, handling session creation, wiring observers, and cleaning up worktrees — reaching into Agent 10+ times across `spawn()` and `startAgent()`.
After Phase 15, Agent is born complete with all dependencies and configuration, owns `run()` and `resume()`, and manages its own observer and worktree lifecycle.

All six steps are closed: [#227], [#228], [#231], [#229], [#230], [#232].

## Key changes

- `AgentRecord` renamed to `Agent` with full behavioral surface.
- `Agent.run()` encapsulates the entire execution lifecycle: worktree setup, runner invocation, session-creation handling, observer wiring, worktree cleanup, and status transitions.
- `Agent.resume()` manages its own observer subscription lifecycle.
- `startAgent` deleted from `AgentManager` — replaced by `agent.run()`.
- `ConcurrencyQueue` extracted from `AgentManager` — scheduling is independently testable.
- `SpawnArgs` deleted — the queue stores agent IDs, not config objects.
- `onSessionCreated` callback replaced by `AgentLifecycleObserver` passed at construction.
- `exec` and `registry` relay-only dependencies moved from `AgentManager` to `ConcreteAgentRunner`.
- `AgentManagerOptions` shrunk from 7 to 5 fields.

## Steps

### Step 1: Evolve AgentRecord into Agent with behavior — [#227]

Renamed `AgentRecord` → `Agent`.
Moved per-agent behavior from `AgentManager` into the agent: `abort()`, `queueSteer()` / `flushPendingSteers()`, `setupWorktree()`.

### Step 2: Convert startAgent to async/await — [#228]

Converted `startAgent` to `async` with `try/catch` and dissolved `RunHandle` into `Agent` methods.
Agent gained run lifecycle methods: `completeRun`, `failRun`, `wireSignal`, `attachObserver`, `releaseListeners`.

### Step 3: Push exec/registry relay deps to runner construction — [#231]

`exec` and `registry` moved from `AgentManager` to `ConcreteAgentRunner` via `RunnerDeps`.
`RunContext` shrunk from 4 to 2 per-call fields.

### Step 4: Agent born complete — Agent.run() absorbs startAgent — [#229]

Agent receives `runner`, `worktrees`, and a lifecycle observer at construction.
`Agent.run()` encapsulates the entire execution lifecycle.
`startAgent`, `SpawnArgs`, `onSessionCreated` callback deleted.

### Step 5: Extract ConcurrencyQueue from AgentManager — [#230]

Extracted `queue[]`, `runningBackground`, `_getMaxConcurrent`, `drainQueue()`, `finalizeBackgroundRun()` into `ConcurrencyQueue`.
`AgentManager` lost 3 fields and 3 methods (~40 lines).

### Step 6: Agent.resume() with internal observer lifecycle — [#232]

`Agent.resume(prompt, signal)` manages its own observer subscription lifecycle.
`AgentManager.resume()` became a one-liner delegation.

## Findings summary

| Finding                                                            | Category     | Status                |
| ------------------------------------------------------------------ | ------------ | --------------------- |
| `AgentRecord` anemic — no behavior, manager reaches in 37×         | B: Oversized | ✅ Resolved           |
| Agent cannot run itself — manager orchestrates 10 external touches | C: Coupling  | ✅ Resolved           |
| Scheduling tangled into `AgentManager` (3 fields, 3 methods)       | A: Coupling  | ✅ Resolved           |
| `startAgent` uses `.then()`/`.catch()` instead of async/await      | C: Callbacks | ✅ Resolved           |
| `onSessionCreated` callback flows through 3 layers                 | C: Callbacks | ✅ Subsumed by Step 4 |
| `resume()` duplicates observer subscribe/unsubscribe pattern       | A: Redundant | ✅ Resolved           |
| `exec`/`registry` relay-only deps on `AgentManager`                | C: Coupling  | ✅ Resolved           |

[#227]: https://github.com/gotgenes/pi-packages/issues/227
[#228]: https://github.com/gotgenes/pi-packages/issues/228
[#229]: https://github.com/gotgenes/pi-packages/issues/229
[#230]: https://github.com/gotgenes/pi-packages/issues/230
[#231]: https://github.com/gotgenes/pi-packages/issues/231
[#232]: https://github.com/gotgenes/pi-packages/issues/232
