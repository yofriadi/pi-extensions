## MODIFIED Requirements

### Requirement: Subtree consumption
The monorepo SHALL consume the fork using `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main --squash`. The monorepo's tracked tree SHALL be clean repo-wide before the operation. The upstream remote remains for fetching and tag reference only. The advertised `pnpm update:pi-condense` command SHALL invoke a wrapper that uses the named `pi-condense-fork` remote, verifies that its configured URL is the fork URL, fetches `local/main`, and executes this squash pull; it MUST NOT pull `jjuraszek/pi-condense/main` directly. After a successful pull, the wrapper SHALL run G1, G2, G3, and G4 from `packages/pi-condense` before reporting success.

#### Scenario: Routine future sync
- **WHEN** upstream advances and the fork has rebased after the first re-baseline
- **THEN** the subtree pull from the fork is expected to be conflict-free; any conflict pauses the sync for investigation

#### Scenario: Dirty tree blocks subtree operations
- **WHEN** any tracked monorepo file is modified or staged
- **THEN** subtree operations do not run until the tree is cleaned, committed, or stashed

#### Scenario: Scripted subtree update
- **WHEN** an operator runs `pnpm update:pi-condense` in a clean monorepo
- **THEN** the wrapper fetches `pi-condense-fork/local/main`, performs a squash subtree pull from that branch, runs G1–G4, and never contacts upstream as the subtree source

### Requirement: Sync gates
Every sync SHALL run the gates in the fork and rerun the applicable gates in the monorepo after the subtree pull. G4 runs for each thematic slice; G1, G3, and G5 run at the slice tip and after the subtree pull; G6 runs once at the fork tip. The monorepo lockfile SHALL be regenerated with the repository's declared pnpm version whenever a subtree pull changes `packages/pi-condense/package.json`, and its `packages/pi-condense` importer MUST exactly represent the consumed manifest's dependencies and development dependencies. Regeneration SHALL occur from a clean worktree so unrelated lockfile edits are not incorporated.

1. G0 requires a repo-wide clean tracked monorepo tree before subtree operations: `git diff-index HEAD` and `git diff-index --cached HEAD` are both empty.
2. G1 forbids imports or mocks from `@earendil-works/pi-ai/compat` and `reasoningEffort:` option assignments under `src/`. The `not.toHaveProperty("reasoningEffort")` regression assertion is allowed.
3. G2 runs targeted summarizer tests; G3 runs the complete suite.
4. G4 runs `bun run typecheck` through the package-owned TypeScript 7 project configuration; fork test CI, release CI, and release preflight SHALL run this command before tests.
5. G5 verifies the protected-path allowlist, that required local paths exist with local content, and the exact scoped identity, branch-qualified image URLs, release-script identity constants, test PR target, and GitHub default branch.
6. G6 verifies exported patch completeness and the sync-introduced allowlist.

#### Scenario: Current TypeScript runs without parent-config leakage
- **WHEN** G4 runs in the standalone fork or from the monorepo package directory
- **THEN** it invokes the package-owned TypeScript 7.0.2 compiler through `tsconfig.json`, checks the `index.ts` graph, and does not resolve a parent monorepo configuration or global compiler

#### Scenario: A gate fails
- **WHEN** any sync gate fails
- **THEN** the sync pauses until the failure is fixed or the work rolls back; the monorepo is never left half-synced

#### Scenario: Lockfile is stale after a consumed manifest change
- **WHEN** a subtree pull updates the pi-condense manifest and the root lockfile importer differs from that manifest
- **THEN** the lockfile is regenerated from a clean worktree and committed before frozen workspace installation is treated as reproducible

### Requirement: Accurate change status at close-out
Each sync SHALL record the accurate implementation state of other active OpenSpec changes. Spec-only changes SHALL not be represented as shipped; the fork's resulting `local/main` tip SHALL be recorded as their new implementation base. An authenticated real-session Antigravity smoke SHALL remain explicitly pending until an operator runs it and records the session artifact and observed configured-model/fallback outcome; automated mocks and static gates MUST NOT be represented as its substitute.

#### Scenario: Sync coexists with an unimplemented local change
- **WHEN** a sync completes while another active change remains spec-only
- **THEN** the close-out notes record that state and the new fork base without checking any task boxes for the unrelated change

#### Scenario: Automated validation completes without live credentials
- **WHEN** CI and local mock-based gates are green but no authenticated Antigravity session has been run
- **THEN** the close-out record leaves the live smoke task pending and identifies the required manual verification
