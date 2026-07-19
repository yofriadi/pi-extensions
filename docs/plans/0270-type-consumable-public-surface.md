---
issue: 270
issue_title: "Make @gotgenes/pi-subagents type-consumable by sibling workspace packages"
---

# Publish a bundled `.d.ts` for the pi-subagents public surface

## Problem Statement

`@gotgenes/pi-subagents` cannot be imported by another TypeScript package in this workspace.
A sibling that writes `import { getSubagentsService, type WorkspaceProvider } from "@gotgenes/pi-subagents"` fails its `tsc` run.
This blocks Issue #263 (extract worktree isolation to `@gotgenes/pi-subagents-worktrees`), the first package that needs to import the subagents service and the `WorkspaceProvider` seam by name.

Two compounding causes were confirmed empirically with `tsc --traceResolution`:

1. `package.json` `exports["."]` points at `./src/service.ts`, which does not exist — the real module is `./src/service/service.ts`.
   This is a latent bug; nothing in-repo imports the package by name today.
2. Once the path is corrected, the public entry's internal alias imports cascade.
   `service/service.ts` imports `type LifetimeUsage` and `type WorkspaceProvider` via `#src/*`.
   When a sibling's `tsc` follows the symlink and resolves those specifiers, the consumer's own `paths` (`#src/*` → `./src/*`) intercept first and point into the *consumer's* `src/` (a global-`paths` collision — both packages even define `#src/*`).
   The fallback to the publisher's `package.json` `imports` field then fails too: tsc cannot resolve the extensionless `.ts` target under Node `imports` semantics ("Import specifier '#src/lifecycle/usage' does not exist in package.json scope").

The public entry's type closure is also deeply entangled: `WorkspaceProvider` (in `lifecycle/workspace.ts`) pulls in `AgentStatus` from the 510-line `lifecycle/agent.ts`, plus `SubagentType`/`AgentInvocation` from `types.ts` (which itself re-exports the `Agent` class).
A shallow alias-free entry is therefore not achievable without a substantial source restructure.

## Goals

- A consumer using the **published/packaged** `@gotgenes/pi-subagents` can `import { getSubagentsService, type WorkspaceProvider } from "@gotgenes/pi-subagents"` and have `tsc` pass.
- Fix the stale `exports["."]` path so it resolves to a real file.
- Emit a self-contained (alias-free) `.d.ts` for the public surface via `rollup-plugin-dts`, generated at pack/publish time and shipped in the npm tarball.
- Add a verification harness that proves external consumability via `pnpm pack` → throwaway consumer → `tsc`, with no publish round-trip.
- No regression to how Pi loads the extension from source (`pi.extensions: ["./src/index.ts"]` is untouched).
- `feat:` — adds a publishable capability (a typed public API surface) to `pi-subagents`.

## Non-Goals

- No source restructuring to make the entry alias-free (the rejected alternative — see Background).
  `src/` modules and `#src/*` internal imports are left exactly as they are.
- No removal of worktree code from the core (`worktree.ts`, `worktree-isolation.ts`, `IsolationMode`, `isolation` spawn mode) — that is Issue #263.
- No change to `pi-subagents-worktrees`' dependency wiring: it stays on `workspace:*` and does not yet import `@gotgenes/pi-subagents`.
  Flipping it to registry consumption (drop `workspace:*`, set `link-workspace-packages: false`, point at the fixed version, wire the real import) is deferred to Issue #263, because the registry version carrying this fix does not exist until #270 is published.
- No registration of `pi-subagents-worktrees` into `release-please-config.json` — that belongs to Issue #263 when it is ready to publish.

## Background

Relevant modules and facts:

- `packages/pi-subagents/src/service/service.ts` — the real public entry.
  Locally declares the public service contract (`SubagentsService`, `SubagentRecord`, `SpawnOptions`, `SubagentStatus`, `SUBAGENT_EVENTS`) and the `Symbol.for()` accessor functions (`publishSubagentsService`, `getSubagentsService`, `unpublishSubagentsService`).
  Its only internal imports are `import type { LifetimeUsage }` and `import type { WorkspaceProvider }` — both type-only, so they erase at runtime.
- `src/lifecycle/workspace.ts` — defines `WorkspaceProvider`, `Workspace`, and the prepare/dispose context types.
  Imports `AgentStatus` from `#src/lifecycle/agent` and `AgentInvocation`/`SubagentType` from `#src/types`.
- `src/lifecycle/usage.ts` — defines `LifetimeUsage` plus internal runtime helpers.
- `src/lifecycle/agent.ts` (510 LOC) — defines `AgentStatus` near the top, alongside the `Agent` class and a wide `#src/*` import graph.
- `src/index.ts` — the Pi extension entry; imports `publishSubagentsService`/`unpublishSubagentsService` from `#src/service/service` (internal use, unaffected).

Constraints from `AGENTS.md` and the package skill:

- Ship-source model: every package ships raw `.ts` executed directly by Pi; there is no build step today.
  [ADR-0002] frames pi-subagents as a minimal core.
  Introducing the repo's **first build step** is a deliberate decision and warrants an ADR.
- `eslint`'s `no-parent-relative-imports` rule forbids `../` imports inside `packages/*/src`; same-directory `./` is allowed.
  This (plus the deep type entanglement above) is why the alias-free-entry alternative was rejected.
- New packages and internal docs subdirectories must be added to `release-please-config.json` `exclude-paths` where appropriate.

Rejected alternative (recorded for the ADR): restructure the source so the entry's full type closure is alias-free (leaf types module imported via `./`).
It is mechanically possible but requires moving `AgentStatus`/`SubagentType`/`AgentInvocation`/`WorkspaceProvider` definitions and reworking the `agent.ts`/`types.ts` entanglement, with care around dependency direction (inner layers must not import the outer service layer).
Larger blast radius than emitting a `.d.ts`.

Release/CI mechanics relevant to sequencing:

- CI publishes only when the `release-please` PR is merged (`publish` job gated on `releases_created == true`), not on every push to `main`.
- `release-please` batches all releasable commits per component.
  The `#263` scaffold commits on `main` touch only the `pi-subagents-worktrees` component (which is **not** registered in `release-please-config.json`), so they neither trigger a release nor batch into `pi-subagents`.

## Design Overview

### Conditional exports

Point the `types` condition at the bundled declaration and the runtime condition at the real source module:

```jsonc
"exports": {
  ".": {
    "types": "./dist/public.d.ts",
    "default": "./src/service/service.ts"
  }
}
```

- `default` → `./src/service/service.ts` fixes the stale path and serves runtime `await import("@gotgenes/pi-subagents")` (the accessor functions; its `import type` lines erase, so no runtime `#src/*` resolution is needed).
- `types` → `./dist/public.d.ts` gives a consumer's `tsc` a self-contained declaration that never references `#src/*`, sidestepping both the `paths` collision and the `imports`-field resolution failure.

### Bundled declaration emit

`rollup-plugin-dts` rolls the declaration graph rooted at `src/service/service.ts` into a single `dist/public.d.ts`.
It tree-shakes to only the types reachable from the entry's exports — `SubagentsService`, `SubagentRecord`, `SpawnOptions`, `SubagentStatus`, `SUBAGENT_EVENTS`, the accessor signatures, plus the seam closure (`WorkspaceProvider`, `Workspace`, the context types, `AgentStatus`, `AgentInvocation`, `SubagentType`) and `LifetimeUsage`, all inlined.
Imports from `@earendil-works/*` and `@sinclair/typebox` remain **external** in the output (the consumer has them as peers), so they are not inlined.

We ship `.ts` source, so we want **only** the `.d.ts` — no JS bundle.
`rollup-plugin-dts` does exactly that.

Resolution note (primary feasibility risk): the roll-up must resolve the publisher's `#src/*` specifiers while parsing the type graph.
`rollup-plugin-dts` drives the TypeScript compiler, which reads `compilerOptions.paths`; the build config references a tsconfig carrying the existing `#src/*` → `./src/*` paths.
If `#src/*` does not resolve out of the box, add a tsconfig-paths/alias resolver to the rollup config.
The first build step (below) is the checkpoint that proves this.

### Generation timing and packaging

- `prepack` runs `build:types` before both `pnpm pack` and `pnpm publish` (publish packs internally), so the tarball always contains a freshly generated `dist/public.d.ts`.
- `dist/` is gitignored, so the artifact is **never committed**.
- A `files` allowlist is added so the gitignored `dist/` is included in the published tarball.
  The allowlist must preserve everything currently published (the whole `src/` tree, `docs/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `AGENTS.md`, `.prettierignore`) plus `dist/`.
  Validate parity with `pnpm pack --dry-run` before/after.

### Verification harness (the proof)

A script (run locally and in CI) proves external consumability without a publish:

```bash
# pseudocode — scripts/verify-public-types.sh
pnpm --filter @gotgenes/pi-subagents pack --pack-destination "$TMP"   # triggers prepack → build:types
cd "$TMP/consumer"                                                     # minimal package.json + tsconfig
pnpm add "$TMP/gotgenes-pi-subagents-*.tgz" \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui typescript
# probe.ts: import { getSubagentsService, type WorkspaceProvider } from "@gotgenes/pi-subagents"
pnpm exec tsc --noEmit                                                 # must pass
```

Plus a cheap self-containment guard: assert `dist/public.d.ts` exists, exports the expected symbols, and contains no `#src/` substring (proving it is alias-free).

## Module-Level Changes

- `packages/pi-subagents/package.json`
  - `exports["."]` → `{ "types": "./dist/public.d.ts", "default": "./src/service/service.ts" }`.
  - Add `devDependencies`: `rollup`, `rollup-plugin-dts` (package-specific, not catalog — only this package builds types).
  - Add scripts: `"build:types"` (runs rollup with the dts config) and `"prepack": "pnpm run build:types"`; add `"verify:public-types"` invoking the harness script.
  - Add a `files` allowlist including `src`, `dist`, `docs`, `README.md`, `LICENSE`, `CHANGELOG.md`, `AGENTS.md`, `.prettierignore` (validated against `pnpm pack --dry-run`).
- `packages/pi-subagents/rollup.dts.config.mjs` — **new**.
  Entry `src/service/service.ts` → output `dist/public.d.ts`; `rollup-plugin-dts` with the package tsconfig (for `#src/*` paths); externals = peer deps + `@sinclair/typebox`.
- `packages/pi-subagents/scripts/verify-public-types.sh` (or repo-level `scripts/`) — **new**.
  Pack → throwaway consumer → `tsc`, plus the self-containment grep guard.
- `.github/workflows/ci.yml`
  - Add a "Verify public types" step in the `check` job (runs on PR and `main`) invoking `pnpm --filter @gotgenes/pi-subagents run verify:public-types`.
- `packages/pi-subagents/docs/decisions/0003-publish-bundled-type-declarations.md` — **new** ADR.
  Records the first-build-step decision, the rejected alias-free alternative, and the ship-source tradeoff (docs path; `exclude-paths` already covers `docs/decisions`, so it does not trigger a release).

No `src/` module is added, renamed, or removed; no exported symbol is removed.
No `docs/architecture/` layout/complexity tables reference `dist/` or the build config, so no architecture-doc edits are required beyond the ADR (optionally cross-link a one-line "build step" note — defer to build stage).

## Test Impact Analysis

This is a build/packaging change; `src/` is untouched, so the existing vitest suite (362 tests) is unaffected and stays as-is.

1. New verification this enables: a packaged-artifact consumability check (`pnpm pack` → consumer `tsc`) that did not exist and was previously impossible (the package was not consumable at all).
2. No existing tests become redundant — none currently exercise packaging or the public `exports`.
3. No existing tests must change; the public service contract types in `service.ts` are unchanged.

## Build Order

This is a tooling/config change with a verification harness (not red→green→refactor), so it proceeds as build steps that each leave the repo valid.

1. **Emit checkpoint.**
   Add `rollup` + `rollup-plugin-dts` devDeps, write `rollup.dts.config.mjs`, add the `build:types` script.
   Run `build:types`; confirm `dist/public.d.ts` is generated, exports the expected symbols, and contains no `#src/` substring (resolve the `#src/*` resolution risk here — add a paths/alias resolver if needed).
   Commit: `build(pi-subagents): bundle public .d.ts with rollup-plugin-dts`.
2. **Wire exports + packaging.**
   Set the conditional `exports` (`types` + `default`, fixing the stale path), add `prepack`, add the `files` allowlist; validate `pnpm pack --dry-run` parity (no currently-shipped file dropped; `dist/public.d.ts` present).
   Commit: `feat(pi-subagents): publish bundled type declarations and fix stale exports path`.
3. **Verification harness + CI.**
   Add `scripts/verify-public-types.sh` (pack → throwaway consumer → `tsc`, plus self-containment guard), the `verify:public-types` script, and the CI step.
   Commit: `test(pi-subagents): verify the public surface is type-consumable from the packaged tarball`.
4. **ADR.**
   Add `docs/decisions/0003-publish-bundled-type-declarations.md`.
   Commit: `docs(pi-subagents): record decision to publish bundled type declarations (ADR 0003)`.

## Risks and Mitigations

- **`rollup-plugin-dts` cannot resolve `#src/*`** (primary risk).
  Mitigation: drive it with the package tsconfig (which carries `#src/*` paths); if needed, add a tsconfig-paths/alias resolver.
  Step 1 is the explicit checkpoint — if it cannot produce an alias-free `dist/public.d.ts`, stop and reassess before wiring exports.
- **Deep type graph via `agent.ts`.**
  The seam closure reaches the 510-LOC `agent.ts`.
  Mitigation: `rollup-plugin-dts` tree-shakes to only reachable types; the self-containment guard asserts the output is minimal and alias-free.
- **`files` allowlist drops currently-published files.**
  Mitigation: diff `pnpm pack --dry-run` before/after; the allowlist must reproduce the existing tarball plus `dist/`.
- **`types` condition points at a gitignored, build-time artifact.**
  An in-repo workspace-linked consumer that imported the package would need `dist/public.d.ts` present.
  Mitigation: tight scope — `pi-subagents-worktrees` does not import the package yet; #263 consumes the built artifact from the published tarball.
- **Release batching / ordering with #263.**
  Once #263 resumes and edits `pi-subagents` core, its commits batch into the same `pi-subagents` release.
  Mitigation: publish #270 first (merge its release-please PR → `pi-subagents` publishes), then resume #263 against the published version.
  The current `#263` scaffold commits touch only the unregistered `pi-subagents-worktrees` component, so they do not batch into `pi-subagents` today.
- **`prepack` must fire under the publish path.**
  `scripts/publish-released.sh` runs `pnpm --filter @gotgenes/pi-subagents publish`, which packs and therefore runs `prepack`.
  Mitigation: the verification harness exercises the same `pnpm pack` path that publish uses.

## Open Questions

- Whether to add a fast vitest self-containment assertion in addition to the shell harness, or keep the guard inside the script only — defer to the build stage.
- Whether the ADR should add a short "build process" subsection to `docs/architecture/architecture.md` — defer; the ADR is sufficient.
- Exact `files` allowlist entries — finalize against `pnpm pack --dry-run` in Step 2.

[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
