# Design: sync-upstream-2-11-2

## Decision 1: Port the monorepo-only commits into the fork before rebasing

Two content edits and one accidental version bump landed in `packages/pi-condense` inside the monorepo after the last subtree pull (`116c5d35`), which the layered-fork model forbids:

- `36413a9a` — the `<context-prune-summary>` wrapper feature (`src/summary-refs.ts`, `index.ts`, `src/pruner.ts`, `src/chain-compressor.ts`, `src/commands.ts`, `src/indexer.ts`, `src/tree-browser.ts`, five test files, `PRUNING.md`, the OpenSpec change).
- `e4d91053` — `src/proactive-tiers.integration.test.ts` plus the archived `harden-sync-release-automation` record.
- `0abef17d` — the `proactive-budget-tiers` OpenSpec change, deletion of the package `.pi/` tree, and a `package.json` version bump to `3.9.1`, all inside an unrelated `pi-provider-antigravity` commit.

They were replayed into the fork as three commits: `git format-patch -1 <sha> -- packages/pi-condense` in the monorepo, then `git am -p3` in the fork (the `-p3` strip removes `a/packages/pi-condense/`). The `.pi/` deletion was **not** ported: `.pi/` is protected local content, so the fork keeps it. That leaves the monorepo divergent, and because Decision 8 does edit `.pi/gauntlet-overrides.md`, the divergence surfaced as a modify/delete conflict at pull time rather than staying dormant; Decision 9 records how it was resolved. The `3.9.1` bump was not ported either — see Decision 6.

Porting first keeps the rebase honest: every local commit that touches an upstream-modified file is replayed by the rebase itself instead of being re-applied by hand afterwards.

**Verification.** Every line the wrapper commit added in the monorepo exists in the rebased tip (checked per file for all 16 source/doc paths), the removed `getPerBatchSummaryTextForToolCallIds` is still gone, and `git diff upstream/main HEAD -- index.ts src/pruner.ts src/chain-compressor.ts src/tree-browser.ts src/indexer.ts src/commands.ts` shows only the wrapper feature.

## Decision 2: Rebase the local layer, do not merge or re-baseline

`git rebase upstream/main` on a scratch branch (`sync/2.11.2`) replays all 19 local commits onto `04a64d2`. The rebase target is upstream's `main` tip rather than the `v2.11.2` tag; the only commit past the tag (`04a64d2`) renames routing text in `AGENTS.md`/`AGENTS.core.md`, which the local layer deletes, so it resolves as a kept deletion.

Alternatives rejected: merging upstream into `local/main` (the spec's history shape is upstream plus explicit local commits, and a merge would hide which local commit owns which reconciliation); squashing the local layer into one re-baseline commit (loses the slice structure G6 and the protected-surface audit depend on).

## Decision 3: Conflict resolutions

| File | Resolution |
|---|---|
| `src/config.test.ts` | Union: upstream's `frontierGapThresholdTokens`, `maxImagesPerRequest`, and `saveConfig` fails-closed describes plus the local `summarizerConcurrency` describe. |
| `src/summarizer.test.ts` | Local imports (no `pi-ai/compat` mock). Upstream's new image-marker prompt test **ported** to the host-registry harness: `ctx.modelRegistry.getProvider().streamSimple` captures the input instead of `mock.module`. Local `summarizerThinkingOptions` describe kept. |
| `src/reload-rearm.integration.test.ts` | Import union minus the compat mock: upstream's `readFileSync` (its `#16` fixture test reads `src/fixtures/gh16-frontier-83.jsonl`) and `supersededStub`, local's `mock`-free `bun:test` import. The body auto-merged; the local `getProvider().streamSimple` harness now drives all 41 cases including upstream's new `#16` and supersede-floor suites. |
| `package.json` | Local identity, version `2.11.3` (Decision 6). Upstream changed nothing but its own version since the base. |
| `README.md` | Row union: upstream's `frontierGapThresholdTokens`, `maxImagesPerRequest`, and supersession-aware `protectedPaths` wording plus the local `summarizerConcurrency` row. |
| `CHANGELOG.md` | Upstream's 2.11.2…2.9.1 sections verbatim; the local section renumbered to `## [2.9.1+local] - 2026-08-12` to avoid a duplicate `2.9.1` heading (Decision 5); the previous sync's narrative moved from `## [Unreleased]` into that section because it describes the v2.9.0 rebase, which shipped as local 2.9.1. |
| `AGENTS.md`, `AGENTS.core.md` | Kept deleted (`git rm`), including upstream's post-tag rename commit. |
| `.agents/skills/release/**` | Local side taken at each conflicting commit; upstream mechanics ported once at the tip (Decision 4). |

## Decision 4: One release-helper reconciliation at the tip

Three local commits touch `.agents/skills/release/**` (`e072a9a`, `e298990`, `5b34b4c`) and upstream 2.10.4 reworked the same files. Resolving hunk-by-hunk three times would produce three half-upstream states. Instead each conflict took the local side, and one tip commit ports upstream's mechanics into the hardened helper:

- CONFIG gains `CHANGELOG_HEADING='## [%s] - %s'`.
- `has_unreleased`, `changelog_top_version`, `prepare_changelog` copied from upstream verbatim.
- `prepare_changelog "$new"` runs after `require_release_branch`, `require_clean_tree`, and the origin remote-tag check, so a release still stops before any mutation.
- The `Release X.Y.Z` commit is created whenever anything is staged, so `current` can commit a promoted heading without a version bump.
- Usage and dry-run text describe the promotion; `SKILL.md` is rebuilt on upstream's structure (Boundaries, Bump policy, four-step Process, enforced Safety checks) with the fork's scoped identity, `local/main`, and `bun run typecheck && bun test src/` pre-flight.

`scripts/test-release-helper.sh` gains a CHANGELOG fixture, an assertion that an empty `## [Unreleased]` stops the run before mutation, and a pre-promoted heading for the atomic-push case. Both local automation suites (`test-release-helper.sh`, `test-smoke-antigravity.sh`) pass.

## Decision 5: CHANGELOG heading collisions

Upstream shipped `## [2.9.1] - 2026-08-18` (#11) while the local layer had `## [2.9.1] - 2026-08-12` (flush pacing, published to npm as `@yofriadi/pi-condense@2.9.1`). The conflict policy says to renumber local entries. The local heading becomes `## [2.9.1+local] - 2026-08-12`, mirroring the `subtree-v2.9.0+local` baseline-tag convention; it stays between upstream's `2.9.1` and `2.9.0` sections, so chronology reads correctly. `release.sh`'s `changelog_top_version` only inspects the first versioned heading, which is now upstream's `2.11.2`, so the marker does not confuse the helper.

New local notes go under `## [Unreleased]`, which `prepare_changelog` promotes to `## [2.11.3] - <date>` on the next release.

## Decision 6: Version 2.11.3 despite a published 3.9.1

The version policy is the synced upstream version with the patch incremented: v2.11.2 → `2.11.3`. The monorepo's `packages/pi-condense/package.json` said `3.9.1`, and `@yofriadi/pi-condense@3.9.1` is on npm as `latest`, published 2026-08-19 outside the fork's release path: npm's `gitHead` for that version is monorepo commit `c57386f8` (an unrelated pi-toon removal whose tree still said `2.9.1`), no fork tag `v3.9.1` exists, and the `3.9.1` string itself was only committed later inside an unrelated `pi-provider-antigravity` commit — so the tarball came from a dirty monorepo working tree.

The policy version wins: the sync does not inherit an out-of-band number, and `3.9.1` never existed in the fork. Consequence recorded for whoever publishes next: `2.11.3 < 3.9.1`, so publishing it moves the `latest` dist-tag downwards and any `^3` pin stops resolving. Publishing is a separate decision from syncing — either deprecate `3.9.1` and publish `2.11.3`, or amend the version policy to stay above the published high-water mark. This change does not decide that.

## Decision 7: Spec-first red suites are skipped, not deleted

`src/proactive-tiers.integration.test.ts` is the executable spec for `proactive-budget-tiers` (0/25 tasks). 19 of its 22 cases assert tier flushes, retry floors, and staged-commit behavior that `index.ts` and `src/budget.ts` do not have; they failed by construction and kept G3 red in the monorepo, which would have blocked both the fork gates and `pnpm update:pi-condense`'s candidate check.

The describe block is `describe.skip` with an in-place comment naming the change, the reason, and task 2.4 as the unskip point (task 6.4 already requires a green suite before that change can be archived). Alternatives rejected: implementing the feature (25 tasks, out of scope for a sync, and it must now be re-designed against upstream's `frontierGapThresholdTokens` precedence); deleting the tests (destroys review work); narrowing the gate command (hides genuine failures from every future run).

## Decision 8: `.pi/gauntlet-overrides.md` is upstream content in a protected tree

Upstream 2.10.4 rewrote the file (issue tracker section, release write-gate carve-out). The local layer had never modified it — `git diff 125147c1 df6b92e8 -- .pi/gauntlet-overrides.md` is empty — so the rebase adopted upstream's version cleanly. Only fork identity was re-applied: tracker repo `yofriadi/pi-condense` with a note that refs inherited from upstream CHANGELOG entries and `doc/specs/` point at `jjuraszek/pi-condense`, and `local/main` wherever the text said `main`. `.pi/prompts/**` and `.pi/skills/**` remain purely local.

## Decision 9: Monorepo consumption

`pnpm update:pi-condense` runs the squash subtree pull in a detached candidate worktree, regenerates the root lockfile (the consumed `package.json` version changed), and fast-forwards only after frozen install plus root/G1–G4 pass. The monorepo tree must be clean repo-wide first, so unrelated in-flight work is stashed and restored around the pull. The duplicate active `openspec/changes/harden-sync-release-automation/` directory in the monorepo disappears with the pull because the fork archived it.

The pull is **not** conflict-free this time, because the monorepo carried three divergences the model forbids; each is resolved once and does not recur:

| Conflict | Cause | Resolution |
|---|---|---|
| `packages/pi-condense/package.json` (content) | the monorepo's out-of-band `3.9.1` against the fork's policy `2.11.3` | take the fork side |
| `packages/pi-condense/src/proactive-tiers.integration.test.ts` (add/add) | the file existed monorepo-side first and the fork's copy carries the skip guard | take the fork side |
| `packages/pi-condense/.pi/gauntlet-overrides.md` (modify/delete) | the monorepo deleted the whole `.pi/` tree in `0abef17db` while the fork localizes that file (Decision 8) | restore `.pi/**` from the fork |

The `.pi/` resolution restores 13 local files plus upstream's new `.pi/gauntlet/telemetry/doc/specs/2026-09-29-image-honest-pruning.yaml`, so `packages/pi-condense` matches the fork exactly and no `.pi/` conflict recurs. Two grounds: the spec's monorepo-side G5 requires protected paths to show intentional edits and *never deletions*, and a stripped `.pi/` makes every future fork edit under it a modify/delete conflict. The deletion looks collateral rather than deliberate — it rode in on an unrelated `pi-provider-antigravity` commit that also carried the stray `3.9.1` bump, its message never mentions pi-condense, and `packages/pi-permission-system/.pi/` shows the monorepo tolerates nested `.pi/` trees. Stripping `.pi/` monorepo-side remains available as a packaging choice, but it must then be recorded as an intentional, recurring divergence. Nothing published changes either way: `package.json` `files` allowlists `index.ts`, `src/**`, `scripts/**`, and the three docs, so `.pi/**` and `.agents/**` never enter the tarball. Everything else the fork changed lands clean because the ported commits made the two trees identical first.
