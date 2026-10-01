# Tasks: sync-upstream-2-11-2

## 1. Phase 0 — port the monorepo-only local work into the fork

- [x] 1.1 Re-clone the fork to `~/Developer/oss/pi-condense` (the previous clone was gone); remotes `origin` → `yofriadi/pi-condense`, `upstream` → `jjuraszek/pi-condense`; `git fetch upstream --tags`; `bun install`
- [x] 1.2 Baseline the fork tip: `bun run typecheck` clean, `bun test` 507 pass / 0 fail
- [x] 1.3 Enumerate the monorepo-only divergence: `git log 116c5d357..HEAD -- packages/pi-condense` plus a tree/hash comparison of `pi-condense-fork/local/main` against `HEAD:packages/pi-condense`
- [x] 1.4 Port `0abef17d`'s `openspec/changes/proactive-budget-tiers/**` subset (`git format-patch -1 <sha> -- <path>` → `git apply -3 -p3`); do NOT port its `.pi/` deletion or its `3.9.1` version bump
- [x] 1.5 Port `36413a9a` (summary-context wrapper) with `git am -p3`
- [x] 1.6 Port `e4d91053` (proactive-tiers integration suite + archived automation record) with `git am -p3`, then complete the archive move by removing the duplicate active `openspec/changes/harden-sync-release-automation/`
- [x] 1.7 Skip-guard the 19 red spec-first cases (`describe.skip` + in-place note naming task 2.4 as the unskip point); fork suite green: 531 pass / 22 skip / 0 fail
- [x] 1.8 Verify the port: fork tree vs monorepo tree differs only by `.pi/` (fork keeps it), the archived duplicate, `package.json` version, and the skip guard

## 2. Phase 1 — rebase onto upstream v2.11.2

- [x] 2.1 Tag the pre-rebase tip `backup/pre-upstream-2.11.2`; rebase on a scratch branch `sync/2.11.2` so `local/main` stays intact until the gates pass
- [x] 2.2 `git rebase upstream/main` (19 local commits onto `04a64d2`, past the `v2.11.2` tag)
- [x] 2.3 Resolve `cc83269` (pacing): `src/config.test.ts` union
- [x] 2.4 Resolve `d4039c6` (dispatch): `src/summarizer.test.ts` local imports + upstream's image-marker prompt test ported to the `getProvider().streamSimple` harness; `src/reload-rearm.integration.test.ts` import union minus the compat mock
- [x] 2.5 Resolve `1c45b7d` (identity): `package.json` (local identity, version `2.11.3`), `README.md` row union, `CHANGELOG.md` (upstream sections verbatim, local section renumbered to `## [2.9.1+local] - 2026-08-12`, `## [Unreleased]` on top), `AGENTS.md`/`AGENTS.core.md` kept deleted, release skill files taken local
- [x] 2.6 Resolve `b5db8bc`: move the v2.9.0 sync narrative out of `## [Unreleased]` into the `2.9.1+local` section
- [x] 2.7 Resolve `e072a9a` and the remaining release-automation commits by taking the local side; reconcile once at the tip
- [x] 2.8 Mid-rebase gates after the dispatch commit: G1 clean, G4 clean, G2 19 pass, `src/reload-rearm.integration.test.ts` 41 pass including upstream's new `#16` and supersede-floor suites

## 3. Phase 2 — tip reconciliation

- [x] 3.1 Port upstream's CHANGELOG-promotion mechanics into `.agents/skills/release/scripts/release.sh` (`CHANGELOG_HEADING`, `has_unreleased`, `changelog_top_version`, `prepare_changelog`, conditional `Release X.Y.Z` commit, usage/dry-run text); `bash -n` clean
- [x] 3.2 Rebuild `.agents/skills/release/SKILL.md` on upstream's structure with fork identity, `local/main`, and the typecheck pre-flight
- [x] 3.3 Extend `scripts/test-release-helper.sh` for the CHANGELOG gate; both automation suites pass (`test-release-helper.sh`, `test-smoke-antigravity.sh`)
- [x] 3.4 Re-apply fork identity to upstream's rewritten `.pi/gauntlet-overrides.md` (tracker repo, ref provenance note, `local/main`)
- [x] 3.5 Audit the auto-merged wrapper surface: every line the wrapper commit added exists at the tip; the removed indexer helper stays removed; `index.ts` wrap point sits on upstream's `summaryText` construction so custom-message content, `appendSummaryMessage`, `registerSummaryBody`, and the oversized-skip decision all see wrapped text; `wrappedSummaryLens` still feeds the skip notification

## 4. Phase 3 — fork close-out

- [x] 4.1 CHANGELOG `## [Unreleased]` sync entry (synced to v2.11.2, adopted behavior changes, reconciliations, version note, active-change status)
- [x] 4.2 This change's `specs/upstream-sync/spec.md` delta synced into `openspec/specs/upstream-sync/spec.md`
- [x] 4.3 `openspec validate --all` clean
- [x] 4.4 Full gates at the tip: G1 (no `pi-ai/compat`, no `reasoningEffort:` assignment), G2 targeted summarizer tests, G3 complete suite, G4 `bun run typecheck`, G5 protected-surface and identity audit, G6 local-layer completeness
- [x] 4.5 `openspec archive sync-upstream-2-11-2`
- [x] 4.6 Move `sync/2.11.2` onto `local/main`; push `backup/pre-upstream-2.11.2`, then `git push --force-with-lease origin local/main`
- [ ] 4.7 Authenticated real-session Antigravity smoke — **pending**; requires an operator-recorded sanitized durable report (model, restrictive tool policy, summary count, flush outcome, warning scan, credential cleanup). Mock, static, and CI gates are not a substitute

## 5. Phase 4 — monorepo consumption (runs after the fork push)

- [x] 5.1 Stash unrelated in-flight monorepo work so the tree is clean repo-wide (G0)
- [x] 5.2 Squash subtree pull from `pi-condense-fork/local/main` in a detached candidate worktree (`pnpm update:pi-condense` stops at conflicts by design, so the same flow was driven by hand), resolving the three one-time monorepo divergences per design Decision 9, then frozen install, G1–G4 from `packages/pi-condense`, root `pnpm run check`, and the caller fast-forward
- [x] 5.3 Monorepo-side G5: `packages/pi-condense` verified byte-identical to fork `local/main` (177 files, per-file hashes), `.pi/**` restored, the duplicate active automation change directory gone, and no change outside `packages/pi-condense`. The lockfile regeneration the script would have committed was dropped: its only delta was deleting the `pi-cc-ui` and `pi-provider-cline` importers, which are in the committed lockfile but still untracked at HEAD, and the pi-condense importer block is unchanged by a version bump
- [x] 5.4 Restore the stashed unrelated work and verify it came back intact
- [x] 5.5 Tag the fork `subtree-v2.11.2+local` at the consumed tip

## 6. Phase 5 — adversarial review (code-reviewer agent)

- [x] 6.1 Round 1 over the fork rebase, the reconciliation commits, and the monorepo merge: verdict *request changes* — one Required (this record misstated the `.pi/**` resolution in proposal Impact, design Decisions 1 and 9, and task 5.3), one Optional (the block-level `describe.skip` also silenced the 3 cases that pass), one Nit (task 5.2 text stitched twice). Every code area it attacked came back clean: wrapper/wrapped-text consistency at all construction, storage, fusion, render, hash, dedup, and metric sites; no upstream hunk lost in the auto-merged files; release-helper ordering and atomicity; both harness ports; the CHANGELOG restructure
- [x] 6.2 Correct the record (proposal Impact, design Decisions 1, 6, 9, tasks 5.2/5.3), citing npm's `gitHead` metadata for the `3.9.1` attribution instead of implying commit `c57386f8` published it
- [x] 6.3 Move the 3 green cases into an unskipped `describe("proactive budget tiers — behavior that already holds")` with a note on which of them are vacuous until task 2.4; the red block stays `describe.skip`, so the Sync-gates requirement is met unchanged and the suite is 689 pass / 19 skip / 0 fail
- [ ] 6.4 Round 2 re-review of the remediation

## 7. Gates reference

- G0 clean tree (monorepo, pre-subtree-op): `git diff-index HEAD` and `git diff-index --cached HEAD` both empty repo-wide
- G1 grep: no import from `@earendil-works/pi-ai/compat` and no `reasoningEffort:` property assignment under `src/` or `index.ts`; the `not.toHaveProperty("reasoningEffort")` assertion is allowed
- G2 targeted: `bun test src/summarizer.test.ts src/summarizer-wiring.test.ts`
- G3 complete suite: `bun test`
- G4 typecheck: `bun run typecheck` (package-owned TypeScript 7.0.2, `tsconfig.json`, `index.ts` graph)
- G5 protected-path audit (fork side): every path in `git diff --name-only upstream/main HEAD` is either an upstream file the local layer legitimately edits or a purely local path; purely local protected paths exist with local content; scoped identity, branch-qualified image URL, release-script constants, and `local/main` are exact
- G6 completeness: the local-layer diff against the new base contains every ported local path, and every excess path belongs to the named sync-introduced allowlist
- Local automation suites: `bash scripts/test-release-helper.sh`, `bash scripts/test-smoke-antigravity.sh`

## 8. Out of scope

Implementing `proactive-budget-tiers` (0/25) or `summarizer-fallback-model` (0/21); archiving `add-summary-context-wrapper` (implemented, tasks complete, left active for its own close-out); deciding the npm `3.9.1` high-water-mark question in Decision 6; monorepo files outside `packages/pi-condense`; upstream's stale unmerged branch `demote-oversized-skip-to-info`; contributing anything back upstream.
