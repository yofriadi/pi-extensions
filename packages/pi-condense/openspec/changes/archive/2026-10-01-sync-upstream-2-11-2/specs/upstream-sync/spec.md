# Spec Delta: upstream-sync

## MODIFIED Requirements

### Requirement: Protected local surfaces

The following SHALL be treated as local-only and MUST NOT be overwritten by a sync: `src/summarizer-pacing.ts`, `src/summarizer-pacing.test.ts`, `ANTIGRAVITY.md`, `tsconfig.json`, the `.pi/` tree, the `openspec/` tree, and the scoped release identity. The scoped release identity consists of `package.json` fields `name: "@yofriadi/pi-condense"`, `version` under the local version policy, `publishConfig.access: "public"`, `repository`, `homepage`, `bugs`, `pi.image` (branch-qualified to `local/main`), `scripts.typecheck`, and TypeScript 7.0.2 / Node 22 development dependencies; the scoped installation strings in `README.md` and `CHANGELOG.md`; `.agents/skills/release/SKILL.md`; `.agents/skills/release/scripts/release.sh` values `PACKAGE_NAME="@yofriadi/pi-condense"`, `REPO_SLUG="yofriadi/pi-condense"`, and `RELEASE_BRANCH="local/main"`; and `local/main` as the fork default and only release branch. `src/summarizer.ts`, `src/summarizer-wiring.test.ts`, and `src/reload-rearm.integration.test.ts` carry protected invariants rather than whole-file ownership: host-registry dispatch through `ctx.modelRegistry.getProvider().streamSimple`, no `pi-ai/compat` import or mock, and no `reasoningEffort` option. Upstream may legitimately modify these files; a sync reconciles their changes while retaining the invariants. `src/summarizer-fallback.ts` and `src/summarizer-fallback.test.ts` remain upstream-owned until the local fallback change is implemented.

Protection is per aspect, not per path, wherever upstream also owns the file. `.pi/gauntlet-overrides.md` is upstream content inside the protected `.pi/` tree: a sync adopts upstream's version and re-applies only fork identity (tracker repository slug, the provenance of inherited issue refs, and `local/main` wherever the text names a release branch). `.agents/skills/release/scripts/release.sh` and `.agents/skills/release/SKILL.md` protect the identity constants, the local hardening (plain-version assertion, nearest-SemVer tag selection ignoring baseline tags, local and remote tag collision checks, atomic branch-plus-tag push, typecheck-before-test preflight, scoped and legacy pin migration), and the fork's release-branch wording; upstream's release mechanics are adopted. `.pi/prompts/**` and `.pi/skills/**` remain purely local.

#### Scenario: Sync attempts to overwrite a protected file

- **WHEN** an upstream release modifies a protected file
- **THEN** the sync keeps local protected content, manually reconciles the remainder, and records the reconciliation in the sync change

#### Scenario: Upstream touches an unprotected overlapping file

- **WHEN** upstream modifies `src/types.ts`, `src/commands.ts`, `package.json`, or `doc/configuration.md`
- **THEN** the sync takes a three-way union of upstream and local additions unless the conflict policy declares otherwise

#### Scenario: Upstream rewrites an inherited file inside a protected tree

- **WHEN** upstream rewrites a file the local layer never modified, such as `.pi/gauntlet-overrides.md`
- **THEN** the sync adopts upstream's content and re-applies only the fork identity strings, recording the localization in the sync change

#### Scenario: Upstream adds release mechanics

- **WHEN** upstream changes how `release.sh` or the release skill works without touching the protected identity constants
- **THEN** the sync adopts the mechanics on top of the local hardening in a single reviewable tip commit rather than resolving the same files at every conflicting local commit

### Requirement: Conflict policy

A sync SHALL resolve conflicts according to this table.

| File | Policy |
|---|---|
| `src/summarizer.ts`, `src/summarizer-wiring.test.ts` | Local wins the compat-mock/dispatch question; use a three-way union otherwise. |
| `src/types.ts`, `src/commands.ts` | Three-way union. |
| `src/config.test.ts`, `src/summarizer.test.ts`, `src/reload-rearm.integration.test.ts` | Union of upstream and local cases; summarization-driving upstream cases are ported to the `getProvider().streamSimple` harness. |
| `package.json` | Merge upstream dependency changes with local identity, typecheck, and TypeScript fields. |
| `CHANGELOG.md`, `README.md`, `PRUNING.md`, `doc/configuration.md` | Merge narratives; avoid duplicate release headings by renumbering local entries when needed. |
| `AGENTS.md`, `AGENTS.core.md` | Keep deletion and remove the dependent CI step, script, and helper. |
| `.agents/skills/release/scripts/release.sh`, `.agents/skills/release/SKILL.md` | Adopt upstream mechanics; keep the protected identity constants and the local hardening; reconcile once at the tip. |
| `.pi/gauntlet-overrides.md` | Adopt upstream content; re-apply fork identity. |
| Summarization-driving upstream tests that mock `pi-ai/compat` | Port the harness to a `getProvider().streamSimple` fake; do not adopt the compat mock. |
| All other upstream-touched files | Adopt upstream as-is. |

#### Scenario: The compat mock returns via upstream

- **WHEN** upstream patches a `pi-ai/compat` mock in a protected dispatch test
- **THEN** the host-registry test harness remains in place and the compat mock is not reintroduced

#### Scenario: Version bump arrives upstream

- **WHEN** upstream releases v2.10.0 and the sync rebases onto it
- **THEN** the local package becomes `2.10.1` according to the version policy while preserving local identity fields

#### Scenario: Upstream adds a test case to a harness the local layer ported

- **WHEN** upstream adds cases to `src/reload-rearm.integration.test.ts` or `src/summarizer.test.ts` that drive summarization through the compat mock
- **THEN** the cases are kept and ported to the host-registry fake, and the ported cases pass at the rebased commit rather than at the tip only

#### Scenario: A local release heading collides with an upstream one

- **WHEN** upstream ships a version the local layer already used, such as upstream `## [2.9.1]` against a published local `2.9.1`
- **THEN** the local heading is renumbered with a `+local` marker, its position between the surrounding upstream sections is preserved, and the marker is recorded in the sync change

### Requirement: Sync gates

Every sync SHALL run the gates in the fork and rerun the applicable gates in the monorepo after the subtree pull. G4 runs for each thematic slice; G1, G3, and G5 run at the slice tip and after the subtree pull; G6 runs once at the fork tip. Fork test CI, release CI, and the local release preflight SHALL execute package-owned `bun run typecheck` before tests using the committed `bun.lock`, pinned Bun version, and frozen install. When a subtree pull changes `packages/pi-condense/package.json`, the root lockfile SHALL be regenerated in a detached candidate worktree with the repository's declared pnpm version; the candidate MUST pass frozen install and root/G1–G4 checks before the caller branch fast-forwards, and a failed candidate MUST leave the caller branch unchanged.

1. G0 requires a repo-wide clean tracked monorepo tree before subtree operations: `git diff-index HEAD` and `git diff-index --cached HEAD` are both empty.
2. G1 forbids imports or mocks from `@earendil-works/pi-ai/compat` and `reasoningEffort:` option assignments under `src/`. The `not.toHaveProperty("reasoningEffort")` regression assertion is allowed.
3. G2 runs targeted summarizer tests; G3 runs the complete suite.
4. G4 runs `bun run typecheck` through the package-owned TypeScript 7 project configuration; test CI, release CI, and release preflight run it before package tests.
5. G5 verifies the protected-path allowlist, that required local paths exist with local content, and the exact scoped identity, branch-qualified image URLs, release-script identity constants, test PR target, and GitHub default branch.
6. G6 verifies exported patch completeness and the sync-introduced allowlist.
7. The local automation suites (`scripts/test-release-helper.sh`, `scripts/test-smoke-antigravity.sh`) run at the fork tip whenever the sync touches `.agents/skills/release/**` or `scripts/**`.

G3 runs the complete suite and MUST be green. A test file committed ahead of its implementation — the executable spec of an active, unimplemented OpenSpec change — SHALL be guarded with `describe.skip` and an in-place comment naming the change, why the cases fail by construction, and the task that removes the guard, so the skipped cases stay visible in test output and the gate stays meaningful for everything else. Such a guard is not a removal of the tests and SHALL be recorded in the sync change.

#### Scenario: Current TypeScript runs without parent-config leakage

- **WHEN** G4 runs in the standalone fork or from the monorepo package directory
- **THEN** it invokes the package-owned TypeScript 7.0.2 compiler through `tsconfig.json`, checks the `index.ts` graph, and does not resolve a parent monorepo configuration or global compiler

#### Scenario: A gate fails

- **WHEN** any sync gate fails
- **THEN** the sync pauses until the failure is fixed or the work rolls back; the monorepo is never left half-synced

#### Scenario: A spec-first suite is red

- **WHEN** a synced tree contains tests for a local change that is not implemented yet
- **THEN** the suite is skip-guarded with an in-place note, G3 passes with the skips reported, and the sync change records the guard and the task that removes it

### Requirement: Version policy

The fork package version SHALL be the synced upstream version with its patch incremented by one: upstream v2.9.0 becomes `2.9.1`, upstream v2.10.0 becomes `2.10.1`, and upstream v2.9.1 becomes `2.9.2`. If upstream already publishes the selected local version, the local patch SHALL be incremented again until it is free. The version SHALL remain valid SemVer and package identity SHALL remain local. A version published out of band — from the monorepo, or by any path other than the fork's release helper — does not become the local high-water mark: the sync still uses the policy version, and the close-out record SHALL note the published anomaly and that publishing the policy version moves the `latest` dist-tag relative to it.

#### Scenario: Upstream ships v2.10.0

- **WHEN** the next sync rebases onto v2.10.0
- **THEN** the fork version becomes `2.10.1` with local identity fields unchanged

#### Scenario: A higher version was published outside the fork

- **WHEN** the scoped npm package already publishes a version above the policy version, such as `3.9.1` against a policy `2.11.3`
- **THEN** the fork keeps the policy version, the sync change records the out-of-band publication with its date and source commit, and the choice between deprecating the higher version and amending this policy is left to an explicit release decision
