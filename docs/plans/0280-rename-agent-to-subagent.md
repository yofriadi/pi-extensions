---
issue: 280
issue_title: "Rename the internal Agent class to Subagent"
---

# Rename the internal `Agent` class to `Subagent`

## Problem Statement

The internal lifecycle class `Agent` (`src/lifecycle/agent.ts`) models a single spawned subagent, but the bare name `Agent` collides with two unrelated concepts in the same code: the parent Pi agent that invokes our tooling, and the SDK's `AgentSession` that each subagent wraps.
The public API already standardized on the `Subagent*` family (`SubagentsService`, `SubagentRecord`, `SubagentStatus`, `SubagentType`, and — after [#265] — `SubagentSession` / `createSubagentSession`).
The internal lifecycle layer is the lone holdout still using bare `Agent*`.
Renaming the subagent-instance cluster closes that inconsistency and removes the parent/child/SDK ambiguity.

## Goals

- Rename the subagent-instance cluster in `src/lifecycle/` to the `Subagent*` family: `Agent` → `Subagent`, `AgentManager` → `SubagentManager`, `AgentInit` → `SubagentInit`, `AgentLifecycleObserver` → `SubagentLifecycleObserver`, `AgentManagerObserver` → `SubagentManagerObserver`, `AgentManagerOptions` → `SubagentManagerOptions`, `AgentObserverOptions` → `SubagentObserverOptions`, `AgentManagerLike` → `SubagentManagerLike`.
- Consolidate the duplicate `AgentStatus` union into the existing public `SubagentStatus`, deleting the duplicate and re-pointing `WorkspaceDisposeOutcome.status`.
- Rename the lifecycle module files to match their primary export: `agent.ts` → `subagent.ts`, `agent-manager.ts` → `subagent-manager.ts`, plus the matching test files and the `make-agent.ts` test helper.
- Extend the rename to adjacent identifiers in the same cluster for full consistency: the `subscribeAgentObserver` function → `subscribeSubagentObserver`, the `SubagentManagerObserver` methods `onAgent*` → `onSubagent*`, and the `createTestAgent` helper → `createTestSubagent`.
- Update residual bare `Agent` / `AgentManager` references in lifecycle comments, JSDoc, and error strings — the acceptance grep matches these, not just symbols.
- Update `docs/architecture/architecture.md` to the new names.
- This is internal-only and non-breaking — the exported surface is unchanged apart from `WorkspaceDisposeOutcome.status` reading `SubagentStatus` (an identical union), so commits use `refactor:`, never `feat!:`.

## Non-Goals

- The agent-type/config axis stays untouched: `AgentConfig`, `AgentType`, `AgentTypeRegistry`, `AgentConfigLookup`, `AgentInvocation`, `AgentPromptConfig`, `AgentCategories`.
- The UI/tool surface stays untouched: `AgentTool` (+ `AgentTool*` variants), `AgentSpawnConfig`, `AgentWidget`, `AgentsMenuHandler`, `AgentActivityTracker`, `AgentDetails`, `AgentCreationWizard`, `AgentConfigEditor`, `AgentFileOps`.
- SDK types stay untouched: `AgentSession`, `AgentSessionEvent`.
- Internal field/method names that do not contain the bare `Agent` word — `listAgents`, `getRecord`, the `agents` map, and `record:` parameters — are left as-is; they are not bare-`Agent` symbols and the acceptance grep does not flag them.
- No behavior changes: this is a pure rename plus a structurally no-op type consolidation.

## Background

Relevant modules (Lifecycle domain unless noted):

- `src/lifecycle/agent.ts` — defines `Agent`, `AgentInit`, `AgentLifecycleObserver`, and the duplicate `AgentStatus` union; owns the full execution lifecycle (`run`, `resume`, `abort`, `steer`, status transitions, workspace disposal).
  Contains bare-`Agent` JSDoc and two error strings (`"Agent not configured for execution …"`, `"Agent not configured for resume …"`).
- `src/lifecycle/agent-manager.ts` — defines `AgentManager`, `AgentManagerObserver` (methods `onAgentStarted` / `onAgentCompleted` / `onAgentCompacted` / `onAgentCreated`), `AgentManagerOptions`, and `AgentSpawnConfig` (out of scope).
- `src/lifecycle/workspace.ts` — `WorkspaceDisposeOutcome.status` is typed as the internal `AgentStatus`, imported from `#src/lifecycle/agent`.
- `src/observation/record-observer.ts` — defines `AgentObserverOptions` and the `subscribeAgentObserver` function.
- `src/service/service.ts` — defines the public `SubagentStatus` union (verbatim duplicate of `AgentStatus`) and re-exports `LifetimeUsage`, `Workspace`, and the four workspace collaborator types from the lifecycle layer.
- `src/service/service-adapter.ts` — defines the `AgentManagerLike` test seam.
- `src/types.ts` — barrel that re-exports `Agent` from `#src/lifecycle/agent`; most consumers import `Agent` via this barrel.
- `test/helpers/make-agent.ts` — exports `createTestAgent`, imported by ~16 test files.

Blast radius is mechanical but wide (~360 occurrences, dominated by the `Agent` class via the `types.ts` barrel).
`typescript` + `tsserver` are available, so each rename is a scope-aware language-service pass verified by `pnpm run check`; the occurrence count does not drive scope.

Constraints from AGENTS.md and skills that apply:

- Within a package, import siblings via `#src/` / `#test/` aliases (eslint enforces this) — the file moves must preserve alias imports, not introduce relative paths.
- After a barrel rename, verify at least one consumer still imports the renamed symbol from the barrel — many consumers import `Subagent` from `#src/types`, so this holds.
- The public `dist/public.d.ts` bundle is rolled from `src/service/service.ts`; run `pnpm run verify:public-types` after touching the public surface or the status consolidation.
- Load the `mermaid` skill before editing the architecture doc's class/sequence diagrams.

## Design Overview

### Status consolidation and the layering constraint

`AgentStatus` (in `agent.ts`) and `SubagentStatus` (in `service.ts`) are identical seven-member unions (`queued | running | completed | steered | aborted | stopped | error`).
The issue asks `WorkspaceDisposeOutcome.status` to point at the public `SubagentStatus`.

A naive fix — importing `SubagentStatus` from `service.ts` into `workspace.ts` — would create a circular dependency: `service.ts` already imports the workspace collaborator types (`WorkspaceDisposeOutcome`, …) from `workspace.ts`, so `workspace.ts → service.ts` reverses an existing arrow.
The correct single home is the lifecycle layer, mirroring how `service.ts` already re-exports `LifetimeUsage` from `#src/lifecycle/usage` and the workspace types from `#src/lifecycle/workspace`:

- Keep the union defined in the lifecycle layer (in the renamed `subagent.ts`), renamed `AgentStatus` → `SubagentStatus`.
- `service.ts` deletes its local definition and adds `export type { SubagentStatus } from "#src/lifecycle/subagent";` alongside its existing re-exports.
- `workspace.ts` imports `SubagentStatus` from `#src/lifecycle/subagent` (it already imports `AgentStatus` from the same module today — only the symbol name and, after the file move, the path change).

The `subagent ↔ workspace` relationship is type-only and already exists (`subagent.ts` imports `Workspace` / `WorkspaceProvider` from `workspace.ts`; `workspace.ts` imports the status union from `subagent.ts`), so no new runtime cycle is introduced — type-only imports are erased.

`rollup-plugin-dts` inlines `#src/*` types, so `dist/public.d.ts` still emits the same `SubagentStatus` union literal — structurally a no-op for consumers, confirmed by `verify:public-types`.

```typescript
// src/lifecycle/subagent.ts (renamed from agent.ts)
export type SubagentStatus =
  | "queued" | "running" | "completed" | "steered"
  | "aborted" | "stopped" | "error";

// src/service/service.ts — delete local def, re-export instead
export type { SubagentStatus } from "#src/lifecycle/subagent";

// src/lifecycle/workspace.ts
import type { SubagentStatus } from "#src/lifecycle/subagent";
export interface WorkspaceDisposeOutcome {
  status: SubagentStatus;
  description: string;
}
```

### Rename mechanics

Each symbol rename is an atomic, scope-aware language-service operation (the API behind LSP "Rename Symbol"); after each, `pnpm run check` verifies the tree compiles.
Because a rename updates every reference in one pass and leaves the build green, each logical rename is its own commit with the repository in a valid state — no lift-and-shift staging is required (a rename is not a type replacement; old and new names never coexist).

Symbol renames do not touch comments, JSDoc, or string literals.
There are 26 bare `Agent` and 4 bare `AgentManager` word-occurrences in `src/lifecycle/` comments/strings (e.g. the two `"Agent not configured …"` error messages and cross-file JSDoc in `turn-limits.ts`, `create-subagent-session.ts`, `subagent-session.ts`).
The acceptance criterion greps `src/lifecycle/` for bare `Agent` / `AgentManager`, so each rename step must also sweep residual comment/string occurrences.
Compound names (`AgentSession`, `AgentInvocation`, `AgentTypeRegistry`) are not bare-word matches and stay.

### Full-consistency adjacent identifiers

Per the scope decision, the rename extends to the rest of the cluster's naming so no `Agent`-as-subagent identifier survives:

- `src/observation/record-observer.ts`: `subscribeAgentObserver` → `subscribeSubagentObserver`, `AgentObserverOptions` → `SubagentObserverOptions`.
- `src/lifecycle/subagent-manager.ts`: `SubagentManagerObserver` methods `onAgentStarted` / `onAgentCompleted` / `onAgentCompacted` / `onAgentCreated` → `onSubagentStarted` / `onSubagentCompleted` / `onSubagentCompacted` / `onSubagentCreated` (8 + 11 + 6 + 14 call sites across `src/` and `test/`, all updated by the language-service rename).
- `test/helpers/make-agent.ts`: `createTestAgent` → `createTestSubagent`, file → `make-subagent.ts` (~16 importers, including `make-deps.ts` and `ui-stubs.ts`).

## Module-Level Changes

Renamed files (git move, preserving `#src/` / `#test/` alias imports):

- `src/lifecycle/agent.ts` → `src/lifecycle/subagent.ts`
- `src/lifecycle/agent-manager.ts` → `src/lifecycle/subagent-manager.ts`
- `test/lifecycle/agent.test.ts` → `test/lifecycle/subagent.test.ts`
- `test/lifecycle/agent-manager.test.ts` → `test/lifecycle/subagent-manager.test.ts`
- `test/helpers/make-agent.ts` → `test/helpers/make-subagent.ts`
- `test/helpers/make-agent.test.ts` → `test/helpers/make-subagent.test.ts`

Changed (symbols, members, imports, comments/strings):

- `src/lifecycle/subagent.ts` — `Agent` → `Subagent`, `AgentInit` → `SubagentInit`, `AgentLifecycleObserver` → `SubagentLifecycleObserver`, `AgentStatus` → `SubagentStatus` (kept here as the single home); update JSDoc and the two error strings.
- `src/lifecycle/subagent-manager.ts` — `AgentManager` → `SubagentManager`, `AgentManagerObserver` → `SubagentManagerObserver` (+ `onAgent*` methods → `onSubagent*`), `AgentManagerOptions` → `SubagentManagerOptions`; `AgentSpawnConfig` unchanged; update header comment.
- `src/lifecycle/workspace.ts` — import `SubagentStatus` from `#src/lifecycle/subagent`; `WorkspaceDisposeOutcome.status` retyped.
- `src/service/service.ts` — delete local `SubagentStatus` definition; add `export type { SubagentStatus } from "#src/lifecycle/subagent";`.
- `src/service/service-adapter.ts` — `AgentManagerLike` → `SubagentManagerLike`; update header comment referencing `AgentManager`.
- `src/observation/record-observer.ts` — `subscribeAgentObserver` → `subscribeSubagentObserver`, `AgentObserverOptions` → `SubagentObserverOptions`; update header comment.
- `src/types.ts` — barrel re-export `export { Agent } from "#src/lifecycle/agent";` → `export { Subagent } from "#src/lifecycle/subagent";`.
- All consumers of the renamed symbols across `src/` and `test/` (tools, UI, runtime, `index.ts`, session, observation, and their tests) — updated transitively by each language-service rename.
  Out-of-scope `Agent*` symbols in these files are untouched.
- `test/helpers/make-subagent.ts`, `make-deps.ts`, `ui-stubs.ts`, and ~16 test importers — `createTestAgent` → `createTestSubagent` and updated import paths.
- `docs/architecture/architecture.md` — file-listing entries (`agent.ts`, `agent-manager.ts`), class/sequence Mermaid diagrams, the type-complexity table row (`AgentInit` → `SubagentInit`, module `agent` → `subagent`), and current-state prose naming the renamed cluster.
  Out-of-scope `Agent*` names (`AgentTool`, `AgentSession`, `AgentTypeRegistry`, …) and historical phase narrative stay as written.

No exports are removed from the public surface; the barrel rename swaps one name for another with many live consumers.
Also swept for the `package-pi-subagents` SKILL.md, which documents internals (`AgentManager`, `Agent`, `make-agent`): update its dependency-flow sketch and module table to the new names.

## Test Impact Analysis

This is a pure rename plus a no-op type consolidation, so the extraction-style test questions resolve simply:

1. New tests enabled: none — no new seams or behavior are introduced.
2. Tests made redundant: none — no test is duplicated or subsumed.
3. Tests that must stay as-is (renamed/retargeted only): all of them.
   `test/lifecycle/subagent.test.ts`, `subagent-manager.test.ts`, `record-observer.test.ts`, `service-adapter.test.ts`, and every `createTestSubagent` consumer continue to exercise the same behavior under the new names.
   The status consolidation leaves `WorkspaceDisposeOutcome` behavior identical, so workspace/service tests are unchanged beyond the symbol name.

## TDD Order

This is a refactor with no red phase; each step is a green checkpoint verified by `pnpm run check` && `pnpm -r run test` (and `verify:public-types` where the public surface is touched) before committing.
Steps are independent renames ordered smallest-blast-first where practical; any order keeps the tree green.

1. Consolidate the status union.
   In `agent.ts` rename `AgentStatus` → `SubagentStatus` and keep the definition there; delete the duplicate in `service.ts` and re-export from the lifecycle module; retype `workspace.ts`.
   Run `pnpm run check`, tests, and `pnpm run verify:public-types` to confirm the bundle is unchanged.
   Commit: `refactor: consolidate AgentStatus into public SubagentStatus (#280)`.
2. Rename the `Agent` class cluster.
   `Agent` → `Subagent`, `AgentInit` → `SubagentInit`, `AgentLifecycleObserver` → `SubagentLifecycleObserver`; git-move `agent.ts` → `subagent.ts` and `test/lifecycle/agent.test.ts` → `subagent.test.ts`; update the `types.ts` barrel re-export and the `workspace.ts` / `service.ts` import paths to `#src/lifecycle/subagent`; sweep residual bare-`Agent` JSDoc and the two error strings in `subagent.ts`.
   Commit: `refactor: rename Agent class to Subagent (#280)`.
3. Rename the manager cluster.
   `AgentManager` → `SubagentManager`, `AgentManagerObserver` → `SubagentManagerObserver` (+ `onAgent*` methods → `onSubagent*`), `AgentManagerOptions` → `SubagentManagerOptions`; git-move `agent-manager.ts` → `subagent-manager.ts` and its test file; sweep residual bare-`AgentManager` comments.
   `AgentSpawnConfig` left untouched.
   Commit: `refactor: rename AgentManager cluster to SubagentManager (#280)`.
4. Rename the observation seam.
   `subscribeAgentObserver` → `subscribeSubagentObserver`, `AgentObserverOptions` → `SubagentObserverOptions` in `record-observer.ts`; update its test and header comment.
   Commit: `refactor: rename subscribeAgentObserver to subscribeSubagentObserver (#280)`.
5. Rename the adapter seam.
   `AgentManagerLike` → `SubagentManagerLike` in `service-adapter.ts`; update its test and header comment.
   Commit: `refactor: rename AgentManagerLike to SubagentManagerLike (#280)`.
6. Rename the test helper.
   `createTestAgent` → `createTestSubagent`; git-move `make-agent.ts` → `make-subagent.ts` and `make-agent.test.ts` → `make-subagent.test.ts`; update all importers and `#test/helpers/make-agent` paths.
   Commit: `test: rename createTestAgent to createTestSubagent (#280)`.
7. Update docs.
   Architecture doc current-state references (file listing, Mermaid diagrams, complexity table, prose) and the `package-pi-subagents` SKILL.md internals; load the `mermaid` skill before editing diagrams.
   Final verification: `pnpm run check`, `pnpm run lint`, `pnpm -r run test`, `pnpm fallow dead-code`, `pnpm run verify:public-types`, and `grep -rnE '\bAgent(Manager|Init)?\b' src/lifecycle/` returns no bare in-scope matches.
   Commit: `docs: update architecture and skill docs for Subagent rename (#280)`.

## Risks and Mitigations

- Risk: a symbol rename misses string literals or comments, leaving bare `Agent` that the acceptance grep flags.
  Mitigation: each rename step explicitly sweeps comments/strings; the final grep gate in step 7 is the backstop.
- Risk: pointing `workspace.ts` at the public `SubagentStatus` introduces a `lifecycle → service` cycle.
  Mitigation: keep the union's home in the lifecycle layer (`subagent.ts`) and re-export from `service.ts`, mirroring the existing `LifetimeUsage` / workspace re-export pattern — no new arrow.
- Risk: the public type bundle changes shape.
  Mitigation: `verify:public-types` after step 1 and step 7; the union is identical, so the bundle differs only in provenance, not content.
- Risk: a file move accidentally rewrites `#src/` alias imports to relative paths.
  Mitigation: use `git mv` and rely on the language service for import updates; eslint's no-relative-sibling rule catches regressions during `pnpm run lint`.
- Risk: over-reach into out-of-scope `Agent*` names.
  Mitigation: the rename is symbol-scoped (not text find-replace); the Non-Goals list enumerates the protected names, and the acceptance grep targets only bare `Agent` / `AgentManager` / `AgentInit` / `Agent*Observer`.

## Open Questions

- Whether to later lowercase incidental prose uses of "Agent" (meaning subagent) in the architecture doc's event tables and history sections — deferred; this plan updates symbol/file names and current-state references, leaving historical narrative as written.
- Whether `listAgents` / `getRecord` / the `agents` map deserve a follow-up naming pass — deferred; they are not bare-`Agent` symbols and fall outside the approved scope.

[#265]: https://github.com/gotgenes/pi-packages/issues/265
