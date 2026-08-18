# Release automation

## Purpose

Prevent fork baseline markers, omitted TypeScript checks, and wrong-branch tags from hiding unreleased changes or publishing an invalid scoped pi-condense package.

## Requirements

### Requirement: SemVer-only release proposal range

The release helper SHALL discover the nearest reachable release tag matching `v<major>.<minor>.<patch>` when proposing a version bump. It MUST ignore non-release tags, including `subtree-*` baseline markers, and SHALL report commits since the selected SemVer tag.

#### Scenario: Subtree baseline is newer than the latest release tag

- **WHEN** `HEAD` is tagged `subtree-v2.9.0+local` and the nearest reachable release tag is `v2.9.0`
- **THEN** `release.sh propose` compares `v2.9.0..HEAD` and does not report that there is nothing to release solely because of the subtree tag

### Requirement: Release branch and tag source are enforced

The release helper SHALL create and push releases only from `local/main`. The release workflow SHALL reject a release-tag commit that is not reachable from `origin/local/main` before publication.

#### Scenario: Manual tag push from another branch

- **WHEN** a `v<major>.<minor>.<patch>` tag is pushed for a commit not reachable from `local/main`
- **THEN** the release workflow fails before running `npm publish`

### Requirement: Typecheck is enforced before publication

The fork test workflow, release workflow, and local release helper preflight SHALL run `bun run typecheck` before `bun test src/`. The typecheck command SHALL be the package-owned TypeScript project check.

#### Scenario: Test CI runs on a pull request

- **WHEN** a pull request targets `local/main`
- **THEN** the test workflow installs dependencies, runs `bun run typecheck`, and runs `bun test src/`

#### Scenario: A release tag is pushed

- **WHEN** a `v<major>.<minor>.<patch>` tag triggers the release workflow
- **THEN** the workflow completes `bun run typecheck` and `bun test src/` before `npm publish --provenance --access public`

#### Scenario: Local release preflight runs

- **WHEN** an operator runs a non-dry-run release without `--skip-tests`
- **THEN** the helper runs `bun run typecheck && bun test src/` before creating or pushing the release tag

### Requirement: Release-helper regression checks

The test and release workflows SHALL run a deterministic helper regression script that proves a `subtree-*` tag does not hide commits since the nearest SemVer release tag.

#### Scenario: CI validates release-tag discovery

- **WHEN** test or release CI runs after dependency installation
- **THEN** it executes the release-helper regression script successfully before reporting a passing workflow

### Requirement: Authenticated Antigravity smoke harness

The repository SHALL provide a documented executable smoke helper for an operator to exercise `index.ts` in an isolated pi agent/session directory. The helper MUST require an explicit Antigravity model, an explicit provider-extension path, an available `pi` executable, and an authenticated source agent directory. It MUST remove copied credentials before retaining any session artifact. It SHALL identify the session artifact for review and direct the operator to verify direct configured-model summarization and the fallback warning format in `ANTIGRAVITY.md`.

#### Scenario: Operator lacks required live-session inputs

- **WHEN** the smoke helper is invoked without a valid Antigravity model, provider extension, pi executable, or source `auth.json`
- **THEN** it exits nonzero with an actionable diagnostic and does not mark a live smoke as passed

#### Scenario: Operator invokes an authenticated smoke

- **WHEN** the smoke helper is invoked with a configured Antigravity model and prompt in an authenticated environment
- **THEN** it runs pi with only the explicit provider and pi-condense extensions in an isolated session directory, prints the session artifact and manual verification criteria, and removes copied credentials before exit
