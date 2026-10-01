# Proposal: clarify-subtree-consumption-lockfile

## Why

Adversarial review round 3 of `sync-upstream-2-11-2` found the live `upstream-sync` spec prescribing a monorepo consumption flow that the sync's own record disproves.

`Subtree consumption` says the advertised command "SHALL conditionally regenerate the root lockfile for a consumed manifest change, pass frozen install plus root/G1–G4 checks, and only then fast-forward the caller branch". In practice:

- `scripts/update-pi-condense-subtree.sh` commits whatever `pnpm install --lockfile-only` produces, unconditionally. During this sync that delta deleted the `pi-cc-ui` and `pi-provider-cline` importers — both present in the committed `pnpm-lock.yaml` while both packages are untracked at HEAD — so the commit was dropped by hand and recorded in the sync change (task 5.3). The repository condition is standing, not transient: the next routine sync run exactly as specified would silently commit those deletions.
- The first pull stopped on the expected re-baseline conflicts, and the command aborts there by design, leaving the candidate discarded and the caller branch untouched. The remaining steps (resolution, gates, fast-forward) were driven by hand in the same detached-candidate shape. The spec's "First re-baseline sync" scenario anticipates the conflicts but never says the command stops and the rest is manual.

A spec that cannot be followed as written is worse than no spec: the next operator either violates it silently or repeats this sync's improvisation without a record.

## What Changes

Amend the `Subtree consumption` requirement with two rules and their scenarios:

1. A regenerated root lockfile is **adjudicated before it is committed**. When the delta only removes importers for workspace packages that are untracked at HEAD, the lockfile commit is dropped, the pull proceeds on the unchanged lockfile, and the reason is recorded in the sync change.
2. When a pull **stops on conflicts**, the caller branch stays untouched and the remaining candidate steps are completed by hand in the same detached-candidate shape, with the resolutions recorded in the sync change.

No code changes: `scripts/update-pi-condense-subtree.sh` in the monorepo is out of scope for the fork, and the recorded behavior is already what a careful operator does. Making the adjudication explicit means the next sync does not have to rediscover it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `upstream-sync`: `Subtree consumption` gains the lockfile-adjudication rule, the hand-driven-conflict rule, and one scenario each.

## Impact

- **Fork**: `openspec/specs/upstream-sync/spec.md` after this change is archived; no source, test, or release-automation behavior changes.
- **Monorepo**: consumed by the next subtree pull. The script keeps its current behavior; operators now have written cover for dropping a lockfile delta that would delete in-flight importers, and for finishing a conflicting pull by hand.
- **Risk**: negligible. Documentation of established practice.
