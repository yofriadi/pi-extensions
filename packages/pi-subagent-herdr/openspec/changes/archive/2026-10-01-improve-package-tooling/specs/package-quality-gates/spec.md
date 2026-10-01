## ADDED Requirements

### Requirement: The package check SHALL include static and type validation

The package `check` script SHALL run both Biome validation and `tsc --noEmit` using the package's `tsconfig.json`.
The existing standalone `typecheck` script SHALL remain available.

#### Scenario: Package check catches a type error

- **WHEN** a TypeScript source or test file contains an error accepted by Biome
- **THEN** `pnpm run check` exits non-zero because the TypeScript step fails

#### Scenario: Clean package check passes

- **WHEN** Biome and TypeScript validation succeed
- **THEN** `pnpm run check` exits zero

### Requirement: Publishing SHALL run all package release gates

The package SHALL define `prepublishOnly` to run package typechecking, unit tests, serial integration tests, and packed-artifact verification.
Existing `test`, `test:coverage`, and `test:integration` scripts SHALL remain available as independent developer commands.

#### Scenario: Publish gate succeeds for a valid package

- **WHEN** `pnpm run prepublishOnly` runs against a valid package
- **THEN** typechecking, unit tests, integration tests, and `verify-pack` all complete successfully

#### Scenario: Publish gate stops on a failed check

- **WHEN** any prepublish command fails
- **THEN** the lifecycle exits non-zero and the publish command does not continue to npm upload

### Requirement: Vitest configuration SHALL use supported Vitest 4 options

The package-local Vitest configuration SHALL preserve the existing test file include/exclude rules, timeouts, hook ordering, fork pool, single-worker behavior, and non-isolated behavior without relying on the removed Vitest 4 `test.poolOptions` property.

#### Scenario: Unit suite runs without a Vitest deprecation warning

- **WHEN** `pnpm run test` executes with the package-local configuration
- **THEN** all existing unit tests pass and the configuration does not emit the `test.poolOptions was removed in Vitest 4` warning

#### Scenario: Coverage behavior remains stable

- **WHEN** `pnpm run test:coverage` executes
- **THEN** c8 still writes Istanbul JSON to `coverage/coverage-final.json`, the normalizer runs, and the artifact remains usable by Fallow
