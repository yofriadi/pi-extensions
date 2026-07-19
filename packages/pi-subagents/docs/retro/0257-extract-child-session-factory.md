---
issue: 257
issue_title: "Extract ChildSessionFactory from runner"
---

# Retro: #257 — Extract ChildSessionFactory from runner

> Superseded — #257 closed `not_planned`; the work was reframed as Phase 16 "invert dependencies" ([ADR-0002], issues #261–#265).

## Stage: Planning (2026-05-29T00:32:12Z)

### Session summary

Produced the implementation plan for Phase 16, Step 2 — extracting session *creation* out of `runAgent()` into a `ChildSessionFactory` collaborator while leaving session *interaction* in the runner.
The plan is a lift-and-shift: `runAgent()` keeps its `(snapshot, type, prompt, options, deps)` signature and delegates creation to a new `ConcreteChildSessionFactory`, so the existing 313-line runner test suite keeps passing through delegation.
`#256` (`WorktreeIsolation`) is already merged; this step is independent of it and gates Steps 3-4.

### Observations

- Two deliberate refinements of the issue's interface sketch, both forced by the lift-and-shift and documented in the plan:
  - `ChildSessionResult` adds `agentMaxTurns?: number` — the turn-limit resolution lives in the interaction half but `cfg.agentMaxTurns` is only known after `assembleSessionConfig`, which moves into the factory.
    Carrying one field across the seam (not the whole `SessionConfig`) is the ISP-narrow choice.
  - `ChildSessionConfig` is kept narrow (six creation inputs); the issue's target also lists `prompt`/`maxTurns`/`getRunConfig`, but those are interaction concerns that would violate ISP for a creation-only factory.
- Deferred `ConcreteAgentRunner.createFactory()` to Step 3 (#258) even though the issue lists it as a Step 2 outcome.
  Adding it now yields an unused class member (fallow flags it): `runAgent` builds the factory directly, and `AgentManager` — the eventual `createFactory` caller — is not wired until Step 3.
  The factory still has a production consumer this step (`runAgent`), so it is not dead.
- The permission-bridge `vi.mock()` is path-based, so moving the `registerChildSession`/`unregisterChildSession` import from `agent-runner.ts` into the factory does not break the existing mock — it intercepts the factory's import unchanged.
- Type-only import of `RunnerDeps` (factory → runner) plus value import of the factory class (runner → factory) is a one-way runtime arrow; `import type` erasure means no real cycle.
- `RunResult.sessionFile` shifts from a late `sessionManager.getSessionFile()` to the factory's `outputFile` — same value (stable after `newSession()`); the existing `/sessions/child.jsonl` assertion is the guard.
- Did not invoke `ask_user`: the issue's "Proposed change" is prescriptive, and the two deviations are forced/justified rather than open-ended.
- IO interfaces (`RunnerIO`, `RunnerDeps`, etc.) intentionally stay in `agent-runner.ts` for this step to minimize churn; their relocation to the factory module is flagged as an Open Question for Step 4 when the runner dissolves.

[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
