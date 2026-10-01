## 1. Fork release and CI hardening

- [x] 1.1 Restrict `release.sh propose` to the nearest reachable `vX.Y.Z` release tag and verify a `subtree-*` tag does not hide unreleased commits.
- [x] 1.2 Run `bun run typecheck` before tests in fork test CI, release CI, and the local release preflight; validate workflow YAML and helper behavior.
- [x] 1.3 Add a credential-gated isolated Antigravity smoke helper with actionable manual verification output; test its fail-closed input validation.

## 2. Fork sync contract

- [x] 2.1 Apply the release-automation and upstream-sync delta requirements to durable specs, document the smoke helper, and validate OpenSpec.
- [x] 2.2 Commit and push the fork hardening change on `local/main` after its package gates pass.

## 3. Monorepo consumer and reproducibility

- [x] 3.1 Replace the direct-upstream `update:pi-condense` wrapper with a guarded `pi-condense-fork local/main --squash` consumer that runs post-pull G1–G4.
- [x] 3.2 Regenerate `pnpm-lock.yaml` from a clean isolated monorepo worktree; reviewed the pi-condense, pi-mlflow, and pi-subagent-herdr importer reconciliation against committed manifests; frozen install and package typecheck passed in the clean worktree.
- [x] 3.3 Pull the committed fork hardening change through the guarded subtree flow without direct package edits, validate exact fork-tree identity, and commit/push the monorepo consumer and lockfile changes.

## 4. Authenticated live verification

- [x] 4.1 Passed 2026-08-18 with the no-input deterministic payload tool (no approval or built-in shell); sanitized model/configuration, summary count, flush outcome, warning scan, and credential-cleanup facts are in `doc/validation/2026-08-18-antigravity-smoke.md`.

## 5. Adversarial review remediation

- [x] 5.1 Pin Bun, commit `bun.lock`, use `bun install --frozen-lockfile` in fork test/release CI, and validate the lock-backed package checks.
- [x] 5.2 Enforce plain release versions, remote tag absence, and atomic branch/tag pushes; keep OIDC out of the first provenance-validation job and protect `v*` tag creation.
- [x] 5.3 Run smoke-helper regression coverage in all fork workflows and verify failed live runs retain artifacts without copied credentials.
- [x] 5.4 Make `pnpm update:pi-condense` transactionally validate a candidate fork pull, lock refresh/frozen install, and G1–G4 before advancing the caller branch; root CI targets `master` with pinned Bun. The no-op and secure-fork update paths both passed without leaving a failed candidate on the caller branch.
