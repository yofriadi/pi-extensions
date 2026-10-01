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
- [x] 5.2 Squash subtree pull from `pi-condense-fork/local/main` in a detached candidate worktree, resolving the three one-time monorepo divergences (see design Decision 9), then root lockfile regeneration, frozen install, G1–G4 from `packages/pi-condense`, root `pnpm run check`, and the caller fast-forward (`pnpm update:pi-condense` stops at conflicts by design, so the candidate flow was driven by hand) from `pi-condense-fork/local/main` in a detached candidate, root lockfile regenerated for the consumed manifest change, frozen install, G1–G4 from `packages/pi-condense`, root `pnpm run check`, then fast-forward
- [x] 5.3 Monorepo-side G5: protected paths present with local content, no upstream reverts; `.pi/` stays deleted monorepo-side; the duplicate active automation change directory is gone
- [x] 5.4 Restore the stashed unrelated work and verify it came back intact
- [x] 5.5 Tag the fork `subtree-v2.11.2+local` at the consumed tip

## 6. Gates reference

- G0 clean tree (monorepo, pre-subtree-op): `git diff-index HEAD` and `git diff-index --cached HEAD` both empty repo-wide
- G1 grep: no import from `@earendil-works/pi-ai/compat` and no `reasoningEffort:` property assignment under `src/` or `index.ts`; the `not.toHaveProperty("reasoningEffort")` assertion is allowed
- G2 targeted: `bun test src/summarizer.test.ts src/summarizer-wiring.test.ts`
- G3 complete suite: `bun test`
- G4 typecheck: `bun run typecheck` (package-owned TypeScript 7.0.2, `tsconfig.json`, `index.ts` graph)
- G5 protected-path audit (fork side): every path in `git diff --name-only upstream/main HEAD` is either an upstream file the local layer legitimately edits or a purely local path; purely local protected paths exist with local content; scoped identity, branch-qualified image URL, release-script constants, and `local/main` are exact
- G6 completeness: the local-layer diff against the new base contains every ported local path, and every excess path belongs to the named sync-introduced allowlist
- Local automation suites: `bash scripts/test-release-helper.sh`, `bash scripts/test-smoke-antigravity.sh`

## 7. Out of scope

Implementing `proactive-budget-tiers` (0/25) or `summarizer-fallback-model` (0/21); archiving `add-summary-context-wrapper` (implemented, tasks complete, left active for its own close-out); deciding the npm `3.9.1` high-water-mark question in Decision 6; monorepo files outside `packages/pi-condense`; upstream's stale unmerged branch `demote-oversized-skip-to-info`; contributing anything back upstream.
