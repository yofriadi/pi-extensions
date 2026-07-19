---
issue: 61
issue_title: "feat: port subagent transcript logging to Pi's official JSONL session format"
---

# Port subagent transcripts to Pi's official session format

## Problem Statement

Subagent conversation transcripts are written as JSONL by `output-file.ts`, but use a bespoke flat format (`{ isSidechain, agentId, type, message, timestamp, cwd }`) that does not conform to Pi's official session file format.
Pi's `SessionManager` writes tree-structured JSONL with a session header, UUIDv7 entry IDs, `parentId` tree structure, and typed entry discriminants (`"message"`, `"compaction"`, etc.).
The bespoke format cannot be loaded by Pi's session tooling (session selector, export-html, resume) and requires manual `jq` inspection for debugging.

## Goals

- Subagent transcripts written in Pi's official JSONL session format via `SessionManager`.
- Transcripts discoverable via the parent session path (nested under a parent-session-relative directory).
- Parent session linkage via the `parentSession` header field.
- Delete `output-file.ts` — the SDK's `SessionManager` handles all JSONL writing natively.
- Existing debugging use case preserved (full turn-by-turn history on disk).

## Non-Goals

- Making subagent sessions resumable via Pi's `/resume` command (future work; requires session selection UX changes).
- Cross-extension parent-session resolution (issue #22 — separate track).
- Changing the `SessionManager` usage for the child `AgentSession` itself (the child session already uses `SessionManager.inMemory()`; we replace it with a persisted one).

## Background

### Current flow

1. `agent-tool.ts` calls `createOutputFilePath(cwd, agentId, parentSessionId)` → creates `/tmp/pi-subagents-<uid>/<encoded-cwd>/<parentSessionId>/tasks/<agentId>.output`.
2. `writeInitialEntry(path, agentId, prompt, cwd)` writes the first user message in the bespoke format.
3. `streamToOutputFile(session, path, agentId, cwd)` subscribes to `turn_end` events and appends bespoke JSONL entries.
4. `agent-manager.ts` calls the cleanup function on completion/error to do a final flush and unsubscribe.

### Pi's SessionManager API

`SessionManager` from `@earendil-works/pi-coding-agent` provides:

- `SessionManager.create(cwd, sessionDir?)` — creates a persisted session file in the given directory.
- `newSession({ parentSession? })` — writes a `SessionHeader` with `parentSession` linking.
- `appendMessage(message)` — writes a `SessionMessageEntry` with auto-generated UUIDv7 `id` and `parentId` (tree structure).
- `appendCompaction(...)`, `appendCustomEntry(...)` — first-class support for all entry types.
- `getSessionFile()` — returns the path to the JSONL file on disk.

The child `AgentSession` (created by `createAgentSession`) accepts a `sessionManager` option.
Currently set to `SessionManager.inMemory(cwd)`, switching to `SessionManager.create(cwd, sessionDir)` makes the SDK write official-format JSONL automatically — no manual streaming code needed.

### Reference implementations

nicobailon/pi-subagents places subagent sessions under `<parent-session-dir>/<parent-session-basename>/<runId>/`.
This keeps them discoverable via the parent session path without cluttering the main session list.
Our approach follows the same pattern: derive a `sessionDir` from the parent session file.

### Constraints

- `agent-runner.ts` already imports `SessionManager` for the `inMemory()` call — switching to `create()` adds no new dependency.
- `ctx.sessionManager` is `ReadonlySessionManager` and provides `getSessionId()`, `getSessionFile()`, and `getSessionDir()`.
- The `code-style` skill requires keeping IO at the edges and not hiding dependencies.
  The session directory derivation should be a pure function that receives the parent session file path.

## Design Overview

### Core change: persisted SessionManager in agent-runner

Replace `SessionManager.inMemory(cwd)` with `SessionManager.create(cwd, sessionDir)` inside `runAgent()`.
The `sessionDir` is derived from the parent's session file path, and the `parentSession` option links the child to the parent.

The key insight is that the SDK's `createAgentSession` already writes all messages through the `SessionManager` it receives.
By switching from in-memory to persisted, every message the child agent produces is automatically written in official JSONL format — no manual subscription or streaming code required.

### Session directory derivation

```typescript
/**
 * Derive the session directory for a subagent from the parent session file.
 * Layout: <parent-dir>/<parent-basename>/tasks/
 *
 * Example:
 *   parent: ~/.pi/agent/sessions/--home-user-project--/2026-05-20T12-00-00Z_.jsonl
 *   result: ~/.pi/agent/sessions/--home-user-project--/2026-05-20T12-00-00Z_/tasks/
 *
 * Falls back to a temp directory when the parent session is not persisted.
 */
function deriveSubagentSessionDir(
  parentSessionFile: string | undefined,
  cwd: string,
): string;
```

### Data flow (after)

1. `agent-tool.ts` passes `parentSessionFile` (from `ctx.sessionManager.getSessionFile()`) and `parentSessionId` to `agent-manager.ts` via `SpawnOptions`.
2. `agent-manager.ts` threads them to `agent-runner.ts` via `RunOptions`.
3. `agent-runner.ts` calls `deriveSubagentSessionDir(parentSessionFile, cwd)` and creates `SessionManager.create(cwd, sessionDir)` with `{ parentSession: parentSessionId }`.
4. The `createAgentSession` SDK call receives this persisted `SessionManager`.
5. All messages are written to disk automatically by the SDK.
6. `agent-runner.ts` returns the session file path in `RunResult` (via `sessionManager.getSessionFile()`).
7. `agent-tool.ts` stores the path on `AgentRecord.outputFile` for display in notifications/UI.

### What gets deleted

- `output-file.ts` — entirely replaced by the persisted `SessionManager`.
- `output-file.test.ts` — the `encodeCwd` tests are no longer needed (Pi's `SessionManager` handles directory encoding internally).
- `streamToOutputFile`, `writeInitialEntry`, `createOutputFilePath` imports from `agent-tool.ts`.
- `outputCleanup` field from `AgentRecord` (no manual cleanup needed; the `SessionManager` is append-only).
- The `onSessionCreated` wrapper in `agent-tool.ts` that wires output-file streaming.

### What changes

- `RunOptions` gains `parentSessionFile?: string` and `parentSessionId?: string`.
- `RunResult` gains `sessionFile?: string` (path to the persisted session JSONL).
- `SpawnOptions` gains `parentSessionFile?: string` and `parentSessionId?: string`.
- `AgentRecord.outputCleanup` is removed (no manual flush/unsubscribe lifecycle).
- `agent-manager.ts` removes the `outputCleanup` calls in completion/error paths.
- `agent-tool.ts` sets `record.outputFile` from the `RunResult.sessionFile` instead of calling `createOutputFilePath`.
- `notification.ts`, `renderer.ts`, `types.ts` — `outputFile` field semantics unchanged (still a path string); only the source changes.

### Edge cases

1. **Parent session not persisted** (e.g., API/headless mode where the parent uses `SessionManager.inMemory()`): `ctx.sessionManager.getSessionFile()` returns `undefined`.
   Fallback: use a temp directory under `/tmp/pi-subagents-<uid>/` (similar to current behavior) so transcripts are still written to disk.
2. **Worktree isolation**: `effectiveCwd` differs from `ctx.cwd`.
   The `SessionManager.create()` call uses `effectiveCwd` (same as current `inMemory` call), but the `sessionDir` is still derived from the parent session — the session header's `cwd` field correctly records the worktree path.

## Module-Level Changes

### New file: `src/session-dir.ts`

Pure function `deriveSubagentSessionDir(parentSessionFile, cwd)`.
Extracts the parent session basename, constructs `<parent-dir>/<parent-basename>/tasks/`.
Falls back to a temp directory when `parentSessionFile` is undefined.

### Modified: `src/agent-runner.ts`

- Import `deriveSubagentSessionDir` from `session-dir.ts`.
- Add `parentSessionFile?: string` and `parentSessionId?: string` to `RunOptions`.
- Add `sessionFile?: string` to `RunResult`.
- Replace `SessionManager.inMemory(cfg.effectiveCwd)` with:

```typescript
const sessionDir = deriveSubagentSessionDir(options.parentSessionFile, cfg.effectiveCwd);
const sessionManager = SessionManager.create(cfg.effectiveCwd, sessionDir);
sessionManager.newSession({ parentSession: options.parentSessionId });
```

- After `session.prompt()`, capture `sessionManager.getSessionFile()` into `RunResult.sessionFile`.

### Modified: `src/agent-manager.ts`

- Add `parentSessionFile?: string` and `parentSessionId?: string` to `SpawnOptions`.
- Thread them to `RunOptions` in the `runner.run()` call.
- Remove `outputCleanup` calls from the completion and error handlers.

### Modified: `src/tools/agent-tool.ts`

- Remove import of `createOutputFilePath`, `streamToOutputFile`, `writeInitialEntry`.
- Remove the `onSessionCreated` wrapper that wired output-file streaming.
- Pass `parentSessionFile: ctx.sessionManager.getSessionFile()` and `parentSessionId: ctx.sessionManager.getSessionId()` in `SpawnOptions`.
- After spawn, set `record.outputFile` from the returned session file path (available via `onSessionCreated` callback which gives access to the session's `sessionManager`).

### Modified: `src/types.ts`

- Remove `outputCleanup?: () => void` from `AgentRecord`.

### Deleted: `src/output-file.ts`

Entire file removed.

### Deleted: `test/output-file.test.ts`

Entire file removed.

### Unchanged: `src/notification.ts`, `src/renderer.ts`

These read `record.outputFile` (a path string) — the field still exists, just populated differently.
The `NotificationDetails.outputFile` field is unchanged.

## Test Impact Analysis

### New tests enabled by extraction

1. `test/session-dir.test.ts` — unit tests for `deriveSubagentSessionDir`:
   - Parent session file present → derives correct nested path.
   - Parent session file undefined → falls back to temp directory.
   - Various path shapes (POSIX, Windows-like).

2. `test/agent-runner.test.ts` — updated tests verifying:
   - `SessionManager.create` is called (not `inMemory`) when `parentSessionFile` is provided.
   - `newSession({ parentSession })` is called with the parent session ID.
   - `RunResult.sessionFile` is populated from the session manager.

### Tests that become redundant

- `test/output-file.test.ts` (`encodeCwd` tests) — the directory encoding is now handled by `deriveSubagentSessionDir` with a different layout.
  The `encodeCwd` function is deleted.

### Tests that stay as-is

- All `agent-manager.test.ts` tests that mock the runner — they don't depend on `output-file` internals.
- All `notification.test.ts` and `renderer.test.ts` tests — they read `record.outputFile` which remains a string.
- The `onSessionCreated` callback tests in `agent-tool.test.ts` need updating to remove the output-file wiring expectations.

## TDD Order

### Step 1: Add `deriveSubagentSessionDir` with tests

1. Create `src/session-dir.ts` with the pure function.
2. Create `test/session-dir.test.ts` with tests for parent-present and fallback cases.
3. Commit: `feat: add deriveSubagentSessionDir for session directory derivation (#61)`

### Step 2: Thread parent session info through SpawnOptions and RunOptions

1. Add `parentSessionFile?: string` and `parentSessionId?: string` to `SpawnOptions` in `agent-manager.ts`.
2. Add `parentSessionFile?: string` and `parentSessionId?: string` to `RunOptions` in `agent-runner.ts`.
3. Add `sessionFile?: string` to `RunResult` in `agent-runner.ts`.
4. Thread the new fields from `SpawnOptions` → `RunOptions` in `agent-manager.ts`.
5. Update tests to verify the new fields are threaded.
6. Commit: `feat: thread parent session info through spawn and run options (#61)`

### Step 3: Switch agent-runner to persisted SessionManager

1. In `runAgent()`, replace `SessionManager.inMemory(cfg.effectiveCwd)` with the persisted variant using `deriveSubagentSessionDir`.
2. Call `sessionManager.newSession({ parentSession: options.parentSessionId })`.
3. Capture `sessionManager.getSessionFile()` into `RunResult.sessionFile`.
4. Update `agent-runner.test.ts` mocks to expect `SessionManager.create` instead of `SessionManager.inMemory`.
5. Commit: `feat: use persisted SessionManager for subagent sessions (#61)`

### Step 4: Remove output-file wiring from agent-tool and agent-manager

1. Remove the `onSessionCreated` output-file wrapper in `agent-tool.ts`.
2. Remove `createOutputFilePath`, `writeInitialEntry`, `streamToOutputFile` imports.
3. Set `record.outputFile` from the session manager's file path (via `onSessionCreated` callback).
4. Pass `parentSessionFile` and `parentSessionId` in spawn options.
5. Remove `outputCleanup` calls from `agent-manager.ts` completion/error handlers.
6. Remove `outputCleanup` from `AgentRecord` in `types.ts`.
7. Update agent-tool and agent-manager tests.
8. Commit: `feat: wire session file path through agent-tool, remove output-file streaming (#61)`

### Step 5: Delete output-file.ts and its tests

1. Delete `src/output-file.ts`.
2. Delete `test/output-file.test.ts`.
3. Run full test suite to verify no remaining references.
4. Commit: `feat!: remove bespoke output-file transcript format (#61)`

### Step 6: Documentation update

1. Update `docs/architecture/architecture.md` — remove `output-file.ts` from the module listing, add `session-dir.ts`, mark #61 as complete.
2. Commit: `docs: update architecture for session format migration (#61)`

## Risks and Mitigations

### Risk: SessionManager.create may fail in environments without a writable home directory

The temp-directory fallback in `deriveSubagentSessionDir` handles this case.
When the parent session file is unavailable (headless/API mode), we fall back to a temp directory just like the current implementation.

### Risk: Persisted sessions accumulate disk space over time

Pi's session tooling already manages session storage.
Subagent sessions nested under the parent session directory are cleaned up when the parent session is deleted.
This is an improvement over the current `/tmp` location where files persist until system cleanup.

### Risk: Tests that mock SessionManager.inMemory need updating

Step 3 explicitly plans for updating these mocks.
The change is localized to `agent-runner.ts` and its direct test file.

### Risk: Breaking change for consumers that read outputFile paths

The `outputFile` field changes from `/tmp/pi-subagents-<uid>/.../tasks/<agentId>.output` to `~/.pi/agent/sessions/.../<timestamp>_<uuid>.jsonl`.
Consumers that parse the path (unlikely) would break, but the field is internal to the extension and only used for display.
The format of the file content changes from bespoke JSONL to Pi's official format — this is the intentional breaking change.

## Open Questions

1. Should the plan add a `sessionDir` field to `AgentRecord` alongside `outputFile`, or is the session file path sufficient for all use cases?
   Deferred — start with `outputFile` pointing to the session file; add `sessionDir` if needed later.
2. Should foreground agents also get persisted sessions, or only background agents?
   The current `output-file` code only runs for background agents.
   Persisted sessions are valuable for both — the plan applies the change in `agent-runner.ts` which serves both paths.
   If this proves too noisy, a follow-up can gate it behind a setting.
