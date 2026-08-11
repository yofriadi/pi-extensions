# Coverage-informed Fallow Baseline

Generated with `pnpm run test:coverage` followed by `pnpm exec fallow health --format json --pretty` on 2026-08-11.

- **Test suite:** 348 passed, 0 failed
- **Coverage model:** `istanbul` (389 of 1,546 functions matched)
- **Health findings:** 41 production findings after the explicit test-file override
- **Effective defaults:** `maxCyclomatic = 20`, `maxCognitive = 15`, `maxCrap = 30.0`, `maxUnitSize = 60`

## Effective inherited test override (recorded before replacement)

The inherited config had exactly one `health.thresholdOverrides` entry:

```toml
[[health.thresholdOverrides]]
files = ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**"]
maxUnitSize = 500
reason = "describe()/it() callbacks are whole-suite closures; relax the unit-size ceiling for test files so health stays prod-focused (complexity/CRAP checks unchanged)."
```

The package-level entry restates those fields verbatim, then adds bounded test-only `maxCyclomatic = 20`, `maxCognitive = 20`, and `maxCrap = 200.0` ceilings.
The baseline test maxima were CC 13, cognitive 18, and CRAP 182.

## Production findings and extraction targets

`istanbul` is exact where a source function can be matched.
`estimated` / `not measured` findings are still listed because they must be remediated; after a module move, regenerate coverage before selecting a final CRAP target.
A 0%-covered function targets CC ≤ 4 unless new unit coverage raises its measured percentage.

| File                      | Function / line                                        | Metrics                        | Measured coverage | Target                                                 |
| ------------------------- | ------------------------------------------------------ | ------------------------------ | ----------------- | ------------------------------------------------------ |
| `src/activity.ts`         | `<arrow>` :488                                         | CC 5, cog 4, CRAP 30           | estimated         | standard                                               |
| `src/agent-definition.ts` | `stripInlineComment` :57                               | CC 12, cog 22                  | not measured      | standard; suppression only if extraction hurts clarity |
| `src/completion.ts`       | `waitForCompletion` :206                               | CC 22, cog 40                  | not measured      | standard                                               |
| `src/delivery-barrier.ts` | `flush` :86                                            | CC 28, cog 33, CRAP 36.1       | 78.18%            | standard                                               |
| `src/herdr.ts`            | `getHerdrCurrentPaneInfo` :150                         | CC 12, cog 6, CRAP 156         | **0%**            | **CC ≤ 4** or add coverage                             |
| `src/herdr.ts`            | `getHerdrPaneLayout` :240                              | CC 19, cog 12, CRAP 79.4       | 44.90%            | standard                                               |
| `src/index.ts`            | arrows :1189, :2172, :2585, :2830, :2885, :3067, :3458 | CC 7–16, cog 4–18, CRAP 56–272 | estimated         | standard                                               |
| `src/index.ts`            | `captureStickyLaunchFailure` :1921                     | CC 6, cog 5, CRAP 42           | **0%**            | **CC ≤ 4** or add coverage                             |
| `src/index.ts`            | `ensureLifecycle` :1122                                | CC 24, cog 22, CRAP 188.9      | 34.09%            | standard                                               |
| `src/index.ts`            | `execute` :2947                                        | CC 57, cog 59, CRAP 3306       | **0%**            | **CC ≤ 4** units; add execute-path tests               |
| `src/index.ts`            | `findDeliveryEntry` :2393                              | CC 20, cog 25                  | not measured      | standard                                               |
| `src/index.ts`            | `launchSubagent` :1398                                 | CC 35, cog 46, CRAP 1260       | **0%**            | **CC ≤ 4** units; add launch-path tests                |
| `src/index.ts`            | `lifecycleActivityLead` :883                           | CC 17, cog 16                  | not measured      | standard                                               |
| `src/index.ts`            | `pump` :2499                                           | CC 19, cog 30, CRAP 380        | estimated         | move/refactor its `retryPendingDeliveries` owner       |
| `src/index.ts`            | `render` :3367                                         | CC 27, cog 41, CRAP 756        | estimated         | standard                                               |
| `src/index.ts`            | `renderResult` :3307                                   | CC 22, cog 28, CRAP 37.9       | 68.00%            | standard                                               |
| `src/index.ts`            | `renderSubagentWidgetLines` :914                       | CC 33, cog 41, CRAP 33         | 99.29%            | standard                                               |
| `src/index.ts`            | `settleParentShutdown` :2760                           | CC 12, cog 17                  | not measured      | standard                                               |
| `src/index.ts`            | `startBackgroundSpawn` :2688                           | CC 7, cog 6, CRAP 56           | **0%**            | **CC ≤ 4** or add coverage                             |
| `src/index.ts`            | `telemetryParts` :819                                  | CC 15, cog 17                  | not measured      | standard                                               |
| `src/index.ts`            | `watchSubagent` :1951                                  | CC 45, cog 54, CRAP 257.5      | 52.83%            | standard                                               |
| `src/layout.ts`           | `attachPane` :315                                      | CC 28, cog 26                  | not measured      | standard                                               |
| `src/layout.ts`           | `ranked` :178, :193                                    | CC 5–11, cog 5–9, CRAP 30–132  | estimated         | standard                                               |
| `src/lifecycle.ts`        | `detail` :221                                          | CC 13, cog 12, CRAP 182        | estimated         | standard                                               |
| `src/lifecycle.ts`        | `formatLifecycleTransitionLine` :507                   | CC 8, cog 8, CRAP 72           | **0%**            | **CC ≤ 4** or add coverage                             |
| `src/lifecycle.ts`        | `observeActivity` :198                                 | CC 39, cog 41, CRAP 45.3       | 83.93%            | standard                                               |
| `src/lifecycle.ts`        | `observePaneInspection` :106                           | CC 29, cog 38                  | not measured      | standard                                               |
| `src/runtime-routing.ts`  | `resolveRuntimePlan` :184                              | CC 17, cog 24                  | not measured      | standard                                               |
| `src/skills.ts`           | `collision` :54                                        | CC 5, cog 1, CRAP 30           | estimated         | standard                                               |
| `src/status.ts`           | `observeStatus` :143                                   | CC 27, cog 22                  | not measured      | standard                                               |
| `src/subagent-done.ts`    | arrows :120, :195, :300                                | CC 6–10, cog 2–10, CRAP 42–110 | estimated         | standard                                               |
| `src/terminal.ts`         | `runScriptInPane` :73                                  | CC 5, cog 2, CRAP 30           | **0%**            | **CC ≤ 4** or add coverage                             |

The baseline also found test-only functions in the selected integration helpers.
They are governed by the explicit bounded test-file override rather than production thresholds.
