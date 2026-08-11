# Proposal: fix-fallow-health-complexity

## Why

`nr fallow` fails with exit code 1: 132 functions exceed complexity/CRAP thresholds.
Concentrated cause: `src/index.ts` (3485 LOC) holds a 681-line `subagentsExtension` god function plus `execute` (cyc 57), `watchSubagent` (45), `launchSubagent` (35), and `renderSubagentWidgetLines` (33).
Dead code and duplication are already clean; only the health gate fails.
High CRAP in core dispatch/delivery paths raises regression risk on every change.

## What Changes

- Reduce false signal: generate real coverage with `c8 --reporter=json` wrapping the existing `node --test` runs (this package does not use vitest), wired into the gate config (`.fallow.toml` `health.coverage` or the auto-detected `coverage/coverage-final.json` path) so bare `nr fallow` uses the istanbul coverage model — not the ad-hoc `--coverage` flag.
- Make coverage reproducible: add a `test:coverage` script, gitignore `coverage/`, pin `fallow` and `c8` as devDependencies.
  The gate's clean-tree pass is defined as "after coverage generation".
- Respect CRAP math: `CRAP = CC² × (1−cov)³ + CC` means `maxCrap` 30 admits only CC ≤ 4 for 0%-covered functions.
  `execute`/`launchSubagent`/`startBackgroundSpawn` are currently reachable only from integration tests (real herdr + `PI_TEST_MODEL`), so they measure 0% under unit coverage.
  Remediation: split to CC ≤ 4 units AND add unit tests for the launch/execute path; where that is impractical, a documented `maxCrap` `thresholdOverrides` entry with `reason`.
- Pre-extract inline handlers before moving: `execute`, `renderCall`, `renderResult`, and the `render` functions are object-literal methods / closure returns, not top-level symbols.
  Hoist them to named top-level functions (threading `pi` as a parameter) first; per-invocation state (`ownedCompletionRuntime`) travels in an instance-state object passed explicitly — never hoisted to module scope, preserving session-bound completion API ownership.
- Split `src/index.ts` by concern into focused modules: shared mutable state first (leaf `src/state.ts` to avoid circular imports), then tool execution, launch/watch, widget rendering, background delivery clusters.
  Preserve `__test__` export shape and instance identity via re-export from `index.ts`.
- Shrink `subagentsExtension` itself under the 60-LOC unit-size threshold via the handler extraction above.
- Extract flagged god functions in `src/lifecycle.ts` (`observeActivity`, `observePaneInspection` — dispatch table, not per-kind clones, to avoid duplication findings), `src/completion.ts` (`waitForCompletion`), `src/delivery-barrier.ts` (the `flush` class method at line 86, not `flushLegacyBarrier` at :175), `src/layout.ts` (`attachPane`).
- Work through remaining flagged functions in `status.ts`, `herdr.ts`, `runtime-routing.ts`, `agent-definition.ts`, `activity.ts`, `subagent-done.ts`, `session.ts`, `coordinator.ts`.
- Test-file complexity policy: dump the effective merged config first, then restate ALL inherited `test/**` `thresholdOverrides` entries verbatim alongside new complexity keys (array-replace drops every parent entry, not just one).
- Existing test suite must pass unmodified except for the added launch/execute unit tests called out above.

## Capabilities

### New Capabilities

- `code-health-gate`: Requirement that `fallow` health checks report no unsuppressed findings with coverage-informed CRAP, that the coverage artifact is reproducibly generated and wired into the gate, and that complexity targets account for measured per-function coverage.

### Modified Capabilities

None.
No requirement-level behavior changes; all refactoring is implementation-internal. (Session-bound completion API ownership from archived change `prevent-discovery-runtime-poisoning` is a constraint, not a modification.)

## Impact

- **Code**: `src/index.ts` plus new modules (`state.ts`, `tool-execute.ts`, `subagent-launch.ts`, `widget.ts`, `delivery.ts`); `src/lifecycle.ts`, `src/completion.ts`, `src/delivery-barrier.ts`, `src/layout.ts`; tail files.
  Public extension API and `__test__` export shape unchanged.
- **Config**: package `.fallow.toml` gains `health.coverage` and a `test/**` threshold override restating all inherited entries.
- **package.json**: new `test:coverage` script; `fallow` and `c8` pinned as devDependencies.
- **Tests**: existing `node --test` suite unchanged and green; new unit tests added for the launch/execute path to lift measured coverage off 0%.
- **Verification**: `tsc --noEmit`, `biome check .`, `nr fallow` (incl. dupes) all green.
