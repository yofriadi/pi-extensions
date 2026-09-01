## Context

Pi subagents run as separate processes and write their conversation to standard Pi session files (`<stem>.jsonl`).
To coordinate process settlement, launch execution, and track live activity, `pi-subagent-herdr` previously scattered artifacts across multiple paths:

- Flat `.owner.json` sidecars (redundant with the `.jsonl` header line)
- Flat `.exit` sidecars (non-standard compound file extension)
- Global `artifacts/<parentSessionId>/` holding `context/`, `subagent-scripts/`, and `subagent-activity/`

This design consolidates all ephemeral and run-specific artifacts into a single companion directory `<session_dir>/<stem>/` matching `<session_dir>/<stem>.jsonl`, eliminates redundant files, and implements a strict cause-and-effect lifecycle.

## Goals / Non-Goals

**Goals:**

- Consolidate all subagent run artifacts (`launch.sh`, prompts, `activity.json`, `exit.json`) into `<session_dir>/<stem>/`.
- Eliminate the redundant `owner.json` file completely, relying solely on the `.jsonl` header.
- Maintain a clean sessions directory after successful runs: `<stem>/` is deleted upon successful settlement (`exitCode === 0`).
- Preserve `<stem>/` intact when a run fails or crashes (`exitCode !== 0`) so developers can inspect and debug.
- Enforce strict cause-to-action lifecycle: no implicit background deletion or magic startup sweeps.

**Non-Goals:**

- Moving `.jsonl` session files into subdirectories (session files remain flat in `sessions/--project--/`).
- Preserving backward compatibility for legacy compound sidecars (`.jsonl.exit`, `.jsonl.owner.json`) or legacy `artifacts/<parentSessionId>/` hierarchy.

## Decisions

### 1. Companion Directory Derivation (fail closed)

For any subagent session file path ending in `.jsonl`, its companion artifact directory is derived by stripping the `.jsonl` extension:

```typescript
export function getSubagentArtifactDir(sessionFile: string): string {
	if (!sessionFile.endsWith(".jsonl")) {
		throw new Error(`Session file must end in .jsonl: ${sessionFile}`);
	}
	return sessionFile.slice(0, -6);
}
```

The helper MUST throw on any non-`.jsonl` input.
A silent fallback that returns the input unchanged would alias the artifact directory to the session file itself, and every deletion site below is recursive — the child transcript would be destroyed. (`test/test.ts:1715` drives the sidecar path with `session.json` today, so the fallback is a live hazard, not a hypothetical; the fixture is renamed to `.jsonl` in Task 5.6.)

### 2. Consolidated Folder Layout

Inside `<session_dir>/<stem>/`:

| File            | Purpose                                 | Previous Location                                     |
| :-------------- | :-------------------------------------- | :---------------------------------------------------- |
| `launch.sh`     | Terminal boot script for Herdr pane     | `artifacts/<parent>/subagent-scripts/<agent>-<id>.sh` |
| `task.md`       | Task instructions passed to `@path`     | `artifacts/<parent>/context/<agent>-task-...md`       |
| `sysprompt.md`  | Injected system prompt / identity       | `artifacts/<parent>/context/<agent>-sysprompt-...md`  |
| `activity.json` | Live activity telemetry (~500ms writes) | `artifacts/<parent>/subagent-activity/<id>.json`      |
| `exit.json`     | Ephemeral settlement IPC                | `<stem>.jsonl.exit`                                   |

Because names are now fixed, the timestamp+runId artifact-naming scheme (`buildLaunchArtifactName`, the `context/` path templates) becomes dead code and is removed (see Decision 7).
Note that `activity.json` is consequently per-SESSION, not per-runId — all attempts of a retried run (sibling change) share one file, and consumers must key validation on the current attempt's id (recorded in the Sequencing section of `proposal.md`).

### 3. Elimination of `owner.json`

- Provenance metadata (`subagentOwner`, `parentSession`, `parentSessionId`, `agentId`, `token`) is already recorded in line 1 of `<stem>.jsonl`; the sidecar's only extra field (`parentSessionFile`) duplicates the header's `parentSession`.
- No reader of `owner.json` exists anywhere in `src/` — only the writer (`session.ts`) and one rollback `rmSync` (`subagent-launch.ts`).
- `writeSessionOwner`, `getSessionOwnerPath`, and `SubagentSessionOwner` are removed from `src/session.ts`. `SUBAGENT_OWNER_VERSION` is retained (still used by the header).
- The child derives its sidecar path from `PI_SUBAGENT_SESSION` by importing `getSubagentArtifactDir` from `./session.ts`; `src/activity.ts` likewise gains a top-level import of `./session.ts` (no cycle — `session.ts` imports nothing local).

### 4. Deterministic Cause-to-Action Lifecycle

All file creations and deletions are strictly bound to explicit causal events:

```text
[Cause]                                         [Action]
─────────────────────────────────────────────────────────────────────────────
1. Subagent Launch                    ───►  Create `<stem>/` companion folder
                                            (writes launch.sh, prompt files)

2. Live Execution                     ───►  Child writes `<stem>/activity.json`
                                            ↳ Child stops the activity recorder,
                                              flushes the final activity write, and
                                              ONLY THEN writes `<stem>/exit.json`
                                              (activity flush strictly precedes the
                                              sidecar, so a success deletion can never
                                              race the child into recreating the dir)

3. Successful Settle (exit 0)         ───►  Settlement disposition verifies the
                                            completion outcome — sidecar success:
                                            exit 0 AND runId equal to the run's id;
                                            sentinel success: exit 0 (bound via the
                                            run's own pane tail) — then, AFTER
                                            transcript extraction and the final
                                            activity read, recursively removes
                                            `<stem>/`

4. Launch Aborted / Rollback          ───►  Rollback transaction removes `<stem>/`
                                            (the `<stem>.jsonl` rollback is RETAINED —
                                            only extension-created files are rolled back)

5. Failed Run / Crash (exit != 0)     ───►  Parent delivers failure message
                                            ↳ Preserves `<stem>/` (minus the consumed
                                              exit.json) for manual inspection
```

**Deletion policy — exactly one deletion site for settlement, plus rollback:**

1. **`applySettlementDisposition`** (`src/subagent-launch.ts`, `:200-207`) is the SINGLE settlement deletion site.
   It runs after transcript extraction (`:794`) and after the final activity observation (`:785`), so nothing reads `<stem>/` afterwards (deleting inside `consumeExitSidecar` would strand the final telemetry read on a missing `activity.json` → `activityHealth: problem` on a successful run).
2. The disposition's artifact decision keys on the **full `CompletionResult`**, not `reason` alone, with per-channel binding: a sidecar-derived success deletes only when `exitCode === 0` AND the result's runId is present and equal to `running.id` (fail-closed — absent or mismatched means preserve); a sentinel success deletes on `exitCode === 0` alone, because sentinel results carry no runId at all (`src/completion.ts:164, :166, :269, :313` — likewise timeout and pane results) and bind to this run inherently, the `__SUBAGENT_DONE_<N>__` tail being read from the run's own freshly launched pane.
   This matters because `resolveSettlementDisposition` currently keys on `reason` (`:190-198`) — a `reason`-keyed rule would delete a failed run's artifacts on a nonzero sentinel exit.
   The signature changes to accept the result and to return the artifact decision (e.g. a `preserveArtifacts` field); the positional callers in `test/watch-abandoned.test.ts:72-113` and `test/abandoned-lease.test.ts:16-20, :127-169` are `any`-typed and only `pnpm test` will catch them.
3. Fail-closed on identity: a sidecar-derived result without the run's own id preserves the directory (production ownership checks make this unreachable — `consumeExitSidecar` compares against `expectedRunId: running.id`, `subagent-launch.ts:763` — so the guard is belt-and-suspenders; the runId-less results in `test/test.ts:1695-1710` never reach the disposition).
4. Ownership is satisfied transitively: `consumeExitSidecar` rejects stale/malformed sidecars before they can become the `CompletionResult`, so a rejected sidecar can never drive deletion — which is exactly the `stale sidecar never deletes the companion directory` scenario. `consumeExitSidecar` itself deletes NOTHING but the consumed sidecar file.
5. `registerSessionRollbacks` (`src/subagent-launch.ts:515-518`) collapses to TWO rollbacks: the companion directory (`<stem>/`) and the session file (`rmSync(state.subagentSessionFile)` — retained; a failed launch must not orphan a `.jsonl` Pi's session picker lists).
   The `.owner.json` and per-file artifact rollbacks disappear (the per-file `own()` sites at `:588` and `:657`); `state.rollbackPaths` / `cleanupRollbackPaths` — including the initializer at `:381` — (`:108, :590, :660, :719, :728-734`) become vestigial and are removed.
6. Registration order note: the admission-lease release is registered first (`:413`, inside `createLaunchTransaction` `:411-416`), the surface close next (`registerSurfaceRollback` `:457-459`), the directory rollback later (`registerSessionRollbacks` `:516-517`) — reverse-order replay (`launch-transaction.ts:51-59`) therefore deletes `<stem>/` before the pane closes.
   The one still-later registration, the launch-script `own()` at `:657`, is removed as redundant by this change; the `runningSubagents.delete` own at `:652` is order-irrelevant.
   POSIX open-fd semantics keep the in-execution `bash <stem>/launch.sh` valid, and today's `writeLaunchScript` already `rmSync`s the executing script (`:657`), so this is not a regression.

**Explicit Policy:** No implicit deletion.
There are no startup scans or background timers deleting files; cleanup only happens when directly triggered by the settlement disposition or rollback.

**Consumption is deterministic:** `exit.json` is unlinked on every read attempt regardless of outcome — valid, malformed, or stale (matching the current consumer's behavior, `completion.ts:85`/`:97`, and what the retry sibling depends on).
"Preserved intact" on failure therefore always means `<stem>/` minus the already-consumed `exit.json`.

### 5. Settlement IPC (`exit.json`)

- The child writes `join(getSubagentArtifactDir(sessionFile), "exit.json")` atomically via a temporary file `exit.${process.pid}.tmp` (the existing `${sessionFile}.exit` writer already uses tmp+rename; the scheme is unchanged, only the path moves).
- Companion-directory creation uses `mode: 0o700` at the PARENT's creation sites — the activity-directory `mkdirSync` (`subagent-launch.ts:506-507`) and launch-artifact writes (`:587`) — because the parent creates `<stem>/` first and `mkdirSync` never chmods an existing directory; the child's `writeCompletionSidecar` mirrors the same recursive `mkdirSync` with `mode: 0o700` (the directory holds prompts and task text beside a `0o600` transcript, so default umask is needlessly loose and the tighter mode costs nothing).
- Child write ordering is corrected: `src/subagent-done.ts` currently publishes the settled sidecar *before* the final activity flush (`publishSettledSidecar` at `:319` precedes `recorder.agentEndDone()` at `:321`, which flushes and `mkdirSync`s the directory).
  The recorder is stopped and flushed **before** the sidecar is published, eliminating the recreate-after-delete race (`agentEndDone()` → `markDone` → `flushNow()` then `disable()`, `activity.ts:498, :404-412`; disabled recorders early-return, so post-reorder the child cannot recreate `<stem>/`).
  The `subagent_done` tool path already has the correct order.
- Parent watcher in `consumeExitSidecar`: read → parse → ownership check → return the result (plus the deterministic unlink).
  No directory decisions here.

### 6. Placement Inside Pi's Sessions Directory

`<session_dir>` is Pi's own session store (`<agentDir>/sessions/--<cwd>--/`).
Verified safe against Pi core: every session-enumeration path filters entries on `.endsWith(".jsonl")` (`dist/core/session-manager.js:400`, `:1311`; `dist/migrations.js:81`), so sibling `<stem>/` directories are invisible to session discovery, resume lists, and migrations.
The guard test (Task 5.7h) asserts this against a REAL pi-core export — `SessionManager` is exported from the `@earendil-works/pi-coding-agent` package root (`dist/index.d.ts:19`), and `SessionManager.list` is the enumeration API — not against a re-implemented local filter, so a pi-core enumeration change fails the test instead of silently starting to list directories.

### 7. Injected-Dependencies Contract

`subagent-launch.ts` currently receives `getArtifactDir(sessionDir, sessionId)` and `getSubagentActivityFile(artifactDir, runningChildId)` as injected deps and stores `LaunchState.artifactDir`.
After this change:

- Both deps collapse into one: `getSubagentArtifactDir(sessionFile) => string`.
- `LaunchState.artifactDir` is removed; `LaunchDeps` and the `createSubagentLaunchService({...})` wiring in `src/index.ts` are updated.
- `getSubagentActivityFile` in `src/activity.ts` becomes `getSubagentActivityFile(sessionFile) => join(getSubagentArtifactDir(sessionFile), "activity.json")`; the `runningChildId` parameter and its interpolation into the temp-file name disappear.
- `buildLaunchArtifactName` (dead once names are fixed) is removed from `src/index.ts` (`:818-820` definition, `:655` wiring, `:712` `__test__` entry), the `LaunchDeps` declaration (`subagent-launch.ts:63`), and its collision test (`test.ts:1044-1045`) — the package runs a `fallow:dead-code` gate, so this is mandatory, not cosmetic.
- `StableParentContext.sessionDir` loses its only reader (`:376` was `getArtifactDir(ctx.sessionDir, sessionId)`) and is removed from `StableParentContext` (`types.ts:93`), `snapshotParentContext` (`index.ts:338, :345`), and their tests — the same dead-code gate applies.
  Verification runs `nr fallow` (the code-health gate) alongside `pnpm run check`/`pnpm test` (Task 5.8).

## Risks / Trade-offs

- **[Risk] Failed subagents leave `<stem>/` on disk permanently**: intentional for debuggability, but "no implicit sweeps" plus the absence of any cleanup affordance (nothing in `herdr.ts`, `session-leases.ts`, or the abandoned-lease machinery touches artifact paths) means residue accumulates unboundedly.
  This is relocation, not worsening: today's `artifacts/<parentSessionId>/` trees and `.owner.json` files also survive forever.
  Manual removal is always safe because nothing re-reads a settled run's companion directory.
  A future cleanup command is out of scope here.
- **[Risk] A crash between `exit.json` write and parent consumption leaves the directory forever**: the cause table has no sweeper by design; the failure window equals the watch deadline plus delivery time and the residue is one small directory.
  A late child write after a sentinel-success deletion can recreate a directory holding only the consumed sidecar — residue, not retained state; "zero leftover files" is an outcome, not an invariant.
- **[Risk] Directory deletion is not atomic across readers**: a concurrently-running `ls`/debugger can observe partial state.
  Accepted — the causality guarantee (no deletion before a verified-successful settlement or rollback) is what matters.
