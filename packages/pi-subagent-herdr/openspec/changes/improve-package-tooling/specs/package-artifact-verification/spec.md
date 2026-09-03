## ADDED Requirements

### Requirement: The package SHALL verify the packed artifact

The package SHALL provide a `verify-pack` command that runs `pnpm pack` into a temporary directory and validates the resulting tarball as an external artifact.
The verifier SHALL not inspect only the workspace source tree.

#### Scenario: Packed manifest contains the package contract

- **WHEN** `pnpm run verify-pack` runs successfully
- **THEN** the packed `package.json` has the expected package name, an ESM `type`, `engines.node >=22.19.0`, an export for `.`, an export for `./package.json`, and `pi.extensions` containing `./src/index.ts`

#### Scenario: Packed tarball contains required runtime files

- **WHEN** the verifier inspects the tarball listing
- **THEN** it finds `package/src/index.ts` and the package README, license, changelog, and manifest

#### Scenario: Packed tarball excludes development files

- **WHEN** the verifier inspects the tarball listing
- **THEN** it contains no `package/test/`, `package/coverage/`, `package/node_modules/`, `package/tsconfig.json`, or `package/vitest.config.ts` entries

### Requirement: Published metadata SHALL resolve the TypeScript entrypoint

The package SHALL export its root entrypoint as `./src/index.ts` and SHALL export `./package.json` explicitly.
The metadata SHALL declare the minimum supported Node version used by the package and repository (`>=22.19.0`).

#### Scenario: Consumer resolves the package entrypoint

- **WHEN** a Node/TypeScript consumer resolves `@yofriadi/pi-subagent-herdr`
- **THEN** the package export map resolves the root entry to `./src/index.ts`, and the package's `./package.json` subpath resolves to the package manifest

### Requirement: Pack verification SHALL fail closed

The verifier SHALL exit non-zero for a missing required file, unexpected published development file, malformed manifest field, workspace dependency specifier, or mismatched package metadata.
Temporary directories SHALL be removed on success and failure.

#### Scenario: Broken package contract blocks verification

- **WHEN** the packed manifest omits `./src/index.ts` from `pi.extensions` or the tarball includes a forbidden development path
- **THEN** `verify-pack` exits non-zero and reports the violated contract
