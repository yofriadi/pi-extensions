# Proposal: add-vitest

## Why

Unit scripts in this package enumerate every `test/*.test.ts` file for `node --test`; adding a suite means editing two long script lines, and `test:coverage` repeats the whole list.
Sibling packages already run Vitest.
This package should match that runner for unit tests while leaving the serial Herdr integration suite and the `c8`/fallow coverage pipeline untouched.

## What Changes

- Add a package-local `vitest.config.ts` that includes `test/test.ts` and `test/**/*.test.ts`, sets `exclude` to `[...configDefaults.exclude, "test/integration/**"]`, pins `testTimeout`/`hookTimeout`, and sets `sequence.hooks: "list"`.
- Alias `node:test` to a package-local shim (`test/alias.js`) so existing `node:test` imports run under Vitest unchanged.
  Vitest has no `before`/`after` exports, so the shim maps `before → beforeAll` and `after → afterAll` and passes through `describe`/`it`/`beforeEach`/`afterEach`.
  The alias is declared as a top-level `resolve.alias` entry (Vitest requires `resolve.alias` at the top level, not inside `test`), with an `enforce: "pre"` `resolveId` plugin as a fallback in case Vite's built-in `node:` resolution wins.
- Point `test` at `vitest run` and wrap the same suite with the existing `c8` + `scripts/normalize-istanbul-coverage.mjs` for `test:coverage`, so `.fallow.toml` still reads Istanbul JSON at `coverage/coverage-final.json`.
- Replace the two query-string cache-busting dynamic imports in `test/runtime-safety.test.ts` (`?discovery-timer=…`, `?replacement-retry=…`) with `vi.resetModules()` + a plain `await import("../src/index.ts")`.
  Vite does not re-evaluate a module for a `?query` suffix (it fails with "does not provide an export named `__test__`"), so this is the one narrow, assertion-preserving test change required to keep the module-isolation suites green.
- Add exact-pinned `vitest` 4.1.9 as a package `devDependency` via `pnpm install`; do NOT add `@vitest/ui`.
- Keep every unit and integration test on `node:test` + `node:assert/strict`.
  No assertion rewrite, no `expect`, no `test/test.ts` rename, no `c8` removal, no `test:watch`, no `globals: true`.
- Leave `test:integration` on serial `node --test --test-concurrency=1`.
- Drop `vitest.config.ts` and `test/alias.js` from the published `files` list (they are dev/test-only).
- Update the `.fallow.toml` coverage comment to name Vitest as the wrapped runner; thresholds and the artifact path are unchanged.

## Capabilities

### New Capabilities

- `unit-test-runner`: unit tests run under Vitest via a `node:test` shim; integration stays serial `node --test`; coverage stays `c8` Istanbul JSON consumed by fallow.

### Modified Capabilities

- `code-health-gate`: the coverage artifact is now produced by wrapping the Vitest unit suite with `c8` instead of `node --test`; the artifact path, gitignore policy, and behavior-lock constraints are preserved, with a concrete coverage-parity merge gate and a feasible full-revert fallback.

## Impact

- **Code**: none in `src/**`.
- **Config**: `package.json` scripts + `devDependencies` + `files`; new `vitest.config.ts`; comment-only `.fallow.toml`.
  Install via `pnpm install` (pnpm workspace); do not commit an npm `package-lock.json`.
- **Tests**: exactly one narrow change — the two dynamic-import sites in `test/runtime-safety.test.ts` switch to `vi.resetModules()`; all assertions and every other file are untouched.
  The lone `t.skip(...)` in `test/permission-integration.test.ts` needs no change because Vitest's `TestContext` provides `skip()`.
- **Verification**: capture the `node --test` baseline first, then `vitest list` count match; `npm test`; `npm run test:coverage`; `tsc --noEmit`; `biome check .`; `nr fallow`; `npm run test:integration`; plus the coverage-parity merge gate.
