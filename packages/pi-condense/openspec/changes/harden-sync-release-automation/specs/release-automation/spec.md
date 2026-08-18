## ADDED Requirements

### Requirement: SemVer-only release proposal range
The release helper SHALL discover the nearest reachable release tag matching `v<major>.<minor>.<patch>` when proposing a version bump. It MUST ignore non-release tags, including `subtree-*` baseline markers, and SHALL report commits since the selected SemVer tag.

#### Scenario: Subtree baseline is newer than the latest release tag
- **WHEN** `HEAD` is tagged `subtree-v2.9.0+local` and the nearest reachable release tag is `v2.9.0`
- **THEN** `release.sh propose` compares `v2.9.0..HEAD` and does not report that there is nothing to release solely because of the subtree tag

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

### Requirement: Authenticated Antigravity smoke harness
The repository SHALL provide a documented executable smoke helper for an operator to exercise `index.ts` in an isolated pi agent/session directory. The helper MUST require an explicit Antigravity model and an available `pi` executable, and MUST fail without claiming success when they are absent. It SHALL identify the session artifact for review and direct the operator to verify direct configured-model summarization and the fallback warning format in `ANTIGRAVITY.md`.

#### Scenario: Operator lacks required live-session inputs
- **WHEN** the smoke helper is invoked without its required model input or without `pi` on `PATH`
- **THEN** it exits nonzero with an actionable diagnostic and does not mark a live smoke as passed

#### Scenario: Operator invokes an authenticated smoke
- **WHEN** the smoke helper is invoked with a configured Antigravity model and prompt in an authenticated environment
- **THEN** it runs pi with only the local extension in an isolated session directory and prints the session artifact path and manual verification criteria
