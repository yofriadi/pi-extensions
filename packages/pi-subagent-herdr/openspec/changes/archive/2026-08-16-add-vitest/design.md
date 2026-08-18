# Design: add-vitest

## Context

`package.json` currently lists every unit file twice (`test` and `test:coverage`) and runs them with `node --test`.
`test:coverage` wraps that suite in `c8 --reporter=json --report-dir=coverage` and then `scripts/normalize-istanbul-coverage.mjs`.
Fallow reads `coverage/coverage-final.json`.
Integration tests stay serial because they drive a live Herdr.

## Goals / Non-Goals

**Goals:**

- Default unit runner is `vitest run` driven by a package-local `vitest.config.ts`.
- Existing `node:test` imports keep working via a shim; assertions stay `node:assert/strict`.
- Coverage stays `c8` + the existing normalizer so fallow still sees Istanbul JSON.
- Integration stays `node --test --test-concurrency=1 test/integration/*.test.ts`.

**Non-Goals:**

- Rewriting assertions to Vitest `expect`.
- Renaming `test/test.ts`.
- Replacing `c8` with `@vitest/coverage-v8`.
- Moving integration tests onto Vitest.
- Adding `test:watch`, `globals: true`, or `@vitest/ui`.

## Decisions

### D1: node:test shim and alias mechanism

Vitest has no `before`/`after` exports (the Mocha/Jest equivalents are `beforeAll`/`afterAll`).
`test/alias.js` therefore imports `describe`/`it`/`beforeAll`/`afterAll`/`beforeEach`/`afterEach` from `vitest` and re-exports `beforeAll as before`, `afterAll as after`, and the rest unchanged.
The alias is declared at the TOP LEVEL as `resolve.alias["node:test"] → <absolute path to test/alias.js>`; Vitest docs require `resolve.alias` at the top level, not inside `test`.
Because Vite can resolve `node:`-prefixed built-ins before user aliases run, an `enforce: "pre"` `resolveId` plugin returning the same shim for `id === "node:test"` is included as a deterministic fallback.
`exclude` is set as `[...configDefaults.exclude, "test/integration/**"]` so Vitest's default excludes are preserved.
Target versions: vitest 4.1.9 / vite 7.3.5.

Shim surface is sufficient: no unit test uses `node:test`'s `mock` API (the `mock.` references in `review-fixes.test.ts` are a local helper object).
The single test-context use, `t.skip(...)` in `permission-integration.test.ts`, works unchanged because Vitest's `TestContext` provides `skip()`.

### D2: Module-isolation imports

Two suites obtain a second, independently evaluated copy of `src/index.ts`.
Under `node --test` they use `await import("../src/index.ts?<token>")`; Vite does not re-evaluate a module for a `?query` suffix and fails with "does not provide an export named `__test__`".
The narrow fix is `vi.resetModules()` + a plain `await import("../src/index.ts")` at exactly those two sites; all assertions are untouched.
This is the only `vi` usage and the only test change.

The semantic difference is deliberate and verified, not assumed: `?query` re-evaluates only `src/index.ts` (static deps stay shared), whereas `vi.resetModules()` re-evaluates the whole module graph.
Not all shared state survives that — `src/state.ts` keeps `inflightDelivery` and `wakeInflightByParent` in module scope (intentionally not reload-persistent), so a `vi.resetModules()` copy gets its own.
The two tests still hold because their cross-copy coupling runs ONLY through `globalThis`-resident state: `RUNTIME_KEY` (→ `pendingDeliveries`/`deliveredRunIds`), `ACTIVE_COMPLETION_RUNTIME_KEY`, and the widget/status/delivery-retry interval keys.
`timerSnapshot()` reads those `globalThis` interval keys, which module re-evaluation does not clear.
The invariant the tests depend on is therefore: "the asserted state lives on `globalThis` under `Symbol.for` keys," NOT "all shared state is on `globalThis`."

### D3: Coverage

`test:coverage` = `c8 --reporter=json --report-dir=coverage vitest run && node scripts/normalize-istanbul-coverage.mjs`.
`c8` remains the only instrumenter; Vitest's built-in coverage provider is NOT enabled.
The artifact path stays `coverage/coverage-final.json`.

### D4: Runner behavior pins

Pin `testTimeout: 30_000`: `node --test` has no default per-test timeout, Vitest defaults to 5s, and `runtime-safety.test.ts` polls up to ~4s while `review-fixes.test.ts` waits up to 2s.
Pin `hookTimeout: 10_000` — this equals Vitest's current default and is pinned deliberately so a future default change cannot silently tighten it.
Set `sequence.hooks: "list"` so after-hook order matches Node's list order (Vitest's default `stack` reverses it).

### D5: Published files and dependencies

`vitest.config.ts` and `test/alias.js` are dev/test-only; remove them from the npm `files` list.
Add `vitest` 4.1.9 as an exact-pinned `devDependency` (matching the `c8 10.1.3` / `fallow 3.14.0` convention) and do NOT add `@vitest/ui` (no watch/UI mode is a goal).
Install with `pnpm install` from the workspace root; do not commit an npm `package-lock.json` (this is a pnpm workspace).

## Risks / Trade-offs

- `test/test.ts` is NOT matched by `test/**/*.test.ts` (it has no `.test.ts` suffix), so it is included explicitly; relying on the glob alone would silently skip it.
- `c8` now wraps Vite-transformed module evaluation across Vitest workers; coverage keys can mis-map or split (including duplicate `src/index.ts` entries from module re-imports), which changes CRAP inputs.
  **Pass rule (merge gate):** `nr fallow` exits 0 under the `istanbul` model, AND no `src/**` function that had baseline coverage loses it.
  **Merge rule for duplicate entries:** identical `statementMap`/`fnMap`/`branchMap` → sum counters in the normalizer; divergent maps → not reconcilable.
- **Pre-agreed fallback (feasible):** `test/runtime-safety.test.ts` requires Vitest (it imports `vi`), so a `node --test` coverage runner cannot run it as-is.
  If coverage parity is unreconcilable, the fallback is a FULL REVERT to the pre-change state — revert the two import sites to `?query` cache-busting and run `test` and `test:coverage` under `node --test` (where `?query` is native).
  This restores the complete suite and complete coverage by construction.
- The `test/integration/**` exclude is load-bearing: without it, Vitest's default include would sweep `test/integration/*.test.ts` into the unit run.
