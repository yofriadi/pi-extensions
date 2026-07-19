---
issue: 270
issue_title: "Make @gotgenes/pi-subagents type-consumable by sibling workspace packages"
---

# Retro: #270 — Make @gotgenes/pi-subagents type-consumable by sibling workspace packages

## Stage: Planning (2026-05-29T00:00:00Z)

### Session summary

Diagnosed the consumability failure empirically with `tsc --traceResolution` and planned a `.d.ts`-emit fix.
The plan adds a `rollup-plugin-dts` build that bundles `src/service/service.ts` into a self-contained `dist/public.d.ts`, wires conditional `exports` (`types` → the bundle, `default` → the real source), generates the artifact at `prepack` time, ships it via a `files` allowlist, and proves external consumability with a `pnpm pack` → throwaway-consumer → `tsc` harness.

### Observations

- Root cause is two compounding failures: the stale `exports["."]` path (`./src/service.ts` does not exist) and, once fixed, an unresolvable `#src/*` cascade.
  The trace showed the consumer's own `paths` (`#src/*` → `./src/*`) intercept first (both packages define `#src/*`), and the publisher's `imports`-field fallback cannot resolve the extensionless `.ts` target.
- The public type closure is entangled: `WorkspaceProvider` → `AgentStatus` (in the 510-LOC `agent.ts`) → `types.ts` (which re-exports the `Agent` class).
  This made the alias-free-entry alternative (Option 2) a substantial source restructure, so it was rejected.
- Decisions taken via `ask_user`:
  1. Approach — emit a bundled `.d.ts` (the repo's first build step), over alias-free restructure or type re-declaration.
  2. Bundler — `rollup-plugin-dts` (purpose-built for flattening declarations; no JS bundle, which suits ship-source), over `tsdown`/`api-extractor`.
  3. Artifact — not committed; generated at `prepack` and shipped in the tarball, consumed via the package interface.
  4. Scope — tight: packaging + a `pnpm pack`-based verification harness in #270; defer the `pi-subagents-worktrees` registry-consumption flip (drop `workspace:*`, `link-workspace-packages: false`, wire the real import) to #263.
- Scope was deliberately narrowed after a chicken-and-egg surfaced: the registry version carrying the fix does not exist until #270 publishes, so the meaningful consumer flip belongs to #263.
- Sequencing constraint for #263 (captured in the plan): publish #270 first — merge its release-please PR so `pi-subagents` publishes — *before* resuming #263, otherwise #263's `pi-subagents` core edits batch into the same release.
  The current `#263` scaffold commits on `main` touch only the unregistered `pi-subagents-worktrees` component, so they do not batch into `pi-subagents` and #270 ships cleanly.
- Primary feasibility risk flagged: whether `rollup-plugin-dts` resolves `#src/*` while rolling up the type graph.
  Build Step 1 is the explicit checkpoint (emit + assert the output is alias-free and exports the expected symbols).
- `dist/` is gitignored and already excluded by eslint/biome; the new wrinkle is that a `files` allowlist is required so the gitignored `dist/public.d.ts` is included in the npm tarball — validate `pnpm pack --dry-run` parity so no currently-shipped file is dropped.

## Stage: Implementation — Build (2026-05-29T00:00:00Z)

### Session summary

Executed all four build-order steps: added `rollup` + `rollup-plugin-dts` and a `build:types` script that bundles `src/service/service.ts` into a self-contained `dist/public.d.ts`; wired conditional `exports` (`types` + `default`, fixing the stale path) with a `prepack` hook and a `files` allowlist; added a `pnpm pack` → throwaway-consumer → `tsc` verification harness (`scripts/verify-public-types.sh`) plus a CI step; and recorded [ADR-0003].
A fifth commit documented the new build step in the `package-pi-subagents` skill (reviewer WARN).
Root `pnpm run check`, root `pnpm run lint`, and `verify:public-types` all pass.

### Observations

- The primary feasibility risk (`rollup-plugin-dts` resolving `#src/*`) resolved cleanly out of the box: driving it with the package `tsconfig` (which carries the `#src/*` paths) produced a 178-line `dist/public.d.ts` with zero `#src/` residue and only `ThinkingLevel` kept external from `@earendil-works/pi-ai`.
  No alias/path resolver plugin was needed.
- Harness deviation (fixed in the same step): `pnpm add` in the isolated (`--ignore-workspace`) throwaway consumer exited non-zero with `ERR_PNPM_IGNORED_BUILDS` because it does not inherit the workspace `allowBuilds` approvals (`@google/genai`, `protobufjs`).
  Fixed by adding `--ignore-scripts` — a type-check needs no dependency build scripts.
  Worth remembering for any future packaged-consumer harness.
- A subtle gotcha while debugging: `pnpm ... | tail; echo $?` reports `tail`'s exit, not pnpm's, which masked the real failure.
  Use `set -o pipefail` or check the command directly.
- `files` allowlist parity was validated with a before/after `pnpm pack --dry-run` diff: nothing dropped, only `dist/public.d.ts` added.
  The allowlist reproduces the current contents (`src`, `docs`, `vitest.config.ts`, `AGENTS.md`, `CHANGELOG.md`, `.prettierignore`) plus `dist`.
  Did not take the opportunity to slim the tarball (docs/test-config still ship) — that would be a separate deliberate change.
- Runtime `default` → `./src/service/service.ts` is safe because that module's only internal imports are `import type`, which erase; no runtime `#src/*` resolution occurs.
- No `src/`/`test/` `.ts` files were touched, so the vitest suite and `tsc` were unaffected (confirmed via root check).
- Pre-completion reviewer: WARN — no findings attributable to this session.
  Reviewer warnings: (1) the `package-pi-subagents` skill lacked a build-step note — addressed in commit `2ff5a375`; (2) `pnpm fallow dead-code` exits non-zero on a pre-existing finding in `packages/pi-subagents-worktrees/package.json` from the #263 scaffold (commit `9a7dcfc5`), out of scope for #270 and left for #263.

## Stage: Final Retrospective (2026-05-29T21:00:00Z)

### Session summary

Shipped #270 end-to-end across planning, build, and ship stages: diagnosed the cross-package type-resolution failure empirically, built a `rollup-plugin-dts` declaration bundle plus a pack-based verification harness, and published `@gotgenes/pi-subagents@11.6.0` (tag `pi-subagents-v11.6.0`).
Two CI failures during the ship stage — a pre-existing `pnpm fallow dead-code` gate and lockfile drift — required two extra fix commits before CI went green.

### Observations

#### What went well

- Empirical-first diagnosis: `tsc --traceResolution` in planning pinned the exact two-part failure (consumer `paths` collision + the publisher's `imports`-field extensionless-`.ts` miss) and directly justified the chosen `.d.ts`-emit approach over the alias-free restructure.
- The flagged primary risk evaporated: `rollup-plugin-dts` resolved `#src/*` out of the box via the package `tsconfig` paths, producing a clean 178-line `dist/public.d.ts` with no resolver plugin.
- Novel, reusable pattern: `scripts/verify-public-types.sh` proves a ship-source package is externally type-consumable via `pnpm pack` → throwaway-consumer → `tsc`, with no publish round-trip.
  Worth promoting if other packages grow public surfaces.
- Disciplined `ask_user` use on the genuinely ambiguous decisions (approach, bundler, artifact handling, scope), with strong user steering — the `tsup`-is-unmaintained redirect to `rollup-plugin-dts`, the "no workspace trickery / use released versions" directive, and the #263 chicken-and-egg catch that correctly narrowed scope.

#### What caused friction (agent side)

- `missing-context` — Pushed to `main` with a pre-existing `pnpm fallow dead-code` failure (unused `@earendil-works/pi-coding-agent` devDependency in `packages/pi-subagents-worktrees/package.json`, from the #263 scaffold).
  The pre-completion reviewer reported it as `FAIL` but labelled it out-of-scope, and I accepted that framing and pushed.
  The CI `Fallow dead-code gate` runs `if: github.ref == 'refs/heads/main'` — a hard gate that fires on every `main` push regardless of who introduced the failure — so CI failed (run `26659647270`).
  Impact: 2 fix commits (`7e7afadd`, `10e74f2f`) and 2 extra CI cycles (~10 min).
  The ship pre-push step runs only `pnpm run lint`, never `pnpm fallow dead-code`.
- `missing-context` — Removed the devDependency and committed/pushed `package.json` (`7e7afadd`) without the updated `pnpm-lock.yaml`.
  CI's `pnpm install --frozen-lockfile` failed with `ERR_PNPM_OUTDATED_LOCKFILE` (run `26659851716`).
  Impact: 1 extra commit (`10e74f2f`) and 1 extra CI cycle.
  Self-identified from the CI log.
- `rabbit-hole` (minor) — While debugging the harness's `ERR_PNPM_IGNORED_BUILDS`, the `pnpm ... | tail; echo $?` idiom reported `tail`'s exit code, masking pnpm's real failure; took ~4 tool calls before tracing with `bash -x`.
  Impact: added friction, no rework.

#### What caused friction (user side)

- The "pi-subagents-* extensions should use the released, npm-installed version, no workspace trickery" directive arrived mid-planning, after initial exploration.
  Surfacing the consumption-model constraint at kickoff would have framed the scope question earlier.
  Opportunity, not criticism — the same exchange produced the high-value chicken-and-egg catch (the registry version with the fix cannot exist until #270 publishes) that correctly deferred the worktrees flip to #263.
- A brief "there is no [ADR-0003]" → "My mistake" exchange; no rework.

### Diagnostic details

- Model-performance correlation — the lone subagent dispatch (`pre-completion-reviewer`) ran on `anthropic/claude-sonnet-4-6`, appropriate for judgment-heavy review.
  The dead-code-gate framing miss was a protocol-scope issue (pre-existing vs blocking), not a model-capability mismatch.
- Escalation-delay — no error sequence exceeded 5 consecutive tool calls; the harness `ERR_PNPM_IGNORED_BUILDS` resolved in ~4.
- Feedback-loop gap — build-stage verification ran incrementally after each step (good); the gap was at ship: the pre-push check omits the `main`-only gates (`pnpm fallow dead-code`) and lockfile validation that CI enforces, so a locally-clean `pnpm run lint` still failed CI twice.

### Changes made

1. `.pi/prompts/ship-issue.md` — renamed Step 2 to "Pre-push checks" and added `pnpm fallow dead-code` alongside `pnpm run lint`, with a one-line note that the gate is `main`-only and blocks pushes regardless of who introduced the failure.
2. `AGENTS.md` (§ Code Style pnpm rules) — added a rule to run `pnpm install` and commit the updated `pnpm-lock.yaml` in the same commit when a `package.json` dependency changes, since CI installs with `--frozen-lockfile`.

[ADR-0003]: ../decisions/0003-publish-bundled-type-declarations.md
