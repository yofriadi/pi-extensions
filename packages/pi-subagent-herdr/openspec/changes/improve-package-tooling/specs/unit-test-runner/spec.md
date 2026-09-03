## MODIFIED Requirements

### Requirement: Unit tests keep the established Vitest/c8 behavior

The package SHALL continue to run unit tests with `vitest run`, include `test/test.ts` and `test/**/*.test.ts`, exclude `test/integration/**`, use the local `node:test` shim, preserve `testTimeout: 30_000`, `hookTimeout: 10_000`, `sequence.hooks: "list"`, `pool: "forks"`, one worker, and `isolate: false`, and produce c8/Istanbul JSON at `coverage/coverage-final.json`.
The Vitest 4 configuration SHALL express the one-worker setting using supported top-level configuration rather than the removed `test.poolOptions` property.

#### Scenario: Existing unit suite remains green

- **WHEN** `pnpm run test` executes after the configuration update
- **THEN** the same unit test files run under Vitest and pass without executing `test/integration/**`

#### Scenario: Integration suite remains on Node's runner

- **WHEN** `pnpm run test:integration` executes
- **THEN** `node --test --test-concurrency=1 test/integration/*.test.ts` remains the runner and the package does not route integration tests through Vitest

#### Scenario: Coverage artifact remains compatible

- **WHEN** `pnpm run test:coverage` completes
- **THEN** `coverage/coverage-final.json` exists as normalized Istanbul JSON at the existing path and Fallow can consume it
