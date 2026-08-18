# Proposal: sync-upstream-2-9-0

## Why

The pi-condense subtree in this monorepo is based on upstream `jjuraszek/pi-condense` at `1d040e68` (v2.5.0, synced 2026-08-09). Upstream has since advanced to `125147c1` (v2.9.0, 14 commits, 53 files) carrying real fixes we want:

- tool-call id collision fixes: positional chain drops, occurrence identity, orphan sweep (ref #8)
- single-chain observability + reload-stranded flush trigger repair (issue #6)
- budget-trigger window capped at 300k
- deterministic compression of uncovered chains with recoverability backfill (fixes #10)
- `pi-ai/compat` mock hygiene in tests

Local changes (flush pacing — implemented and shipped; Antigravity host-registry dispatch — implemented and guarded by `ANTIGRAVITY.md`; openspec scaffolding; package identity) currently exist only as a squashed delta inside the monorepo subtree. The third local change, `summarizer-fallback-model`, is **spec'd but unimplemented** (0/21 tasks done; `src/summarizer-fallback.ts` is still upstream's single-boolean controller, no `summarizerFallback*` config keys exist). Every direct `git subtree pull` re-fights the same textual conflicts — and one such merge already reintroduced the `pi-ai/compat` dispatch regression documented in `ANTIGRAVITY.md`. Unstructured subtree merging of a large local delta does not scale and is unsafe for the protected surfaces.

The former G4 command also relies on an ad-hoc compiler invocation. Current TypeScript discovers the parent monorepo `tsconfig.json` when it is passed `index.ts` directly and stops with TS5112 before checking source. The local layer therefore needs a package-local project configuration and package-owned current TypeScript tooling that work in the standalone fork.

## What Changes

1. **Adopt the layered-fork model.** Local pi-condense changes move to a dedicated branch (`local/main`) in a standalone fork clone of `jjuraszek/pi-condense`, expressed as clean commits layered on top of upstream `main`. Syncing upstream becomes `git rebase upstream/main` in the fork; routine monorepo pulls from the fork branch are then conflict-free by construction (the first pull is a re-baseline with a known conflict set — see design Decision 2c).
2. **Sync to v2.9.0.** Rebase the local layer from base `1d040e68` onto `125147c1`, resolving the overlap (10 files: `AGENTS.md`, `AGENTS.core.md`, `CHANGELOG.md`, `PRUNING.md`, `README.md`, `doc/configuration.md`, `package.json`, `src/commands.ts`, `src/types.ts`, `src/summarizer-wiring.test.ts`) under an explicit conflict policy.
3. **Codify durable sync invariants** (protected local surfaces, ANTIGRAVITY regression gates, verification gates, version policy) as the `upstream-sync` capability so every future sync follows the same contract.
4. **Consume the synced tree in the monorepo** via `git subtree pull` from the fork's `local/main`.
5. **Make typechecking standalone and current.** Add a package-local `tsconfig.json` scoped to the `index.ts` source graph, declare current TypeScript 7.0.2 and Node 22 type definitions in package development dependencies, and run G4 in project mode so neither the monorepo parent config nor a globally installed compiler affects the fork.

## Capabilities

### New Capabilities

- `upstream-sync`: invariants and procedure for tracking `jjuraszek/pi-condense` upstream while preserving the local layer — history shape, protected files, conflict policy, regression gates, subtree consumption, and version policy.

### Modified Capabilities

None. `summarizer-pacing` behavior is unchanged by this sync (upstream did not touch `src/summarizer.ts`, `src/summarizer-fallback.ts`, or `src/summarizer-pacing.ts` in `1d040e68..125147c1`); `summarizer-fallback` remains a spec-only active change, untouched by the sync.

## Impact

- **New artifacts**: fork branch `local/main` (standalone clone of `jjuraszek/pi-condense`, consumed by the monorepo via remote `pi-condense-fork`); openspec change `sync-upstream-2-9-0` (this change).
- **Monorepo**: `packages/pi-condense/**` updated to upstream v2.9.0 + local layer via subtree merge commit; no other packages touched.
- **Protected local surfaces** (must survive byte-intent, not just line-survive): the `src/summarizer.ts`/`src/summarizer-wiring.test.ts` dispatch invariants (host `ctx.modelRegistry.getProvider().streamSimple`, no `pi-ai/compat`, no `reasoningEffort`; invariant-based, not whole-file — see spec), `src/summarizer-pacing*`, `ANTIGRAVITY.md`, `tsconfig.json`, `.pi/`, `openspec/` (complete tree, including active changes), and package identity/typecheck fields.
- **Typechecking**: G4 uses package-owned TypeScript 7.0.2, Node 22 type definitions, and `tsconfig.json`; the unrelated root `pnpm-lock.yaml` stash remains outside this change.
- **Risk**: moderate — confined to the 10 overlapping files plus local tooling; all other upstream changes land untouched. Regression risk is mechanically detectable via the ANTIGRAVITY gates.
- **Alternative rejected**: continuing direct `git subtree pull` from upstream in the monorepo (keeps re-fighting conflicts with no layer isolation; already caused one regression).
