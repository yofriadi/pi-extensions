---
issue: 48
issue_title: "feat: implement and publish SubagentsAPI at extension init"
---

# Implement and publish SubagentsService

## Problem Statement

The package currently exposes an untyped, undocumented manager via `Symbol.for("pi-subagents:manager")` on `globalThis`.
This forces consumers to guess the API shape, lacks model resolution at the boundary (causing "No API key found for undefined" crashes when consumers pass string model names), and leaks non-serializable internals (`AgentSession`, `AbortController`) in returned records.

The architecture doc specifies a typed interface with `Symbol.for()` accessor functions that other extensions import as an optional peer dependency.
This issue implements that boundary, following the naming and structural conventions established by `pi-permission-system`.

## Goals

- Export `SubagentsService` interface, `SubagentRecord`, `SubagentStatus`, `SpawnOptions`, `LifetimeUsage`, accessor functions (`publishSubagentsService`, `getSubagentsService`), and event constants from the package's public entry point.
- Create `src/service-adapter.ts` — an adapter wrapping `AgentManager` to satisfy `SubagentsService`, handling string model resolution and record serialization.
- Call `publishSubagentsService()` at extension init; clean up on `session_shutdown`.
- Remove the old `Symbol.for("pi-subagents:manager")` global key.
- This is a **breaking change** (`feat!:`) — the old untyped global key is removed and replaced with the typed service under a new key.
- Follow the naming and structural conventions established by `pi-permission-system` (`service.ts`, `@gotgenes/<pkg>:service` key, `Record<symbol, unknown>` cast).

## Non-Goals

- Consumer extensions (scheduling, transcript) — these are separate packages.
- Native Pi service registry integration (`pi.registerService()`) — deferred to a future Pi SDK release.
- `SubagentsService.resume()` — not part of the initial interface per the architecture doc.
- Output-file JSONL format migration (#61).

## Background

### Prerequisite issues

- #49 (remove group-join and RPC) — **closed/merged**.
  The untyped RPC channels are already gone.
- #52 (remove scheduled subagents) — **closed/merged**.
- #51 (update ADR for hard fork) — **closed/merged**.

### Relevant modules

| Module                  | Role in this change                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | Wiring layer. Currently publishes the untyped global; will call `publishSubagentsService()` instead. |
| `src/agent-manager.ts`  | Core lifecycle manager. The adapter wraps its public methods.                                        |
| `src/model-resolver.ts` | `resolveModel()` converts string → `Model`. The adapter calls this at the API boundary.              |
| `src/types.ts`          | Defines `AgentRecord` (internal, non-serializable).                                                  |
| `src/usage.ts`          | Exports `LifetimeUsage` (already serializable).                                                      |

### Constraints from AGENTS.md

- One concern per file — types/accessors in `src/service.ts`, adapter logic in `src/service-adapter.ts`.
- Avoid `any` unless absolutely necessary — the accessor functions use `Record<symbol, unknown>` on `globalThis`.
- Pi SDK imports stay out of business-logic modules — `service-adapter.ts` accepts `pi` and `ctx` as narrow interface parameters.
- Narrow interface types for collaborators — the adapter takes a minimal `AgentManagerLike` interface, not the concrete `AgentManager` class.

### Alignment with pi-permission-system

This plan deliberately follows the pattern established by `@gotgenes/pi-permission-system`:

| Aspect          | pi-permission-system                       | pi-subagents (this plan)                |
| --------------- | ------------------------------------------ | --------------------------------------- |
| Public file     | `src/service.ts`                           | `src/service.ts`                        |
| Interface name  | `PermissionsService`                       | `SubagentsService`                      |
| Symbol.for key  | `"@gotgenes/pi-permission-system:service"` | `"@gotgenes/pi-subagents:service"`      |
| globalThis cast | `Record<symbol, unknown>`                  | `Record<symbol, unknown>`               |
| Accessors       | `publish/get/unpublishPermissionsService`  | `publish/get/unpublishSubagentsService` |
| exports →       | `./src/service.ts`                         | `./src/service.ts`                      |

The architecture doc uses `SubagentsAPI` naming and `pi:service:subagents` key; it should be updated during implementation to reflect the final naming.

## Design Overview

### Module decomposition

```text
src/service.ts          ← SubagentsService interface, SubagentRecord, SpawnOptions,
                          SubagentStatus, accessor functions, event constants
src/service-adapter.ts  ← createSubagentsService() factory, record serialization,
                          model resolution at the boundary
src/index.ts            ← wire: publishSubagentsService(createSubagentsService(...))
```

### Types (in `src/service.ts`)

```typescript
export type SubagentStatus =
  | "queued" | "running" | "completed" | "steered"
  | "aborted" | "stopped" | "error";

export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  worktreeResult?: { hasChanges: boolean; branch?: string };
}

export interface SpawnOptions {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  isolated?: boolean;
  inheritContext?: boolean;
  foreground?: boolean;
  bypassQueue?: boolean;
  isolation?: "worktree";
}

export interface SubagentsService {
  spawn(type: string, prompt: string, options?: SpawnOptions): string;
  getRecord(id: string): SubagentRecord | undefined;
  listAgents(): SubagentRecord[];
  abort(id: string): boolean;
  steer(id: string, message: string): Promise<boolean>;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
}

export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  ACTIVITY: "subagents:activity",
} as const;
```

### Accessor pattern

```typescript
const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

export function publishSubagentsService(service: SubagentsService): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
}

export function getSubagentsService(): SubagentsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
    | SubagentsService
    | undefined;
}

export function unpublishSubagentsService(): void {
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
}
```

### Adapter (`src/service-adapter.ts`)

The adapter accepts narrow interfaces rather than concrete classes:

```typescript
interface AgentManagerLike {
  spawn(pi: any, ctx: any, type: string, prompt: string, options: any): string;
  getRecord(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
  abort(id: string): boolean;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
}

interface AdapterDeps {
  manager: AgentManagerLike;
  resolveModel: (input: string, registry: ModelRegistry) => any;
  getCtx: () => { pi: any; ctx: any } | undefined;
  getModelRegistry: () => ModelRegistry | undefined;
}
```

Key behaviors:

1. **String model resolution** — `spawn()` calls `resolveModel(options.model, registry)` before delegating to the manager.
   If resolution fails, throws with the error string (list of available models).
2. **Session gating** — throws if `getCtx()` returns `undefined` (no active session).
3. **Record serialization** — `toSubagentRecord()` strips `session`, `abortController`, `promise`, `pendingSteers`, `outputCleanup` from `AgentRecord`.
4. **Steer delegation** — uses the same pattern as the `steer_subagent` tool: checks status, queues if session not ready, delegates to `session.steer()`.

This mirrors the `pi-permission-system` pattern: a slim `service.ts` defines the contract and accessors; a separate adapter file contains the implementation wiring.

### Public entry point

The package currently has no explicit `exports` field in `package.json`.
Since Pi loads the extension via `pi.extensions` (pointing at `./src/index.ts`), the service types and accessors need a separate public entry point.
Add an `exports` map:

```json
{
  "exports": {
    ".": "./src/service.ts"
  }
}
```

This exposes the types and accessor functions to consumers who `import("@gotgenes/pi-subagents")`.
The extension entry point (`./src/index.ts`) remains declared in `pi.extensions`.
This matches the pattern established by `pi-permission-system` (`exports` → `service.ts`, `pi.extensions` → `index.ts`).

### Edge cases

- **No active session**: `spawn()` throws `"No active session — cannot spawn agents outside a session."`.
- **Model resolution failure**: `spawn()` throws with the error string from `resolveModel()`.
- **Missing description**: default to a truncated prompt (`prompt.slice(0, 80)`).
- **Steer on non-running agent**: returns `false`.
- **Steer before session ready**: queues the message (returns `true`).

### Naming conventions

Following `pi-permission-system`'s established pattern:

- Public file: `service.ts` (not `api.ts`)
- Interface: `SubagentsService` (not `SubagentsAPI`)
- Symbol key: `"@gotgenes/pi-subagents:service"` (scoped package name, not generic `pi:service:*`)
- globalThis cast: `Record<symbol, unknown>` (not `any`)
- Accessor names: `publish/get/unpublishSubagentsService`

## Module-Level Changes

### New files

| File                           | Contents                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/service.ts`               | `SubagentsService` interface, `SubagentRecord`, `SubagentStatus`, `SpawnOptions`, `LifetimeUsage` re-export, accessor functions, event constants, `unpublishSubagentsService`. |
| `src/service-adapter.ts`       | `createSubagentsService()` factory. `toSubagentRecord()` serializer. Narrow `AgentManagerLike` and `AdapterDeps` interfaces.                                                   |
| `test/service-adapter.test.ts` | Unit tests for the adapter (model resolution, serialization, session gating, steer delegation).                                                                                |
| `test/service.test.ts`         | Unit tests for accessor functions (publish/get/unpublish round-trip, isolation between keys).                                                                                  |

### Modified files

| File           | Change                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | Import `publishSubagentsService`, `unpublishSubagentsService` from `./service.js` and `createSubagentsService` from `./service-adapter.js`. Replace `Symbol.for("pi-subagents:manager")` block with `publishSubagentsService(createSubagentsService(...))`. In `session_shutdown`, call `unpublishSubagentsService()` instead of `delete (globalThis as any)[MANAGER_KEY]`. |
| `package.json` | Add `"exports": { ".": "./src/service.ts" }`.                                                                                                                                                                                                                                                                                                                               |
| `src/usage.ts` | No change needed — `LifetimeUsage` is already exported. Re-exported from `src/service.ts`.                                                                                                                                                                                                                                                                                  |

## Test Impact Analysis

1. **New unit tests enabled**: `test/service-adapter.test.ts` tests the adapter in isolation against a mock `AgentManagerLike` — model resolution, record stripping, session gating, steer semantics.
   `test/service.test.ts` tests the accessor functions (publish/get/unpublish lifecycle, `undefined` before publish).
2. **Existing tests that become redundant**: None — the old `Symbol.for("pi-subagents:manager")` global was not unit-tested.
3. **Existing tests that must stay**: All `agent-manager.test.ts` and `agent-runner.test.ts` tests remain — they test the internal engine, not the public service boundary.
   Any test referencing `MANAGER_KEY` or `"pi-subagents:manager"` in string assertions must be updated.

## TDD Order

1. **`src/service.ts` — types, accessors, and event constants.**
   Test: `test/service.test.ts` — `publishSubagentsService` stores on globalThis, `getSubagentsService` retrieves it, `unpublishSubagentsService` removes it, `getSubagentsService` returns `undefined` when not published.
   Commit: `feat!: add SubagentsService types and accessor functions`

2. **`src/service-adapter.ts` — `toSubagentRecord()` serializer.**
   Test: `test/service-adapter.test.ts` — given an `AgentRecord` with `session`, `abortController`, `promise`, `pendingSteers`, `outputCleanup`, verify the returned `SubagentRecord` contains only serializable fields.
   Commit: `feat: add SubagentRecord serializer`

3. **`src/service-adapter.ts` — `createSubagentsService().getRecord()` and `listAgents()`.**
   Test: verify `getRecord` delegates to manager and serializes; `listAgents` returns serialized records sorted by `startedAt` descending.
   Commit: `feat: implement getRecord and listAgents on SubagentsService adapter`

4. **`src/service-adapter.ts` — `spawn()` with model resolution and session gating.**
   Test: (a) throws when `getCtx()` returns `undefined`; (b) resolves string model names via `resolveModel`; (c) throws on model resolution failure; (d) delegates to manager with resolved model; (e) uses truncated prompt as default description.
   Commit: `feat: implement spawn with model resolution on SubagentsService adapter`

5. **`src/service-adapter.ts` — `steer()`, `abort()`, `waitForAll()`, `hasRunning()`.**
   Test: `steer` returns `false` for non-running agent, `true` when session queues or delivers; `abort`/`waitForAll`/`hasRunning` delegate to manager.
   Commit: `feat: implement steer, abort, waitForAll, hasRunning on adapter`

6. **Wire into `src/index.ts` — replace old global with typed service.**
   Replace `Symbol.for("pi-subagents:manager")` block with `publishSubagentsService(createSubagentsService(...))`.
   Update `session_shutdown` to call `unpublishSubagentsService()`.
   Commit: `feat!: publish SubagentsService at extension init, remove old untyped global`

7. **Add `exports` to `package.json`.**
   Add `"exports": { ".": "./src/service.ts" }` so consumers can `import("@gotgenes/pi-subagents")`.
   Commit: `feat: expose public service entry point via package exports`

8. **Run full suite and type check.**
   `pnpm vitest run && pnpm run check`.
   Fix any straggling references to `MANAGER_KEY` or `"pi-subagents:manager"` in tests.
   Commit (if fixes needed): `test: update references to old Symbol.for key`

## Risks and Mitigations

| Risk                                                                            | Mitigation                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consumers relying on the old `pi-subagents:manager` key break silently          | This is a `feat!:` (major bump). No other package in this monorepo references the old key. Document migration in CHANGELOG via release-please.                                                                     |
| `exports` field breaks Pi's extension loader                                    | Pi loads via `pi.extensions` (`./src/index.ts`), which is separate from `exports`. The `exports` field only affects `import("@gotgenes/pi-subagents")` from consumer code. Same pattern as `pi-permission-system`. |
| Adapter leaks internal state if `AgentRecord` gains new non-serializable fields | `toSubagentRecord()` uses an explicit allowlist (pick pattern), not a denylist. New fields must be opted in.                                                                                                       |
| `steer()` race condition — session created between status check and queue push  | The existing tool handler has the same race window and handles it acceptably. The adapter uses the same pattern (check session → queue if absent → delegate if present).                                           |
| `resolveModel` returns `any` — type unsafety at boundary                        | The adapter's `AgentManagerLike.spawn` already accepts `Model<any>` for the `options.model` field. The `any` is confined to the model-resolution seam, matching existing code.                                     |
| Architecture doc uses different naming (`SubagentsAPI`, `pi:service:subagents`) | Open question documented below. Update the architecture doc during implementation to reflect final naming.                                                                                                         |

## Open Questions

- Should `SubagentsService` be augmented with an `onEvent(channel, callback)` subscription method, or is `pi.events.on(SUBAGENT_EVENTS.COMPLETED, ...)` sufficient for consumers?
  Deferred — consumers already have access to `pi.events` and the event constants are exported.
- The architecture doc uses `SubagentsAPI` naming and `pi:service:subagents` key.
  This plan intentionally diverges to align with the established `pi-permission-system` pattern (`*Service` naming, `@gotgenes/<pkg>:service` key, `Record<symbol, unknown>` cast).
  The architecture doc should be updated during implementation to reflect the final naming.
