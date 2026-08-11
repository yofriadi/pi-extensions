# Design: fix-fallow-health-complexity

## Context

`fallow` health gate fails: 132 functions above complexity/CRAP thresholds (schema defaults: `maxCyclomatic` 20, `maxCognitive` 15, `maxCrap` 30.0, `maxUnitSize` 60, `crapRefactorBand` 5).
`src/index.ts` (3485 LOC, 14 fan-in) is the monolith: `subagentsExtension` (681 LOC, :2805–3485) with `execute` nested at :2947 as a `pi.registerTool` object-literal method (cyc 57/cog 59); top-level `watchSubagent` (45/54, :1951), `launchSubagent` (35/46, :1398), `renderSubagentWidgetLines` (33/41, :914); `renderCall`/`renderResult` are object-literal methods (:3279/:3307); three distinct `render` functions exist (:1080 widget component, :3367 and :3465 inside `renderResult` expansions); `pump` (:2499) is a local IIFE inside `retryPendingDeliveries`, not a movable symbol.
Secondary hotspots: `lifecycle.ts`, `completion.ts`, `delivery-barrier.ts` (`flush` class method :86; `flushLegacyBarrier` :175 is separate), `layout.ts`.

CRAP math constrains everything: `CRAP = CC² × (1−cov)³ + CC`.
At cov = 0, `maxCrap` 30 admits only CC ≤ 4.
`execute`, `launchSubagent`, `startBackgroundSpawn` measure 0% under unit coverage (no unit test calls them; reachable only from `test/integration/*` requiring real herdr + `PI_TEST_MODEL`).
So extraction targets for 0%-covered code are CC ≤ 4, not the headline CC ≤ 20.

Constraints:

- Extension public API must not change; tests pass unmodified (except the new launch/execute unit tests this change deliberately adds).
- `__test__` (`src/index.ts:1251`) exports ~60 internals; ~20 test files mutate live state by reference. `runtime.*` lives on `globalThis[RUNTIME_KEY]` (:565) so it survives module moves; `inflightDelivery` (:585) and other module-local Maps do not — identity must be preserved by re-export.
- Session-bound ownership: `ownedCompletionRuntime` (:2811) is per-factory-invocation `let` state closed over by `session_start`/`session_shutdown`; hoisting to module scope violates archived requirement "session-bound completion API ownership" (`openspec/changes/archive/2026-08-10-prevent-discovery-runtime-poisoning/`).
- Package runs `node --test`; no vitest.
  `.fallow.toml` `thresholdOverrides` arrays replace ALL parent entries.
  No `test:coverage` script exists; `fallow` not yet a devDependency; `coverage/` not gitignored.

## Goals / Non-Goals

**Goals:**

- `nr fallow` exits 0 after coverage generation, under the `istanbul` coverage model, dupes included.
- Coverage reproducibly generated (`test:coverage` script), wired into gate config, ignored by git.
- `index.ts` reduced to wiring; `subagentsExtension` under `maxUnitSize`.
- Every `src/**` function under thresholds or explicitly suppressed/overridden with reason; extraction targets sized by measured coverage (CC ≤ 4 at cov 0).

**Non-Goals:**

- No behavior/API/`__test__`-shape changes.
- No test-runner migration, no integration-test changes.
- No suppression as primary strategy.

## Decisions

### D1: Coverage pipeline — c8 script, gate wiring, gitignore

Add `test:coverage` (`c8 --reporter=json --report-dir=coverage node --test …`), normalize only c8's generated-source-map `-1` location columns, and write the resulting Istanbul map to the gitignored `coverage/coverage-final.json`.
Pin `c8` and `fallow`, and set `health.coverage` to that artifact in the package `.fallow.toml`.
Gate pass is defined as "after coverage generation"; the spec's clean-tree scenario says so.
Ad-hoc `--coverage` flag rejected: gate command and coverage-informed check must be the same check.

### D2: CRAP-aware extraction targets

Before splitting any function, note its measured coverage from the Phase 0 baseline.
Units expected to remain at 0% coverage (`execute`, `launchSubagent`, `startBackgroundSpawn` path) target CC ≤ 4 per extracted unit; units with real coverage target CC ≤ 20 / CRAP ≤ 30.
Add unit tests for the launch/execute path to lift measured coverage where feasible; where genuinely impractical, a documented `thresholdOverrides` `maxCrap` entry with `reason` — recorded as explicit debt, not silent failure.

### D3: Pre-extraction before moves

`execute`, `renderCall` (`:3279`), `renderResult` (`:3307`), and the `render` methods are not top-level symbols — they close over `pi` (`pi.getThinkingLevel()` :2996) and `shouldRegister` (:2928).
Sequence: (1) hoist to top-level named functions threading `pi` (and friends) as parameters — signature change expected, NOT a verbatim move; (2) then move to cluster modules.
`pump` is not hoisted; its owner `retryPendingDeliveries` is the movable unit, along with `startDeliveryRetry`, `stopDeliveryRetry`, `deliveryEntryExists` (all in `__test__`).

### D4: Session-bound state travels in an instance-state object

Handler extraction inside `subagentsExtension` uses a per-invocation instance-state object (holding `ownedCompletionRuntime` and kin) created in the factory body and passed explicitly to each extracted handler.
Module-scope hoisting of `ownedCompletionRuntime` is forbidden — an old closure must never clear a replacement session's record.

### D5: Split order — state leaf first, then clusters

1. `src/state.ts` (leaf, imports nothing local): shared mutable state (`runningSubagents`, `pendingDeliveries`, `inflightDelivery`, `deliveredRunIds`, `queuedSubagents`, `stickyTerminalRuns`, `wakeInflightByParent`, `widgetInterval`, …).
   Without this, cluster modules importing state from `index.ts` while `index.ts` imports them = `circular-dependencies` error.
2. Shared types to leaf module(s).
3. Cluster modules, verbatim after D3 pre-extraction: `widget.ts`, `delivery.ts`, `subagent-launch.ts`, `tool-execute.ts`.
4. `index.ts` re-exports every `__test__` member with identical object identity; registration order unchanged.

### D6: Secondary hotspots

- `lifecycle.ts`: `observeActivity` / `observePaneInspection` — **dispatch table** keyed by observation/inspection kind (NOT mechanical per-kind handler clones, which risk ≥50-token/5-line structural duplicates that fail the dupes check; re-run dupes after).
- `completion.ts`: `waitForCompletion` — sidecar polling / timeout budget / evidence sweep.
- `delivery-barrier.ts`: `flush` class method (:86) — per-entry attempt + retry classification. `flushLegacyBarrier` (:175) untouched.
- `layout.ts`: `attachPane` — region selection / tab fallback / placement.

### D7: Test-file thresholds — merged-config-first

Task step 1: dump the effective merged config (`fallow` config resolution) to see ALL inherited `thresholdOverrides` entries.
Then write the package-level `test/**` entry restating every inherited test entry verbatim plus new complexity/CRAP keys.
Do not hard-code `maxUnitSize = 500` — restate what the merged config actually shows.

### D8: Suppression policy

No `fallow-ignore` during main phases.
Post-refactor candidates: `parsePaneGetOutput`, `stripInlineComment` — only if extraction hurts clarity; documented inline with reason.
Spec wording ("no unsuppressed findings") makes this legal.
`stale-suppressions` is warn-severity: green = zero warnings.

## Risks / Trade-offs

- [0%-covered god functions can't reach CRAP ≤ 30 even at CC ≤ 4 if units proliferate] → D2's unit tests for launch/execute; documented override as explicit fallback.
- [Fresh checkout → `static_estimated` → gate red] → D1 defines gate pass as after-coverage; `test:coverage` script makes it one command; CI runs it.
- [Move breaks `__test__` identity / by-reference mutations] → D5 state leaf + re-export; suite green after each cluster.
- [Hoisting `ownedCompletionRuntime` poisons session ownership] → D4 instance-state object; forbidden hoisting called out in tasks.
- [Dispatch-table vs clones trade-off in lifecycle] → D6 dispatch table; dupes re-run verifies.
- [Restating inherited overrides wrong value] → D7 merged-config dump first.
- [Extracted `execute` signature change ripples into `pi.registerTool` call site] → call site becomes a thin closure delegating to the top-level function; behavior identical.

## Migration Plan

1. Phase 0: coverage pipeline + gate wiring + merged-config-aware test override + coverage-informed baseline.
2. Phase 1: D3 pre-extractions (inline methods → top-level), then D5 state leaf + cluster moves; suite green per step.
3. Phase 2: `subagentsExtension` under 60 LOC (D4); god-function refactors at D2 targets; secondary hotspots (D6).
4. Phase 3: tail files; dupes re-check; `nr fallow` green.
5. Rollback: per-commit reverts.

## Open Questions

- `health.coverage` config vs auto-detect — resolved: the package explicitly sets `health.coverage = "coverage/coverage-final.json"`.
- How much of launch/execute is unit-testable without herdr — resolved when writing D2 unit tests; determines whether any `maxCrap` override entries are needed.
- Whether any D8 suppression is needed — after extraction attempts.
