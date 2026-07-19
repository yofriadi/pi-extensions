---
status: superseded
date: 2026-05-11
---

# 0001 — Deferred fork patches and upstream-PR strategy

## Status

Superseded by [`docs/architecture/architecture.md`](../architecture/architecture.md), which commits to a hard fork with material scope reduction (scheduling removal, `SubagentsAPI` boundary, `index.ts` decomposition).
The original rationale below remains useful context.

## Context

This fork was created to land three pieces of work identified during RepOne issue [#442](https://github.com/Tiny-IG-Software/repone/issues/442):

1. **Peer-dep rename** — `@mariozechner/pi-*` → `@earendil-works/pi-*`.
2. **Patch 2 — Re-activate extension tools post-`bindExtensions`** (Spike 3 finding).
3. **Patch 3 — Inject `<active_agent>` tag** (Spike 4 finding).

A fourth piece of work was scoped during the same spike round but deferred:

- **Patch 1 — Mirror parent's `additionalExtensionPaths` (and siblings) into the child's `DefaultResourceLoader`** (Spike 2 finding).

This ADR records why Patch 1 was deferred and the strategy for upstream PRs back to [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Decision

### Patch 1 is deferred

The original Spike 2 finding was that the parent's `additionalExtensionPaths` does not propagate to the child's `DefaultResourceLoader`.
The fix was sketched as "plumb parent's `additionalExtensionPaths` (and siblings) into the child."

During planning for this fork, two implementation constraints surfaced:

1. The parent's `DefaultResourceLoader.additionalExtensionPaths` is **private** — no public getter on `ExtensionContext`.
2. The parent's CLI flags (e.g., `pi -e <path>`) are parsed in `main.js` and not surfaced through any extension API.

A working patch would have to either:

- Accept new fields in `RunOptions` so callers supply the paths explicitly, **or**
- Reach into `process.argv` to re-resolve `-e`/`--extensions` flags from the child's perspective.

Neither matches the production need.
For RepOne (and any consumer that installs extensions via `pi install`), extensions are settings-discoverable: children inherit them independently of the parent's `DefaultResourceLoader` configuration.
The `pi -e <path>` ephemeral-extension case is the only beneficiary of Patch 1, and it does not appear in our workflow.

We therefore defer Patch 1 rather than carry a speculative patch in the fork's diff against upstream.
A follow-up issue on the RepOne board (linked from #443) captures the criterion for revisiting: **a workflow that needs `pi -e <path>` ephemeral extensions to reach children**.

### Upstream PRs are open

All three divergences now have upstream PRs, opened after production validation in RepOne:

1. **Peer-dep migration** — [tintinweb/pi-subagents#71](https://github.com/tintinweb/pi-subagents/pull/71) (`fix(deps)!: migrate from deprecated @mariozechner/pi-* to @earendil-works/pi-*`)
2. **Post-bind re-filter** — [tintinweb/pi-subagents#72](https://github.com/tintinweb/pi-subagents/pull/72) (`fix(agent-runner): re-filter active tools after bindExtensions so extension tools land in child`)
3. **Active-agent tag** — [tintinweb/pi-subagents#73](https://github.com/tintinweb/pi-subagents/pull/73) (`feat(prompts): inject <active_agent name="..."/> tag for permission resolution`)

If these land upstream, upstream gains the peer-dep fix and the two RepOne patches.
However, the fork now diverges intentionally beyond those patches — see [`docs/architecture/architecture.md`](../architecture/architecture.md) for the full scope of planned changes.

## Consequences

### Positive

- The fork's diff against upstream stays minimal — three patches plus tooling alignment.
- We avoid landing a speculative Patch 1 that would need rework if upstream's `ExtensionContext` API changes.
- Production evidence strengthened the upstream PRs.

### Negative

- The `pi -e <path>` ephemeral-extension case in subagents will not work until Patch 1 lands.
  We accept this because no consumer in scope uses that pattern.

### Operational

- Upstream PRs are open and linked above.
  If merged, upstream gains the three patches, but the fork continues independently with broader architectural changes per [`docs/architecture/architecture.md`](../architecture/architecture.md).
- The architecture document governs the fork's direction going forward; this ADR's original "thin-patch" framing no longer describes the fork's trajectory.
- When Patch 1 is eventually added, it should be a separate ADR in `docs/decisions/` with its own follow-up.
