# Tasks: sync-upstream-2-9-0

## 1. Phase 0 — monorepo cleanup & safety net

- [x] 1.1 `git branch backup/pre-upstream-2.9.0 master`
- [x] 1.2 Commit unrelated staged pi-subagent-herdr work as its own commit
- [x] 1.2a Fetch upstream refs into the monorepo and verify the patch base is resolvable: add the remote if absent (`git remote add pi-condense-upstream https://github.com/jjuraszek/pi-condense.git`), then `git fetch pi-condense-upstream main --tags` then `git cat-file -e 1d040e68^{commit}` (the squash-based subtree imported no upstream commits; this is what makes `1d040e68` available for the 3.1 patch and G5/G6)
- [x] 1.3 Commit the complete pi-condense local state: `git add -A packages/pi-condense` (untracked `ANTIGRAVITY.md`, `.pi/`, the whole `openspec/` tree including this change, `AGENTS.md` deletion) as `chore(pi-condense): record local docs, openspec tree and .pi assets`
- [x] 1.4 Stash or commit the remaining repo-wide tracked modifications (`.fallow.toml`, root `AGENTS.md`, root `package.json`, `pnpm-lock.yaml`, `packages/pi-accounts/*`, `packages/pi-provider-antigravity/*`, `packages/pi-toon/package.json`, `packages/pi-mlflow/AGENTS.md`) — `git-subtree`'s `ensure_clean()` runs `git diff-index HEAD` repo-wide; untracked files are fine. Stash is enough; it does not bring them into scope.
- [x] 1.5 Add and commit the package-local TypeScript 7 project configuration (`tsconfig.json`, `typecheck` script, and exact development dependencies), then run gates G1–G4 (G4 is `bun run typecheck`) on the tip; verify `git diff-index HEAD` and `git diff-index --cached HEAD` are both empty repo-wide

## 2. Phase 1 — fork setup

- [x] 2.1 Create the fork: `gh repo fork jjuraszek/pi-condense --clone=false` (verified 404 today; `yofriadi/pi-condense` does not exist yet)
- [x] 2.2 Clone `jjuraszek/pi-condense` to `~/Developer/oss/pi-condense`; remotes `origin` → fork, `upstream` → `jjuraszek/pi-condense`; run the baseline `bun install` in the fork
- [x] 2.3 Branch `local/main` at `125147c1`; push to origin

## 3. Phase 2 — layer reconstruction (tooling bootstrap + dependency-ordered slices on `local/main`)

- [x] 3.1 Export the local-layer patch from the monorepo: `git diff 1d040e68 <phase0-tip>:packages/pi-condense` written to a file outside both repos. **Base is `1d040e68`, NOT `125147c1`** — diffing from `125147c1` would emit deletes/reverts of the upstream v2.6–2.9.0 work. (`125147c1` is used separately, only as the G5 fork-side check base.)
- [x] 3.2 Slice ⓪ `chore(tooling): configure standalone TypeScript 7 checks` — `tsconfig.json` scoped to the `index.ts` graph, plus `package.json` `typecheck` script and exact `typescript` 7.0.2 / `@types/node` 22.19.19 development dependencies; apply with `git apply -3`, run `bun install`, verify `bun run typecheck` resolves the declared package-owned TypeScript 7.0.2 and Node 22 types in the fresh clone, gate on G4, and commit. This bootstrap MUST precede every feature slice.
- [x] 3.3 Slice ① `feat(summarizer): flush pacing and rate-limit retry` — `src/summarizer-pacing.ts`, `src/config.ts` (`summarizerConcurrency` normalize/clamp), `src/config.test.ts`, the `pacing` seam in `types.ts`, pacing parts of `commands.ts`, archived openspec change; apply with `git apply -3`; **gate on G4 (typecheck) only** — G1/G3 can't pass here (`src/summarizer.ts` is still upstream's compat version; `src/summarizer-pacing.test.ts` imports `summarizeBatch` from it and lives in slice ②); commit.
- [x] 3.4 Slice ② `feat(summarizer): antigravity host-registry dispatch + harness port` — `src/summarizer.ts` (dispatch rewrite, keeps the pacing imports), `src/summarizer-wiring.test.ts`, `src/summarizer-pacing.test.ts`, `src/summarizer.test.ts` (reasoning-vs-`reasoningEffort` unit test), `ANTIGRAVITY.md`, AND the port of `src/reload-rearm.integration.test.ts` (compat `stream` mock → `getProvider().streamSimple` fake, mirroring `summarizer-wiring.test.ts`) — the port MUST be in the same gated commit as dispatch or G3 fails; gates; commit.
- [x] 3.5 Slice ③ `chore: local identity and scaffolding` — the remaining `package.json` identity + version `2.9.1` changes (the TypeScript script/dependencies landed in slice ⓪), the complete `openspec/` tree (`config.yaml`, `specs/`, archived pacing, active `summarizer-fallback-model`, this `sync-upstream-2-9-0` change), `.pi/`, `AGENTS.md`/`AGENTS.core.md` deletions + removal of `.github/workflows/test.yml` check-agents-core step, `check:agents-core` script, `scripts/check-agents-core.mjs`, CHANGELOG renumber (local `## [2.9.0]` entries move under a new `## [2.9.1] - <date>` section for the local layer; `Unreleased` left empty — the inherited `release.yml` release-notes job needs the section on a `v2.9.1` tag, and a future `v2.9.1` tag WOULD trigger `npm publish`; the `subtree-v2.9.0+local` tag does not match the release pattern and is safe), README/PRUNING/doc entries, and scoped release identity: `@yofriadi/pi-condense`, `yofriadi/pi-condense`, `local/main` as the only release/default branch, branch-qualified image URLs, and migration of legacy unscoped npm pins through `.agents/skills/release/**`; gates; commit.
- [x] 3.6 Completeness gate (G6): the local-layer diff's file list ⊆ the union of the tooling bootstrap and three feature slices' committed file lists, and the union exceeds it only by the sync-introduced allowlist (`.github/workflows/test.yml`, `scripts/check-agents-core.mjs`, `package.json` scripts, `.agents/skills/release/scripts/release.sh`, `.agents/skills/release/SKILL.md`, and `src/reload-rearm.integration.test.ts` for the required host-dispatch harness port). Compute against the exported 3.1 patch (NOT `<phase0-tip>` — that ref is unreachable in the fork): patch paths via `git apply --numstat`/`--summary` vs `git diff --name-only 125147c1 local/main`.
- [x] 3.7 Full gates G1–G6 on `local/main` tip; verify version `2.9.1`.

## 4. Phase 3 — fork close-out (all mutations in the fork)

- [x] 4.1 CHANGELOG sync entry under `Unreleased` (includes: synced to upstream v2.9.0; `summarizer-fallback-model` unimplemented 0/21, fork `local/main` is its new base)
- [x] 4.2 `openspec validate --all` clean (in the fork)
- [x] 4.3 Sync the `upstream-sync` delta into `openspec/specs/upstream-sync/spec.md` (openspec-sync-specs skill) so the durable capability exists as a spec, not only as an archived delta
- [x] 4.3b `openspec archive sync-upstream-2-9-0` (in the fork; does NOT archive `summarizer-fallback-model` — it stays active)
- [x] 4.4 Commit and push fork (`git push origin local/main`; first push, fast-forward)

## 5. Phase 4 — monorepo consumption (first pull = re-baseline)

- [x] 5.1 `git remote add pi-condense-fork <fork-url>` (skip if present)
- [x] 5.2 `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main --squash -m "Update pi-condense subtree to upstream v2.9.0 + local layer"` — the `--squash` flag is REQUIRED: the subtree lineage is squash-based and a non-squash pull dies with `fatal: refusing to merge unrelated histories` (no common commit history with the fork)
- [x] 5.3 Expected first-pull conflicts: the conflict-policy table's files (`AGENTS.md`, `AGENTS.core.md`, `CHANGELOG.md`, `PRUNING.md`, `README.md`, `doc/configuration.md`, `package.json`, `src/commands.ts`, `src/summarizer-wiring.test.ts`) — resolve by taking the fork side per the spec's conflict policy. This is NOT protected-surface drift; the "any conflict ⇒ pause" rule applies only to subsequent syncs.
- [x] 5.4 Re-run gates G1–G5 in the monorepo (G6 is fork-only; G5 monorepo form: `git diff <phase0-tip>:packages/pi-condense/<path> HEAD:packages/pi-condense/<path>` per protected path — only intentional edits, never deletions)
- [ ] 5.5 Live smoke: reload extension in a real session; Antigravity summarizer produces summaries directly; fallback warning format matches `ANTIGRAVITY.md`
- [x] 5.6 Tag fork `subtree-v2.9.0+local` at the consumed tip; push monorepo

## 6. Gates reference

- G0 clean tree (pre-subtree-op, monorepo): `git diff-index HEAD` and `git diff-index --cached HEAD` empty repo-wide (untracked ignored)
- G1 grep: no import from `@earendil-works/pi-ai/compat` and no `reasoningEffort:` property assignment anywhere in `src/` (spans `summarizer.ts`, `summarizer-wiring.test.ts`, `reload-rearm.integration.test.ts`). Allowlisted: the `expect(...).not.toHaveProperty("reasoningEffort")` assertion in `summarizer-wiring.test.ts` — it enforces the invariant, the gate must not trip on it.
- G2 targeted tests: `bun test src/summarizer.test.ts src/summarizer-wiring.test.ts`
- G3 full suite: `bun test`
- G4 typecheck: `bun run typecheck` (the authoritative `tsconfig.json` project-mode check with package-owned TypeScript 7.0.2 and Node 22 types; `ANTIGRAVITY.md` defers to it)
- G5 protected-path audit — two executable forms:
  - fork-side (Phases 2–3), two directional checks: (a) every path in `git diff --name-only 125147c1 local/main` matches an allowlisted glob from the expected-path set below; (b) every purely-local protected path (`.pi/prompts/*`, `.pi/skills/*`, `openspec/**`, `src/summarizer-pacing.*`, `ANTIGRAVITY.md`) exists on `local/main` with local content
  - monorepo-side (Phase 4, `<phase0-tip>` is a local ref there): per protected path `git diff <phase0-tip>:packages/pi-condense/<path> HEAD:packages/pi-condense/<path>` shows only intentional edits (changelog/archive moves), never deletions or upstream reverts
- G6 completeness (Phase 2 tip, fork): patch paths from the 3.1 export ⊆ `git diff --name-only 125147c1 local/main`, excess only by the sync-introduced allowlist (`.github/workflows/test.yml`, `scripts/check-agents-core.mjs`, `package.json` scripts, `.agents/skills/release/scripts/release.sh`, `.agents/skills/release/SKILL.md`, `src/reload-rearm.integration.test.ts` for the required host-dispatch harness port)

**G5 expected-path set** (fork-side) — local-layer paths plus upstream files carrying local edits: `tsconfig.json`, `src/summarizer-pacing.*`, `src/config.ts`, `src/config.test.ts`, `src/summarizer.ts`, `src/summarizer-wiring.test.ts`, `src/summarizer.test.ts`, `ANTIGRAVITY.md`, `.pi/**`, `openspec/**`, `src/types.ts`, `src/commands.ts`, `src/reload-rearm.integration.test.ts`, `package.json`, `CHANGELOG.md`, `README.md`, `PRUNING.md`, `doc/configuration.md`, `.github/workflows/test.yml`, `scripts/check-agents-core.mjs` (deletion), `AGENTS.md`/`AGENTS.core.md` (deletions), `.agents/skills/release/scripts/release.sh`, `.agents/skills/release/SKILL.md`. Anything outside this set = investigate.

G4 runs for the tooling bootstrap and every Phase 2 feature slice; G1/G3/G5 run at the Phase 2 tip and post-merge in the monorepo; G6 runs at the Phase 2 tip only (fork). Any failure: fix in place, or roll back (`git reset --hard backup/pre-upstream-2.9.0` in monorepo; `git reset --hard upstream/main` in fork).

## 7. Out of scope

Monorepo files outside `packages/pi-condense` (root `HANDOFF.md`, root `.fallow.toml`, root `AGENTS.md` deletion, root `package.json`, `pnpm-lock.yaml`, `packages/pi-accounts/*`, `packages/pi-provider-antigravity/*`, `packages/pi-toon/package.json`, `packages/pi-mlflow/AGENTS.md`, other packages' untracked `.pi/`/`openspec/` dirs) — these are stashed/committed in Phase 0 only to satisfy `git-subtree`'s repo-wide clean-tree requirement; their content is not touched. Upstream side branches. Contributing the local layer upstream. Implementing `summarizer-fallback-model` (it rides along as active spec; implement on the fork after this sync).

## 8. Binding sequencing

Phases 0 → 1 → 2 → 3 → 4; slices ⓪ → ① → ② → ③ (the TypeScript tooling bootstrap precedes all G4 checks; pacing before dispatch — `summarizer.ts` imports `./summarizer-pacing.js`; dispatch and its harness port in one commit — upstream's unported `reload-rearm` test fails G3 under dispatch); G4 (typecheck) green per slice before the next slice; G1/G3/G5 run tip-only (at 3.6/3.7), not per-slice; G6 green before Phase 3; Phase 4 gates green before tagging/pushing the monorepo.
