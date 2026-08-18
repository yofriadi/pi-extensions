# Spec: unit-test-runner

## ADDED Requirements

### Requirement: Unit tests run under Vitest via a node:test shim

The package SHALL run its non-integration unit suite with `vitest run` driven by a package-local `vitest.config.ts`.
The config SHALL include `test/test.ts` and `test/**/*.test.ts` and SHALL set `exclude` to `[...configDefaults.exclude, "test/integration/**"]` (preserving Vitest's default excludes).
The `test` script SHALL be `vitest run`.
Unit tests SHALL keep importing `node:test`; a package-local shim aliased as `node:test` SHALL map those imports onto Vitest so the suites register with Vitest, not Node's runner.
Because Vitest has no `before`/`after` exports, the shim SHALL map `before → beforeAll` and `after → afterAll` and pass through `describe`/`it`/`beforeEach`/`afterEach`.
The alias SHALL be a top-level `resolve.alias` entry, with an `enforce: "pre"` `resolveId` plugin as a fallback for `node:`-prefixed specifiers.

#### Scenario: Default unit command

- **WHEN** a developer runs `npm test` in this package
- **THEN** Vitest executes every unit file matched by the config and does not execute `test/integration/**`

#### Scenario: New unit file is picked up

- **WHEN** a new file `test/example.test.ts` is added
- **THEN** `npm test` runs it without editing `package.json` scripts

#### Scenario: Shim maps node:test hooks onto Vitest

- **WHEN** `vitest run` executes `test/test.ts`
- **THEN** its `before`/`after`/`describe`/`it` run as Vitest `beforeAll`/`afterAll`/`describe`/`it`, and `vitest list` reports the same unit count as the `node --test` baseline

### Requirement: Integration tests stay on serial node:test

The `test:integration` script SHALL remain `node --test --test-concurrency=1 test/integration/*.test.ts`.
Integration files SHALL keep `node:test` imports and SHALL NOT run under Vitest.

#### Scenario: Integration command is unchanged

- **WHEN** a developer runs `npm run test:integration`
- **THEN** Node's test runner executes `test/integration/*.test.ts` serially and Vitest is not the runner

### Requirement: Unit tests keep node:test and node:assert, with one narrow isolation exception

Existing unit tests SHALL keep `node:test` hooks and `node:assert/strict`.
The change SHALL NOT rewrite assertions to Vitest `expect`, SHALL NOT rename `test/test.ts`, and SHALL NOT introduce `vi` helpers, EXCEPT for one narrow module-isolation mechanism: the two dynamic imports in `test/runtime-safety.test.ts` that previously used a `?query` cache-buster SHALL instead call `vi.resetModules()` and then a plain `await import("../src/index.ts")`, with every assertion untouched.
The lone `t.skip(...)` in `test/permission-integration.test.ts` is unchanged and works because Vitest's `TestContext` provides `skip()`.

#### Scenario: Assertion style is unchanged

- **WHEN** the runner switch lands
- **THEN** unit files still import `node:assert/strict` and `node:test`, and `test/test.ts` still exists at that path

#### Scenario: Module-isolation exception is the only vi usage

- **WHEN** the module-isolation suites run
- **THEN** the only `vi` call is `vi.resetModules()` at the two former cache-busted import sites, and all surrounding assertions are byte-identical to before

### Requirement: Coverage stays c8 Istanbul JSON

`test:coverage` SHALL produce Istanbul JSON at `coverage/coverage-final.json` via `c8` followed by `scripts/normalize-istanbul-coverage.mjs`, and the package SHALL NOT enable Vitest's built-in coverage provider.
In the primary configuration `c8` wraps `vitest run`; if the code-health-gate coverage-parity fallback is invoked, `c8` wraps the fallback runner instead.
The artifact path and normalizer are invariant across both branches.

#### Scenario: Coverage artifact is regenerated

- **WHEN** `npm run test:coverage` completes successfully
- **THEN** `coverage/coverage-final.json` exists as Istanbul JSON with normalized non-negative location columns

### Requirement: Test and hook timeouts are pinned

`vitest.config.ts` SHALL pin `testTimeout` and `hookTimeout` so long-running unit tests are not cut short by Vitest's defaults. `hookTimeout` MAY equal Vitest's current default; it is pinned deliberately so a future default change cannot silently tighten it.

#### Scenario: Long unit test is not cut short

- **WHEN** a unit test legitimately waits or polls beyond Vitest's default timeout
- **THEN** it runs to completion under the pinned timeouts instead of failing with a timeout

### Requirement: Hook ordering matches node --test

`vitest.config.ts` SHALL set `sequence.hooks: "list"` so after-hooks run in file order, matching `node --test` (Vitest's default `stack` reverses after-hook order).

#### Scenario: Hook ordering is pinned

- **WHEN** suites with `after`/`afterEach` hooks run
- **THEN** hooks execute in the same order as they would under `node --test`
