# Proposal: improve-package-tooling

## Why

`@yofriadi/pi-subagent-herdr` already has a solid local test setup: Vitest runs the unit suite, `c8` produces the Istanbul artifact consumed by Fallow, and the serial `node:test` integration suite remains separate.
The package currently passes its Biome check, TypeScript check, and 422 unit tests (1 skipped).

The remaining tooling gaps are at the package boundary:

- `check` runs Biome but not TypeScript, so the package-level check command can pass while `tsc --noEmit` fails.
- The package publishes raw TypeScript from `src/` but has no explicit `exports` map or `engines` declaration, unlike some sibling packages.
- There is no package-local packed-tarball verification.
  The existing `pi-provider-antigravity` package demonstrates a useful `verify-pack` pattern, but Herdr does not verify its own `package.json`, `pi.extensions`, exports, or published file allowlist before release.
- There is no `prepublishOnly` gate.
  A package can therefore be published without the package-specific checks that confirm the tarball is usable.
- Vitest 4 currently emits a `poolOptions` deprecation warning from `vitest.config.ts`; the configuration should use the current top-level equivalent without changing the tested single-fork behavior.

The GitHub `gotgenes/pi-packages` package was only used as a reference for the general idea of improving package tooling.
It is not the implementation target.
This change is limited to the local `pi-subagent-herdr` package and its directly required package-local configuration.

## What Changes

- Make `check` run both `biome check .` and `tsc --noEmit`.
- Replace the deprecated Vitest 4 `test.poolOptions.forks.singleFork` configuration with the supported top-level equivalent while preserving the single-fork, non-isolated unit-runner behavior and c8 coverage parity.
- Add explicit `engines.node` and an `exports` map for the package's TypeScript entrypoint, including `./package.json`.
- Add a package-local `scripts/verify-pack.mjs` that packs the package into a temporary directory, inspects the packed manifest and tarball file list, and verifies that the advertised extension entrypoint and required runtime files are present while tests/configuration files are absent.
- Add `verify-pack` and `prepublishOnly` scripts. `prepublishOnly` runs typecheck, unit tests, integration tests, and packed-artifact verification before publishing.
- Keep the runtime source, unit-test architecture, c8/Istanbul coverage format, Fallow configuration, and serial integration runner unchanged.

## Capabilities

### New Capabilities

- `package-artifact-verification`: The published tarball is checked as an external artifact, including manifest metadata, exports, Pi extension entrypoint, allowlisted files, and exclusion of development/test files.
- `package-quality-gates`: The package-level check and publish commands run the static, type, test, integration, and package-artifact gates in an explicit order.

## Impact

- **Package files:** `packages/pi-subagent-herdr/package.json`, `vitest.config.ts`, and a new `scripts/verify-pack.mjs`.
- **Published metadata:** Adds `exports` and `engines`; the package continues to publish TypeScript source and the existing `src/index.ts` Pi extension.
- **Tests:** No runtime or test assertions need to change.
  Existing unit, integration, and coverage commands remain available.
- **Release behavior:** Publication becomes stricter and can fail before npm upload if any package gate or tarball contract fails.
- **Out of scope:** No changes to the `gotgenes/pi-packages` repository, no Rollup/Rolldown migration, no root-monorepo CI redesign, no Renovate/catalog work, and no runtime behavior changes.
