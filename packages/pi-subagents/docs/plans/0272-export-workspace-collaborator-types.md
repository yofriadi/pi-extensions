---
issue: 272
issue_title: "Export WorkspaceProvider collaborator types by name from the public surface"
---

# Export `WorkspaceProvider` collaborator types by name from the public surface

## Problem Statement

`@gotgenes/pi-subagents` re-exports the `WorkspaceProvider` seam by name from its public surface, but not the four collaborator types that seam references: `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, and `WorkspaceDisposeResult`.
Those types are inlined into the bundled declaration (rolled in because `WorkspaceProvider` references them) but never exported by name.
A consumer implementing the seam — `@gotgenes/pi-subagents-worktrees` (#263) — cannot `import type { Workspace, WorkspacePrepareContext } from "@gotgenes/pi-subagents"`.
Instead it recovers the names through indexed-access gymnastics (`Parameters<WorkspaceProvider["prepare"]>[0]`, `NonNullable<Awaited<ReturnType<...>>>`).
That compiles and is type-safe, but every seam consumer has to repeat the same incantation rather than importing the names directly.

## Goals

- Re-export `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, and `WorkspaceDisposeResult` by name from `src/service/service.ts`, alongside `WorkspaceProvider`.
- Confirm the four names land in the bundled `dist/public.d.ts` and are importable by an external consumer.
- Extend the verification harness (`scripts/verify-public-types.sh`) so its symbol guard and probe consumer assert the four names are present and importable.
- `feat:` — adds names to the publishable public API surface (purely additive, non-breaking).

## Non-Goals

- No change to `src/lifecycle/workspace.ts` — the four interfaces already exist there with the right shapes; this issue only re-exports them.
- No change to the runtime accessor functions, `SubagentsService`, `SpawnOptions`, `SubagentRecord`, or `SUBAGENT_EVENTS`.
- No edits to `@gotgenes/pi-subagents-worktrees`.
  Replacing its indexed-access aliases with named imports and bumping its `@gotgenes/pi-subagents` dependency is deferred to that package — it can only consume these names after `pi-subagents` cuts a new release carrying them (the registry-consumption model settled in #270).
- No source restructuring of the entry's type closure (out of scope per #270's design; the rollup bundle already inlines the closure).
- No new vitest unit test — the re-exports are type-only and erase at runtime, so they are verified by the type-level `verify:public-types` harness, not by the runtime suite.

## Background

Relevant modules:

- `packages/pi-subagents/src/service/service.ts` — the public entry.
  It currently imports `type { WorkspaceProvider } from "#src/lifecycle/workspace"` and `type { LifetimeUsage } from "#src/lifecycle/usage"`, and ends with `export type { LifetimeUsage, ..., WorkspaceProvider }`.
  A standing comment already anticipates this issue: "Named re-exports of those collaborator types are tracked in #272."
- `packages/pi-subagents/src/lifecycle/workspace.ts` — defines all four collaborator interfaces plus `WorkspaceProvider`.
  `WorkspacePrepareContext` carries `agentId`, `agentType`, `baseCwd`, and optional `invocation`; `WorkspaceDisposeOutcome` carries `status` and `description`; `WorkspaceDisposeResult` carries optional `resultAddendum`; `Workspace` carries `readonly cwd` and `dispose(outcome)`.
- `packages/pi-subagents/rollup.dts.config.mjs` — rolls `src/service/service.ts` into a self-contained `dist/public.d.ts`, inlining `#src/*` types and keeping `@earendil-works/*` external.
  No config change is needed: once the names are exported from the entry, `rollup-plugin-dts` carries the (already-inlined) declarations through as named exports.
- `packages/pi-subagents/scripts/verify-public-types.sh` — the CI-backed verification harness.
  It packs the tarball, runs a self-containment guard (`grep '#src'`), loops a symbol-presence guard (`for sym in getSubagentsService WorkspaceProvider SubagentsService LifetimeUsage`), then type-checks a throwaway `probe.ts` consumer against the packaged tarball.

Constraints from `AGENTS.md` and the package skill:

- Ship-source model with one build step: `build:types` (rollup) regenerates `dist/public.d.ts` at `prepack`; `dist/` is gitignored and must never be committed.
- Run `pnpm run verify:public-types` after any change to the public surface — it is also a CI step.
- Open-for-extension/closed-for-modification: pi-subagents is a minimal core; re-exporting collaborator types of an existing seam is consistent with that boundary (no new behavior, no consumer knowledge).

## Design Overview

The change is additive and type-only.
`service.ts` already imports the seam's entry type; extend that import to bring in the four collaborator types, then list them in the existing `export type { … }`.

Import and re-export shape after the change:

```typescript
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "#src/lifecycle/workspace";

export type {
  LifetimeUsage,
  SpawnOptions,
  SubagentRecord,
  SubagentStatus,
  SubagentsService,
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
};
```

Consumer call site this enables (the pattern that motivates the issue):

```typescript
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "@gotgenes/pi-subagents";

const provider: WorkspaceProvider = {
  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    return { cwd: ctx.baseCwd, dispose: (_outcome: WorkspaceDisposeOutcome) => undefined };
  },
};
```

Edge cases:

- The standing comment in `service.ts` ("Named re-exports of those collaborator types are tracked in #272") becomes stale once the re-exports land — update it to describe the current state rather than a tracked future.
- `WorkspaceProvider` already pulls the four collaborator declarations into the rollup bundle by reference, so adding the named exports does not change the bundle's self-containment (the `grep '#src'` guard stays green).

## Module-Level Changes

- `packages/pi-subagents/src/service/service.ts` — widen the `#src/lifecycle/workspace` type import to include `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, and `WorkspaceDisposeResult`; add the same four names to the `export type { … }` block; replace the "tracked in #272" comment with a present-tense description of the seam's named re-exports.
- `packages/pi-subagents/scripts/verify-public-types.sh` — add the four names to the `for sym in …` symbol-presence guard, and extend the inline `probe.ts` to import and exercise the four types by name (e.g. annotate a `prepare` implementation with `WorkspacePrepareContext`/`Workspace` and reference `WorkspaceDisposeOutcome`/`WorkspaceDisposeResult`).

No architecture-doc updates are required: `docs/architecture/architecture.md` lists `workspace.ts` under the Lifecycle domain but does not enumerate the public surface's named exports, and no complexity/health table references this change.

## Test Impact Analysis

This is a type-only re-export change, not an extraction or refactor.

1. New tests enabled: none at the vitest level — type-only re-exports erase at runtime and cannot be observed by the runtime suite.
   The meaningful new assertion is at the type level: the extended `verify:public-types` probe proves the four names are importable from the packaged tarball, and the symbol guard proves they appear in `dist/public.d.ts`.
2. Redundant existing tests: none.
   `test/service/service.test.ts` exercises the runtime accessors and `SUBAGENT_EVENTS`; it is unaffected and stays as-is.
3. Tests that must stay as-is: the full vitest suite (the regression canary) and `test/lifecycle/agent.test.ts` (which imports `Workspace`/`WorkspaceProvider` from `#src/lifecycle/workspace` internally — unrelated to the public re-export).

## TDD Order

The "test surface" here is the type-level verification harness, which is the red→green loop for a type-only public-surface change.

1. Extend the verification harness (red → green in one step).
   Add the four names to the `for sym in …` guard in `scripts/verify-public-types.sh` and extend the inline `probe.ts` to import them by name.
   Run `pnpm run verify:public-types` to confirm it fails (red) because the names are absent from `dist/public.d.ts` and the probe import is unresolved.
   Then add the import and `export type` entries in `src/service/service.ts` and update the standing comment, and re-run `pnpm run verify:public-types` to confirm it passes (green).
   Harness change and source change land together because the type checker proves them as a unit — a packaged-tarball probe cannot import names the entry does not yet export.
   Commit: `feat: export WorkspaceProvider collaborator types by name (#272)`.

The harness step and the source step are bundled into a single commit deliberately: splitting them would leave the repo in a state where `verify:public-types` (a CI step) fails between commits.

## Risks and Mitigations

- Risk: the rollup bundle does not surface the new names as named exports.
  Mitigation: `rollup-plugin-dts` carries through whatever the entry exports; the symbol guard + probe in `verify:public-types` prove the names land in `dist/public.d.ts` and are importable.
- Risk: committing the generated `dist/public.d.ts`.
  Mitigation: `dist/` is gitignored and regenerated at `prepack`; the plan commits only `service.ts` and the harness script.
- Risk: stale comment misleads future readers.
  Mitigation: the comment update is part of the same step.

## Open Questions

- The downstream simplification in `@gotgenes/pi-subagents-worktrees` (swap indexed-access aliases for named imports, bump the `@gotgenes/pi-subagents` dependency) is intentionally deferred until a `pi-subagents` release carries these exports — it is tracked with #263's follow-up, not this plan.
