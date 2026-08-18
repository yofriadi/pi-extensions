# Spec Delta: upstream-sync

## ADDED Requirements

### Requirement: Layered-fork sync model

The extension SHALL be consumed in the monorepo as a git subtree of a fork branch whose history is upstream `main` plus explicit local commits (the "local layer"). The fork clone SHALL live outside the monorepo (default `~/Developer/oss/pi-condense`) with remotes `origin` → the user's fork of `jjuraszek/pi-condense` (GitHub, created via `gh repo fork` — it does not currently exist) or a local bare repo, and `upstream` → `jjuraszek/pi-condense`. All local work — features AND close-out edits (changelog entries, openspec archive operations) — SHALL be committed to the fork branch `local/main` (or an ancestor) and reach the monorepo only via subtree pull; the monorepo SHALL NOT make content edits to `packages/pi-condense` after a subtree pull. First-pull (re-baseline) conflict *resolution* that takes the fork side verbatim is exempt — it is adoption of fork content, not an edit.

#### Scenario: Upstream releases a fix

- **WHEN** upstream `main` advances and the user wants the fix
- **THEN** the fork rebases `local/main` onto `upstream/main`, pushes with `--force-with-lease` (rebases rewrite local commit ids; tag the pre-rebase tip first), and the monorepo pulls the fork branch; the monorepo never merges upstream directly

#### Scenario: New local feature work

- **WHEN** a new local change to pi-condense is needed
- **THEN** it is committed in the fork on top of `local/main` and reaches the monorepo via the next subtree pull, not committed inside `packages/pi-condense` in the monorepo

### Requirement: Protected local surfaces

The following SHALL be treated as local-only and MUST NOT be overwritten by a sync: `src/summarizer-pacing.ts`, `src/summarizer-pacing.test.ts`, `ANTIGRAVITY.md`, `tsconfig.json`, the `.pi/` tree, the `openspec/` tree, and the scoped release identity. The scoped release identity consists of `package.json` fields `name: "@yofriadi/pi-condense"`, `version` under the local version policy, `publishConfig.access: "public"`, `repository`, `homepage`, `bugs`, `pi.image` (branch-qualified to `local/main`), `scripts.typecheck`, and TypeScript 7.0.2 / Node 22 development dependencies; the scoped installation strings in `README.md` and `CHANGELOG.md`; `.agents/skills/release/SKILL.md`; `.agents/skills/release/scripts/release.sh` values `PACKAGE_NAME="@yofriadi/pi-condense"`, `REPO_SLUG="yofriadi/pi-condense"`, and `RELEASE_BRANCH="local/main"`; and `local/main` as the fork default and only release branch. `src/summarizer.ts`, `src/summarizer-wiring.test.ts`, and `src/reload-rearm.integration.test.ts` carry protected invariants rather than whole-file ownership: host-registry dispatch via `ctx.modelRegistry.getProvider().streamSimple`, no `pi-ai/compat` import or mock, and no `reasoningEffort` option. Upstream may legitimately modify these files; the sync reconciles keeping the invariants intact. `src/summarizer-fallback.ts` and `src/summarizer-fallback.test.ts` are upstream files until the local fallback change is implemented.

#### Scenario: Sync attempts to overwrite a protected file

- **WHEN** an upstream release modifies a protected file
- **THEN** the sync keeps local content for the protected aspects, manually reconciles the remainder, and documents the reconciliation in the sync change

#### Scenario: Upstream touches an unprotected overlapping file

- **WHEN** upstream modifies `src/types.ts`, `src/commands.ts`, `package.json`, or `doc/configuration.md`
- **THEN** the sync takes a 3-way union of upstream and local additions unless the conflict policy declares otherwise


### Requirement: Local-layer completeness

Every file in the local-layer diff (`git diff --name-only 1d040e68 <phase0-tip>:packages/pi-condense` plus Phase 0's previously-untracked paths) SHALL appear in exactly one slice (subset: diff ⊆ union of slices). The slices may additionally contain a named allowlist of sync-*introduced* changes not in the diff: `.github/workflows/test.yml` (remove broken AGENTS-core step), `scripts/check-agents-core.mjs` (delete), `package.json` `check:agents-core` script (remove), `.agents/skills/release/scripts/release.sh` and `.agents/skills/release/SKILL.md` (npm-identity strings), and `src/reload-rearm.integration.test.ts` (required host-registry dispatch harness port). The local layer includes a tooling bootstrap (`tsconfig.json`, the `typecheck` script, TypeScript 7.0.2, and Node 22 type definitions) before functional slices so G4 is standalone. In particular, the layer includes `src/config.ts` (the `summarizerConcurrency` normalize/clamp), `src/config.test.ts`, and `src/summarizer.test.ts` (the reasoning-vs-`reasoningEffort` unit test) — omitting them silently drops shipped behavior, and no test gate can detect an absent file.

#### Scenario: Completeness gate at slice tip

- **WHEN** all slices are applied on `local/main`
- **THEN** `git diff --name-only 1d040e68 <phase0-tip>:packages/pi-condense` ⊆ the union of the slices' committed file lists, and the union exceeds the diff only by the named sync-introduced allowlist (verified before Phase 3)

### Requirement: Conflict policy

A sync SHALL resolve file conflicts according to this binding table.

| File | Policy |
|---|---|
| `src/summarizer.ts`, `src/summarizer-wiring.test.ts` | local wins the compat-mock/dispatch question; 3-way union otherwise |
| `src/types.ts`, `src/commands.ts` | 3-way union |
| `package.json` | merge: upstream version and dependencies + local identity fields, `typecheck` script, and TypeScript 7 development dependencies |
| `CHANGELOG.md`, `README.md`, `PRUNING.md`, `doc/configuration.md` | merge narratives; in `CHANGELOG.md`, renumber the local `## [2.9.0]` section into `Unreleased` before merging upstream's own `2.9.0` section |
| `AGENTS.md`, `AGENTS.core.md` | keep deletion; never resurrect; remove the CI step and `check:agents-core` script + `scripts/check-agents-core.mjs` that depend on them |
| upstream tests that mock `pi-ai/compat` and drive summarization (`src/reload-rearm.integration.test.ts` this cycle) | port the harness to host-registry dispatch (`getProvider().streamSimple` fake); do not adopt as-is |
| all other upstream-touched files | adopt upstream as-is |

#### Scenario: The compat mock returns via upstream

- **WHEN** an upstream release patches the `pi-ai/compat` mock in `src/summarizer-wiring.test.ts`
- **THEN** the local no-compat-mock version is kept, because host-registry dispatch tests the real contract

#### Scenario: Version bump arrives upstream

- **WHEN** upstream releases v2.10.0 and the sync rebases onto it
- **THEN** `package.json` version becomes `2.10.1` per the version policy and local identity fields are preserved

### Requirement: Sync gates

Every sync SHALL pass the gates as follows and re-run them in the monorepo after the merge: **G4 (typecheck) runs per thematic slice**; **G1, G3, G5 are tip-only** (run at the slice tip and post-merge, not per-slice — at slice ① `src/summarizer.ts` is still upstream's compat version so G1/G3 cannot pass, and G3's `summarizer-pacing.test.ts` harness needs slice ②'s summarizer); G6 runs once at the slice tip:

0. G0 clean tree before subtree operations: `git diff-index HEAD` and `git diff-index --cached HEAD` are both empty repo-wide (untracked files ignored). This is `git-subtree`'s `ensure_clean()` contract — a package-scoped check is insufficient.
1. G1 grep: no import from `@earendil-works/pi-ai/compat` and no `reasoningEffort:` property assignment anywhere in `src/`. The `expect(...).not.toHaveProperty("reasoningEffort")` assertion in `summarizer-wiring.test.ts` is the regression coverage and is explicitly allowlisted — it *enforces* the invariant, so the gate must not trip on it.
2. G2 targeted tests `bun test src/summarizer.test.ts src/summarizer-wiring.test.ts`; G3 full `bun test` green.
3. G4 typecheck green with `bun run typecheck`, whose package-local TypeScript 7.0.2 executable reads `tsconfig.json` in project mode and therefore cannot inherit a parent monorepo configuration.
4. G5 protected-path audit: every protected path (`.pi/`, `openspec/` complete tree, `src/summarizer-pacing.*`, `ANTIGRAVITY.md`, `tsconfig.json`, and the scoped release identity) exists with local content preserved; fork-side form checks (a) every path in `git diff --name-only <upstream-base> local/main` against the expected-path allowlist, (b) purely-local protected-path presence, and (c) exact scoped identity: branch-qualified `local/main` image URLs, `@yofriadi/pi-condense` package/install strings, release-script constants, test workflow PR target, and GitHub default branch. The monorepo-side form checks each protected path for intentional edits only after the subtree pull.
5. G6 completeness (tip only, fork): patch paths from the Phase-2 export ⊆ `git diff --name-only 125147c1 local/main`, excess only by the named sync-introduced allowlist.

#### Scenario: Current TypeScript runs without parent-config leakage

- **WHEN** G4 runs in the standalone fork or from the monorepo package directory
- **THEN** it invokes the package-owned TypeScript 7.0.2 compiler through `tsconfig.json`, checks the `index.ts` graph, and does not resolve or require a parent monorepo `tsconfig.json` or global compiler.

#### Scenario: A gate fails

- **WHEN** any gate fails at any point during the sync
- **THEN** the sync pauses and the failure is fixed, or the sync rolls back to the pre-sync backup branch; the monorepo is never left half-synced

#### Scenario: Gate scope

- **WHEN** gates run during slice application in the fork
- **THEN** the identical gates re-run in the monorepo after the subtree pull

### Requirement: Version policy

The fork's `package.json` version SHALL be the synced upstream tag with patch + 1 (upstream v2.9.0 → `2.9.1`; v2.10.0 → `2.10.1`; an upstream patch release v2.9.1 → `2.9.2`). If upstream later publishes the exact number this rule produces, the patch SHALL be bumped again until free. The local identity fields SHALL be preserved.

#### Scenario: Upstream ships v2.10.0

- **WHEN** the next sync rebases onto v2.10.0
- **THEN** the local version becomes `2.10.1` with identity fields unchanged

### Requirement: Accurate change status at close-out

Each sync change SHALL record, at close-out, the accurate implementation status of other active openspec changes in the package (currently `summarizer-fallback-model`: 0/21 tasks done, implementation not started — `src/summarizer-fallback.ts` is still upstream's single-boolean controller). The record SHALL NOT mark spec-only work as shipped. Post-sync, the fork's `local/main` is the base for implementing such changes on top of the new upstream version.

#### Scenario: Sync coexists with unimplemented local change

- **WHEN** a sync completes while another active change is spec-only
- **THEN** the sync's close-out notes record that change as unimplemented and the fork tip as its new base, without checking any of its task boxes

### Requirement: Subtree consumption

The monorepo SHALL consume the fork branch via `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main --squash` with remote `pi-condense-fork` pointing at the user's fork. The `--squash` flag is required: the subtree lineage is squash-based, and a non-squash pull against the fork dies with `fatal: refusing to merge unrelated histories` (no common commit history). The remote `pi-condense-upstream` SHALL remain pointed at upstream for fetch and tag reference only. Subtree operations SHALL run only when the monorepo tree is clean **repo-wide** (`git diff-index HEAD` and `git diff-index --cached HEAD` empty — `git-subtree`'s `ensure_clean()` checks the whole repo; untracked files are ignored).

#### Scenario: First (re-baseline) sync

- **WHEN** the fork is first consumed after local commits existed on both sides
- **THEN** a known conflict set is expected (the conflict-policy table's files: `AGENTS.md`, `AGENTS.core.md`, `CHANGELOG.md`, `PRUNING.md`, `README.md`, `doc/configuration.md`, `package.json`, `src/commands.ts`, `src/summarizer-wiring.test.ts`), resolved by taking the fork side per the conflict policy; this is NOT protected-surface drift

#### Scenario: Routine future sync

- **WHEN** upstream advances and the fork has rebased, after the first re-baseline
- **THEN** the monorepo subtree pull from the fork is expected to be conflict-free; any conflict indicates protected-surface drift and pauses the sync

#### Scenario: Dirty tree blocks subtree ops

- **WHEN** any tracked file repo-wide is modified or staged (untracked files are fine)
- **THEN** subtree operations are blocked until the tree is cleaned or the changes are committed or stashed

## MODIFIED Requirements

None — `upstream-sync` is a new capability.
