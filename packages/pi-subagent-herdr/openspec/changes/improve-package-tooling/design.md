## Context

The implementation target is only `packages/pi-subagent-herdr` in the local `pi-extensions` monorepo.
The GitHub `gotgenes/pi-packages` package was a reference for package tooling, not a source of implementation requirements.

Current package state:

- Package name: `@yofriadi/pi-subagent-herdr`, version `0.5.0`.
- Runtime entrypoint: `src/index.ts`, registered through `pi.extensions`.
- Published allowlist: `src/`, README, changelog, license, and package manifest.
- Unit tests: Vitest 4.1.9 with a local `node:test` shim, c8 Istanbul JSON coverage, fork pool, one fork, and `isolate: false`.
- Integration tests: serial Node test runner using `node --test --test-concurrency=1`.
- `check`: currently only `biome check .`; `typecheck` is separate.
- Current baseline observed during planning: Biome passes, TypeScript passes, 29 Vitest files / 359 tests pass.
  Vitest emits one configuration deprecation warning because `test.poolOptions` was removed in Vitest 4.
- The sibling `pi-provider-antigravity` package already has a package-local `verify-pack.mjs` pattern that packs a tarball, extracts its manifest, checks metadata, and checks the tarball listing.
- The package currently has no `exports`, no `engines`, no `verify-pack`, and no `prepublishOnly`.

## Goals / Non-Goals

**Goals:**

- Make the package-local `check` command catch both formatting/lint errors and TypeScript errors.
- Remove the known Vitest 4 configuration deprecation without changing runner behavior or coverage semantics.
- Validate the actual npm tarball's manifest and file allowlist before publication.
- Make the package's TypeScript entrypoint, package metadata, and minimum Node version explicit.
- Ensure `prepublishOnly` fails closed before npm upload.

**Non-Goals:**

- No Rollup, Rolldown, declaration bundling, or JavaScript runtime bundling.
  This package intentionally publishes TypeScript source.
- No changes to runtime source code or public runtime behavior.
- No replacement of Vitest, c8, Fallow, the node:test shim, or the serial integration runner.
- No root CI redesign, Renovate configuration, pnpm catalog migration, or changes to the unrelated reference repository.
- No broad package-wide metadata normalization across the other `pi-extensions` packages.

## Decisions

### D1: Use package-local artifact verification modeled on the existing sibling pattern

Implement `scripts/verify-pack.mjs` with Node's standard library (`mkdtemp`, `rm`, `execFileSync`, `tar`) rather than adding a new validation dependency.
The script will:

1. Create a temporary staging directory.
2. Run `pnpm pack --pack-destination <staging>` with the package directory as cwd.
3. Extract `package/package.json` from the generated tarball.
4. Assert the package name, `type: "module"`, Node engine, root/package-json exports, and `pi.extensions` entry.
5. Assert required tarball paths exist.
6. Assert development-only paths are absent.
7. Remove the temporary directory in a `finally` block.

The script must parse the tarball manifest rather than the workspace manifest so a packaging mistake cannot be masked by source state.

### D2: Add an explicit exports map without pretending the package has compiled JS

The package remains source-published.
Add:

```json
"exports": {
  ".": "./src/index.ts",
  "./package.json": "./package.json"
}
```

This matches the package's existing Pi loader entry and the source-publishing convention used by sibling Pi extensions.
It does not add a `types` declaration target or a CommonJS condition because the package has no compiled JavaScript or generated declaration bundle.

### D3: Use Node 22.19 as the package engine floor

The root workspace and several sibling packages already declare `node >=22.19.0`; use the same floor for this package.
The verifier checks the exact value in the packed manifest.
This is metadata alignment, not a runtime implementation change.

### D4: Make the package check compositional

Change `check` from `biome check .` to `biome check . && pnpm run typecheck`.
Keep `typecheck` as a separately callable script.
This keeps local debugging convenient while ensuring package-scoped checks cannot omit TypeScript validation.

### D5: Migrate only the deprecated Vitest option

Vitest 4 removed `test.poolOptions`.
Preserve the existing behavior with the supported top-level worker setting, expected to be `maxWorkers: 1` together with `pool: "forks"` and `isolate: false`.
Verify the exact test count, coverage artifact, and Fallow result before and after.
Do not change the node:test shim, test inclusion, timeouts, hook ordering, or integration runner.

### D6: Put all release gates behind `prepublishOnly`

Add:

```json
"prepublishOnly": "pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run verify-pack"
```

`verify-pack` itself runs `pnpm pack`, which triggers `prepack` if one exists; this package currently has no `prepack`, so no recursive lifecycle is introduced. `prepublishOnly` is intentionally separate from `test` and `check` so developers can run focused commands, while publication receives the complete package-specific gate.

## Risks / Trade-offs

- **Raw TypeScript exports:** Some generic Node consumers cannot execute `.ts` files directly.
  This is already the package's intended Pi-extension distribution model; the change makes it explicit rather than adding a misleading compiled-JS condition.
- **Stricter publication:** Existing release workflows or local publication commands that do not have Pi pane integration available may fail during `test:integration`.
  That is intentional for a release gate; document the focused `verify-pack` command for metadata-only checks.
- **Vitest worker semantics:** Replacing `singleFork` with `maxWorkers: 1` could alter process reuse if the defaults differ.
  Compare unit count, pass results, coverage parity, and Fallow output; revert the option migration if behavior changes.
- **Tarball allowlist drift:** New intended runtime files must be added to `files` and to the verifier's required list together.
  The verifier should fail on missing required artifacts rather than silently broadening the allowlist.
- **Engine metadata:** Raising the package engine floor to `>=22.19.0` can reject Node 22.18 users, but aligns the package with the root repository and sibling packages.
  Validate the actual supported Pi runtime before release.
- **No new publishing tool dependency:** Using Node/tar directly avoids dependency growth but makes the verifier Unix-oriented, consistent with the existing repository scripts and CI environment.

## Migration Plan

1. Capture the current package baseline: `check`, `typecheck`, `test`, `test:coverage`, `test:integration`, Fallow health/dead-code where available, and current `pnpm pack` listing.
2. Update `vitest.config.ts` to remove `test.poolOptions`, then rerun unit tests, coverage, and Fallow.
   If the 359-test count or coverage parity changes, stop and resolve before continuing.
3. Update `package.json` with the combined check, `engines`, `exports`, `verify-pack`, and `prepublishOnly` scripts.
4. Add `scripts/verify-pack.mjs`; run it against a real tarball and intentionally test at least one failure path (for example, a missing required manifest field in a temporary fixture or an assertion-level unit test for the verifier helper).
5. Run the complete package gate and inspect the tarball with `tar -tf`; verify test/configuration files are excluded and `src/index.ts` is present.
6. Run root verification only after package-local gates pass; update README/release notes only if the new package publishing commands need documentation.

Rollback is straightforward: revert the package metadata/script changes, remove `verify-pack.mjs`, and restore the prior Vitest pool configuration.
No runtime source migration or generated artifacts are involved.

## Open Questions

- Confirm whether `maxWorkers: 1` exactly preserves the current single-fork behavior under Vitest 4.1.9; if not, use the current supported Vitest 4 configuration that does.
- Decide whether `prepublishOnly` should include the potentially environment-sensitive integration suite or use a dedicated release command with an explicit integration opt-out.
  The default plan keeps it because publication should validate the complete package.
- Confirm whether the package should export additional stable subpaths beyond `.` and `./package.json`; do not add any without a consumer and tarball test.
