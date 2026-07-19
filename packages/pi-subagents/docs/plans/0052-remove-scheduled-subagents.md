---
issue: 52
issue_title: "feat: remove in-process scheduled subagents"
---

# Remove in-process scheduled subagents

## Problem Statement

The scheduling subsystem reimplements OS-level cron inside a process that is not designed to be a long-lived daemon.
System cron (or launchd) invoking `pi` directly is strictly superior: it survives crashes and reboots, is inspectable via `crontab -l`, and adds zero lines of code to this extension.
The current implementation weighs ~610 source lines plus ~820 test lines, a `croner` dependency, PID-locked file persistence, and scheduler lifecycle wiring scattered across `index.ts`.

## Goals

- Delete the three scheduling source files (`schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`).
- Delete the three scheduling test files (`schedule.test.ts`, `schedule-store.test.ts`, `schedule-e2e.test.ts`).
- Remove all scheduler wiring from `index.ts` (~200 lines of imports, lifecycle hooks, tool-schema gates, and menu routing).
- Remove `ScheduledSubagent` and `ScheduleStoreData` interfaces from `types.ts`.
- Remove `schedulingEnabled` from `SubagentsSettings`, `SettingsAppliers`, and related sanitize/apply logic in `settings.ts`.
- Remove the `croner` dependency from `package.json`.
- Update `README.md` (remove "Scheduling" section and events-table rows) and package `AGENTS.md` (remove scheduling modules from architecture diagram and tables).
- This is a **breaking change** (`feat!:`) — the `schedule` parameter is removed from the `Agent` tool, and the `subagents:scheduled` / `subagents:scheduler_ready` events are no longer emitted.

## Non-Goals

- Removing `bypassQueue` from `SpawnOptions` in `agent-manager.ts` — it remains useful for cross-extension RPC callers.
- Removing other subsystems slated for removal in the architecture doc (output-file, cross-extension-rpc, group-join) — those are separate issues.
- Providing a migration path or compatibility shim — no known consumers depend on the scheduling events.

## Background

The architecture doc (`docs/architecture/architecture.md`) already marks `schedule.ts`, `schedule-store.ts`, and `ui/schedule-menu.ts` as `← removing`.
This issue executes that plan.

The scheduling code touches `index.ts` in several distinct regions:

1. Imports (lines 27–28, 46)
2. Scheduler instance creation and `startScheduler()` helper (lines 445–462)
3. Lifecycle hooks: `session_start`, `session_before_switch`, `session_shutdown` (lines 470–496)
4. The `schedule` tool-schema param shape, conditional inclusion, and guideline string (lines 621–640, 666, 719)
5. Schedule execution path in the Agent tool handler (lines 880–918)
6. `/agents` menu: "Scheduled jobs" entry and routing (lines 1297–1327)
7. `/agents → Settings → Scheduling` toggle (lines 1855–1867)

The `settings.ts` module has `schedulingEnabled` woven into `SubagentsSettings`, `SettingsAppliers`, `sanitize()`, and `applySettings()`.

`types.ts` carries `ScheduledSubagent` (30 lines) and `ScheduleStoreData` (5 lines) — both are only consumed by the scheduling subsystem.

## Design Overview

This is a pure deletion change with no new abstractions.
The approach is inside-out: delete leaf modules first (no dependents), then remove references from the wiring layer (`index.ts`, `settings.ts`, `types.ts`), then clean up docs.

The `bypassQueue` option on `SpawnOptions` stays — its JSDoc comment mentioning "scheduler" should be updated to a generic description since the scheduler is the only current user but the option is architecturally useful for any caller that needs to skip the concurrency queue.

## Module-Level Changes

### Delete

| File                          | Lines |
| ----------------------------- | ----- |
| `src/schedule.ts`             | 365   |
| `src/schedule-store.ts`       | 143   |
| `src/ui/schedule-menu.ts`     | 104   |
| `test/schedule.test.ts`       | 429   |
| `test/schedule-store.test.ts` | 154   |
| `test/schedule-e2e.test.ts`   | 237   |

### Modify

| File                                       | Change                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                             | Remove scheduler imports, instance creation, `startScheduler()`, lifecycle hooks, `scheduleParamShape`/`scheduleParam`/`scheduleGuideline`, schedule execution path in Agent handler, "Scheduled jobs" menu entry + routing, "Scheduling" settings toggle.                   |
| `src/types.ts`                             | Remove `ScheduledSubagent` interface and `ScheduleStoreData` interface.                                                                                                                                                                                                      |
| `src/settings.ts`                          | Remove `schedulingEnabled` from `SubagentsSettings` and `SettingsAppliers`. Remove sanitize clause and `applySettings` clause for `schedulingEnabled`.                                                                                                                       |
| `src/agent-manager.ts`                     | Update `bypassQueue` JSDoc to remove scheduler-specific language.                                                                                                                                                                                                            |
| `package.json`                             | Remove `"croner": "^10.0.1"` from dependencies.                                                                                                                                                                                                                              |
| `README.md`                                | Remove "Scheduling" feature bullet, "Scheduling" subsection (lines 66–96), and `subagents:scheduled` / `subagents:scheduler_ready` rows from the events table.                                                                                                               |
| `.pi/skills/package-pi-subagents/SKILL.md` | Remove `schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts` from the architecture diagram and module tables. Update `index.ts` description to drop scheduler mention. (`packages/pi-subagents/AGENTS.md` is a stub — the architecture content lives in the skill file.) |

## Test Impact Analysis

1. No new unit tests are needed — this is pure deletion.
2. All three scheduling test files (`schedule.test.ts`, `schedule-store.test.ts`, `schedule-e2e.test.ts`) become entirely redundant and are deleted.
3. Existing tests for `agent-manager`, `agent-runner`, `settings`, and other modules stay as-is.
   The `settings.test.ts` file (if it exists) may need minor updates to remove `schedulingEnabled` from fixture data.

## TDD Order

Since this is a removal (not a feature), the order is deletion-first with a single validation pass.

1. **Delete scheduling source files.**
   Delete `src/schedule.ts`, `src/schedule-store.ts`, `src/ui/schedule-menu.ts`.
   Delete `test/schedule.test.ts`, `test/schedule-store.test.ts`, `test/schedule-e2e.test.ts`.
   Commit: `feat!: remove scheduled subagents source and tests`

2. **Remove scheduler wiring from `index.ts`.**
   Remove imports, scheduler instance, `startScheduler()`, lifecycle hooks, schedule-related tool schema params and guideline, schedule execution path in Agent handler, "Scheduled jobs" menu entry/routing, and "Scheduling" settings toggle.
   Commit: `feat!: remove scheduler wiring from index.ts`

3. **Clean up types and settings.**
   Remove `ScheduledSubagent` and `ScheduleStoreData` from `types.ts`.
   Remove `schedulingEnabled` from `SubagentsSettings`, `SettingsAppliers`, `sanitize()`, and `applySettings()` in `settings.ts`.
   Update `bypassQueue` JSDoc in `agent-manager.ts`.
   Commit: `feat!: remove scheduling types and settings`

4. **Remove `croner` dependency.**
   Remove from `package.json`, run `pnpm install` to update lockfile.
   Commit: `build: remove croner dependency`

5. **Verify all tests pass.**
   Run `pnpm vitest run` in the package.
   Fix any test fixtures that reference `schedulingEnabled` or scheduling types.
   Commit (if fixes needed): `test: remove scheduling references from test fixtures`

6. **Update documentation.**
   Update `README.md`: remove scheduling feature bullet, "Scheduling" subsection, and event-table rows.
   Update package `AGENTS.md`: remove scheduling modules from architecture diagram and module tables, update `index.ts` description.
   Commit: `docs: remove scheduling from README and AGENTS`

## Risks and Mitigations

| Risk                                             | Mitigation                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Missed scheduling reference causes compile error | `grep -rn 'schedule\|Schedule\|croner' src/` after each step to catch stragglers. TypeScript `noEmit` check catches import errors. |
| Test fixtures reference `schedulingEnabled`      | Step 5 explicitly scans for and fixes these.                                                                                       |
| `bypassQueue` removal mistakenly included        | Explicitly excluded in Non-Goals; plan preserves the option and only updates its JSDoc.                                            |
| Breaking change not communicated                 | `feat!:` commit prefix triggers a major version bump via release-please.                                                           |

## Open Questions

None — the issue scope is fully specified and the architecture doc already ratified this removal.
