## 1. Fork release and CI hardening

- [x] 1.1 Restrict `release.sh propose` to the nearest reachable `vX.Y.Z` release tag and verify a `subtree-*` tag does not hide unreleased commits.
- [x] 1.2 Run `bun run typecheck` before tests in fork test CI, release CI, and the local release preflight; validate workflow YAML and helper behavior.
- [x] 1.3 Add a credential-gated isolated Antigravity smoke helper with actionable manual verification output; test its fail-closed input validation.

## 2. Fork sync contract

- [x] 2.1 Apply the release-automation and upstream-sync delta requirements to durable specs, document the smoke helper, and validate OpenSpec.
- [x] 2.2 Commit and push the fork hardening change on `local/main` after its package gates pass.

## 3. Monorepo consumer and reproducibility

- [ ] 3.1 Replace the direct-upstream `update:pi-condense` wrapper with a guarded `pi-condense-fork local/main --squash` consumer that runs post-pull G1–G4.
- [ ] 3.2 Regenerate `pnpm-lock.yaml` from a clean isolated monorepo worktree; review every changed importer against committed manifests and verify frozen installation/type checking.
- [ ] 3.3 Pull the committed fork hardening change through the guarded subtree flow without direct package edits, validate exact fork-tree identity, and commit/push the monorepo consumer and lockfile changes.

## 4. Authenticated live verification

- [x] 4.1 Authenticated smoke passed on 2026-08-18 with `google-antigravity/gemini-3.7-flash`: session artifact `/var/folders/1p/43y8tds156zgqt2l95sz36t40000gn/T/pi-condense-antigravity-smoke.yLkX1U/sessions/2026-08-18T11-16-05-275Z_01a01495-ee1b-7951-8781-a7699b5af486.jsonl` contains 3 `context-prune-summary` entries and one `context-prune-flush-metrics` entry (`message-end`/`summarized`); no fallback warning occurred. Copied credentials were removed before artifact retention.
