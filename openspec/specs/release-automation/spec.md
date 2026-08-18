# Release automation

## Purpose

Prevent unsafe releases, mutable dependency resolution, and unrestricted live-smoke execution from publishing or validating the scoped fork without the intended provenance and safety controls.

## Requirements

### Requirement: SemVer-only release proposal range

The release helper SHALL discover the nearest reachable release tag matching `v<major>.<minor>.<patch>` when proposing a version bump. It MUST ignore non-release tags, including `subtree-*` baseline markers, and SHALL report commits since the selected SemVer tag.

#### Scenario: Subtree baseline is newer than the latest release tag

- **WHEN** `HEAD` is tagged `subtree-v2.9.0+local` and the nearest reachable release tag is `v2.9.0`
- **THEN** `release.sh propose` compares `v2.9.0..HEAD` and does not report that there is nothing to release solely because of the subtree tag

### Requirement: Release provenance and publication are separated

The release helper SHALL create releases only from `local/main`, require a plain `X.Y.Z` package version, require the target tag to be absent locally and on `origin`, and atomically push the branch plus tag. The release workflow SHALL run provenance validation without OIDC permission before a protected `npm-publish` environment grants the publish job `id-token: write`. A protected `v*` tag ruleset SHALL limit tag mutation to the designated release role, and the protected environment SHALL require deployment review from an authorized release reviewer.

#### Scenario: Malformed version or occupied tag

- **WHEN** an operator attempts `current`, `patch`, `minor`, or `major` with a prerelease version or a target tag already present locally or on `origin`
- **THEN** the helper fails before mutating package metadata, creating a local tag, or pushing a ref

#### Scenario: Manual tag push from another branch

- **WHEN** a `v<major>.<minor>.<patch>` tag is pushed for a commit not reachable from `local/main`
- **THEN** the no-OIDC validation job fails before the protected publish job can receive an OIDC token

### Requirement: Reproducible fork validation

The fork SHALL commit `bun.lock`, pin Bun to the lockfile-producing version in CI, and run `bun install --frozen-lockfile` before CI/release checks. The package-owned TypeScript check SHALL run before package tests in fork test CI, release CI, and local release preflight.

#### Scenario: Test CI runs on a pull request

- **WHEN** a pull request targets `local/main`
- **THEN** the test workflow installs the committed Bun lockfile with a pinned Bun version, runs `bun run typecheck`, package tests, release-helper regression checks, and smoke-helper regression checks

#### Scenario: A release tag is approved for publication

- **WHEN** a plain release tag reaches the protected publish job
- **THEN** frozen Bun installation, typecheck, package tests, and both helper regression suites complete before `npm publish --provenance --access public`

### Requirement: Authenticated Antigravity smoke harness

The repository SHALL provide a documented executable smoke helper for an operator to exercise `index.ts` in an isolated pi agent/session directory. It MUST require an explicit Antigravity model, provider-extension path, available `pi` executable, and authenticated source agent directory. The model SHALL receive only a no-input deterministic smoke-payload tool; the helper MUST use no approval and no built-in tools, context files, skills, or prompt templates. It MUST remove copied credentials before retaining any session artifact and produce a sanitized durable report before marking a live smoke passed.

#### Scenario: Operator lacks required live-session inputs

- **WHEN** the smoke helper is invoked without a valid Antigravity model, provider extension, pi executable, or source `auth.json`
- **THEN** it exits nonzero with an actionable diagnostic and does not mark a live smoke as passed

#### Scenario: Provider call fails

- **WHEN** the isolated smoke command fails
- **THEN** the session artifact directory remains available for inspection but the copied credential has already been removed

#### Scenario: Operator invokes an authenticated smoke

- **WHEN** the smoke helper is invoked with a configured Antigravity model in an authenticated environment
- **THEN** it runs pi with only the explicit provider, deterministic payload, and pi-condense extensions, and the operator records model, tool policy, summary count, flush outcome, warning scan, and credential-cleanup result in a sanitized repository report
