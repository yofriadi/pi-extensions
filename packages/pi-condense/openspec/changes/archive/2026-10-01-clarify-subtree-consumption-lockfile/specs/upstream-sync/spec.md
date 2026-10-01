# Spec Delta: upstream-sync

## MODIFIED Requirements

### Requirement: Subtree consumption

The monorepo SHALL consume the fork using `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main --squash`. The monorepo's tracked tree SHALL be clean repo-wide before the operation. The upstream remote remains for fetching and tag reference only. The advertised `pnpm update:pi-condense` command SHALL validate the configured `pi-condense-fork` URL, fetch `local/main`, and use that branch as its only subtree source in a detached candidate worktree. It SHALL conditionally regenerate the root lockfile for a consumed manifest change, pass frozen install plus root/G1–G4 checks, and only then fast-forward the caller branch; it MUST NOT pull `jjuraszek/pi-condense/main` directly or leave a failed candidate on the caller branch.

A regenerated root lockfile SHALL be adjudicated before it is committed. A committed root lockfile can carry importers for workspace packages that are still untracked at HEAD, and a regeneration run from a clean candidate silently deletes them; while such packages are in flight that delta SHALL be dropped, the pull SHALL proceed on the unchanged lockfile, and the sync change SHALL record why. A consumed manifest change that only alters the package version leaves the lockfile unchanged, because workspace importers are recorded as `link:` specifiers rather than versions.

When a pull stops on conflicts, the command leaves the caller branch untouched and the remaining candidate steps — conflict resolution, frozen install, package and root gates, fast-forward — SHALL be completed by hand in the same detached-candidate shape, with every resolution recorded in the sync change.

#### Scenario: First re-baseline sync

- **WHEN** the fork is first consumed after local commits existed on both sides
- **THEN** known conflicts in the conflict-policy files are resolved by taking the fork side; they are expected re-baseline conflicts rather than protected-surface drift

#### Scenario: Routine future sync

- **WHEN** upstream advances and the fork has rebased after the first re-baseline
- **THEN** the subtree pull from the fork is expected to be conflict-free; any conflict pauses the sync for investigation

#### Scenario: Dirty tree blocks subtree operations

- **WHEN** any tracked monorepo file is modified or staged
- **THEN** subtree operations do not run until the tree is cleaned, committed, or stashed

#### Scenario: Scripted consumer update

- **WHEN** an operator runs `pnpm update:pi-condense` in a clean monorepo
- **THEN** it fetches and squash-pulls `pi-condense-fork/local/main`, runs G1–G4 from `packages/pi-condense`, and never contacts upstream as the subtree source

#### Scenario: Regenerated lockfile would delete in-flight importers

- **WHEN** the consumed manifest changed and the regenerated root lockfile differs only by removing importers for packages that are untracked at HEAD
- **THEN** the lockfile commit is dropped, the pull proceeds on the unchanged lockfile, and the sync change records why

#### Scenario: Conflicting pull is driven by hand

- **WHEN** a subtree pull stops on conflicts and the command discards its candidate
- **THEN** the caller branch is unchanged, and the operator resolves the conflicts, runs the candidate gates, and fast-forwards manually in the same detached-candidate shape, recording each resolution in the sync change

#### Scenario: Automated gates complete without live credentials

- **WHEN** all local, CI, and mock-based gates are green but no authenticated Antigravity session has been inspected
- **THEN** the close-out record leaves the live-smoke task pending and identifies the required manual verification
