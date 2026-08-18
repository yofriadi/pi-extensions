## Context

The v2.9.0 reconstruction introduced a fork-owned `local/main` branch and a squash subtree consumer, but the long-standing monorepo update script still pulls upstream directly. A non-release baseline tag also makes unrestricted `git describe --tags` hide unreleased work in the release helper. Finally, G4 is currently a manual gate rather than a CI/release preflight, and the root lockfile predates the consumed package manifest.

The package source remains fork-owned. The monorepo needs a small consumer wrapper and a regenerated workspace lockfile; these are not package-content edits and therefore do not violate the subtree source-of-truth rule.

## Goals / Non-Goals

**Goals:**
- Route every scripted monorepo update through `pi-condense-fork local/main --squash`.
- Enforce package TypeScript validation in CI, release CI, and local release preflight.
- Make release proposals compare with the most recent `vX.Y.Z` tag, never a `subtree-*` marker.
- Commit a lockfile generated from the clean monorepo baseline and preserve unrelated local lockfile work separately.
- Provide a repeatable, credential-gated real-session smoke helper and an honest close-out record.

**Non-Goals:**
- Change summarizer behavior, fallback policy, or provider credentials.
- Automatically claim or simulate successful Antigravity service calls without authenticated operator access.
- Replace the manual review required after a future upstream rebase.

## Decisions

### Fork remote is the sole scripted subtree source

`update-pi-condense-subtree.sh` will use a named remote `pi-condense-fork`, expected to point at `yofriadi/pi-condense`, and `local/main`. It will add the remote when absent, reject a conflicting remote URL, fetch the branch, and pull it with `--squash`. It will reject only tracked modifications using the same index checks used by the sync contract, allowing harmless untracked user files. This prevents accidental direct consumption of upstream while retaining the established squash lineage.

**Alternative considered:** retain a direct upstream URL and ask operators to edit the script for local changes. Rejected because it silently discards the protected local layer.

### Treat typecheck as a release gate

The canonical command remains `bun run typecheck`, not a direct global `tsc` invocation. Test CI and release CI run it after dependency installation and before tests. The release helper's preflight command becomes `bun run typecheck && bun test src/`, keeping `--skip-tests` as the explicit operator escape hatch.

**Alternative considered:** only add a root workspace check. Rejected because the root command uses a different TypeScript version and previously excluded pi-condense.

### Use SemVer-tag discovery only

`release.sh propose` will locate the nearest reachable tag matching exactly a release-tag glob (`v[0-9]*.[0-9]*.[0-9]*`). Baseline markers such as `subtree-v2.9.0+local` are deliberately excluded. A focused shell regression test will create a temporary repository with both tag classes and assert proposals use the SemVer tag range.

### Regenerate lockfile in an isolated clean worktree

The root lockfile will be regenerated from the committed monorepo baseline with pnpm 10.5.2 and committed as a root-only change. Existing user modifications to `pnpm-lock.yaml` are preserved in a stash and reapplied afterwards; they are never folded into this change. The generated diff may reconcile other already-declared workspace importers because pnpm lockfile generation is workspace-wide; each importer change is reviewed and must correspond to an already committed manifest.

### Provide a credential-gated smoke helper

A `scripts/smoke-antigravity.sh` helper will create an isolated agent/session directory, require an explicit Antigravity model and already-configured authentication, load `index.ts`, and emit the exact artifact paths and expected signal. It must fail closed when required input or the `pi` executable is missing. It documents that an operator must inspect a real summary and warning behavior; no test marks the live smoke complete automatically.

## Risks / Trade-offs

- [Workspace lock regeneration changes more than one importer] → Generate in a detached clean worktree, inspect every changed importer against committed manifests, and commit only the regenerated lockfile.
- [Subtree update post-gates fail after creating a merge commit] → The script prints the failing gate and leaves the merge available for inspection/revert; it does not claim the update succeeded.
- [Tag glob accepts malformed non-release tags] → Use the release workflow's `v<major>.<minor>.<patch>` naming convention and cover a `subtree-*` marker fixture.
- [Live provider APIs are unavailable or quota-limited] → Keep the smoke operator-gated and record the actual error suffix defined in `ANTIGRAVITY.md` rather than treating the service failure as a code pass.

## Migration Plan

1. Implement and validate fork automation changes on `local/main`.
2. Regenerate the monorepo lockfile in a clean detached worktree and commit the root wrapper/lock update without package-content edits.
3. Pull the fork update through the hardened wrapper, resolve only fork-originated content through the subtree, and rerun gates.
4. Run the credential-gated smoke with an authenticated operator, then record its actual outcome in the active hardening change.

Rollback is a normal `git revert` of the fork or monorepo automation commit; the pre-existing `subtree-v2.9.0+local` baseline tag remains referenceable.
