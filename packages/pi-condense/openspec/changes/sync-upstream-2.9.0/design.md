# Design: sync-upstream-2.9.0

## Context

Monorepo `packages/pi-condense` is a git subtree of upstream `jjuraszek/pi-condense`. Sync history: added at `5f13117a`, last synced to `1d040e68` (v2.5.0) on 2026-08-09 via merge commit `98ff65c8`. Local work layered on the subtree since then (commit `0c4eacec` plus uncommitted files) carries flush pacing (implemented, openspec-archived), Antigravity host-registry dispatch (implemented, guarded by `ANTIGRAVITY.md`), openspec scaffolding, package identity (`@yofriadi/pi-condense` v2.9.1), and the spec'd-but-unimplemented `summarizer-fallback-model` change (all 21 tasks open; `src/summarizer-fallback.ts` is still upstream's single-boolean controller, and no `summarizerFallback*` config keys exist). Upstream advanced `1d040e68..125147c1` (v2.9.0, 14 commits, 53 files): id-collision fixes (ref #8), single-chain observability and reload-stranded flush repair (#6), budget-window cap, deterministic uncovered-chain backfill (#10), and `pi-ai/compat` mock hygiene in two test files.

The 10-file overlap between the local layer and this upstream range: `AGENTS.md`, `AGENTS.core.md`, `CHANGELOG.md`, `PRUNING.md`, `README.md`, `doc/configuration.md`, `package.json`, `src/commands.ts`, `src/types.ts`, `src/summarizer-wiring.test.ts`. Critically, upstream did **not** touch `src/summarizer.ts`, `src/summarizer-fallback.ts`, or `src/summarizer-pacing.ts` in this range — the protected summarizer core is conflict-free this cycle.

## Goals / Non-Goals

**Goals**

1. Land upstream v2.9.0 fixes with zero functional loss of local behavior.
2. Restructure so local changes live as explicit commits on top of upstream, making future syncs a rebase instead of a monorepo conflict fight.
3. Make regressions mechanically detectable (ANTIGRAVITY.md gates) before anything reaches the monorepo.
4. Enter the sync with a clean monorepo working tree.

**Non-Goals**

1. Contributing the local layer upstream (no PRs to `jjuraszek/pi-condense`).
2. Moving or renaming the extension inside the monorepo.
3. Completing the 21 unchecked tasks in `openspec/changes/summarizer-fallback-model/tasks.md` — implementation has not started; close-out only records its accurate status (unimplemented, base moved to the fork tip) without altering its ledger.
4. Porting upstream's `doc/specs/*.md` files into openspec format — they remain upstream documentation adopted as-is.

## Decisions

### Decision 1: Layered fork — `local/main` branch in a standalone clone

**Options considered**

| | A — direct subtree pull from upstream each sync | B — layered fork branch, subtree pull from fork |
|---|---|---|
| Upstream sync cost | Re-fight textual conflicts in the overlap every sync | Rebase local commits onto upstream; conflicts resolved once per commit |
| Local work representation | Squashed delta inside subtree history | Explicit, reviewable, revertable commits |
| Regression risk | High — one merge already restored the `pi-ai/compat` path | Confined to the rebase; routine (subsequent) monorepo pulls are conflict-free by construction; the FIRST pull is a re-baseline with a known conflict set — see Decision 2c |
| Overhead | None | One standalone clone + one remote |

**Chosen: B**, per the user's instinct ("move my changes on top of upstream for easy merge") — it is the right call for a delta this size (~2k lines / 28 files).

Setup: standalone clone at `~/Developer/oss/pi-condense` with remotes `origin` → `yofriadi/pi-condense` (GitHub fork; create via `gh repo fork` if absent) and `upstream` → `jjuraszek/pi-condense`. Branch `local/main` = `upstream/main` + thematic local commits. The monorepo gains a remote `pi-condense-fork` → the fork. Routine (subsequent) syncs become:

```bash
# fork: git fetch upstream && git rebase upstream/main local/main
#       git push --force-with-lease=local/main origin local/main   # rebases rewrite local commit ids
# monorepo: git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main
```

After the first publication of `local/main`, every sync rebase rewrites the local commits' ids, so the push MUST be `--force-with-lease` (never bare `--force`); tag the pre-rebase tip first (e.g. `subtree-v2.9.0+local`) so the consumed history stays referenceable. The monorepo subtree merge records the new ids; no monorepo history is rewritten.

Rejected: submodules (changes monorepo build/publish), patch-series directories (lose git 3-way context), vendored copy (drifts).

### Decision 2: Local layer reconstructed by path-filtered diff, not by rebasing monorepo commits

Monorepo commits are entangled with non-pi-condense work (`0c4eacec` also touched other packages; staged tree holds unrelated pi-subagent-herdr work). Rebasing them into the fork drags foreign paths along.

Instead: the local layer is `git diff 1d040e68 <clean-tip>:packages/pi-condense` (after Phase 0 commits everything), sliced into thematic commits applied in the fork on top of `125147c1` (order matters — pacing first, since `summarizer.ts` imports from `./summarizer-pacing.js`):

1. `feat(summarizer): flush pacing and rate-limit retry` — `src/summarizer-pacing.ts`, `src/config.ts` (`summarizerConcurrency` normalize/clamp), `src/config.test.ts`, the `pacing` seam in `types.ts`, pacing parts of `commands.ts`, archived openspec change. (`src/summarizer-pacing.test.ts` is NOT here — it imports `summarizeBatch` from `summarizer.ts`, which is slice ②; it lands in slice ②. Slice ① is gated on typecheck only.)
2. `feat(summarizer): antigravity host-registry dispatch + harness port` — `src/summarizer.ts` (dispatch rewrite, keeps the pacing imports), `src/summarizer-wiring.test.ts`, `src/summarizer-pacing.test.ts`, `src/summarizer.test.ts` (reasoning-vs-`reasoningEffort` unit test), `ANTIGRAVITY.md`, AND the port of `src/reload-rearm.integration.test.ts` (replace its compat `stream` mock + `modelRegistry`-without-`getProvider` fake with a `getProvider().streamSimple` fake, mirroring the local `summarizer-wiring.test.ts`). The port MUST land in the same gated commit as dispatch: the moment dispatch lands, upstream's unported harness fails G3, so a commit containing dispatch without the port can never pass its gates.
3. `chore: local identity and scaffolding` — `package.json` (`@yofriadi/pi-condense`, `publishConfig`, version `2.9.1`), the complete `openspec/` tree (`config.yaml`, `specs/`, archived pacing change, active `summarizer-fallback-model`, and this `sync-upstream-2.9.0` change), `.pi/`, `AGENTS.md`/`AGENTS.core.md` deletions plus removal of the CI step + `check:agents-core` script + `scripts/check-agents-core.mjs` they break, CHANGELOG renumber (local `## [2.9.0]` → `Unreleased`, see Decision 3 table), README/PRUNING/doc entries

Slices are ordered by dependency: `summarizer.ts` (slice 2) imports `RATE_LIMIT_*`/`RateLimitGate`/etc. from `./summarizer-pacing.js` (slice 1) and reads the `pacing` option seam in `types.ts` (slice 1), so pacing must land first or slice 2 fails its gates on a missing module. The harness port is fused into slice 2 (not a separate later slice) because the fork base `125147c1` already contains the unported `reload-rearm.integration.test.ts`, which fails G3 the moment dispatch lands (the fake's missing `getProvider` throws a TypeError that the summarizer buckets as transient) — no gated commit may contain dispatch without the port. Each slice is applied with `git apply -3` (3-way against the upstream base), gated (tests + typecheck + ANTIGRAVITY greps), then committed. Bisectability matters more than perfectly atomic slices.

### Decision 2c: First consumption is a re-baseline, not a merge

The monorepo subtree was added and updated with `--squash` (commits `5f13117a`, `9c942925`, `74175154`), so `git merge-base master 125147c1` is empty — the monorepo and the fork share **no commit history**. A plain `git subtree pull` therefore dies with `fatal: refusing to merge unrelated histories` (verified by simulation against git 2.50.1's `git-subtree`; `cmd_pull` never passes `--allow-unrelated-histories`).

Two working mechanisms:

| | A — `subtree pull --squash` from the fork | B — one-time tree replacement (`read-tree`/`subtree add` after removal) |
|---|---|---|
| History | Preserves squash lineage; future pulls get a merge base | Severs squash lineage; next pull needs care |
| First-pull conflicts | Expected known set (~8 files: the overlap minus disjoint edits) — resolved per Decision 3 table | None — fork tree is adopted verbatim |
| Operator instruction needed | "Conflicts on first pull are expected, not drift" | None |

**Chosen: A.** The conflicts are exactly the Decision 3 table's files (verified: `git merge-tree 1d040e68^{tree} <phase0-tip>:packages/pi-condense 125147c1^{tree}` reports ~7 hunks across `AGENTS.md`, `CHANGELOG.md`, `PRUNING.md`, `README.md`, `doc/configuration.md`, `package.json`, `src/commands.ts`, `src/summarizer-wiring.test.ts`, plus `AGENTS.core.md` modify/delete). They are the *same* resolutions already encoded in the fork's slices, so resolution is mechanical: take the fork side. The spec's "any conflict ⇒ pause" scenario is scoped to **subsequent** syncs only; the first pull's expected conflict set is named explicitly there.

### Decision 3: Binding conflict policy per overlapping file

| File | Policy | Rationale |
|---|---|---|
| `src/summarizer-wiring.test.ts` | **local wins the mock question** | Upstream `3b1dc0cd` only patches the `pi-ai/compat` `mock.module(...)`; the local rewrite removed the compat mock entirely (host-registry dispatch). Adopting upstream's hunk reintroduces the documented regression. If upstream later rewrites the file substantively, merge manually with the no-compat-mock rule as invariant. |
| `src/types.ts`, `src/commands.ts` | **3-way union** | Both sides added real content: take upstream's additions (pacing-adjacent types, `/pruner` changes) and keep local additions (fallback/pacing config types, fallback commands). |
| `package.json` | **merge** | Take upstream version bumps and dependency changes; keep local `name`, `publishConfig`, scripts. |
| `CHANGELOG.md`, `README.md`, `PRUNING.md`, `doc/configuration.md` | **merge narratives** | Upstream 2.6.0–2.9.0 sections + local entries; both truths stay. For `CHANGELOG.md`, the local `## [2.9.0] - 2026-08-12` section (flush pacing) MUST be renumbered into `Unreleased` (or `2.9.1`) before merging upstream's own `## [2.9.0]` — two different `2.9.0` sections is not a mergeable state. |
| `AGENTS.md`, `AGENTS.core.md` | **keep local deletion** | Deliberate divergence. Never resurrect. If upstream's no-new-machinery rule (`5221debc`) matters locally, port the rule text into `ANTIGRAVITY.md`. |
| Upstream tests that mock `pi-ai/compat` and drive summarization (`src/reload-rearm.integration.test.ts` this cycle) | **port, don't adopt** | Their `stream`-mock + `modelRegistry`-without-`getProvider` harness returns `transient: provider not found` under host-registry dispatch, so G3 fails if adopted as-is. Port to a `getProvider().streamSimple` fake, mirroring the local `summarizer-wiring.test.ts`. |
| All other upstream-touched files | **adopt upstream as-is** | No local divergence; includes new modules (`occurrence-key`, `orphan-sweep`, `diagnostics`, `context-metrics`, `test-support`, new integration tests, new `doc/specs/*`). |

### Decision 4: Gates run in the fork before the monorepo sees anything

Gates G1–G6 (authoritative executable forms in tasks.md §6). **G4 (typecheck) runs per slice**; **G1, G3, G5 are tip-only** (at slice ① `src/summarizer.ts` is still upstream's compat version, so G1/G3 cannot pass; G3's `summarizer-pacing.test.ts` harness needs slice ②'s summarizer); **G6 (completeness) runs once at the tip**:

1. G1 grep: no `pi-ai/compat` import and no `reasoningEffort:` property assignment in `src/` (the `not.toHaveProperty("reasoningEffort")` assertion in `summarizer-wiring.test.ts` is allowlisted).
2. G2 targeted tests: `bun test src/summarizer.test.ts src/summarizer-wiring.test.ts`; G3 full `bun test`.
3. G4 typecheck: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
4. G5 protected-path audit (executable form in tasks.md §6).
5. G6 completeness (tip only, tasks.md §6).

Then subtree pull into the monorepo, and re-run 1–3 there.

### Decision 5: Version policy

Local layer version = the synced upstream tag with **patch + 1**: v2.9.0 → `2.9.1`; a future v2.10.0 → `2.10.1`; an upstream patch release v2.9.1 → `2.9.2`. If upstream ever publishes the exact number this rule produces, bump patch again until the number is free (collision rule). Always valid SemVer, always distinct from the upstream tag it was built from at sync time. The local `package.json` already carries `2.9.1`, matching this policy for the v2.9.0 sync.

## Risks / Trade-offs

1. **One more repo to maintain.** Accepted for clean history; sync remains one command in each repo.
2. **The rebase/slicing is the hard part** (~2k lines over 10 overlapping files). Mitigated by thematic slices, per-slice gates, and the `backup/pre-upstream-2.9.0` branch.
3. **Unimplemented fallback spec rides along**: `summarizer-fallback-model/tasks.md` shows 0/21 checked because the work genuinely hasn't been done — the tier chain exists only as spec. Post-sync, the fork's `local/main` is the correct base for implementing it (on top of v2.9.0, not v2.5.0); this sync must simply not mislabel it as shipped.
4. **`summarizer-wiring.test.ts` upstream drift**: if upstream keeps evolving its compat mock, every sync re-litigates this file. The spec records the invariant (no compat mock) rather than the diff, so future resolutions stay principled.

## Migration Plan

- **Phase 0 — monorepo cleanup** (no subtree ops): branch `backup/pre-upstream-2.9.0`; commit unrelated staged pi-subagent-herdr work as its own commit; commit the complete pi-condense local state with `git add -A packages/pi-condense` (untracked `ANTIGRAVITY.md`, `.pi/`, the whole `openspec/` tree including this change, `AGENTS.md` deletion); stash or commit the remaining repo-wide tracked modifications (`.fallow.toml`, root `AGENTS.md`, root `package.json`, `pnpm-lock.yaml`, `packages/pi-accounts/*`, `packages/pi-provider-antigravity/*`, `packages/pi-toon/package.json`, `packages/pi-mlflow/AGENTS.md`) — `git-subtree`'s `ensure_clean()` runs `git diff-index HEAD` **repo-wide**, so a package-scoped clean tree is not enough; untracked files are fine.
- **Phase 1 — fork setup**: `gh repo fork jjuraszek/pi-condense`; clone to `~/Developer/oss/pi-condense`; remotes `origin` (fork) + `upstream`; branch `local/main` = `125147c1`; push.
- **Phase 2 — layer reconstruction**: apply the three thematic slices from the monorepo diff onto `125147c1` with `git apply -3`; resolve per Decision 3; gates green per slice; commit.
- **Phase 3 — fork close-out** (all mutations in the fork, never the monorepo): CHANGELOG sync entry under `Unreleased` with the accurate status note (`summarizer-fallback-model` unimplemented 0/21; fork `local/main` is its new base); `openspec validate --all` in the fork; `openspec archive sync-upstream-2.9.0` in the fork; commit; push.
- **Phase 4 — monorepo consumption**: `git remote add pi-condense-fork <fork-url>`; single `git subtree pull --prefix=packages/pi-condense pi-condense-fork local/main`; re-run gates G1–G5 in the monorepo; live Antigravity smoke; tag fork `subtree-v2.9.0+local`; push monorepo.

The monorepo receives close-out artifacts (changelog entry, archived change) through the same subtree pull — no post-pull package edits, preserving the fork as sole source of truth.

## Open Questions

1. **Fork existence — resolved during review**: `https://github.com/yofriadi/pi-condense` returns 404; the fork must be created at Phase 1 via `gh repo fork jjuraszek/pi-condense`. The subtree source may be the GitHub fork or a local path (git subtree accepts either); the spec's remote wording admits both.
2. **Track upstream's side branches?** (`demote-oversized-skip-to-info`, `honor-pi-coding-agent-dir`) — default no; only `main` is tracked. Revisit if a fix lands only on a branch.
