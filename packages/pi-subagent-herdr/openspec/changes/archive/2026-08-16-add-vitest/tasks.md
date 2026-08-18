# Tasks: add-vitest

## Context

Switch only the unit runner to Vitest via a local `node:test` shim.
Leave assertions, `c8`, and the serial integration suite unchanged.
The single allowed test edit is the module-isolation import mechanism in `test/runtime-safety.test.ts`.
Capture the `node --test` baseline BEFORE mutating anything, so parity comparisons remain possible.

## Tasks

- [x] 1.
      Capture baseline (before any mutation): record the `node --test` unit test count, and run `test:coverage` to snapshot `src/**` statement/branch/function totals from `coverage/coverage-final.json`.

  - Baseline captured before any mutation: `node --test` → **358 tests / 90 suites / 0 fail**.
  - `test:coverage` (node --test + c8) snapshot for `src/**` (23 files): **9665 statements (8385 covered) / 2311 branches (1898 covered) / 832 functions (649 covered)**; `src/index.ts` alone: 1114/970 stmts, 184/154 branches, 72/56 functions.
    Saved to `/tmp/add-vitest-wip/coverage-baseline.json` + `/tmp/add-vitest-wip/fn-baseline.json` for the parity gate.
- [x] 2.
      Add `vitest.config.ts`: include `test/test.ts` + `test/**/*.test.ts`; `exclude` = `[...configDefaults.exclude, "test/integration/**"]`; pin `testTimeout: 30_000` and `hookTimeout: 10_000`; set `sequence.hooks: "list"`; alias `node:test` via a top-level `resolve.alias` entry AND an `enforce: "pre"` `resolveId` plugin, both pointing at `test/alias.js`.
- [x] 3.
      Add `test/alias.js`: import `describe`/`it`/`beforeAll`/`afterAll`/`beforeEach`/`afterEach` from `vitest`; re-export `beforeAll as before`, `afterAll as after`, and the rest unchanged.
- [x] 4.
      Update `package.json`: `test` → `vitest run`; `test:coverage` → `c8 --reporter=json --report-dir=coverage vitest run && node scripts/normalize-istanbul-coverage.mjs`; leave `test:integration` on serial `node --test`; add exact-pinned `vitest` 4.1.9 to `devDependencies` and do NOT add `@vitest/ui`; remove `vitest.config.ts` and `test/alias.js` from `files`.
      Run `pnpm install` from the workspace root; do not commit an npm `package-lock.json`.
- [x] 5.
      Replace the two query-string cache-busting imports in `test/runtime-safety.test.ts` with `vi.resetModules()` + a plain `await import("../src/index.ts")`; keep every assertion untouched; fix the resulting indentation so `biome check .` passes.
- [x] 6.
      Coverage parity (merge gate): re-run `test:coverage`; confirm `nr fallow` exits 0 under the `istanbul` model and no `src/**` function that had baseline coverage loses it.
      Reconcile duplicate `src/index.ts` entries in `scripts/normalize-istanbul-coverage.mjs` (identical maps → sum counters; divergent maps → not reconcilable).
      If unreconcilable, apply the full-revert fallback (see design Risks).

  - Root cause found for the parity gap: Vite-transformed code executes with offsets that do not map onto the original sources, so `c8` misattributed coverage (114 covered functions appeared uncovered).
    Fix in `vitest.config.ts`: `server.deps.external: [/\/src\//]` (Node loads `src/**` natively, offsets align) + `pool: forks`, `poolOptions.forks.singleFork: true`, `isolate: false` (all test files share one fork so every dump is written/merged).
  - Result: statements 8385/8385 covered (exact parity), functions 649/649 covered (exact parity), zero statement/function regressions.
    Branches 2300 vs 2311 entries — the 11 missing entries are V8 block-coverage decomposition differences on identical code (verified spans), not lost coverage.
  - `nr fallow` exits 0 under the istanbul model with 814/2046 functions matched — identical match count to the baseline artifact.
    No duplicate `src/index.ts` entries appeared (single-fork + native loading produces one entry), so no normalizer reconciliation was needed; fallback not invoked.
- [x] 7.
      Update the `.fallow.toml` coverage comment to name Vitest as the wrapped runner; keep thresholds and the artifact path `coverage/coverage-final.json`.
- [x] 8.
      Verify: `vitest list` unit count matches the task-1 baseline; `npm test`; `npm run test:coverage`; `tsc --noEmit`; `biome check .`; `nr fallow`; `npm run test:integration`.

  - `vitest list` → 358 (= baseline); `npm test` → 358/358 pass; `test:coverage` → 358/358 + parity artifact; `tsc --noEmit` OK; `biome check .` OK; `nr fallow` exit 0.
  - `test:integration`: `mux-surface.test.ts` passes 8/8.
    `blocking-layout`, `configured-package`, and `subagent-lifecycle` time out spawning live pi panes — verified IDENTICAL timeouts on the untouched pre-change tree (stash round-trip), so this is an environment limitation, not a regression.
    The integration suite itself is byte-identical (no edits under `test/integration/`).
