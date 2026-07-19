---
status: accepted
date: 2026-05-29
---

# 0003 — Publish a bundled `.d.ts` for the public surface

## Status

Accepted.
Introduces the repository's first build step, scoped to type declarations only.

## Context

`@gotgenes/pi-subagents` could not be imported by another TypeScript package in this workspace.
Issue #263 (extract worktree isolation to `@gotgenes/pi-subagents-worktrees`) is the first intra-repo consumer: it must `implements WorkspaceProvider` and call `getSubagentsService().registerWorkspaceProvider(...)`, both of which require importing the package by name.

A `tsc --traceResolution` of a sibling consuming the package surfaced two compounding failures.

1. `package.json` `exports["."]` pointed at `./src/service.ts`, which does not exist — the real module is `./src/service/service.ts`.
   A latent bug, unnoticed because nothing in-repo imported the package by name.
2. Once corrected, the public entry's internal alias imports cascade.
   `service/service.ts` imports `type LifetimeUsage` and `type WorkspaceProvider` via the `#src/*` alias.
   When a sibling's `tsc` follows the symlink, the consumer's own `paths` (`#src/*` → `./src/*`) intercept first and resolve into the *consumer's* `src/` — a global-`paths` collision, since both packages define `#src/*`.
   The fallback to the publisher's `package.json` `imports` field also fails: `tsc` cannot resolve the extensionless `.ts` target under Node `imports` semantics ("Import specifier '#src/lifecycle/usage' does not exist in package.json scope").

The public entry's type closure is deeply entangled: `WorkspaceProvider` (in `lifecycle/workspace.ts`) reaches `AgentStatus` in the 510-line `lifecycle/agent.ts`, plus `SubagentType`/`AgentInvocation` from `types.ts` (which itself re-exports the `Agent` class).
A shallow alias-free entry is therefore not achievable without a substantial source restructure.

This collides with the ship-source model ([ADR-0002]): every package ships raw `.ts` executed directly by Pi, with no build step.

## Decision

Emit a single, self-contained `dist/public.d.ts` for the public surface and advertise it through a `types` export condition, while the runtime entry continues to serve `.ts` source.

```jsonc
"exports": {
  ".": {
    "types": "./dist/public.d.ts",
    "default": "./src/service/service.ts"
  }
}
```

- `rollup-plugin-dts` rolls the declaration graph rooted at `src/service/service.ts` into one file, inlining the internal `#src/*` types and keeping peer-dependency types (`@earendil-works/*`, `@sinclair/typebox`) external.
  We ship `.ts` source, so only the declaration bundle is emitted — no JS.
- The bundle is generated at `prepack` time and shipped via a `files` allowlist; it is gitignored and never committed.
- `default` → `./src/service/service.ts` fixes the stale path and serves runtime consumers; its `import type` lines erase, so no runtime `#src/*` resolution is needed.
- A `pnpm pack` → throwaway-consumer → `tsc` harness proves external consumability with no publish round-trip and no workspace privileges.

This is the repository's first build step.
It is deliberately narrow: it produces type declarations only and changes nothing about how Pi loads the extension from source (`pi.extensions: ["./src/index.ts"]` is untouched).

## Alternatives considered

- Alias-free public entry (restructure the source so the entry's full type closure resolves via same-directory `./` imports).
  Mechanically possible, but it requires moving the `AgentStatus`/`SubagentType`/`AgentInvocation`/`WorkspaceProvider` definitions and untangling the `agent.ts`/`types.ts` graph, with care that inner layers do not import the outer service layer.
  `eslint`'s `no-parent-relative-imports` rule (which forbids `../`) narrows the options further.
  Larger blast radius than emitting a `.d.ts`, and it churns the domain model to serve a packaging concern.
- A self-contained entry that re-declares the public types inline, guarded by a conformance test.
  Avoids a build step but duplicates the seam/usage/status type definitions, which drift over time.

## Consequences

- The repository now has a build step, but it is type-only and isolated to this package; the ship-source model is otherwise intact.
- Consumers (including `@gotgenes/pi-subagents-worktrees` in #263) consume the packaged public interface like any external developer — no `workspace:*` privileges.
- The `types` condition points at a build-time artifact; an in-repo workspace-linked consumer that imported the package would need `dist/public.d.ts` present.
  This is acceptable because no in-repo package imports the surface yet; #263 consumes the built artifact from the published tarball.
- Sequencing: #270 must be published (its release-please PR merged) before #263 edits `pi-subagents` core, so #263's changes do not batch into the same `pi-subagents` release.

[ADR-0002]: ./0002-extensions-on-a-minimal-core.md
