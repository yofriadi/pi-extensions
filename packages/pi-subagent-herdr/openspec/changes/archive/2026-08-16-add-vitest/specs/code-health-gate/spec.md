# Spec: code-health-gate

## MODIFIED Requirements

### Requirement: Coverage artifact is reproducible and wired into the gate

CRAP scores used by the health gate SHALL be computed from real coverage data produced by wrapping the Vitest unit suite with `c8` (Istanbul JSON).
The package SHALL provide a `test:coverage` script that regenerates the artifact; the artifact location SHALL be wired into the gate configuration (`.fallow.toml` `health.coverage` or the auto-detected `coverage/coverage-final.json` path) so bare `nr fallow` uses the istanbul coverage model.
The generated artifact SHALL be gitignored, not committed.
Switching the wrapped runner from `node --test` to Vitest SHALL NOT silently change CRAP inputs.
Coverage parity is a merge gate: `nr fallow` SHALL exit 0 under the `istanbul` model, AND no `src/**` function that had baseline coverage SHALL lose it.
Duplicate `src/index.ts` entries from module re-imports SHALL be reconciled in `scripts/normalize-istanbul-coverage.mjs` by summing counters when the `statementMap`/`fnMap`/`branchMap` are identical; divergent maps are not reconcilable and invoke the fallback.

#### Scenario: Gate run uses real coverage

- **WHEN** `test:coverage` has run and `nr fallow` executes
- **THEN** the health report computes CRAP under the `istanbul` coverage model (not `static_estimated`)

#### Scenario: Fresh checkout without coverage

- **WHEN** coverage has not been generated and `nr fallow` executes
- **THEN** the gate falls back to the estimation heuristic, this state is visible in the report, and the documented remediation is running `test:coverage` first

#### Scenario: Runner switch preserves coverage inputs

- **WHEN** the wrapped runner switches from `node --test` to Vitest and `test:coverage` is re-run
- **THEN** `nr fallow` exits 0 under the `istanbul` model and no `src/**` function that had baseline coverage loses it, after duplicate-entry reconciliation

#### Scenario: Coverage parity is unreconcilable

- **WHEN** the Vitest coverage artifact cannot be reconciled to baseline (divergent `src/index.ts` maps)
- **THEN** the pre-agreed fallback applies: revert the two module-isolation imports in `test/runtime-safety.test.ts` to `?query` cache-busting and run `test` and `test:coverage` under `node --test` (where `?query` is native), restoring the complete suite and complete coverage

### Requirement: Extension behavior and test contract preserved

Complexity remediation SHALL NOT change observable extension behavior: the public extension API, the `__test__` export shape (including object identity of every exported mutable instance), tool semantics, widget rendering output, delivery guarantees, and lifecycle transitions SHALL remain identical, verified by the existing unit suite passing unmodified under the Vitest runner.
The only permitted test changes are (a) the NEW unit tests for the launch/execute path added by `2026-08-11-fix-fallow-health-complexity`, and (b) the narrow module-isolation mechanism in `test/runtime-safety.test.ts` (two query-string cache-busting dynamic imports replaced by `vi.resetModules()` + a plain dynamic `import`) required to obtain a fresh module instance under Vite; every assertion remains untouched.

#### Scenario: Refactor lands

- **WHEN** any extraction, module split, or runner switch from this change is applied
- **THEN** the full pre-existing unit suite passes without modification to test expectations

#### Scenario: Test-only exports after module split

- **WHEN** functions or state are moved out of `src/index.ts` into new modules
- **THEN** `src/index.ts` continues to re-export every `__test__` member with the same object identity as before the move
