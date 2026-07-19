---
issue: 422
issue_title: "pi-subagents: delete AgentActivityTracker and ui-observer, drop the activity map from the core"
---

# Delete AgentActivityTracker and ui-observer, drop the activity map from the core

## Problem Statement

The activity tier is the UI's live-streaming bookkeeping, but today it lives inside the core.
A `Map<string, AgentActivityTracker>` sits on the core composition root (`SubagentRuntime`), and the two spawn tools construct trackers, open a second session subscription (`subscribeUIObserver`), and populate or delete the map.
After Phase 18 Step 2 ([#421]) migrated every reader to the record getters, nothing reads the trackers or the map any longer — they are dead bookkeeping the core still maintains.
This is the third step of the Phase 18 spine (activity-tier disentanglement): delete `AgentActivityTracker` and `ui-observer`, and remove the activity map from `SubagentRuntime` and the spawn tools.

## Goals

- Delete `src/ui/agent-activity-tracker.ts` and `src/ui/ui-observer.ts` (~145 LOC).
- Remove `agentActivity` from `SubagentRuntime` (`src/runtime.ts`) and from the `AgentToolRuntime` slice (`src/tools/agent-tool.ts`).
- Stop constructing trackers, calling `subscribeUIObserver` / `setSession`, and populating or deleting the map in `src/tools/foreground-runner.ts` and `src/tools/background-spawner.ts`.
- Remove the now-unused `AgentActivityAccess` interface and the `agentActivity` parameter from both spawner functions.
- Leave each child session with exactly one session subscription (the core's own `record-observer`) and zero UI state on the runtime.
- Keep the existing test suite green at every commit.

This is **not** a breaking change.
`AgentActivityTracker`, `ui-observer`, and `SubagentRuntime.agentActivity` are internal symbols — none appear in the public service surface (`src/service/service.ts`) or the settings entry (`src/layered-settings.ts`).
Observable behavior is unchanged; commits use `refactor:` / `docs:`.

## Non-Goals

- Changing how the widget starts/stops its timer — the spawn tools still call `widget.ensureTimer` / `update` / `markFinished` after this step; that decoupling is Phase 18 Step 4 ([#423]).
- Dropping the `widget` or activity-map constructor params from the `subagent` tool — that is Phase 18 Step 5 ([#424]).
- Touching `record-observer.ts`, `SubagentState`, or the record getters added in Steps 1–2.
- Reconciling the public event contract (Step 6) or any UI-distribution decision (Step 8).

## Background

Relevant modules and their current relationships:

- `src/ui/agent-activity-tracker.ts` — `AgentActivityTracker` class (active tools, response text, turn count, session ref).
  Constructed per-spawn in both spawner tools; written via transition methods; no longer read after [#421].
- `src/ui/ui-observer.ts` — `subscribeUIObserver(session, tracker, onUpdate?)` opens a second session subscription parallel to `record-observer` and streams events into the tracker.
- `src/runtime.ts` — `SubagentRuntime.agentActivity: Map<string, AgentActivityTracker>`, the UI streaming-state map on the core composition root.
- `src/tools/agent-tool.ts` — declares the `AgentActivityAccess` interface and the `AgentToolRuntime.agentActivity` field; passes `this.runtime.agentActivity` into both spawners.
- `src/tools/foreground-runner.ts` — constructs `fgState`, calls `setSession` + `subscribeUIObserver`, populates and deletes the map; its `streamUpdate` already reads activity off the record (`recordRef`), not the tracker.
- `src/tools/background-spawner.ts` — constructs `bgState`, calls `setSession` + `subscribeUIObserver` inside an `observer.onSessionCreated`, populates the map.

The architecture doc records this as Phase 18 Step 3 (`docs/architecture/architecture.md`, roadmap and step-dependency diagram), with the explicit outcome "−145 LOC, one session subscription per child, runtime holds zero UI state."

AGENTS.md constraints that apply:

- Run `pnpm fallow dead-code` locally before pushing — deleting modules can orphan sibling exports.
- pi-subagents is a narrow core with no UI policy; removing UI bookkeeping from the core moves it in the documented direction (dependency arrows point inward).

## Design Overview

This step is a deletion enabled by Step 2, not a new abstraction.
The two structural wins are removing an output-argument pattern (`agentActivity.set(...)` / `.delete(...)` writes into a received map) and narrowing two function signatures by dropping the `agentActivity` parameter.

### Foreground runner

The `observer.onSessionCreated` callback stays — it is still the only place `recordRef` and `fgId` are bound mid-flight (while `spawnAndWait` is in progress) and where `widget.ensureTimer()` fires.
Only the tracker lines are removed.
The post-change callback:

```typescript
observer: {
  onSessionCreated: (agent) => {
    recordRef = agent;
    fgId = agent.id;
    widget.ensureTimer();
  },
},
```

The `fgState` construction, the `unsubUI` variable and its two `unsubUI?.()` cleanup calls, and `agentActivity.set` / `agentActivity.delete` all go.
`streamUpdate` is unchanged — it already reads `recordRef?.turnCount`, `recordRef?.activeTools`, `recordRef?.responseText`.
Re-renders are driven by the existing 80 ms spinner interval, which reads fresh record state populated by the core's `record-observer`.

### Background spawner

`onSessionCreated` in the background spawner did **only** tracker work (`bgState.setSession`, `subscribeUIObserver`), so the entire `observer` block is removed from the spawn opts.
The post-spawn `widget.ensureTimer()` and `widget.update()` calls (outside the observer) stay.
The `bgState` construction and `agentActivity.set(id, bgState)` go.

### Agent tool

`AgentTool` stops passing `this.runtime.agentActivity` to both spawners (Step "remove param").
The `AgentActivityAccess` interface, the `AgentToolRuntime.agentActivity` field, and the `import { AgentActivityTracker }` are removed once no caller references them.

### Runtime

`SubagentRuntime.agentActivity` and its `import type { AgentActivityTracker }` are removed, along with the field's doc comment.
The session-context methods and `createSubagentRuntime` are untouched.

## Module-Level Changes

Source:

- `src/tools/foreground-runner.ts` — remove `AgentActivityTracker` import, `subscribeUIObserver` import, `AgentActivityAccess` import, the `agentActivity` parameter, `fgState`, `unsubUI` (+ both `unsubUI?.()` calls), `agentActivity.set`, `agentActivity.delete`; trim the doc comment that lists "AgentActivityTracker creation, UI observer subscription".
- `src/tools/background-spawner.ts` — remove `AgentActivityTracker` import, `subscribeUIObserver` import, `AgentActivityAccess` import, the `agentActivity` parameter, `bgState`, the entire `observer` block, `agentActivity.set`; trim the doc comment.
- `src/tools/agent-tool.ts` — remove `AgentActivityAccess` interface, `AgentToolRuntime.agentActivity` field, `import { AgentActivityTracker }`, and the two `this.runtime.agentActivity` arguments to `spawnBackground` / `runForeground`.
- `src/runtime.ts` — remove `agentActivity` field (+ doc comment) and `import type { AgentActivityTracker }`.
- `src/types.ts` — reword the `SubscribableSession` doc comment from "Used by record-observer and ui-observer" to reference `record-observer` only.
- `src/ui/agent-activity-tracker.ts` — **delete**.
- `src/ui/ui-observer.ts` — **delete**.

Tests:

- `test/ui/agent-activity-tracker.test.ts` — **delete**.
- `test/ui/ui-observer.test.ts` — **delete**.
- `test/tools/foreground-runner.test.ts` — drop the `runtime.agentActivity` argument from every `runForeground(...)` call; remove the "registers activity tracker in agentActivity on session creation" test (redundant with the ensureTimer/markFinished test).
- `test/tools/background-spawner.test.ts` — drop the `runtime.agentActivity` argument from every `spawnBackground(...)` call; remove the "registers an AgentActivityTracker in agentActivity map" test and the `AgentActivityTracker` import.
- `test/tools/agent-tool.test.ts` — remove the "registers activity in agentActivity map" test.
- `test/runtime.test.ts` — remove the "agentActivity map is independently mutable" and "multiple instances are isolated" tests, the two `agentActivity` assertions in "returns correct defaults", and the `AgentActivityTracker` import.
- `test/helpers/make-deps.ts` — remove the `agentActivity` map construction, the `agentActivity` field on the runtime stub, and the `AgentActivityTracker` import; update the runtime doc comment.
- `test/helpers/make-deps.test.ts` — remove the "agentActivity is an empty Map on the runtime" test, the "runtime.agentActivity satisfies AgentActivityAccess" test, and the `AgentActivityTracker` import.

Docs:

- `docs/architecture/architecture.md`:
  - File tree (around line 350) — remove the `agent-activity-tracker.ts` and `ui-observer.ts` entries.
  - "Observation model" prose (around lines 365–368) — drop the "UI streaming … is handled by `ui/ui-observer.ts`" sentence and the stale "widget reads agent state by polling a shared `Map<string, AgentActivityTracker>`" sentence (the widget reads off records since [#421]).
  - System diagram (around line 68) — remove the `ui-observer` node.
  - Sequence-diagram note (around line 261) — drop "+ ui-observer" so it reads "agent-observer subscribes to session events".
  - Phase 18 roadmap Step 3 entry — mark complete (✅) with a `Landed:` bullet, matching the Steps 1–2 format.
  - Phase 18 health-metrics table — the "Activity-tier modules slated for removal" row becomes historical; leave the snapshot but ensure the Step 3 `Landed:` bullet records the realized LOC delta.
- `.pi/skills/package-pi-subagents/SKILL.md`:
  - Module-dependency-flow block — remove `←─subscribes─ ui-observer` from the `record-observer ─subscribes─→ AgentSession` line.
  - Domain table — UI directory count `12 → 10`; domain header "seven domains (59 files)" → "(57 files)".

Historical docs under `docs/plans/`, `docs/retro/`, and `docs/architecture/history/` reference these symbols as records of past work and are **not** edited.

## Test Impact Analysis

This is a deletion, not an extraction, so it enables no new lower-level tests.

1. New tests enabled: none — the deleted modules' behavior is gone, not relocated.
2. Tests that become redundant: the tracker/observer unit suites (`agent-activity-tracker.test.ts`, `ui-observer.test.ts`) test deleted code and are removed wholesale; the "registers in agentActivity map" tests across `foreground-runner`, `background-spawner`, `agent-tool`, `runtime`, and `make-deps` test removed state and are deleted.
3. Tests that must stay: the spawner result-text tests, the `ensureTimer` / `markFinished` / `update` widget-driving tests, the foreground streaming-`onUpdate` test, and the runtime session-context tests — they exercise behavior that survives this step.

## Invariants at risk

This step touches surfaces refactored by Phase 18 Steps 1–2.
The relevant prior `Landed:` invariants and the tests that pin them:

- "no consumer references `AgentActivityTracker`" (Step 2 outcome) — pinned by the type checker: after this step the symbol is deleted, so any surviving reference fails `pnpm run check`.
  The foreground `streamUpdate` reading off `recordRef` (Step 2) must remain — covered by `test/tools/foreground-runner.test.ts` "calls onUpdate with streaming details while running".
- "`Subagent` is the single home for all run state; getters available" (Step 1 outcome) — unchanged here; the getters keep their existing coverage in `test/lifecycle/` and `test/observation/`.
- Foreground re-render after dropping the second subscription — pinned by the streaming-`onUpdate` test (spinner-driven tick), confirming re-renders survive without `subscribeUIObserver`.

No new test is required; the type checker plus the surviving streaming test cover the at-risk invariants.

## TDD Order

This is primarily code deletion; each step is a `refactor:`/`docs:` commit that keeps `pnpm run check` and the full suite green.
Steps are ordered so no commit leaves a dangling type reference.

1. **Remove tracker wiring + the `agentActivity` parameter from the spawners.**
   Edit `foreground-runner.ts` and `background-spawner.ts` to drop tracker construction, `subscribeUIObserver`/`setSession`, map writes, and the `agentActivity` parameter; update the two `AgentTool` call sites; update `foreground-runner.test.ts` and `background-spawner.test.ts` (drop the arg, remove the "registers tracker" tests and the `AgentActivityTracker` import in the background test).
   The parameter removal cascades to call sites and tests at the type level, so they land together.
   Run `pnpm run check` immediately after — shared-signature change.
   Commit: `refactor: stop wiring activity trackers in the spawn tools (#422)`.

2. **Remove the activity map from the runtime and the agent-tool slice.**
   Delete `SubagentRuntime.agentActivity` (`runtime.ts`), the `AgentActivityAccess` interface, the `AgentToolRuntime.agentActivity` field, and the `AgentActivityTracker` import in `agent-tool.ts`; update `make-deps.ts` (drop the map + field), and all tests reading the field (`runtime.test.ts`, `make-deps.test.ts`, `agent-tool.test.ts`).
   Removing the field and `AgentActivityAccess` export breaks every reader at the type level, so all consumer + test updates land in this commit.
   Run `pnpm run check` immediately after.
   Commit: `refactor: drop the activity map from the runtime and agent tool (#422)`.

3. **Delete the dead modules and their tests.**
   Delete `src/ui/agent-activity-tracker.ts`, `src/ui/ui-observer.ts`, `test/ui/agent-activity-tracker.test.ts`, `test/ui/ui-observer.test.ts`; reword the `SubscribableSession` comment in `types.ts`.
   Run `pnpm fallow dead-code` to confirm no sibling export (e.g. `SessionLike`, `SubscribableSession`) was orphaned.
   Commit: `refactor: delete AgentActivityTracker and ui-observer (#422)`.

4. **Update the architecture doc and package skill.**
   Apply the doc edits listed in Module-Level Changes (file tree, observation-model prose, system + sequence diagrams, Phase 18 Step 3 ✅ + `Landed:` bullet, SKILL.md flow diagram and domain counts).
   Verify any touched Mermaid renders (load the `mermaid` skill).
   Commit: `docs: mark Phase 18 Step 3 complete and remove activity-tier references (#422)`.

## Risks and Mitigations

- **Foreground re-render cadence.**
  Dropping `subscribeUIObserver` removes event-driven re-renders; updates now rely solely on the 80 ms spinner poll.
  The displayed content is identical within ≤80 ms latency (the poll reads the same record the core observer populates), and the spinner already ran at this cadence — no perceptible regression.
  Pinned by the streaming-`onUpdate` test.
- **Stale doc references.**
  The architecture doc and SKILL.md describe the activity map as current state.
  Mitigation: Step 4 grep-driven sweep; the file tree, prose, and two diagrams are all listed explicitly.
- **Orphaned sibling exports.**
  Deleting the modules could orphan `SessionLike` or `SubscribableSession`.
  Verified during planning: both remain used (`SessionLike` by `subagent-session.ts`; `SubscribableSession` by `record-observer.ts`, `subagent-session.ts`, `types.ts`).
  Mitigation: `pnpm fallow dead-code` in Step 3.
- **Commit ordering.**
  Removing the field before the spawners stop passing it would break the build.
  Mitigation: Step 1 (stop passing) strictly precedes Step 2 (remove field).

## Open Questions

None blocking.
Whether the widget should self-drive from lifecycle events (so the spawners no longer call `ensureTimer`/`update`/`markFinished`) is deferred to Phase 18 Step 4 ([#423]).

[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
