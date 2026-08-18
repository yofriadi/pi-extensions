## Why

The reconstructed fork is functional, but adversarial review found automation paths that can bypass the fork local layer, omit the authoritative TypeScript check in CI/release, or hide unreleased work behind a non-release subtree marker. The root workspace lockfile also does not describe the consumed package manifest, so frozen installs are not reproducible.

## What Changes

- Make `pnpm update:pi-condense` consume the configured `pi-condense-fork` remote's `local/main` branch through a squash subtree pull, never upstream directly.
- Make the release helper discover only SemVer release tags (`vX.Y.Z`) when proposing the next release, ignoring subtree baseline tags.
- Run the package-owned `bun run typecheck` before package tests in test and release CI.
- Regenerate the monorepo lockfile so the `packages/pi-condense` importer matches the scoped 2.9.1 manifest and its TypeScript tooling.
- Add a repeatable authenticated-session smoke-test procedure and retain it as pending until it is actually performed.
- Strengthen the durable upstream-sync contract to require the hardened consumption and verification paths.

## Capabilities

### New Capabilities

- `release-automation`: Safe branch-aware release proposal and CI validation for the scoped fork package.

### Modified Capabilities

- `upstream-sync`: Require monorepo update automation to consume `pi-condense-fork local/main`, require reproducible lockfile state, and define the real-session smoke-test close-out rule.

## Impact

- Fork: `.agents/skills/release/scripts/release.sh`, GitHub test/release workflows, OpenSpec specs and change artifacts.
- Monorepo: `scripts/update-pi-condense-subtree.sh`, root `pnpm-lock.yaml`, and subtree-derived OpenSpec records.
- No runtime summarizer behavior or public configuration semantics change.
