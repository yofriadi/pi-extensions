## Why

Subagent sessions currently scatter runtime artifacts and sidecars across multiple disparate locations:

1. A global parent artifact directory (`artifacts/<parentSessionId>/`) with split subfolders (`context/`, `subagent-scripts/`, `subagent-activity/`).
2. Flat sidecars in the sessions directory with compound extensions (`<stem>.jsonl.exit` and `<stem>.jsonl.owner.json`).
3. Redundant `owner.json` files whose provenance data (`parentSession`, `parentSessionId`, `agentId`, `token`) is already embedded directly in the first line (header) of the `.jsonl` session file.

Consolidating all subagent runtime artifacts into a single companion directory named after the session stem (`<session_dir>/<stem>/`) simplifies discovery, eliminates redundancy, and enables deterministic, cause-and-effect cleanup.

## What Changes

- **Remove redundant `owner.json` entirely:**
  - Stop writing standalone `owner.json` / `<session>.jsonl.owner.json` sidecars.
  - Rely exclusively on the session header line within the `.jsonl` file for session provenance and ownership verification.
- **Single companion directory per subagent run:**
  - For a subagent session `<session_dir>/<stem>.jsonl`, store all run-specific artifacts in `<session_dir>/<stem>/`:
    - `launch.sh` (startup script, previously in `<parentSessionId>/subagent-scripts/`)
    - `task.md` / `sysprompt.md` (prompts, previously in `<parentSessionId>/context/`)
    - `activity.json` (live telemetry, previously in `<parentSessionId>/subagent-activity/`)
    - `exit.json` (completion IPC, previously `<stem>.jsonl.exit`)
- **Strict Cause-to-Action Lifecycle (no implicit deletion):**
  - **On Success (`exitCode === 0`):** When the run settles successfully — sidecar-consumed or sentinel — the settlement disposition recursively removes the companion directory `<stem>/` after transcript extraction and the final activity observation.
    The retained `<stem>.jsonl` is untouched.
    `rmSync` is not atomic and a late child write can recreate a directory holding only the consumed sidecar; the guarantee is causal (no deletion before a verified-successful settlement or rollback), not atomic.
  - **On Rollback / Abort:** Launch rollback transactions delete `<stem>/` if spawning fails.
  - **On Failure / Error (`exitCode !== 0` or crash):** The companion directory `<stem>/` is preserved intact for manual inspection and debugging.
  - **No implicit sweeps:** No background timers or startup sweeps delete folders; all file mutations are strictly bound to explicit causes.
- **No backward compatibility:**
  - Drop all legacy `.jsonl.exit`, `.jsonl.owner.json`, and global `artifacts/<parentSessionId>/` paths.

## Capabilities

### Modified Capabilities

- `pane-surface`: Provenance metadata is stored exclusively in the session JSONL header; external `owner.json` sidecars are removed; launch scripts and prompt artifacts live in `<stem>/`.
- `completion-delivery`: Completion exit sidecar and activity telemetry live in `<stem>/`; companion folder is deleted on success and preserved on error.

## Impact

- **Code affected:**
  - `src/session.ts`: Remove `writeSessionOwner` and `getSessionOwnerPath`; export `getSubagentArtifactDir`.
  - `src/subagent-launch.ts`: Route launch scripts (`launch.sh`), sysprompts, and task markdown to `<stem>/`; update rollback handlers.
  - `src/activity.ts`: Route `activity.json` to `<stem>/activity.json`.
  - `src/subagent-done.ts`: Route `exit.json` to `<stem>/exit.json`.
  - `src/completion.ts`: Update `consumeExitSidecar` to read `<stem>/exit.json` with deterministic consumption; directory deletion lives solely in the settlement disposition.
  - Tests referencing `owner.json`, `.jsonl.exit`, or `artifacts/<parentSessionId>/`.
- **APIs & Runtime:** No breaking changes to public tool schemas; internal file layout is unified and self-contained.

## Sequencing

- **Land before `subagent-auto-retry-and-resume`.**
  That change's `pane-surface` and `completion-delivery` deltas are written against the base text this change produces (companion-directory settlement, header-only provenance).
  This change must archive first; the retry change then rebases its deltas onto the merged base per its own sequencing section.
- Rebase obligations the retry change absorbs from this base: sidecar path `<stem>/exit.json` (never bare `<stem>.jsonl.exit`), companion-directory delete-on-success / preserve-on-failure, sidecar-triggered deletion gated on verified ownership (the sentinel path has no sidecar and binds via the run's own pane tail), a single deletion site in the settlement disposition keyed on the full completion result (sidecar success: exit code zero with runId equal to the run's id, fail-closed; sentinel success: exit code zero alone), and the activity file no longer being per-runId (`<stem>/activity.json` is shared across all attempts of a retried run, so the retry change must key activity reads on the current attempt's id, not a stale one).
