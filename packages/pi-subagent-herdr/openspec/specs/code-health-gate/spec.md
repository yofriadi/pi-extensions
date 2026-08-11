# Capability: code-health-gate

## Purpose

The `fallow` complexity/CRAP health gate for pi-subagent-herdr, driven by real `c8` coverage, with extraction targets sized from measured coverage, explicit test-file threshold policy, and a hard constraint that remediation never changes extension behavior or session-bound state ownership.

## Requirements

### Requirement: Fallow health gate passes

After coverage generation, the repository SHALL pass `fallow` health checks with no unsuppressed findings: `nr fallow` SHALL exit with code 0 (dead code, duplication, and health all green), and every function in production code (`src/**`) SHALL be under the configured cyclomatic, cognitive, CRAP, and unit-size thresholds or carry an explicit documented suppression or threshold override with a stated reason.
Suppressions/overrides are exceptional and MUST NOT be the primary remediation strategy.

#### Scenario: Health check after coverage generation

- **WHEN** coverage has been generated via the `test:coverage` script and `nr fallow` runs
- **THEN** the command exits with code 0 and reports no unsuppressed complexity findings in `src/**`

#### Scenario: Complexity regression introduced

- **WHEN** a function in `src/**` exceeds a configured complexity threshold without a suppression or override
- **THEN** `nr fallow` exits non-zero and names the offending function and file

### Requirement: Coverage artifact is reproducible and wired into the gate

CRAP scores used by the health gate SHALL be computed from real coverage data produced by the existing `node --test` suite via `c8` (Istanbul JSON).
The package SHALL provide a `test:coverage` script that regenerates the artifact; the artifact location SHALL be wired into the gate configuration (`.fallow.toml` `health.coverage` or the auto-detected `coverage/coverage-final.json` path) so bare `nr fallow` uses the istanbul coverage model.
The generated artifact SHALL be gitignored, not committed.

#### Scenario: Gate run uses real coverage

- **WHEN** `test:coverage` has run and `nr fallow` executes
- **THEN** the health report computes CRAP under the `istanbul` coverage model (not `static_estimated`)

#### Scenario: Fresh checkout without coverage

- **WHEN** coverage has not been generated and `nr fallow` executes
- **THEN** the gate falls back to the estimation heuristic, this state is visible in the report, and the documented remediation is running `test:coverage` first

### Requirement: Extraction targets account for measured coverage

Per-function complexity targets SHALL be derived from measured coverage using `CRAP = CC² × (1−cov)³ + CC`: functions measuring 0% coverage SHALL be split to units of CC ≤ 4 (the ceiling `maxCrap` 30 admits at cov 0) unless covered by new unit tests or a documented `maxCrap` override.
Functions with real coverage SHALL target the standard thresholds.

#### Scenario: Zero-coverage god function

- **WHEN** a flagged function measures 0% coverage in the baseline (e.g. the launch/execute path reachable only from integration tests)
- **THEN** it is split into units of CC ≤ 4, or unit tests are added to lift its measured coverage, or a `thresholdOverrides` `maxCrap` entry with a `reason` is recorded for it

### Requirement: Extension behavior and test contract preserved

Complexity remediation SHALL NOT change observable extension behavior: the public extension API, the `__test__` export shape (including object identity of every exported mutable instance), tool semantics, widget rendering output, delivery guarantees, and lifecycle transitions SHALL remain identical, verified by the existing `node --test` suite passing unmodified.
The only permitted test changes are the NEW unit tests for the launch/execute path that this change deliberately adds.

#### Scenario: Refactor lands

- **WHEN** any extraction or module split from this change is applied
- **THEN** the full pre-existing `node --test` suite passes without modification to test expectations

#### Scenario: Test-only exports after module split

- **WHEN** functions or state are moved out of `src/index.ts` into new modules
- **THEN** `src/index.ts` continues to re-export every `__test__` member with the same object identity as before the move

### Requirement: Session-bound state is never hoisted

Handler extraction inside `subagentsExtension` SHALL preserve per-factory-invocation ownership of session-bound state (`ownedCompletionRuntime` and kin) by passing a per-invocation instance-state object explicitly to extracted handlers; such state MUST NOT be hoisted to module scope.

#### Scenario: Handler extraction

- **WHEN** a `session_start`/`session_shutdown` handler body is extracted to a top-level function
- **THEN** it receives session-bound state via a per-invocation instance-state object and no session-bound `let` binding is moved to module scope

### Requirement: Test-code threshold policy is explicit and complete

Complexity thresholds for test files (`test/**`) SHALL be governed by explicit configuration.
Because `thresholdOverrides` arrays replace ALL parent-config entries, the package-level override SHALL restate every inherited test-file entry verbatim (as shown by the effective merged config) alongside any new complexity keys.

#### Scenario: Test helper exceeds production threshold

- **WHEN** a helper or suite closure in `test/**` exceeds production complexity thresholds but not the test-specific override
- **THEN** the health gate does not fail on that function

#### Scenario: Override preserves inherited relaxations

- **WHEN** the package `.fallow.toml` adds a `test/**` threshold override entry
- **THEN** every inherited test-file override entry (including unit size) appears verbatim in the package entry, verified against the effective merged config
