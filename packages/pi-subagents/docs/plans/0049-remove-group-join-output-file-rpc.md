---
issue: 49
issue_title: "feat: remove group-join, output-file, and ad-hoc RPC"
---

# Remove group-join and ad-hoc RPC

## Problem Statement

Two optional subsystems remain in the core that are either consumer concerns or replaced by the typed `SubagentsAPI` (#48):

1. **Group join** — grouped completion notifications add batching complexity for marginal UX benefit when individual notifications are sufficient.
2. **Ad-hoc RPC** — untyped RPC over `pi.events` with per-request reply channels is replaced by the typed `SubagentsAPI` published via `Symbol.for()`.

Removing these two subsystems reduces the core's surface area by ~220 source LOC, eliminates the join-mode settings system, and simplifies the completion callback path in `index.ts`.

The **output file** subsystem (`src/output-file.ts`) is retained — it provides valuable post-hoc debugging transcripts for subagent sessions.
A separate issue (#61) tracks porting it to Pi's official JSONL session format.

## Goals

- Delete `src/group-join.ts` (141 LOC) and `src/cross-extension-rpc.ts` (80 LOC).
- Delete `test/cross-extension-rpc.test.ts`.
- Remove all group-join wiring from `index.ts`: `GroupJoinManager` instantiation, batch tracking (`currentBatchAgents`, `finalizeBatch`, `batchFinalizeTimer`, `batchCounter`), join-mode configuration state, and settings menu entry.
- Remove all RPC wiring from `index.ts`: `registerRpcHandlers` import, `currentCtx` capture for RPC, `unsubPing/Spawn/Stop` teardown, and the `subagents:ready` broadcast.
- Remove `JoinMode` type and `joinMode`/`groupId` fields from `types.ts`.
- Remove `NotificationDetails.others` field (no longer needed without grouping).
- Remove `defaultJoinMode` from `SubagentsSettings` and `SettingsAppliers` in `settings.ts`.
- Remove `resolveJoinMode` from `invocation-config.ts`.
- Simplify the completion callback in `index.ts` to always send an individual notification.
- Preserve existing lifecycle events (`subagents:started`, `subagents:completed`, `subagents:failed`) — they are already emitted.
- This is a **breaking change** (`feat!:`) — the join-mode setting is removed and RPC channels are no longer registered.

## Non-Goals

- Removing the `Symbol.for("pi-subagents:manager")` global accessor — that belongs to #48 (implement SubagentsAPI), which replaces it with the typed `publishSubagentsAPI()`.
- Removing `bypassQueue` from `SpawnOptions` — it remains useful for the typed API.
- Providing migration shims for RPC consumers — none known.
- Removing or modifying `src/output-file.ts` — retained for debugging value; porting to Pi's JSONL format is tracked in #61.

## Background

The architecture doc marks these modules as "removing."
Issue #52 (remove scheduled subagents) is already implemented and merged.
Issue #48 (implement SubagentsAPI) depends on RPC removal here since the typed API replaces the untyped RPC.

The `index.ts` file is the primary wiring layer affected.
The completion callback currently routes through `groupJoin.onAgentComplete()` and only falls through to `sendIndividualNudge()` on `'pass'`.
After this change, the callback always calls `sendIndividualNudge()` directly, which simplifies the control flow from ~90 lines of group/batch logic down to a single function call.

The `currentCtx` variable captured in `session_start` exists solely for the RPC spawn handler.
After RPC removal, session lifecycle hooks simplify: `session_start` only needs `manager.clearCompleted()`.

## Design Overview

This is a pure deletion change with minor simplification of the remaining completion path.

After removal, the background-agent completion flow becomes:

1. `AgentManager` calls `onComplete(record)`.
2. `onComplete` emits `subagents:completed` or `subagents:failed` on `pi.events`.
3. `onComplete` persists the record via `pi.appendEntry`.
4. If `record.resultConsumed`, clean up widget and return.
5. Otherwise, call `sendIndividualNudge(record)` — which schedules the notification with a 200ms debounce window (retained for `get_subagent_result` cancellation).

The `NotificationDetails` interface stays (individual notifications still use it) but loses the `others` field.
The `outputFile` field on `NotificationDetails` stays since output-file is retained.

### Settings changes

`SubagentsSettings` loses `defaultJoinMode`.
The settings menu loses the "Join mode" entry.
`snapshotSettings()` and `persistToastFor()` patterns are unchanged — they just carry one fewer field.

### Types changes

```typescript
// Remove from types.ts:
export type JoinMode = 'async' | 'group' | 'smart';

// Remove from AgentRecord:
groupId?: string;
joinMode?: JoinMode;

// Remove from NotificationDetails:
others?: NotificationDetails[];
```

`AgentRecord.outputFile`, `outputCleanup`, and `toolCallId` are retained — they support the output-file subsystem which remains in scope.

## Module-Level Changes

### Delete

| File                               | Lines |
| ---------------------------------- | ----- |
| `src/group-join.ts`                | 141   |
| `src/cross-extension-rpc.ts`       | 80    |
| `test/cross-extension-rpc.test.ts` | ~220  |

### Modify

| File                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                             | Remove imports for group-join and RPC modules. Remove `GroupJoinManager` instantiation and the grouped-delivery callback (~30 lines). Remove batch tracking state and `finalizeBatch()` (~40 lines). Remove join-mode state (`defaultJoinMode`, `getDefaultJoinMode`, `setDefaultJoinMode`). Remove RPC registration, `currentCtx` capture, `unsubPing/Spawn/Stop` teardown. Remove `subagents:ready` emit. Remove "Join mode" settings menu entry and `snapshotSettings` join-mode field. Simplify `onComplete` callback to always call `sendIndividualNudge`. Remove the `currentBatchAgents` deferred-notification check. Remove join-mode resolution in background spawn path. |
| `src/types.ts`                             | Remove `JoinMode` type. Remove `groupId` and `joinMode` from `AgentRecord`. Remove `others` from `NotificationDetails`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/settings.ts`                          | Remove `JoinMode` import. Remove `defaultJoinMode` from `SubagentsSettings`. Remove `setDefaultJoinMode` from `SettingsAppliers`. Remove `VALID_JOIN_MODES`. Remove sanitize clause and `applySettings` clause for `defaultJoinMode`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/invocation-config.ts`                 | Remove `JoinMode` import. Remove `resolveJoinMode` export.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `README.md`                                | Remove "Cross-extension RPC" section. Remove join-mode documentation. Remove `subagents:ready` from events table. Update settings persistence paragraph to drop join-mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `.pi/skills/package-pi-subagents/SKILL.md` | Remove `cross-extension-rpc.ts` and `group-join.ts` from architecture diagram and module tables. Update `index.ts` description.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Test Impact Analysis

1. No new unit tests are needed — this is pure deletion.
2. `test/cross-extension-rpc.test.ts` becomes entirely redundant and is deleted.
3. `test/output-file.test.ts` is retained (output-file stays).
4. There is no dedicated `group-join.test.ts` — the group-join logic was only tested indirectly through integration.
5. Existing tests for `agent-manager`, `agent-runner`, `settings`, and `invocation-config` must be checked for references to `joinMode`, `groupId`, `defaultJoinMode`, or `resolveJoinMode` — any such references need updating.
6. The notification renderer test (if any) may reference `others` on `NotificationDetails` — check and remove.

## TDD Order

Since this is a removal (not a feature), the order is deletion-first with validation passes.

1. **Delete source files for both subsystems.**
   Delete `src/group-join.ts`, `src/cross-extension-rpc.ts`.
   Delete `test/cross-extension-rpc.test.ts`.
   Commit: `feat!: remove group-join and cross-extension-rpc source`

2. **Remove RPC wiring from `index.ts`.**
   Remove `registerRpcHandlers` import and call.
   Remove `currentCtx` state and RPC-related `session_start`/`session_shutdown` logic (keep `manager.clearCompleted()` call).
   Remove `unsubPing/Spawn/Stop` teardown.
   Remove `subagents:ready` emit.
   Commit: `feat!: remove RPC wiring from index.ts`

3. **Remove group-join wiring from `index.ts`.**
   Remove `GroupJoinManager` import and instantiation (including the grouped-delivery callback).
   Remove batch tracking (`currentBatchAgents`, `batchFinalizeTimer`, `batchCounter`, `finalizeBatch`).
   Remove `defaultJoinMode` state, `getDefaultJoinMode`, `setDefaultJoinMode`.
   Remove join-mode resolution in background spawn path.
   Remove "Join mode" settings menu entry.
   Remove `defaultJoinMode` from `snapshotSettings()`.
   Simplify the `onComplete` callback: remove `currentBatchAgents` check and `groupJoin.onAgentComplete()` routing — always call `sendIndividualNudge(record)`.
   Remove `setDefaultJoinMode` from `applyAndEmitLoaded` appliers.
   Commit: `feat!: remove group-join wiring from index.ts`

4. **Clean up types, settings, and invocation-config.**
   Remove `JoinMode` type from `types.ts`.
   Remove `groupId` and `joinMode` from `AgentRecord`.
   Remove `others` from `NotificationDetails`.
   Remove `defaultJoinMode` from `SubagentsSettings` and `SettingsAppliers` in `settings.ts`.
   Remove `VALID_JOIN_MODES` and sanitize/apply clauses.
   Remove `resolveJoinMode` and `JoinMode` import from `invocation-config.ts`.
   Commit: `feat!: remove join-mode types and settings`

5. **Verify all tests pass and fix straggling references.**
   Run `pnpm vitest run` and `pnpm run check`.
   Fix any test fixtures or assertions that reference removed fields (`joinMode`, `groupId`, `defaultJoinMode`, `resolveJoinMode`).
   Commit (if fixes needed): `test: remove references to deleted subsystems from test fixtures`

6. **Update documentation.**
   Update `README.md`: remove "Cross-extension RPC" section, join-mode documentation, `subagents:ready` event row.
   Update settings persistence paragraph.
   Update `.pi/skills/package-pi-subagents/SKILL.md`: remove `cross-extension-rpc.ts` and `group-join.ts` from architecture diagram and module tables, update `index.ts` description.
   Commit: `docs: remove group-join and RPC from README and AGENTS`

## Risks and Mitigations

| Risk                                                      | Mitigation                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed references cause compile errors                    | `grep -rn 'group.join\|GroupJoin\|registerRpcHandlers\|resolveJoinMode\|JoinMode' src/` after each step. `pnpm run check` catches import errors.                       |
| Test fixtures reference removed fields                    | Step 5 explicitly scans for and fixes these. TypeScript `noEmit` check catches type mismatches.                                                                        |
| `Symbol.for("pi-subagents:manager")` accidentally removed | Explicitly out of scope — this belongs to #48. The global accessor stays until the typed API replaces it.                                                              |
| Breaking change not communicated                          | `feat!:` commit prefix triggers a major version bump via release-please.                                                                                               |
| Settings file with `defaultJoinMode` on disk              | `sanitize()` already drops unknown fields silently — once the field is removed from the interface, existing files just have an inert JSON key that is ignored on load. |

## Open Questions

None — the issue scope is fully specified and the architecture doc ratified these removals.
