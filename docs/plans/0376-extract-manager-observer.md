---
issue: 376
issue_title: "Extract the manager observer from index.ts into a class"
---

# Extract the manager observer from index.ts into a class

## Problem Statement

`index.ts` constructs an inline `SubagentManagerObserver` object literal (~50 lines, four methods) at the composition root and hands it to `SubagentManager`.
The literal mixes three concerns: emitting `pi.events` lifecycle events, persisting the final record via `pi.appendEntry`, and dispatching completion notifications through the `NotificationManager`.
Per code-design principle 9 (state and behavior belong in a class, not a closure-captured literal), these three concerns cannot be unit-tested today without booting the entire extension.
`index.ts` is the package's dominant churn hotspot (31.3, 91 commits); shrinking it is the goal of Phase 17 Track B.

## Goals

- Extract the inline observer literal into a `SubagentEventsObserver` class under `src/observation/`, constructed with narrow deps: an `emit` function, an `appendEntry` function, and the `NotificationSystem`.
- `index.ts` instantiates the class and passes it to `SubagentManager` in place of the literal.
- Unit-test the observer's three concerns directly (event shapes, record persistence payload, notification dispatch branching) without booting the extension.
- Preserve every emitted event payload and `appendEntry` shape byte-for-byte — this is a pure extraction with no observable behavior change (not breaking).
- Bring `index.ts` below 170 lines.

## Non-Goals

- Splitting widget delegation out of `SubagentRuntime` (Phase 17 Step 6, Issue [#377]) — Step 5 is its prerequisite but lands separately.
- Moving `buildEventData` out of `notification.ts` — it stays where it is tested and is imported by the new observer.
- Pushing event-payload construction onto `Subagent` (a Tell-Don't-Ask improvement) — tracked as an Open Question, out of scope here.
- Narrowing `NotificationSystem` to a two-method interface — see Open Questions.
- Any other Phase 17 step.

## Background

Relevant modules:

- `src/index.ts` (226 lines) — composition root.
  Defines `const observer: SubagentManagerObserver = { … }` at lines 79–134 and passes it to `new SubagentManager({ …, observer, … })`.
- `src/lifecycle/subagent-manager.ts` — owns the `SubagentManagerObserver` interface (four methods: `onSubagentStarted`, `onSubagentCompleted`, `onSubagentCompacted`, `onSubagentCreated`).
  This interface is the manager's contract and stays here.
- `src/observation/notification.ts` — exports `buildEventData(record)` (pure, tested in `notification.test.ts`), the `NotificationSystem` interface (`cancelNudge`, `sendCompletion`, `cleanupCompleted`, `dispose`), and `NotificationManager`.
- `src/observation/record-observer.ts` — the established pattern for an observation-domain module that subscribes/dispatches with narrow deps; the new class is a sibling.

The current literal's four methods:

- `onSubagentStarted(record)` → `emit("subagents:started", { id, type, description })`.
- `onSubagentCompleted(record)` → branch on terminal status to `emit("subagents:failed" | "subagents:completed", buildEventData(record))`; `appendEntry("subagents:record", { …8 fields… })`; then either `notifications.cleanupCompleted(record.id)` (when `record.notification?.resultConsumed`) or `notifications.sendCompletion(record)`.
- `onSubagentCompacted(record, info)` → `emit("subagents:compacted", { id, type, description, reason, tokensBefore, compactionCount })`.
- `onSubagentCreated(record)` → `emit("subagents:created", { id, type, description, isBackground: true })`.

SDK signatures the narrow deps mirror:

- `EventBus.emit(channel: string, data: unknown): void`.
- `ExtensionAPI.appendEntry<T = unknown>(customType: string, data?: T): void`.

The applicable AGENTS.md constraints: Pi SDK imports stay out of the observation module — the class accepts `emit`/`appendEntry` as injected callbacks (the same pattern `SettingsManager` uses with `SettingsEmit`), and `index.ts` wires them to `pi.events.emit`/`pi.appendEntry` via arrows (avoids `@typescript-eslint/unbound-method`).

## Design Overview

### Class shape

```typescript
/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
  emit: EventEmit;
  appendEntry: AppendEntry;
  notifications: NotificationSystem;
}

export class SubagentEventsObserver implements SubagentManagerObserver {
  private readonly emit: EventEmit;
  private readonly appendEntry: AppendEntry;
  private readonly notifications: NotificationSystem;

  constructor(deps: SubagentEventsObserverDeps) {
    this.emit = deps.emit;
    this.appendEntry = deps.appendEntry;
    this.notifications = deps.notifications;
  }

  onSubagentStarted(record: Subagent): void { /* emit started */ }
  onSubagentCompleted(record: Subagent): void { /* emit failed|completed, appendEntry, dispatch */ }
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void { /* emit compacted */ }
  onSubagentCreated(record: Subagent): void { /* emit created */ }
}
```

The four method bodies are moved verbatim from the literal — same event channels, same payload fields, same branching.
`buildEventData` is imported from `#src/observation/notification`.

### Call site in index.ts

```typescript
const observer = new SubagentEventsObserver({
  emit: (channel, data) => pi.events.emit(channel, data),
  appendEntry: (customType, data) => pi.appendEntry(customType, data),
  notifications,
});

const manager = new SubagentManager({
  createSubagentSession: (params) => createSubagentSession(params, subagentSessionDeps),
  baseCwd: process.cwd(),
  observer,
  limiter,
  getRunConfig: () => settings,
});
```

`notifications` (the `NotificationManager`) is already constructed earlier in `index.ts`, so the observer construction slots in where the literal was.

### Extracted-module interaction with upstream deps

The observer only *reads* from its inputs and *tells* its collaborators — no output-argument mutation, no reverse-search, no reach-back into the manager:

```text
onSubagentCompleted(record):
  reads   record.status / record.id / …            (Subagent getters)
  calls   buildEventData(record)                    (pure helper)
  tells   this.emit("subagents:completed", data)    (injected callback)
  tells   this.appendEntry("subagents:record", {…}) (injected callback)
  reads   record.notification?.resultConsumed       (LoD chain — pre-existing)
  tells   this.notifications.cleanupCompleted | sendCompletion
```

The one Law-of-Demeter chain (`record.notification?.resultConsumed`) is carried over unchanged from the literal; it is pre-existing and out of scope (see Open Questions).

### Design-review checklist result

| Smell            | Location                              | Evidence                                                 | Disposition                                  |
| ---------------- | ------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Dependency width | `SubagentEventsObserverDeps` (3 deps) | all methods use `emit`; `onSubagentCompleted` uses all 3 | OK — narrow                                  |
| LoD violation    | `onSubagentCompleted`                 | `record.notification?.resultConsumed`                    | Track and watch — pre-existing, out of scope |
| Output argument  | —                                     | none                                                     | Clean                                        |
| ISP              | `NotificationSystem` (4 methods)      | observer uses `sendCompletion`, `cleanupCompleted`       | Accept per issue spec — see Open Questions   |

The extraction introduces a real collaborator (a class that owns three behaviors and is independently testable), not a procedure split — each method returns no value but performs a distinct side-effecting concern that was previously untestable in isolation.

## Module-Level Changes

- `src/observation/subagent-events-observer.ts` (new)
  - Export `SubagentEventsObserver implements SubagentManagerObserver`, plus `EventEmit`, `AppendEntry`, and `SubagentEventsObserverDeps` types.
  - Imports: `SubagentManagerObserver` from `#src/lifecycle/subagent-manager`, `buildEventData` and `NotificationSystem` from `#src/observation/notification`, `Subagent` and `CompactionInfo` from `#src/types`.
- `src/index.ts` (changed)
  - Remove the inline `const observer: SubagentManagerObserver = { … }` literal (lines 79–134).
  - Add `import { SubagentEventsObserver } from "#src/observation/subagent-events-observer"`.
  - Construct `const observer = new SubagentEventsObserver({ emit, appendEntry, notifications })`.
  - Remove now-unused imports: `buildEventData` (moves to the new module) and the `type SubagentManagerObserver` import (the literal annotation is gone).
  - Keep `NotificationDetails` and `NotificationManager` imports (still used by `registerMessageRenderer` and the `notifications` construction).
- `test/observation/subagent-events-observer.test.ts` (new)
  - Unit tests for all four methods (see TDD Order).
- `docs/architecture/architecture.md` (changed)
  - Mark Phase 17 Step 5 `✅ Complete` and add a "Landed" note (index.ts line count, file/test counts).
  - Update the "Total LOC … (60 files …)" listings to 61 files and refresh the test count.
  - The churn-hotspot note for `index.ts` stays — Step 5 continues the shrink trend.

Grep confirms no `package-*/SKILL.md` documents the inline observer literal or `SubagentEventsObserver` by name; no skill-doc update needed.

## Test Impact Analysis

1. **New unit tests enabled.**
   All four observer methods become directly testable with `vi.fn()` stubs for `emit`/`appendEntry` and a stubbed `NotificationSystem`.
   Previously the only way to exercise these paths was through `SubagentManager` integration tests that drove the manager's `buildObserver` forwarding — the index-level observer body itself had zero coverage.
2. **No existing tests become redundant.**
   The `subagent-manager.test.ts` observer tests (lines 76–148) exercise the manager's *forwarding* (`buildObserver` → `this.observer?.onSubagent…`), a different layer that stays.
   `notification.test.ts` keeps the `buildEventData` tests.
   `agent-tool.test.ts:153` keeps its note that `subagents:created` is delegated to the observer.
3. **Tests that must stay as-is.**
   The manager forwarding tests and the `buildEventData` purity tests genuinely exercise layers the extraction does not touch.

## Invariants at risk

This step touches `index.ts`, which prior Phase 17 steps shrank, and the event/notification dispatch surface.
Step 6 ([#377]) depends on this step; it must not regress the index.ts shrink.

| Invariant                                                                                                                    | Pinned by                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Completion of a successful background agent emits `subagents:completed` (not `subagents:failed`) with `buildEventData` shape | new `onSubagentCompleted` success test        |
| Terminal `error`/`stopped`/`aborted` status emits `subagents:failed`                                                         | new `onSubagentCompleted` error test          |
| `appendEntry("subagents:record", …)` persists the eight-field record on every completion                                     | new `onSubagentCompleted` appendEntry test    |
| Already-consumed result skips `sendCompletion` and calls `cleanupCompleted`                                                  | new `onSubagentCompleted` resultConsumed test |
| `subagents:created` carries `isBackground: true`                                                                             | new `onSubagentCreated` test                  |

These invariants lived only in the untested inline literal before; the new tests pin them for the first time.

## TDD Order

1. **Red → Green → Commit: extract `SubagentEventsObserver` and wire `index.ts`.**

   Write `test/observation/subagent-events-observer.test.ts` first (red), covering:
   - `onSubagentStarted` emits `subagents:started` with `{ id, type, description }`.
   - `onSubagentCompleted` (success status) emits `subagents:completed` with `buildEventData(record)`, calls `appendEntry("subagents:record", …)` with the eight fields, and calls `notifications.sendCompletion(record)`.
   - `onSubagentCompleted` (error/stopped/aborted) emits `subagents:failed`.
   - `onSubagentCompleted` with `record.notification?.resultConsumed` calls `notifications.cleanupCompleted(record.id)` and does *not* call `sendCompletion`.
   - `onSubagentCompacted` emits `subagents:compacted` with `{ id, type, description, reason, tokensBefore, compactionCount }`.
   - `onSubagentCreated` emits `subagents:created` with `{ id, type, description, isBackground: true }`.

   Use `createTestSubagent({ … })` from `#test/helpers/make-subagent` for records (it provides status, result, error, `toolCallId` for `NotificationState`, `compactionCount`); `vi.fn()` for `emit`/`appendEntry`; a stub object for `NotificationSystem`.

   Then create `src/observation/subagent-events-observer.ts` (green) and update `index.ts` in the **same commit**: replace the literal with `new SubagentEventsObserver({ … })` and drop the now-unused `buildEventData` / `type SubagentManagerObserver` imports.
   The class and the index.ts swap are coupled — index.ts is the sole call site of the literal being replaced, and the new class needs a consumer to satisfy `pnpm fallow dead-code`.

   Run `pnpm --filter @gotgenes/pi-subagents run check` and `pnpm --filter @gotgenes/pi-subagents exec vitest run`.
   Commit: `refactor: extract SubagentEventsObserver from index.ts (#376)`

2. **Commit: mark Phase 17 Step 5 complete in the architecture doc.**

   In `docs/architecture/architecture.md`, mark Step 5 `✅ Complete`, add a "Landed" note (new index.ts line count, file count 60 → 61, refreshed test count), and update the two "(60 files …)" LOC listings.
   Commit: `docs: mark Phase 17 Step 5 complete in architecture.md (#376)`

## Risks and Mitigations

- **Risk:** the extracted methods drift from the literal's exact event payloads or `appendEntry` shape.
  **Mitigation:** move the bodies verbatim; the new tests assert each payload field explicitly, pinning the shapes.
- **Risk:** passing `pi.events.emit` / `pi.appendEntry` as bare values trips `@typescript-eslint/unbound-method`.
  **Mitigation:** wire them as arrow callbacks in `index.ts` (`(channel, data) => pi.events.emit(channel, data)`), matching the existing `SettingsManager` emit wiring.
- **Risk:** the new class is flagged as dead code by `pnpm fallow dead-code` if it lands before its consumer.
  **Mitigation:** the class and the `index.ts` wiring land in one commit (TDD step 1).
- **Risk:** `index.ts` does not drop below 170 lines.
  **Mitigation:** the literal is ~50 lines and the replacement is ~6; 226 − ~50 + ~6 ≈ 182 minus the removed import lines lands it near/below 170 — verify with `wc -l` during implementation and, if just over, the net is still a clear shrink (the Outcome target is directional, not a hard gate).

## Open Questions

- Should `NotificationSystem` be narrowed to a two-method `CompletionNotifier` (`sendCompletion`, `cleanupCompleted`) for the observer per ISP?
  Deferred: the issue prescribes passing `NotificationSystem`, and the interface is already cohesive.
  Revisit only if a third consumer wants the narrow slice.
- Should event-payload construction (and the `record.notification?.resultConsumed` read) move onto `Subagent` as Tell-Don't-Ask methods (`record.toEventData()`, `record.isResultConsumed()`)?
  Deferred: out of scope for a faithful extraction; `buildEventData` already exists as a pure helper.

[#377]: https://github.com/gotgenes/pi-packages/issues/377
