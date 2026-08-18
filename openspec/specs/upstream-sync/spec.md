# Upstream sync

## Purpose

Preserve a reviewable local layer while consuming upstream `pi-condense` releases through a standalone fork and squash-based subtree pulls.

## Requirements

### Requirement: Layered-fork sync model

The extension SHALL be consumed in the monorepo as a git subtree of a fork branch whose history is upstream `main` plus explicit local commits (the "local layer"). The fork clone SHALL live outside the monorepo (default `~/Developer/oss/pi-condense`) with remotes `origin` pointing at the user's fork of `jjuraszek/pi-condense` and `upstream` pointing at `jjuraszek/pi-condense`. All local work, including close-out edits such as changelog entries and OpenSpec archive operations, SHALL be committed to the fork branch `local/main` (or an ancestor) and reach the monorepo only through a subtree pull. The monorepo SHALL NOT make content edits to `packages/pi-condense` after a subtree pull. First-pull re-baseline conflict resolution that takes the fork side verbatim is exempt because it adopts fork content rather than creating a divergent local edit.

#### Scenario: Upstream releases a fix

- **WHEN** upstream `main` advances and the user wants the fix
- **THEN** the fork rebases `local/main` onto `upstream/main`, pushes with `--force-with-lease` after tagging the pre-rebase tip, and the monorepo pulls the fork branch; the monorepo never merges upstream directly

#### Scenario: New local feature work

- **WHEN** a new local change to pi-condense is needed
- **THEN** it is committed in the fork on top of `local/main` and reaches the monorepo through the next subtree pull, not through a direct monorepo package commit

### Requirement: Protected local surfaces

The following SHALL be treated as local-only and MUST NOT be overwritten by a sync: `src/summarizer-pacing.ts`, `src/summarizer-pacing.test.ts`, `ANTIGRAVITY.md`, `tsconfig.json`, the `.pi/` tree, the `openspec/` tree, and the scoped release identity. The scoped release identity consists of `package.json` fields `name: "@yofriadi/pi-condense"`, `version` under the local version policy, `publishConfig.access: "public"`, `repository`, `homepage`, `bugs`, `pi.image` (branch-qualified to `local/main`), `scripts.typecheck`, and TypeScript 7.0.2 / Node 22 development dependencies; the scoped installation strings in `README.md` and `CHANGELOG.md`; `.agents/skills/release/SKILL.md`; `.agents/skills/release/scripts/release.sh` values `PACKAGE_NAME="@yofriadi/pi-condense"`, `REPO_SLUG="yofriadi/pi-condense"`, and `RELEASE_BRANCH="local/main"`; and `local/main` as the fork default and only release branch. `src/summarizer.ts`, `src/summarizer-wiring.test.ts`, and `src/reload-rearm.integration.test.ts` carry protected invariants rather than whole-file ownership: host-registry dispatch through `ctx.modelRegistry.getProvider().streamSimple`, no `pi-ai/compat` import or mock, and no `reasoningEffort` option. Upstream may legitimately modify these files; a sync reconciles their changes while retaining the invariants. `src/summarizer-fallback.ts` and `src/summarizer-fallback.test.ts` remain upstream-owned until the local fallback change is implemented.

#### Scenario: Sync attempts to overwrite a protected file

- **WHEN** an upstream release modifies a protected file
- **THEN** the sync keeps local protected content, manually reconciles the remainder, and records the reconciliation in the sync change

#### Scenario: Upstream touches an unprotected overlapping file

- **WHEN** upstream modifies `src/types.ts`, `src/commands.ts`, `package.json`, or `doc/configuration.md`
- **THEN** the sync takes a three-way union of upstream and local additions unless the conflict policy declares otherwise

### Requirement: Local-layer completeness

Every file in the local-layer diff (`git diff --name-only <upstream-base> <phase0-tip>:packages/pi-condense` plus Phase 0's previously-untracked paths) SHALL appear in exactly one slice. Slices may additionally contain a named allowlist of sync-introduced changes outside that diff: `.github/workflows/test.yml` (remove the broken AGENTS-core step), `scripts/check-agents-core.mjs` (delete), the `package.json` `check:agents-core` script (remove), `.agents/skills/release/scripts/release.sh` and `.agents/skills/release/SKILL.md` (npm identity), and `src/reload-rearm.integration.test.ts` (required host-registry dispatch harness port). The local layer SHALL include the TypeScript bootstrap before functional slices: `tsconfig.json`, the `typecheck` script, TypeScript 7.0.2, and Node 22 type definitions. It SHALL also include `src/config.ts`, `src/config.test.ts`, and `src/summarizer.test.ts` so shipped pacing and dispatch behavior cannot be silently omitted.

#### Scenario: Completeness gate at slice tip

- **WHEN** all slices are applied on `local/main`
- **THEN** every exported local-layer patch path exists in `git diff --name-only <upstream-base> local/main`, and every excess path belongs to the named sync-introduced allowlist

### Requirement: Conflict policy

A sync SHALL resolve conflicts according to this table.

| File | Policy |
|---|---|
| `src/summarizer.ts`, `src/summarizer-wiring.test.ts` | Local wins the compat-mock/dispatch question; use a three-way union otherwise. |
| `src/types.ts`, `src/commands.ts` | Three-way union. |
| `package.json` | Merge upstream dependency changes with local identity, typecheck, and TypeScript fields. |
| `CHANGELOG.md`, `README.md`, `PRUNING.md`, `doc/configuration.md` | Merge narratives; avoid duplicate release headings by renumbering local entries when needed. |
| `AGENTS.md`, `AGENTS.core.md` | Keep deletion and remove the dependent CI step, script, and helper. |
| Summarization-driving upstream tests that mock `pi-ai/compat` | Port the harness to a `getProvider().streamSimple` fake; do not adopt the compat mock. |
| All other upstream-touched files | Adopt upstream as-is. |

#### Scenario: The compat mock returns via upstream

- **WHEN** upstream patches a `pi-ai/compat` mock in a protected dispatch test
- **THEN** the host-registry test harness remains in place and the compat mock is not reintroduced

#### Scenario: Version bump arrives upstream

- **WHEN** upstream releases v2.10.0 and the sync rebases onto it
- **THEN** the local package becomes `2.10.1` according to the version policy while preserving local identity fields

### Requirement: Sync gates

Every sync SHALL run the gates in the fork and rerun the applicable gates in the monorepo after the subtree pull. G4 runs for each thematic slice; G1, G3, and G5 run at the slice tip and after the subtree pull; G6 runs once at the fork tip.

1. G0 requires a repo-wide clean tracked monorepo tree before subtree operations: `git diff-index HEAD` and `git diff-index --cached HEAD` are both empty.
2. G1 forbids imports or mocks from `@earendil-works/pi-ai/compat` and `reasoningEffort:` option assignments under `src/`. The `not.toHaveProperty("reasoningEffort")` regression assertion is allowed.
3. G2 runs targeted summarizer tests; G3 runs the complete suite.
4. G4 runs `bun run typecheck` through the package-owned TypeScript 7 project configuration.
5. G5 verifies the protected-path allowlist, that required local paths exist with local content, and the exact scoped identity, branch-qualified image URLs, release-script identity constants, test PR target, and GitHub default branch.
6. G6 verifies exported patch completeness and the sync-introduced allowlist.

#### Scenario: Current TypeScript runs without parent-config leakage

- **WHEN** G4 runs in the standalone fork or from the monorepo package directory
- **THEN** it invokes the package-owned TypeScript 7.0.2 compiler through `tsconfig.json`, checks the `index.ts` graph, and does not resolve a parent monorepo configuration or global compiler

#### Scenario: A gate fails

- **WHEN** any sync gate fails
- **THEN** the sync pauses until the failure is fixed or the work rolls back; the monorepo is never left half-synced

### Requirement: Version policy

The fork package version SHALL be the synced upstream version with its patch incremented by one: upstream v2.9.0 becomes `2.9.1`, upstream v2.10.0 becomes `2.10.1`, and upstream v2.9.1 becomes `2.9.2`. If upstream already publishes the selected local version, the local patch SHALL be incremented again until it is free. The version SHALL remain valid SemVer and package identity SHALL remain local.

#### Scenario: Upstream ships v2.10.0

- **WHEN** the next sync rebases onto v2.10.0
- **THEN** the fork version becomes `2.10.1` with local identity fields unchanged

### Requirement: Accurate change status at close-out

Each sync SHALL record the accurate implementation state of other active OpenSpec changes. Spec-only changes SHALL not be represented as shipped; the fork's resulting `local/main` tip SHALL be recorded as their new implementation base.

#### Scenario: Sync coexists with an unimplemented local change

- **WHEN** a sync completes while another active change remains spec-only
- **THEN** the close-out notes record that state and the new fork base without checking any task boxes for the unrelated change

### Requirement: Subtree consumption

The monorepo SHALL consume the fork using `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main --squash`. The monorepo's tracked tree SHALL be clean repo-wide before the operation. The upstream remote remains for fetching and tag reference only.

#### Scenario: First re-baseline sync

- **WHEN** the fork is first consumed after local commits existed on both sides
- **THEN** known conflicts in the conflict-policy files are resolved by taking the fork side; they are expected re-baseline conflicts rather than protected-surface drift

#### Scenario: Routine future sync

- **WHEN** upstream advances and the fork has rebased after the first re-baseline
- **THEN** the subtree pull from the fork is expected to be conflict-free; any conflict pauses the sync for investigation

#### Scenario: Dirty tree blocks subtree operations

- **WHEN** any tracked monorepo file is modified or staged
- **THEN** subtree operations do not run until the tree is cleaned, committed, or stashed
