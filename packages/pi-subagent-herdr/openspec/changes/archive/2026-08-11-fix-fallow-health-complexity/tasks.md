# Tasks: fix-fallow-health-complexity

Thresholds (schema defaults): `maxCyclomatic` 20 · `maxCognitive` 15 · `maxCrap` 30.0 · `maxUnitSize` 60.
CRAP reality: `CRAP = CC² × (1−cov)³ + CC` → at cov 0, `maxCrap` 30 admits only **CC ≤ 4**.
Extraction targets are per-function, sized from measured coverage (task 1.5 baseline).

## 1. Coverage pipeline + baseline

- [x] 1.1 Add `c8` and `fallow` devDependencies; add `test:coverage` script (`c8 --reporter=json --report-dir=coverage node --test …`) emitting `coverage/coverage-final.json`; add `coverage/` to `.gitignore`
- [x] 1.2 Wire coverage into the gate: set `health.coverage` in package `.fallow.toml` or confirm auto-detect of `coverage/coverage-final.json`; verify bare `fallow health` reports the `istanbul` coverage model
- [x] 1.3 Dump the effective merged config; record ALL inherited `thresholdOverrides` entries
- [x] 1.4 Add `test/**` override entry in package `.fallow.toml` restating every inherited test entry verbatim (from 1.3, not a hard-coded value) plus new complexity/CRAP keys
- [x] 1.5 Run coverage-informed `fallow health`; record per-function measured coverage + the true above-threshold list; compute per-function extraction targets (CC ≤ 4 where cov = 0)

## 2. Pre-extraction: inline methods/closures → top-level functions

These symbols are NOT top-level and cannot be moved verbatim; hoist first, threading `pi` (and `shouldRegister` etc.) as parameters.
Signature changes expected.
Suite green after each.

- [x] 2.1 Hoist `execute` (`pi.registerTool` method, :2947) to top-level `executeSubagentTool(pi, ...)`; registration site becomes thin delegating closure
- [x] 2.2 Hoist `renderCall` (:3279) and `renderResult` (:3307) to top-level named functions
- [x] 2.3 Hoist the three `render` functions — widget component render (:1080), render inside `renderResult` expansion (:3367), render at :3465 — disambiguated by line number
- [x] 2.4 Do NOT hoist `pump` (:2499, local IIFE) — its owner `retryPendingDeliveries` is the movable unit
- [x] 2.5 Hoist handler bodies registered inside `subagentsExtension` with a per-invocation instance-state object (holding `ownedCompletionRuntime` and kin) passed explicitly; module-scope hoisting of `ownedCompletionRuntime` FORBIDDEN (session-bound ownership invariant)

## 3. Split src/index.ts — state leaf, then clusters (verbatim after section 2)

- [x] 3.1 Create leaf `src/state.ts` (imports nothing local): move shared mutable state (`runningSubagents`, `pendingDeliveries`, `inflightDelivery`, `deliveredRunIds`, `queuedSubagents`, `stickyTerminalRuns`, `wakeInflightByParent`, `widgetInterval`, …); re-export from `index.ts` preserving identity.
      Prevents `circular-dependencies` error
- [x] 3.2 Extract shared types needed by new modules into leaf module(s)
- [x] 3.3 Move widget cluster (`renderSubagentWidgetLines`, hoisted renders/renderCall/renderResult, glyph/fit/format helpers) to `src/widget.ts`; suite green
- [x] 3.4 Move delivery cluster (`retryPendingDeliveries`, `startDeliveryRetry`, `stopDeliveryRetry`, `deliveryEntryExists`, `deliverBackgroundMessage`, `findDeliveryEntry`, `queuePendingDeliveryWithVerification`, `acknowledgeDelivery`, `verifyDeliveryPersisted`, `wakeParent`) to `src/delivery.ts`; suite green
- [x] 3.5 Move launch/watch cluster (`launchSubagent`, `watchSubagent`, `startBackgroundSpawn`, sticky-capture helpers) to `src/subagent-launch.ts`; suite green
- [x] 3.6 Move tool execution cluster (hoisted `executeSubagentTool` + helpers) to `src/tool-execute.ts`; suite green
- [x] 3.7 Verify `__test__` shape unchanged and every exported mutable instance keeps object identity (by-reference test mutations keep working); `subagentsExtension` now under 60 LOC — if not, finish handler extraction per 2.5

## 4. God-function refactors (targets from 1.5 baseline)

- [x] 4.1 Split `execute` (57/59) — 0%-covered: CC ≤ 4 units; add unit tests for the execute path to lift measured coverage, else documented `maxCrap` override with reason
- [x] 4.2 Split `watchSubagent` (45/54)
- [x] 4.3 Split `launchSubagent` (35/46) + `startBackgroundSpawn` — direct launch-path unit coverage exercises child-session seeding, artifacts, pane-script handoff, commit, and background-spawn rollback.
- [x] 4.4 Split `renderSubagentWidgetLines` (33/41) and the flagged `render` (:3367, 27/41)
- [x] 4.5 Split delivery-cluster functions still flagged (`findDeliveryEntry`, `retryPendingDeliveries`, `deliverBackgroundMessage`)
- [x] 4.6 `src/lifecycle.ts`: `observeActivity` (39/41) + `observePaneInspection` (29/38) via **dispatch table** keyed by kind (NOT per-kind clones — structural duplicates fail dupes check)
- [x] 4.7 `src/completion.ts`: split `waitForCompletion` (22/40) — sidecar polling / timeout budget / evidence sweep
- [x] 4.8 `src/delivery-barrier.ts`: split `flush` class method (:86; NOT `flushLegacyBarrier` :175) — per-entry attempt + retry classification
- [x] 4.9 `src/layout.ts`: split `attachPane` (28/26) — region selection / tab fallback / placement
- [x] 4.10 Re-run `nr fallow` incl. dupes after 4.6; resolve any structural-clone findings — 0 clone groups/families.

## 5. Tail files

- [x] 5.1 Re-run coverage-informed `fallow health`; list remaining flagged functions in `status.ts`, `herdr.ts`, `runtime-routing.ts`, `agent-definition.ts`, `activity.ts`, `subagent-done.ts`, `session.ts`, `coordinator.ts` — remaining: `observeStatus`, `getHerdrPaneLayout`, `getHerdrCurrentPaneInfo`, `resolveRuntimePlan`, `stripInlineComment`, activity/subagent-done callbacks, plus parent lifecycle and zero-coverage tail helpers.
- [x] 5.2 Extract branch clusters / flatten guards per remaining function at its measured-coverage target — fresh coverage-informed `fallow health` reports 0 functions above threshold (5.x tail list cleared)
- [x] 5.3 Evaluate `fallow-ignore` only for irreducible parsers (`parsePaneGetOutput`, `stripInlineComment`) if extraction hurts clarity; document reason inline — none needed: both parsers pass thresholds under measured coverage without suppressions

## 6. Verify

- [x] 6.1 Full pre-existing `node --test` suite passes unmodified (358 tests, 90 suites, 0 fail); new launch/execute/delivery-tail unit tests pass
- [x] 6.2 `nr typecheck` (`tsc --noEmit`) and `nr check` (`biome check .`) pass
- [x] 6.3 `nr test:coverage` then `nr fallow` exits 0 under the `istanbul` coverage model — dead code, dupes, health green; 5 pre-existing dead public-API exports (`listRegions`, `pendingCount`, `renameCurrentTab`, `renameCurrentWorkspace`, `HerdrPaneRect`) suppressed with documented `fallow-ignore` comments (public API preserved from HEAD)
- [x] 6.4 `circular-dependencies` (error) green; `stale-suppressions` emits zero warnings
