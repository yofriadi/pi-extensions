---
issue: 265
issue_title: "Born-complete child execution; dissolve the runner"
---

# Born-complete `SubagentSession`; dissolve the runner

## Problem Statement

Phase 16, Step 5 of [ADR-0002].
Today a subagent run is assembled by a monolithic `runAgent()` (the "runner") in `src/lifecycle/agent-runner.ts`: it creates the child session, binds extensions, drives the turn loop, collects the result, and emits the child-execution lifecycle events.
`Agent` then sequences workspace teardown and status transitions around it through an injected `AgentRunner` interface.
With the cwd now resolved through the `WorkspaceProvider` seam (Step 2) and worktrees evicted to a sibling package (Step 3), there is nothing left for a separate runner layer to assemble.

Child-session creation should instead produce a *born-complete* value object — a `SubagentSession` that wraps one SDK `AgentSession` plus its turn-driving and teardown — and the runner concept should dissolve.
`Agent.run()` becomes coordination, not assembly.

This step also closes the determinism gap deferred from #261: today `session-created`/`disposed` bracket only the first turn loop ("executing now"), so a resume — a *second* turn loop on the same session — fires no events and the permission system falls back to its filesystem-path heuristic.
Moving unregistration to true session disposal shifts the registry from "executing now" to "exists", and resume executions become registry-detected for free.

## Goals

- Introduce a born-complete `SubagentSession` (`{ session, outputFile?, dispose() }` plus turn-driving behavior) produced by a `createSubagentSession()` factory.
- `Agent` owns session interaction directly: it tells `SubagentSession` to run/resume turn loops, steer, and dispose — no injected runner.
- Dissolve the runner: remove `runAgent`, `resumeAgent`, `ConcreteAgentRunner`, `AgentRunner`, `RunOptions`, `RunResult`, `ResumeOptions`.
- Retain `getAgentConversation()` and `normalizeMaxTurns()` by relocating them to focused homes.
- Move child-session registration to creation and unregistration to true session disposal, so resume executions are registry-detected (the `disposed` event fires at cleanup, not at run-completion).
- No two-phase `setup()` / late-bound `cwd`: the factory receives a resolved `cwd` value and builds a session that is fully usable the moment it is returned.

This is an internal structural refactor.
The public `SubagentsService` surface (`spawn`, `resume`, `steer`, `registerWorkspaceProvider`) is unchanged, so the change is **non-breaking** for consumers — no `feat!:`.
The one externally observable change is positive: the permission registry now detects resume executions.

## Non-Goals

- Renaming the `Agent` class to `Subagent` — deferred to its own follow-up issue (mechanical, ~19 files, orthogonal to this structural change).
  In this issue the class stays `Agent`; only the new object is named `SubagentSession` (consistent with the existing `SubagentType` / `SubagentSessionDir` naming family).
- Retiring the remaining `agent.session` reach-throughs (steer tool/service buffer-or-deliver, conversation viewing, resume-readiness guards) — tracked in #277.
  `SubagentSession` exposes a `.session` accessor so the existing observer wiring and consumers keep working unchanged; #277 retires those.
- A resume-aware workspace lifecycle (re-establishing a worktree before a resume).
  A worktree's natural lifetime is one turn loop, not the session; worktree + resume is already degenerate today and stays so.
  See Open Questions.
- UI extraction (Phase 17).

## Background

Relevant modules:

- `src/lifecycle/agent-runner.ts` — the runner being dissolved.
  `runAgent()` does assembly + turn loop + result collection + lifecycle events; `resumeAgent()` re-prompts an existing session; `ConcreteAgentRunner` wraps both behind the `AgentRunner` interface injected into `AgentManager`.
  Also currently the home of the retained `getAgentConversation()` and `normalizeMaxTurns()`, plus the SDK-bridge IO interfaces (`EnvironmentIO`, `SessionFactoryIO`, `RunnerIO`, `ResourceLoaderOptions`, `CreateSessionOptions`) and the recursion guard `filterActiveTools()`.
- `src/lifecycle/agent.ts` — `Agent` holds `runner`, `execution: ExecutionState`, workspace prepare/dispose, status transitions, steer buffering, and `run()`/`resume()`.
- `src/lifecycle/execution-state.ts` — `ExecutionState { session, outputFile }`, attached to `Agent` on session creation.
  Subsumed by `SubagentSession`.
- `src/lifecycle/agent-manager.ts` — constructs `Agent`s with the injected `runner`; disposes sessions in `removeRecord`/`dispose`/`cleanup`.
- `src/lifecycle/child-lifecycle.ts` — the `ChildLifecyclePublisher` (`spawning`, `sessionCreated`, `completed`, `disposed`).
  Unchanged here; only *when* `disposed` fires moves.
- `src/lifecycle/workspace.ts` — the abstract `WorkspaceProvider`/`Workspace` seam.
  The core has zero git/worktree knowledge; all worktree mechanics live in `@gotgenes/pi-subagents-worktrees`, untouched by this issue.
- `src/session/session-config.ts` — `assembleSessionConfig()`, the pure assembler `runAgent()` calls.
  Unchanged; the factory calls it instead.

Registry semantics (the determinism gap): The permission system (`pi-permission-system/src/subagent-lifecycle-events.ts`) registers on `subagents:child:session-created` and unregisters on `subagents:child:disposed`, keyed by `sessionDir`.
That subscription code does **not** change.
Today `disposed` fires in `runAgent`'s `finally` (end of the first turn loop), so the registry entry is gone before any resume.
After this change `disposed` fires when the session is truly disposed (`AgentManager` cleanup / session switch / shutdown), so the entry spans the session's whole existence — every turn loop, including resumes.

The two-lifetimes fact (why Option A): A workspace's natural lifetime is **one turn loop** (the run): the `WorkspaceProvider`'s `dispose()` returns a `resultAddendum` that is folded into the run's result, so it must be called at run-completion.
A session's lifetime spans **many turn loops** (run + resumes) and ends at cleanup.
Different clocks ⇒ different resources.
The workspace therefore stays a separate `Agent`-sequenced resource (prepare at run-start, dispose at run-completion, exactly as today); only the session becomes the born-complete object.

AGENTS.md constraints that apply:

- Ship-source package with a public type bundle ([ADR-0003]): none of the dissolved types (`RunOptions`, `RunResult`, `AgentRunner`) are part of `service.ts`, so `public.d.ts` is unaffected.
  Run `pnpm run verify:public-types` is **not** required (no public-surface change), but `pnpm run check` is.
- fallow dead-code: new exports (`SubagentSession`, `createSubagentSession`) must have a production consumer by the end of the work; transient intermediate commits where they are consumed only by tests are acceptable because fallow runs at pre-completion, against the final state.
- `#src/` path-alias imports only; ES2024 target.

## Design Overview

Two new lifecycle modules replace the runner.

### `SubagentSession` — the born-complete object (owns runtime behavior)

```typescript
/** Outcome of one turn loop. */
export interface TurnLoopResult {
  responseText: string;
  aborted: boolean; // hard-aborted (max turns + grace exceeded)
  steered: boolean; // soft-limit steer fired, finished in time
}

export interface TurnLoopOptions {
  maxTurns?: number;
  graceTurns?: number;
  signal?: AbortSignal;
}

/**
 * One child AgentSession plus its turn-driving and teardown — born complete.
 * Construction (createSubagentSession) yields a fully usable instance: the
 * session exists, extensions are bound, the recursion guard is applied.
 */
export class SubagentSession {
  constructor(
    private readonly _session: AgentSession,
    private readonly meta: {
      outputFile: string | undefined;
      sessionDir: string;
      agentName: string;
      lifecycle: ChildLifecyclePublisher;
    },
  ) {}

  /** Wrapped session — exposed for observer wiring + consumers; retired by #277. */
  get session(): AgentSession { return this._session; }
  get outputFile(): string | undefined { return this.meta.outputFile; }

  /** Drive the initial run's turn loop; emits `completed` on success. */
  runTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult>;

  /** Re-prompt the same session (resume); does not emit `completed`. */
  resumeTurnLoop(prompt: string, signal?: AbortSignal): Promise<string>;

  /** Deliver a steer to the live session. */
  steer(message: string): Promise<void>;

  /** Tear down: session.dispose() + emit `disposed` (registry unregister). */
  dispose(): void;
}
```

`runTurnLoop` / `resumeTurnLoop` absorb the turn-counting, soft/hard-limit steer+abort, abort-signal forwarding, and response-text collection currently inside `runAgent`/`resumeAgent`, plus the private helpers `collectResponseText`, `getLastAssistantText`, `forwardAbortSignal`.
Placing them on `SubagentSession` (the object that owns the `AgentSession`) — rather than reaching through `subagentSession.session` from `Agent` — keeps the design free of the Law-of-Demeter violation that an inline-on-`Agent` or free-function approach would introduce.

### `createSubagentSession` — the assembly factory

```typescript
export interface SubagentSessionDeps { // (was RunnerDeps)
  io: SubagentSessionIO;               // EnvironmentIO & SessionFactoryIO (moved verbatim)
  exec: ShellExec;
  registry: AgentConfigLookup;
  lifecycle: ChildLifecyclePublisher;
}

export interface CreateSubagentSessionParams {
  snapshot: ParentSnapshot;
  type: SubagentType;
  cwd?: string;                  // resolved workspace cwd; undefined → parent cwd
  parentSession?: ParentSessionInfo;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

export function createSubagentSession(
  params: CreateSubagentSessionParams,
  deps: SubagentSessionDeps,
): Promise<SubagentSession>;
```

Body (the assembly portion of `runAgent`, unchanged in substance):

1. `lifecycle.spawning(...)`.
2. `detectEnv(exec, cwd ?? snapshot.cwd)` → `assembleSessionConfig(...)`.
3. `createResourceLoader` → `reload()`; `createSessionManager` → `newSession(...)`; `createSession(...)`.
4. Construct `SubagentSession` (session, outputFile, sessionDir, agentName, lifecycle).
5. `lifecycle.sessionCreated({ sessionDir, agentName, parentSessionId })` — synchronous, before `bindExtensions()` (the pre-bind ordering the permission registry depends on).
6. `try { await session.bindExtensions({}); applyRecursionGuard(session); } catch (err) { subagentSession.dispose(); throw err; }` — if binding fails *after* `sessionCreated`, dispose (emit `disposed` + `session.dispose()`) before rethrowing, so registration is never leaked.
7. Return the `SubagentSession`.

Note the factory takes a resolved `cwd` value, never the `WorkspaceProvider`.
The provider stays inside `Agent` (Option A): threading the provider + its prepare-context through the factory just to call `prepare()` would be a parameter-relay smell; `cwd` is a value the factory consumes directly (`detectEnv`, `assembleSessionConfig`, `createSession`).

### Lifecycle-event ownership

| Event             | Emitted by                    | When                                                            |
| ----------------- | ----------------------------- | --------------------------------------------------------------- |
| `spawning`        | `createSubagentSession`       | run start, before session creation                              |
| `session-created` | `createSubagentSession`       | after creation, before `bindExtensions()`                       |
| `completed`       | `SubagentSession.runTurnLoop` | end of the run's turn loop (success path)                       |
| `disposed`        | `SubagentSession.dispose`     | true session disposal (cleanup) — **moved** from run-completion |

`resume` neither creates a session nor emits `completed`/`disposed` — it re-prompts the live session, preserving today's behavior.

### `Agent.run()` — coordination, not assembly (consumer call-site sketch)

```typescript
async run(): Promise<void> {
  this.markRunning(Date.now());
  this.observer?.onStarted?.(this);
  this.wireSignal(this._signal, () => this.abort());

  let cwd: string | undefined;
  try {                                            // workspace prepare — unchanged
    const provider = this._getWorkspaceProvider?.();
    if (provider) { this._workspace = await provider.prepare({ ... }); cwd = this._workspace?.cwd; }
  } catch (err) { this.markError(err); this.releaseListeners(); this.observer?.onRunFinished?.(this); return; }

  try {
    this.subagentSession = await this._createSubagentSession({
      snapshot: this._snapshot!, type: this.type, cwd,
      parentSession: this._parentSession, model: this._model, thinkingLevel: this._thinkingLevel,
    });
  } catch (err) { this.failRun(err); return; }     // factory already disposed its own session

  this.flushPendingSteers();                        // → this.subagentSession.steer(msg)
  this.attachObserver(subscribeAgentObserver(this.subagentSession.session, this, { ... }));
  this.observer?.onSessionCreated?.(this, this.subagentSession.session);

  try {
    const result = await this.subagentSession.runTurnLoop(this._prompt!, {
      maxTurns: this._maxTurns, graceTurns: cfg?.graceTurns, signal: this.abortController.signal,
      // (maxTurns resolution stays: per-call ?? agentMaxTurns ?? defaultMaxTurns, via normalizeMaxTurns)
    });
    this.completeRun(result);                       // workspace teardown + status; no execution rebuild
  } catch (err) { this.failRun(err); }
}
```

`Agent.resume()` becomes `await this.subagentSession!.resumeTurnLoop(prompt, signal)` wrapped in the existing reset/observer/markCompleted/markError/releaseListeners scaffolding — no runner.

`completeRun(result: TurnLoopResult)` drops the `session`/`sessionFile` fields (the `SubagentSession` already holds them) and no longer rebuilds `execution`; it does workspace teardown (folding `resultAddendum`) and the status transition, exactly as today.

`Agent.execution: ExecutionState` becomes `Agent.subagentSession?: SubagentSession`; the `session` / `outputFile` getters delegate to it.
A new `Agent.disposeSession()` calls `this.subagentSession?.dispose()`, invoked by `AgentManager` where `record.session?.dispose?.()` is called today.

The `subscribeAgentObserver(subagentSession.session, ...)` wiring and `observer.onSessionCreated(agent, session)` still pass the raw `AgentSession`; these are the observer reach-throughs explicitly deferred to #277.
The `Agent.session` getter likewise still exposes the wrapped session for the external consumers (steer tool, get-result, menu) that #277 retires.

### Edge cases

- Creation failure after `session-created`: the factory disposes (emit `disposed` + `session.dispose()`) before rethrowing → no registry leak; symmetric with the success path.
- Turn-loop throw: `SubagentSession` exists and stays registered; `Agent.failRun` runs (workspace teardown + error status); `disposed` fires later at cleanup — symmetric register/unregister regardless of run success or failure.
- Graceful abort (max turns + grace): `runTurnLoop` returns `{ aborted: true }` and emits `completed` (matching today); a *thrown* error skips `completed`.

## Module-Level Changes

New:

- `src/lifecycle/subagent-session.ts` — `SubagentSession` class, `TurnLoopResult`, `TurnLoopOptions`, and the private turn-loop helpers (`collectResponseText`, `getLastAssistantText`, `forwardAbortSignal`).
- `src/lifecycle/create-subagent-session.ts` — `createSubagentSession`, `SubagentSessionDeps`, `CreateSubagentSessionParams`, the SDK-bridge IO interfaces moved from `agent-runner.ts` (`EnvironmentIO`, `SessionFactoryIO`, `SubagentSessionIO`, `ResourceLoaderLike`, `SessionManagerLike`, `ResourceLoaderOptions`, `CreateSessionOptions`), and the recursion guard `applyRecursionGuard`/`filterActiveTools` + `EXCLUDED_TOOL_NAMES`.
- `src/lifecycle/turn-limits.ts` — `normalizeMaxTurns`.
- `src/session/conversation.ts` — `getAgentConversation` + `formatAttribution`.

Changed:

- `src/lifecycle/agent.ts` — drop `runner`/`AgentRunner`/`RunResult`/`ExecutionState`; add injected `createSubagentSession` factory dep; `execution` → `subagentSession`; rewrite `run()`/`resume()`; `completeRun(result: TurnLoopResult)`; add `disposeSession()`; `flushPendingSteers()` delegates to `subagentSession.steer`; update the "missing runner" guard messages.
- `src/lifecycle/agent-manager.ts` — `AgentManagerOptions.runner: AgentRunner` → `createSubagentSession: (params) => Promise<SubagentSession>`; pass it into each `Agent`; `removeRecord`/`dispose` call `record.disposeSession()` instead of `record.session?.dispose?.()`.
- `src/index.ts` — drop `ConcreteAgentRunner`/`RunnerDeps`; build `SubagentSessionDeps`; pass `createSubagentSession: (p) => createSubagentSession(p, deps)` to `AgentManager`.
- `src/tools/get-result-tool.ts` — import `getAgentConversation` from `#src/session/conversation`.
- `src/tools/spawn-config.ts` — import `normalizeMaxTurns` from `#src/lifecycle/turn-limits`.
- `src/settings.ts` — update the `normalizeMaxTurns()` doc-comment reference.
- `src/runtime.ts` — update the `RunConfig` doc comment that mentions `RunOptions`.
- `src/session/session-config.ts` — update doc comments referencing `runAgent()` → `createSubagentSession()`.
- `docs/architecture/architecture.md` — update the domain dependency diagram (drop `agent-runner` node, add `SubagentSession`/`createSubagentSession`), the execution-flow sequence diagram, the current-layout listing (lifecycle dir), the dependency-bag inventory rows (`RunOptions`, `RunnerIO`, `CreateSessionOptions`, `ResourceLoaderOptions` now belong to the factory module), and mark Step 5 delivered.
- `.pi/skills/package-pi-subagents/SKILL.md` — the "Lifecycle domain" table lists `agent-runner.ts`; update to the new modules.

Removed (final step):

- `src/lifecycle/agent-runner.ts` — `runAgent`, `resumeAgent`, `ConcreteAgentRunner`, `AgentRunner`, `RunOptions`, `RunResult`, `ResumeOptions`, `RunContext`, `RunnerDeps`, `RunnerIO` (all migrated or deleted).
- `src/lifecycle/execution-state.ts` — `ExecutionState` (subsumed by `SubagentSession`).

Symbol-removal sweep (grep before finalizing each removal step): `runAgent`, `resumeAgent`, `ConcreteAgentRunner`, `AgentRunner`, `RunResult`, `RunOptions`, `ResumeOptions`, `RunContext`, `RunnerDeps`, `RunnerIO`, `ExecutionState`, `execution-state`, `agent-runner`.

## Test Impact Analysis

New unit tests the extraction enables:

- `SubagentSession` in isolation — construct with a mock `AgentSession` and a `ChildLifecyclePublisher` mock; assert `runTurnLoop` turn-limit behavior (soft steer, hard abort, grace window), response capture, `completed` emission, `resumeTurnLoop` re-prompt, `steer` delegation, and `dispose` (session.dispose + `disposed`).
  Previously these lived as `runAgent`/`resumeAgent` tests entangled with assembly.
- `createSubagentSession` — assembly + `spawning`/`session-created` ordering + dispose-on-creation-failure, with no turn-loop noise.

Tests that become redundant / simplified:

- `test/lifecycle/concrete-agent-runner.test.ts` — deleted; `ConcreteAgentRunner` is gone, its delegation coverage absorbed by the factory + `SubagentSession` tests.
- `Agent.run()` tests no longer re-drive turn events through a mock runner; they assert coordination against a stub `SubagentSession` whose `runTurnLoop` resolves to a canned `TurnLoopResult`.

Tests that must stay (genuinely exercise the layer):

- The turn-limit behavior tests (now retargeted from the runner to `SubagentSession.runTurnLoop`).
- The recursion-guard / extension-tool filtering tests (now `createSubagentSession`).
- The child-lifecycle ordering tests (now split across the factory and `SubagentSession`).
- The workspace prepare/dispose tests in `agent.test.ts` — unchanged (Option A leaves that path intact); only assertions that read `runner.run`'s args switch to reading the `createSubagentSession` factory params.

## TDD Order

Lift-and-shift: introduce the new modules alongside the runner, swap consumers atomically, delete the runner last.
Each step compiles and the suite passes; run `pnpm run check` after every step that touches a shared interface.

1. Extract `normalizeMaxTurns` → `src/lifecycle/turn-limits.ts`; update `agent-runner.ts` (internal use), `spawn-config.ts`, and the `settings.ts` comment; move `agent-runner-settings.test.ts` → `turn-limits.test.ts`.
   Commit `refactor: extract normalizeMaxTurns to turn-limits`.
2. Extract `getAgentConversation` → `src/session/conversation.ts`; update `get-result-tool.ts` import and `test/agent-conversation.test.ts` import.
   Commit `refactor: extract getAgentConversation to session/conversation`.
3. Add `SubagentSession` (`src/lifecycle/subagent-session.ts`) with `runTurnLoop`/`resumeTurnLoop`/`steer`/`dispose` + the turn-loop helpers (copied from `agent-runner.ts`; the originals are deleted in step 6 — transient duplication).
   New `test/lifecycle/subagent-session.test.ts` (turn limits, response capture, `completed`/`disposed` emission, resume) — retargeted from the runner's turn-limit + final-output tests.
   Commit `feat: add SubagentSession with turn-loop and disposal behavior`.
4. Add `createSubagentSession` (`src/lifecycle/create-subagent-session.ts`) + `SubagentSessionDeps`/`CreateSubagentSessionParams` + the IO interfaces (moved; re-export from `agent-runner.ts` if still needed there, else copied) + the recursion guard.
   New `test/lifecycle/create-subagent-session.test.ts` and `create-subagent-session-extension-tools.test.ts` — from the runner's assembly, `spawning`/`session-created` ordering, and recursion-guard tests, plus a dispose-on-creation-failure test.
   Commit `feat: add createSubagentSession factory`.
5. Swap `Agent` + `AgentManager` + `index.ts` to the factory/`SubagentSession`; drop `runner` from `AgentInit`/`AgentManagerOptions`/`index`; `execution` → `subagentSession`; add `disposeSession()`; `disposed` now fires at cleanup.
   This is the atomic call-site swap (the `runner` dep is type-coupled across `Agent` ↔ `AgentManager` ↔ `index`), so it lands with its test updates in one commit: `agent.test.ts` (run/resume/completeRun/workspace/disposeSession sections), `agent-manager.test.ts` (`createManager` helper + the dispose-on-cleanup test), `test/helpers/manager-stubs.ts` (runner stubs → factory stubs), `test/print-mode.test.ts` (mock `createSubagentSession` instead of `runAgent`).
   These are localized edits to large files, not full rewrites — the bulk of `agent.test.ts`/`agent-manager.test.ts` (status transitions, getters, queue) is untouched.
   Commit `feat: dissolve the runner; Agent drives SubagentSession directly`.
6. Delete `agent-runner.ts`, `execution-state.ts`, and `concrete-agent-runner.test.ts`; rename `test/helpers/runner-io.ts` → `subagent-session-io.ts` (and its factory functions); update `session-config.ts` / `runtime.ts` doc comments; run the symbol-removal grep sweep.
   Commit `refactor: remove agent-runner and ExecutionState`.
7. Update `docs/architecture/architecture.md` (diagrams, layout, bag inventory, mark Step 5 delivered) and the `package-pi-subagents` skill's lifecycle-domain table.
   Commit `docs: record runner dissolution and SubagentSession (#265)`.

## Risks and Mitigations

- **Registry entry persists longer (cross-package behavior).**
  `disposed` now fires at session disposal, so permission-registry entries live from creation to cleanup.
  Mitigation: `AgentManager.dispose()` (session_shutdown) disposes every `SubagentSession`, firing `disposed` for each; the permission system's subscription is unchanged.
  Verify with `pnpm -r run test` (the permission system mocks the bus, so no timing coupling).
- **Transient duplication (steps 3–5).**
  The turn-loop helpers and assembly exist in both `agent-runner.ts` and the new modules until step 6.
  Mitigation: deleted in step 6; fallow runs at pre-completion against the final state.
- **Large-file test edits in step 5.**
  Mitigation: edits are confined to the run/resume/dispose describe blocks and the `createManager` helper; the new turn-limit/assembly coverage already lives in steps 3–4's dedicated files, so step 5 only adapts coordination assertions.
- **`disposed` not fired on a path that disposes the raw session directly.**
  Mitigation: grep for every `session?.dispose` / `.dispose()` on a session in `agent-manager.ts` and route all of them through `record.disposeSession()`.

## Open Questions

- Resume-aware workspaces: should a resumed worktree agent re-establish (or reattach) a workspace before the next `session.prompt()`?
  Today it runs in the removed worktree directory (degenerate).
  This needs `WorkspaceProvider` support for resume and is out of scope; capture as a follow-up if it becomes a real need.
- Whether `completed` should also fire on resume (it does not today).
  Deferred — preserve current behavior; revisit only with a concrete consumer.

[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
[ADR-0003]: ../decisions/0003-publish-bundled-type-declarations.md
