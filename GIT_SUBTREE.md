# Maintaining upstream extensions as Git subtrees

This monorepo can maintain external Pi extensions under `packages/` as Git
subtrees. A subtree keeps an extension's source as ordinary monorepo files
while retaining a repeatable path for importing upstream updates.

Example layout:

```text
pi-extensions/
└── packages/
    ├── extension-a/
    ├── extension-b/
    └── extension-c/
```

Each package can have a different upstream repository and remote.

## Why use a subtree

A subtree:

- keeps the extension in the normal monorepo checkout;
- works with pnpm workspace discovery and package tests;
- avoids nested repository initialization;
- allows local changes in the same repository; and
- keeps package publishing and CI behavior ordinary.

Unlike a submodule, consumers do not need to initialize a nested repository.
The extension is present after a normal monorepo clone.

## Initial import

From the monorepo root, add a remote for the upstream repository:

```bash
git remote add <extension>-upstream <upstream-repository-url>
git fetch <extension>-upstream main
```

Import the upstream repository below its package prefix:

```bash
git subtree add \
  --prefix=packages/<extension> \
  <extension>-upstream main \
  --squash
```

`--prefix` is the directory that receives the upstream source. The subtree
command creates normal monorepo commits; there is no nested `.git` directory.

If the working tree is not clean, preserve unrelated work before importing:

```bash
git stash push --include-untracked -m pre-subtree-import
git subtree add \
  --prefix=packages/<extension> \
  <extension>-upstream main \
  --squash
git stash pop
```

Review the stash result before continuing. Do not use this workflow if the
target package directory already contains files; move or remove that copy
only after preserving any local changes.

## Pull upstream changes

Run from the monorepo root:

```bash
git status
pnpm --filter <package-name> test

git fetch <extension>-upstream main
git subtree pull \
  --prefix=packages/<extension> \
  <extension>-upstream main \
  --squash

pnpm --filter <package-name> test
```

`git fetch` updates the local remote-tracking branch without changing files.
`git subtree pull` imports the newer upstream source under the package prefix
and creates a normal merge commit.

The working tree must be clean before running `git subtree pull`.

## Why `--squash` is used

Without `--squash`, every upstream commit is imported into the monorepo
history. With `--squash`, each upstream update becomes one compact import
commit:

```text
Upstream commits A, B, C, D
          |
          v
One monorepo import commit
```

This keeps the monorepo history smaller. Individual upstream commits are not
directly visible in the monorepo history, but the imported source remains
fully tracked.

## Local changes

Keep local fixes in separate monorepo commits rather than mixing them into an
upstream import:

```bash
git add packages/<extension>/src/<changed-file>.ts
git commit -m "fix(<extension>): <short description>"
```

Commit local changes before pulling upstream. If upstream changed the same
lines, Git may report a conflict. Resolve the conflict inside the package
prefix, then continue the merge and rerun the package tests.

If upstream accepts the local fix, a later subtree update will contain it and
the local fix commit can be removed or reverted as appropriate.

## Contributing changes upstream

Create a branch containing only one subtree's contents:

```bash
git subtree split \
  --prefix=packages/<extension> \
  -b <extension>-upstream-fix
```

Push that branch to a fork and open an upstream pull request:

```bash
git push <fork-remote> <extension>-upstream-fix
```

## Upstream packages inside a larger repository

When the upstream extension lives below a subdirectory of another repository,
split that directory into a temporary branch before importing it. Do not
subtree-add the upstream repository root, or the entire upstream monorepo will
be placed under the package prefix.

```bash
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/<extension>-upstream.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

git clone --quiet <upstream-repository-url> "$tmp_dir/repo"
git -C "$tmp_dir/repo" subtree split \
  --quiet \
  --prefix=packages/<extension> \
  --branch=<extension>-root \
  main

git subtree add \
  --prefix=packages/<extension> \
  "$tmp_dir/repo" \
  <extension>-root \
  --squash
```

For future updates, replace `git subtree add` with `git subtree pull`. Keep
the commands in a checked-in `scripts/update-<extension>-subtree.sh` helper
when the split step is required repeatedly.

The source directory in the upstream repository may use a different prefix;
set `--prefix` to that upstream path, while the main repository's
`--prefix=packages/<extension>` remains the destination.

## Remote configuration

Git remotes are stored in `.git/config`, not in tracked files. Each developer
or CI checkout that needs to pull updates must add the upstream remote:

```bash
git remote add <extension>-upstream <upstream-repository-url>
```

The remote name is local convention. Use one stable name per upstream so
future update commands are predictable.

## Operational checklist

Before importing or updating an extension:

1. Confirm the package prefix and upstream branch.
2. Confirm the working tree is clean.
3. Run the package's focused test suite.
4. Fetch the upstream branch.
5. Run `git subtree pull` or `git subtree add`.
6. Resolve conflicts only inside the affected package when possible.
7. Rerun the package tests and the monorepo checks.
