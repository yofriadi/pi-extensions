# Tasks: improve-package-tooling

## 1. Capture the local package baseline

- [ ] 1.1 Run package-scoped `check`, `typecheck`, `test`, `test:coverage`, and `test:integration`; record the current pass/fail state, unit count, coverage artifact path, and known integration environment limitations.
- [ ] 1.2 Run the current Fallow health/dead-code checks where the package configuration requires them; record the baseline so the Vitest configuration change cannot silently weaken code-health gates.
- [ ] 1.3 Pack the current package into a temporary directory and record its tarball file list; confirm the current absence of `exports`, `engines`, and `verify-pack` is understood before changing metadata.

## 2. Remove the Vitest 4 deprecation

- [ ] 2.1 Replace `test.poolOptions.forks.singleFork` with the supported Vitest 4 top-level configuration that preserves one fork/one worker and `isolate: false`; leave test includes, excludes, timeout values, hook ordering, aliases, and pool type unchanged.
- [ ] 2.2 Run `pnpm --filter @yofriadi/pi-subagent-herdr run test`; confirm all 359 baseline unit tests pass and the `test.poolOptions was removed in Vitest 4` warning is gone.
- [ ] 2.3 Run `pnpm --filter @yofriadi/pi-subagent-herdr run test:coverage`; confirm `coverage/coverage-final.json` is still normalized and usable by Fallow, then run the relevant Fallow gate.
- [ ] 2.4 Run the serial integration command and confirm it remains on Node's test runner; document any pre-existing live-pane timeout separately from regressions.

## 3. Strengthen package metadata and package-level gates

- [ ] 3.1 Change `check` to run `biome check . && pnpm run typecheck`; keep `typecheck` as a standalone script.
- [ ] 3.2 Add `engines.node: ">=22.19.0"`, matching the root workspace and sibling package convention.
- [ ] 3.3 Add `exports` for `.` → `./src/index.ts` and `./package.json` → `./package.json`; do not add compiled-JavaScript or declaration conditions because the package publishes raw TypeScript.
- [ ] 3.4 Add `verify-pack` and `prepublishOnly` scripts. `prepublishOnly` SHALL run typecheck, unit tests, serial integration tests, and `verify-pack` in a fail-fast chain.
- [ ] 3.5 Verify `pnpm run check` now catches a TypeScript error that Biome alone would not catch, using a temporary uncommitted fixture or an existing safe typecheck probe; restore the tree afterward.

## 4. Implement packed-tarball verification

- [ ] 4.1 Add `scripts/verify-pack.mjs` using `mkdtemp`, `execFileSync`, `tar`, and `finally` cleanup; invoke `pnpm pack --pack-destination` with the package directory as cwd.
- [ ] 4.2 Validate the packed manifest name, `type`, `engines.node`, root/package-json exports, `pi.extensions`, and absence of workspace dependency specifiers.
- [ ] 4.3 Validate the tarball includes `package/src/index.ts`, `package/README.md`, `package/CHANGELOG.md`, `package/LICENSE`, and `package/package.json`.
- [ ] 4.4 Validate the tarball excludes `package/test/`, `package/coverage/`, `package/node_modules/`, `package/tsconfig.json`, and `package/vitest.config.ts`; fail closed for unexpected development files under the published allowlist.
- [ ] 4.5 Run `pnpm --filter @yofriadi/pi-subagent-herdr run verify-pack` against the real tarball and inspect the output with `tar -tf`.
- [ ] 4.6 Exercise a verifier failure path without mutating the final package (for example, test a temporary copied manifest/tarball or add a small script-level fixture); confirm non-zero exit and cleanup.

## 5. Release and repository verification

- [ ] 5.1 Run the full package sequence: `check`, `typecheck`, `test`, `test:coverage`, `test:integration`, `verify-pack`, and the package Fallow checks.
- [ ] 5.2 Run `pnpm pack`/publish dry-run using the package manager's supported options; confirm the packed file list and manifest match `verify-pack`.
- [ ] 5.3 Run root `pnpm run verify` and `pnpm run lint` after package-local gates pass; separate unrelated existing workspace failures from this change.
- [ ] 5.4 Update the package README or changelog only if publishing instructions need to mention `verify-pack` or the Node engine floor.
- [ ] 5.5 Validate the OpenSpec change with `openspec validate improve-package-tooling` and archive it only after all implementation tasks are complete.
