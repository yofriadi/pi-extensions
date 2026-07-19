---
issue: 98
issue_title: "Extract AgentRecord state machine from scattered status transitions"
---

# Extract AgentRecord state machine

## Problem Statement

`AgentRecord` status transitions are scattered across 6 locations in `agent-manager.ts`: `startAgent()` `.then()`, `startAgent()` `.catch()`, `resume()`, `abort()`, `abortAll()`, and `drainQueue()` catch.
Each site sets `record.status` plus associated fields (`completedAt`, `result`, `error`) in ad-hoc combinations, with repeated guards like `if (record.status !== "stopped")`.

There are 15 direct `record.status = ...` writes and 17 associated field writes (`result`, `error`, `completedAt`, `startedAt`) — ~32 scattered mutation sites total.
`startAgent()` is ~130 lines partly because it manages these transitions inline.

## Goals

- Convert `AgentRecord` from a plain interface to a class that owns and encapsulates its transition state.
- Extract status-transition methods that centralize the "don't overwrite stopped" guard.
- Reduce scattered field writes in `agent-manager.ts` to method calls.
- Encapsulate transition fields (`status`, `result`, `error`, `startedAt`, `completedAt`) behind private backing fields with getters — external code can read but not write.
- Use lift-and-shift to migrate incrementally: introduce the class alongside the interface, migrate construction sites, switch the re-export, replace writes, then encapsulate.

## Non-Goals

- Parent snapshot extraction (architecture.md Step 2) — separate issue.
- Session-event observation / callback threading removal (architecture.md Step 3) — separate issue.
- Stat accumulation methods (`toolUses++`, `addUsage()`, `compactionCount++`) — these are running counters, not status transitions.
  They could become methods in a follow-up but are out of scope here.
- Encapsulating non-transition field writes (`session`, `outputFile`, `worktree`, `worktreeResult`, `promise`, `toolCallId`, `resultConsumed`, `pendingSteers`) — these are data capture, not status transitions.

## Prerequisites

- Issue #102 (shared test record factory) — shipped.
  All 8 test files construct `AgentRecord` objects through `createTestRecord()` in `test/helpers/make-record.ts`.
  Converting the interface to a class requires updating only this one factory (plus `agent-manager.ts` construction).

## Background

### Relevant modules

| Module                        | Role                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `src/types.ts`                | Defines `AgentRecord` interface — 20+ consumers read from it                   |
| `src/agent-manager.ts`        | Only file that writes status-transition fields                                 |
| `src/service.ts`              | Defines `SubagentRecord` (serializable snapshot) — unchanged                   |
| `src/service-adapter.ts`      | Converts `AgentRecord` → `SubagentRecord` via `toSubagentRecord()` — unchanged |
| `test/helpers/make-record.ts` | Shared test factory — single construction site for all tests (#102)            |

### External writes to `AgentRecord` (not status transitions)

Several files outside `agent-manager.ts` write non-transition fields:

- `tools/get-result-tool.ts` — `record.resultConsumed = true` (2 sites)
- `tools/steer-tool.ts` / `service-adapter.ts` — `record.pendingSteers` (push messages)
- `tools/agent-tool.ts` — `record.toolCallId = toolCallId`

These are data-capture writes, not status transitions, and remain public fields.

### Code-style constraints

The code-style skill's "output arguments" rule applies directly: "If a function sets a field on a received object, it is doing work that belongs inside the owning object.
Encapsulate the mutation behind a method."
The "scattered resets" rule also applies: "When the same set of fields is reset to the same values in multiple places, extract a single method."

## Design Overview

### `AgentRecord` becomes a class

`AgentRecord` moves from an interface in `types.ts` to a class in a new `src/agent-record.ts` module.
`types.ts` re-exports the class so existing `import type { AgentRecord } from "./types.js"` across the codebase continues to work with no import-path changes.

The class encapsulates the 5 transition fields behind private backing fields with getters.
All other fields remain public (identity fields are `readonly`; non-transition mutable fields stay public).

```typescript
export type AgentRecordStatus =
  | "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";

export class AgentRecord {
  // Identity — readonly, set once at construction
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly invocation?: AgentInvocation;

  // Transition state — private backing fields, public getters
  private _status: AgentRecordStatus;
  get status(): AgentRecordStatus { return this._status; }

  private _result?: string;
  get result(): string | undefined { return this._result; }

  private _error?: string;
  get error(): string | undefined { return this._error; }

  private _startedAt: number;
  get startedAt(): number { return this._startedAt; }

  private _completedAt?: number;
  get completedAt(): number | undefined { return this._completedAt; }

  // Non-transition mutable state — public fields
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  resultConsumed?: boolean;
  pendingSteers?: string[];
  worktree?: { path: string; branch: string };
  worktreeResult?: { hasChanges: boolean; branch?: string };
  toolCallId?: string;
  outputFile?: string;

  constructor(init: AgentRecordInit) { /* ... */ }

  // Transition methods — see below
}
```

### Constructor and `AgentRecordInit`

The constructor accepts a wide init bag that covers all fields.
Required fields: `id`, `type`, `description`.
All others are optional with sensible defaults (`status` defaults to `"queued"`, `toolUses` to 0, etc.).

This wide init bag serves two purposes:

1. Production use (`agent-manager.ts`): passes the 7 fields it needs at spawn time.
2. Test use (`createTestRecord`): sets arbitrary state (e.g., `status: "completed"`, `result: "done"`) without going through transition methods.

```typescript
export interface AgentRecordInit {
  id: string;
  type: SubagentType;
  description: string;
  status?: AgentRecordStatus;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  toolUses?: number;
  lifetimeUsage?: LifetimeUsage;
  compactionCount?: number;
  abortController?: AbortController;
  invocation?: AgentInvocation;
  session?: AgentSession;
  promise?: Promise<string>;
  resultConsumed?: boolean;
  pendingSteers?: string[];
  worktree?: { path: string; branch: string };
  worktreeResult?: { hasChanges: boolean; branch?: string };
  toolCallId?: string;
  outputFile?: string;
}
```

### Transition methods

7 methods covering all 6 transition sites plus the resume-reset:

#### `markRunning(startedAt: number): void`

Sets `status = "running"` and `startedAt`.
Called in `startAgent()` when transitioning from queued to running.

#### `markCompleted(result: string, completedAt?: number): void`

Always sets `result` and `completedAt` (via `??=`).
Only changes `status` to `"completed"` if not already `"stopped"`.
Called in the `.then()` success path and in `resume()` try block.

#### `markAborted(result: string, completedAt?: number): void`

Same guard as `markCompleted` — preserves stopped status.
Sets `status = "aborted"`.
Called in `.then()` when runner returns `aborted: true`.

#### `markSteered(result: string, completedAt?: number): void`

Same guard as `markCompleted` — preserves stopped status.
Sets `status = "steered"`.
Called in `.then()` when runner returns `steered: true`.

#### `markError(error: unknown, completedAt?: number): void`

Always sets `error` (formatted: `Error` → `.message`, otherwise `String(...)`) and `completedAt` (via `??=`).
Only changes `status` to `"error"` if not already `"stopped"`.
Called in `.catch()`, `resume()` catch block, and `drainQueue()` catch.

#### `markStopped(completedAt?: number): void`

Always sets `status = "stopped"` and `completedAt`.
No guard — stopping is always valid.
Called in `abort()` (2 sites) and `abortAll()` (2 sites).

#### `resetForResume(startedAt: number): void`

Sets `status = "running"`, `startedAt`.
Clears `completedAt`, `result`, `error` to `undefined`.
Called in `resume()` before re-running.

### Guard semantics: preserve current behavior

The current `.then()` and `.catch()` blocks guard only the `status` field but always set `result`/`error` and `completedAt`:

```typescript
// Current .then() — result and completedAt are set even when stopped
if (record.status !== "stopped") {
  record.status = aborted ? "aborted" : steered ? "steered" : "completed";
}
record.result = responseText;
record.completedAt ??= Date.now();
```

This is intentional — `get-result-tool.ts` reads `record.result` from stopped records.
The transition methods preserve this behavior: data fields are always set, status is only changed when not stopped.
The `??=` on `completedAt` preserves the abort timestamp when `markStopped()` fires before `.then()`.

### Worktree result-append: reorder, don't add a method

The `.then()` block currently appends worktree branch text to `record.result` after the transition.
With encapsulated fields, direct writes to `result` are forbidden.

Instead of adding an `appendToResult()` method, reorder the `.then()` block to compute the final result (including worktree text) before calling the transition method:

```typescript
.then(({ responseText, session, aborted, steered, sessionFile }) => {
  // Worktree cleanup first — compute final result
  let finalResult = responseText;
  if (record.worktree) {
    const wtResult = this.worktrees.cleanup(record.worktree, options.description);
    record.worktreeResult = wtResult;
    if (wtResult.hasChanges && wtResult.branch) {
      finalResult += `\n\n---\nChanges saved to branch ...`;
    }
  }

  // Transition with complete result
  if (aborted) record.markAborted(finalResult);
  else if (steered) record.markSteered(finalResult);
  else record.markCompleted(finalResult);

  record.session = session;
  if (sessionFile) record.outputFile = sessionFile;

  detach();
  // ...
})
```

The worktree cleanup reads `record.worktree` (a public field set before the promise) and writes `record.worktreeResult` (a public field).
It does not depend on `record.status` or `record.result`, so the reorder is safe.

### Correctness improvement in `resume()`

The current `resume()` method lacks the "don't overwrite stopped" guard:

```typescript
// Current — no guard against abort race
record.status = "completed";
record.result = responseText;
record.completedAt = Date.now();
```

After migration, `record.markCompleted(responseText)` includes the guard.
This closes a latent race where `abort()` sets status to `"stopped"` between `resetForResume()` and the runner returning.
The current code would overwrite `"stopped"` back to `"completed"` — the method call does not.

### Circular import avoidance

`agent-record.ts` imports types from `types.ts` (`SubagentType`, `AgentInvocation`).
`types.ts` re-exports the class from `agent-record.ts`.

This is safe because `agent-record.ts` uses `import type` for its `types.ts` imports — these are erased at runtime, so no runtime circular dependency exists.

## Module-Level Changes

### New files

1. `src/agent-record.ts` — `AgentRecord` class, `AgentRecordInit` interface, `AgentRecordStatus` type.
2. `test/agent-record.test.ts` — unit tests for constructor and all 7 transition methods.

### Changed files

1. `src/types.ts` — remove `AgentRecord` interface; add re-export: `export { AgentRecord, type AgentRecordInit, type AgentRecordStatus } from "./agent-record.js"`.
2. `src/agent-manager.ts` — import `AgentRecord` as a value from `./agent-record.js`; replace object literal construction with `new AgentRecord(...)`; replace ~32 scattered field writes with 11 transition method calls.
3. `test/helpers/make-record.ts` — import `AgentRecord` from `../../src/agent-record.js`; construct with `new AgentRecord(...)` instead of plain object.

### Unchanged files

All other source and test files — they use `import type { AgentRecord } from "./types.js"` and only read fields.
The re-export from `types.ts` means zero import-path changes.

## Test Impact Analysis

### New tests enabled by the extraction

The state machine is currently untestable in isolation — transitions are buried inside `agent-manager.ts`.
After extraction:

- Guard logic tested directly (e.g., `markCompleted` on a stopped record preserves status but sets result).
- Invalid transition sequences tested without mocking the runner.
- Error formatting (`Error` vs string) tested in isolation.
- `resetForResume` field clearing tested without the full resume flow.

### Existing tests that stay as-is

`agent-manager.test.ts` tests verify end-to-end behavior (spawn, complete, abort, resume, queue drain, worktree).
They remain unchanged — they verify the wiring between `AgentManager` and the `AgentRecord` class.

### No test files need updating (except the shared factory)

Issue #102 consolidated all test record construction into `createTestRecord()`.
Only that one factory changes.
All 8 consumer test files are untouched.

## TDD Order

### Cycle 1: AgentRecord class tests

Test surface: `test/agent-record.test.ts` (new file).

Tests cover:

- Constructor: defaults (`status` → `"queued"`, `toolUses` → 0, `lifetimeUsage` → zeros, `compactionCount` → 0), passthrough of init values (including optional transition fields like `result`, `completedAt`).
- `markRunning`: sets status and startedAt.
- `markCompleted`: sets status/result/completedAt when not stopped; preserves status but still sets result/completedAt when stopped; `completedAt` uses `??=` semantics (does not overwrite existing value).
- `markAborted` and `markSteered`: same guard behavior as `markCompleted`.
- `markError`: sets status/error/completedAt when not stopped; preserves status but still sets error/completedAt when stopped; formats `Error` objects to `.message`, non-Error to `String(...)`.
- `markStopped`: always sets status and completedAt, no guard.
- `resetForResume`: sets status to `"running"` and startedAt; clears completedAt, result, error.

Commit: `test: add AgentRecord class tests (#98)`

### Cycle 2: AgentRecord class implementation

Source: `src/agent-record.ts` (new file).
Exports: `AgentRecord` class, `AgentRecordInit` interface, `AgentRecordStatus` type.
All fields public initially (encapsulation deferred to cycle 6).

All cycle 1 tests pass.

Commit: `feat: create AgentRecord class with transition methods (#98)`

### Cycle 3: Lift — migrate construction sites

Changed files: `test/helpers/make-record.ts`, `src/agent-manager.ts`.

`createTestRecord`: import `AgentRecord` from `agent-record.ts`; construct with `new AgentRecord(...)`.
`agent-manager.ts`: import `AgentRecord` from `agent-record.ts` (value import); replace object literal in `spawn()` with `new AgentRecord(...)`.

At this point, both the interface (in `types.ts`) and the class (in `agent-record.ts`) coexist.
`agent-manager.ts` uses the class; all other consumers use the interface.
Scattered field writes still work because fields are public.

Run: full test suite + `pnpm run check`.

Commit: `refactor: construct AgentRecord class in agent-manager and test factory (#98)`

### Cycle 4: Shift — switch `types.ts` from interface to re-export

Changed file: `src/types.ts`.

Remove the `AgentRecord` interface definition.
Add re-exports:

```typescript
export { AgentRecord } from "./agent-record.js";
export type { AgentRecordInit, AgentRecordStatus } from "./agent-record.js";
```

All `import type { AgentRecord } from "./types.js"` across the codebase now resolve to the class.
No consumer constructs `AgentRecord` as a plain object (construction was migrated in cycle 3).

Run: `pnpm run check` (catches any structural incompatibilities).

Commit: `refactor: replace AgentRecord interface with class re-export in types.ts (#98)`

### Cycle 5: Replace scattered field writes with transition methods

Changed file: `src/agent-manager.ts`.

Replace all 11 transition sites:

| Location               | Before                                                             | After                                                               |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `startAgent()` running | `record.status = "running"; record.startedAt = ...`                | `record.markRunning(Date.now())`                                    |
| `.then()` success      | `if (!stopped) status = ...; result = ...; completedAt ??= ...`    | `record.markCompleted(finalResult)` / `markAborted` / `markSteered` |
| `.catch()` error       | `if (!stopped) status = "error"; error = ...; completedAt ??= ...` | `record.markError(err)`                                             |
| `resume()` reset       | `status = ...; startedAt = ...; clear 3 fields`                    | `record.resetForResume(Date.now())`                                 |
| `resume()` try         | `status = "completed"; result = ...; completedAt = ...`            | `record.markCompleted(responseText)`                                |
| `resume()` catch       | `status = "error"; error = ...; completedAt = ...`                 | `record.markError(err)`                                             |
| `abort()` queued       | `status = "stopped"; completedAt = ...`                            | `record.markStopped()`                                              |
| `abort()` running      | `status = "stopped"; completedAt = ...`                            | `record.markStopped()`                                              |
| `abortAll()` queued    | `status = "stopped"; completedAt = ...`                            | `record.markStopped()`                                              |
| `abortAll()` running   | `status = "stopped"; completedAt = ...`                            | `record.markStopped()`                                              |
| `drainQueue()` catch   | `status = "error"; error = ...; completedAt = ...`                 | `record.markError(err)`                                             |

Also reorder the `.then()` block: worktree cleanup moves before the transition call so the final result includes worktree branch text (see Design Overview).

Run: full test suite.

Commit: `refactor: replace scattered status transitions with AgentRecord methods (#98)`

### Cycle 6: Encapsulate transition fields

Changed file: `src/agent-record.ts`.

Make `status`, `result`, `error`, `startedAt`, `completedAt` private (`_status`, `_result`, etc.) with public getters.
Make `id`, `type`, `description`, `invocation` readonly.

Run: `pnpm run check` — verifies no remaining direct writes to encapsulated fields anywhere in `src/` or `test/`.
Run: full test suite.

Commit: `refactor: encapsulate AgentRecord transition state (#98)`

## Risks and Mitigations

| Risk                                                                                                                   | Mitigation                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Guard semantics drift: transition methods might not exactly match scattered guards                                     | Each method's guard logic has dedicated tests (cycle 1); full agent-manager test suite runs after each cycle    |
| Data fields on stopped records: `markCompleted` etc. must still set `result`/`completedAt` even when status is guarded | Explicit "stopped guard" test cases verify data fields are set; mirrors current `.then()` / `.catch()` behavior |
| Worktree result-append after encapsulation: direct `record.result = ...` no longer compiles                            | `.then()` block reordered to compute full result before calling transition method (cycle 5)                     |
| `types.ts` re-export introduces type-only circular dependency                                                          | `agent-record.ts` → `types.ts` imports are `import type` only (erased at runtime); no runtime cycle             |
| `resume()` gains a "stopped" guard it didn't have before                                                               | This is a correctness improvement: closes a latent abort race; noted explicitly in design                       |

## Open Questions

- The `markCompleted`/`markAborted`/`markSteered` split is not in the original issue's 5-method list (which only shows `markCompleted`).
  The split is needed because the `.then()` block dispatches to 3 distinct terminal statuses.
- Stat accumulation (`toolUses++`, `addUsage(lifetimeUsage, ...)`, `compactionCount++`) is left as direct field writes on public fields.
  These could become methods in a follow-up if the callback-threading removal (architecture.md Step 3) makes it natural.
