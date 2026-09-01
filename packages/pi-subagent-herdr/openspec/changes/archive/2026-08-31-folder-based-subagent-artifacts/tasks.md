## 1. Companion Directory Helper & Eliminate `owner.json`

- [x] 1.1 Export `getSubagentArtifactDir(sessionFile: string): string` in `src/session.ts`.
      It MUST throw on any input not ending in `.jsonl` — no silent fallback (a fallback aliases the artifact dir to the session file and every deletion site is recursive).
- [x] 1.2 Remove `writeSessionOwner`, `getSessionOwnerPath`, and `SubagentSessionOwner` from `src/session.ts`; retain `SUBAGENT_OWNER_VERSION` (still used by the session header).
- [x] 1.3 Remove `owner.json` creation from `seedSubagentSessionFile` in `src/session.ts`.

## 2. Launch Artifacts & Dependency Contract

- [x] 2.1 Update `subagent-launch.ts` to write `launch.sh`, `task.md`, and `sysprompt.md` inside `<stem>/` (fixed names; drop the `subagent-scripts/` and `context/` subpaths and their timestamp+runId templates, including the timestamp computation in `systemPromptPath`).
      Create `<stem>/` at the parent's creation sites with `mode: 0o700` (activity directory `:506-507`, launch-artifact writes `:587`) — `mkdirSync` never chmods an existing directory, so the first creator sets the mode.
- [x] 2.2 Collapse the injected deps `getArtifactDir(sessionDir, sessionId)` and `getSubagentActivityFile(artifactDir, runningChildId)` into `getSubagentArtifactDir(sessionFile)`; update `LaunchDeps`, remove `LaunchState.artifactDir`, and update the `createSubagentLaunchService({...})` wiring in `src/index.ts`.
      Also remove the now-readerless `StableParentContext.sessionDir` (`types.ts:93`, writers `index.ts:338, :345`) and update its test sites (`test/runtime-safety.test.ts:82-96`, `test/tool-execute.test.ts:30`, `test/subagent-launch.test.ts:94`) — same `fallow:dead-code` rationale.
- [x] 2.3 Update `registerSessionRollbacks` (`src/subagent-launch.ts:515-518`) to exactly TWO rollbacks: the companion directory (`<stem>/`) and the session file itself (`rmSync(state.subagentSessionFile)` — RETAINED, so a failed launch never orphans a listable `.jsonl`, and the retry sibling's conditionality has something to condition on).
      Remove the `.owner.json` and per-file artifact rollbacks (the per-file `own()` sites at `:588` and `:657`) and the vestigial `state.rollbackPaths` / `cleanupRollbackPaths` — including the initializer at `:381` — (`:108, :590, :660, :719, :728-734`).
- [x] 2.4 Remove `buildLaunchArtifactName` and its `LaunchDeps` declaration, wiring in `src/index.ts` (`:655`), `__test__` entry (`index.ts:712`), and the `@<taskArtifact>` naming expectations — required by the `fallow:dead-code` gate.

## 3. Activity, Exit IPC & the Single Deletion Site

- [x] 3.1 Change `getSubagentActivityFile` in `src/activity.ts` to `(sessionFile) => join(getSubagentArtifactDir(sessionFile), "activity.json")` (top-level import of `./session.ts` — no cycle); drop its `runningChildId` parameter (`:113-115`) and the temp-file interpolation in `writeSubagentActivityFile` (`:221`, which reads the retained `activity.runningChildId` state field, not the parameter).
- [x] 3.2 In `src/subagent-done.ts`: derive the sidecar path via `getSubagentArtifactDir(PI_SUBAGENT_SESSION)` (top-level import from `./session.ts`), keep the tmp+rename atomic write, and add a recursive `mkdirSync` of the companion directory with `mode: 0o700` before writing (post-settlement continuation writes must not ENOENT — on the `subagent_done` tool path the throw would surface before `ctx.shutdown()`).
- [x] 3.3 In `src/subagent-done.ts`: reorder the settle path so the activity recorder is stopped and its final write flushed BEFORE `publishSettledSidecar` (currently sidecar at `:319` precedes `agentEndDone()` at `:321`; post-reorder the disabled recorder early-returns, so the child cannot recreate `<stem>/` after deletion).
      The `subagent_done` tool path already has the correct order.
- [x] 3.4 Update `consumeExitSidecar` in `src/completion.ts` to read `<stem>/exit.json`; keep unlink-on-every-read (valid, malformed, or stale — deterministic consumption) and the ownership check.
      It deletes NOTHING else — no directory decisions here (deleting at consumption would strand the final activity read on a missing `activity.json` and treat a lost settlement claim as already-cleaned).
- [x] 3.5 Make `applySettlementDisposition` (`src/subagent-launch.ts:200-207`) the SINGLE settlement deletion site, running after transcript extraction (`:794`) and the final activity observation (`:785`).
      Change `resolveSettlementDisposition` to accept the full `CompletionResult` (not `reason` alone — the sentinel channel yields `exitCode: N` for any N) and to return the artifact decision (e.g. a `preserveArtifacts` field).
      Deletion rule, per channel: sidecar-derived success deletes only when `exitCode === 0` AND the result's runId equals `running.id` (fail-closed — absent or mismatched preserves); sentinel success deletes on `exitCode === 0` alone (sentinel results carry no runId and bind via the run's own pane tail); any nonzero exit preserves `<stem>/` minus the consumed `exit.json`.

## 4. Remove Legacy Parent Artifact Directory

- [x] 4.1 Remove the obsolete `getArtifactDir` helper from `src/index.ts` and all remaining references (it is dep-injected, not exported; covered together with the dep-contract change in 2.2/2.4; this item tracks the helper removal).

## 5. Test Updates & Verification

- [x] 5.1 `test/test.ts`: update all legacy-path sites — `.exit` assertions (`~:1655, :1676, :1695, :1716, :1811, :1825`), the eight `getSubagentActivityFile(dir, …)` call sites (`~:2269-2492`), the `subagent-activity/` mkdir (`~:2321`), and the `buildLaunchArtifactName` collision test (`~:1044-1045`) — and assert `.jsonl` header provenance instead of `owner.json` (site `~:458-483`).
- [x] 5.2 `test/subagent-launch.test.ts`: update the injected deps doubles (`~:57, :60, :62`), the owner assertion (`~:159`), and the `artifacts/<sessionId>/context/` layout + `@<taskArtifact>` command assertions (`~:193-215`); remove only the **owner** fixture expectations this change invalidates (retain `seed` fixtures — this change keeps `seed: fresh|fork`, and the retry sibling's task 5.4 depends on those fixtures existing).
- [x] 5.3 `test/review-fixes.test.ts`: update the `readSidecar` helper (`~:596`, builds `${sessionFile}.exit`) and the settle-path sidecar tests (`~:620-677, :743-759`) to `<stem>/exit.json`; the stale-sidecar fixture gains a companion directory and asserts the live run's artifacts survive.
- [x] 5.4 `test/completion-timeout.test.ts`: update the `.exit` writer (`~:38`) for the "evidence races the deadline" test.
- [x] 5.5 Update the disposition-callers that are invisible to `tsc` (positional `any`-typed calls): `test/watch-abandoned.test.ts:72-113` and `test/abandoned-lease.test.ts:16-20, :127-169` — assert the new result-keyed signature and its returned `preserveArtifacts` decision, including that a nonzero sentinel exit preserves `<stem>/`, a sentinel exit-zero success deletes it, and a sidecar success lacking the run's id preserves it (fail-closed).
- [x] 5.6 Rename the `session.json` sidecar fixture to a `.jsonl` name (`test/test.ts:1715` — the new helper throw makes this mandatory) and give the rewritten sidecar fixtures a companion directory before their `exit.json` writes.
- [x] 5.7 Add coverage: (a) `getSubagentArtifactDir` throws on non-`.jsonl` input; (b) stale/foreign-runId sidecar is consumed and rejected WITHOUT deleting `<stem>/`; (c) success deletes `<stem>/` via the settlement disposition, AFTER extraction and the final activity read — the sidecar path on a runId match, the sentinel path on exit zero alone; (d) nonzero/crash/abandoned preserves `<stem>/` minus `exit.json`; (e) a sidecar success without the run's id preserves `<stem>/` (fail-closed); (f) child flushes activity before writing the sidecar (and cannot recreate the directory afterwards); (g) sidecar write creates a missing companion directory with `0o700`; (h) Pi-core session discovery ignores `<stem>/` directories — asserted via the real exported `SessionManager.list` from `@earendil-works/pi-coding-agent`, not a local re-implementation.
- [x] 5.8 Run `pnpm run check`, `pnpm test`, and the `fallow` code-health gate (`nr fallow`) — this change deletes several functions.

## 6. Sequencing

- [ ] 6.1 This change archives BEFORE `subagent-auto-retry-and-resume`.
      After it lands, the retry change's `pane-surface`/`completion-delivery` deltas must be rebased onto this merged base text (`<stem>/exit.json`, delete-on-success/preserve-on-failure, sidecar-ownership-gated deletion, single disposition deletion site) per that change's sequencing section.
      Rebase obligations the sibling must absorb are listed in this change's proposal (`## Sequencing`), including the activity file no longer being per-runId.
