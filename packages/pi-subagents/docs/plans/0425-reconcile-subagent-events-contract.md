---
issue: 425
issue_title: "pi-subagents: reconcile the public SUBAGENT_EVENTS contract with emitted channels"
---

# Reconcile the public `SUBAGENT_EVENTS` contract with emitted channels

## Problem Statement

The public lifecycle-event contract has drifted out of sync with what the core actually broadcasts on `pi.events`.
`SUBAGENT_EVENTS.ACTIVITY = "subagents:activity"` is declared in the service surface (`src/service/service.ts`) and the architecture doc's lifecycle-events table, but no module ever emits it — a vacant hook that the architecture's own "no vacant hooks" rule forbids.
The vacancy hardened in Phase 18 Steps 1–5, which deleted the entire activity tier (`AgentActivityTracker`, `ui-observer`), so there is no streaming-progress source left to broadcast.
In the other direction, four channels the core does emit — `subagents:failed`, `subagents:compacted`, `subagents:created` (all in `SubagentEventsObserver`), and `subagents:steered` (in `steer-tool.ts`) — are absent from the constant map.
A consumer reading `SUBAGENT_EVENTS` therefore gets one channel that never fires and misses four that do.

## Goals

- Remove the vacant `SUBAGENT_EVENTS.ACTIVITY` constant.
  This is a **breaking change** to the public surface: it deletes a key from the exported `SUBAGENT_EVENTS` map, so a consumer referencing `SUBAGENT_EVENTS.ACTIVITY` breaks at the type level on upgrade.
  Use `feat!:` with a `BREAKING CHANGE:` footer.
- Add the four emitted agent-lifecycle channels to the constant map: `FAILED`, `COMPACTED`, `CREATED`, `STEERED`.
- After the change, declared channels equal emitted agent-lifecycle channels — no vacant hook, no undeclared emission.
- Update the lifecycle-events table in `docs/architecture/architecture.md` to match, and correct the stale `subagents:completed` payload shape while there.
- Mark Phase 18 Step 6 complete in the architecture roadmap.

## Non-Goals

- Re-introducing a streaming-progress (`activity`) event.
  The activity tier was deliberately deleted in Steps 1–3; resurrecting it is out of scope and was rejected during planning.
- Adding the config-domain events (`subagents:settings_loaded`, `subagents:settings_changed`) or the child-session seam events (`subagents:child:*`) to `SUBAGENT_EVENTS`.
  Those belong to separate domains and already have their own constant homes (settings emitter, `child-lifecycle.ts`); `SUBAGENT_EVENTS` is the agent-lifecycle bus only.
- The `subagents:record` session entry — it is an `appendEntry` (session persistence), not a `pi.events.emit`, so it is not a channel constant.
- Changing any event payload shape or emission site.
  This issue reconciles the *constant map* with what is *already emitted*; emission logic is untouched.
- Phase 18 Steps 7–8 (test-clone consolidation, UI reconsideration) — separate issues ([#426], [#427]).

## Background

- `src/service/service.ts` declares `SUBAGENT_EVENTS` as an `as const` object — the public, cross-extension channel constants, re-exported through the `.` subpath entry and rolled into `dist/public.d.ts`.
- `src/observation/subagent-events-observer.ts` emits `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:compacted`, and `subagents:created`.
- `src/tools/steer-tool.ts` emits `subagents:steered` with payload `{ id, message }`.
- The completed/failed payload is produced by `buildEventData(record)` in `src/observation/notification.ts`: `{ id, type, description, result, error, status, toolUses, durationMs, tokens? }`.
  The architecture doc's current table lists `subagents:completed` as `{ id, type, status, result?, error? }`, which is stale.
- AGENTS.md / `package-pi-subagents` skill constraint: any change to the public surface must run `pnpm --filter @gotgenes/pi-subagents run verify:public-types` (a CI gate), and sibling packages consume this one from the published registry release, not a workspace symlink.
- The "no vacant hooks" rule (ADR-0002, architecture doc §519) governs both directions here: admit a surface only when a real consumer/emitter exists.

This is a value-only reconciliation of a shared constant: no new collaborator, no dependency-wiring change, no new parameter on any interface — so the `design-review` dependency-width / Law-of-Demeter checklist surfaces nothing actionable.

## Design Overview

The reconciled constant map:

```typescript
/** Event channel constants for pi.events subscriptions. */
export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
  COMPACTED: "subagents:compacted",
  CREATED: "subagents:created",
  STEERED: "subagents:steered",
} as const;
```

The declared set is now exactly the set of agent-lifecycle channels emitted by `SubagentEventsObserver` and `steer-tool.ts`.

Updated lifecycle-events table (`architecture.md`):

| Channel               | Payload                                                                             | When                                          |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `subagents:started`   | `{ id, type, description }`                                                         | Agent begins running                          |
| `subagents:completed` | `{ id, type, description, status, result?, error?, toolUses, durationMs, tokens? }` | Agent finishes successfully                   |
| `subagents:failed`    | same as `completed` (`buildEventData` shape)                                        | Agent ends in `error`/`stopped`/`aborted`     |
| `subagents:compacted` | `{ id, type, description, reason, tokensBefore, compactionCount }`                  | Child session compacts                        |
| `subagents:created`   | `{ id, type, description, isBackground }`                                           | Background agent created (pre-admission)      |
| `subagents:steered`   | `{ id, message }`                                                                   | Steering message delivered to a running agent |

The `subagents:activity` row is removed.

### Edge cases

- `as const` preservation: the literal-string value types must stay narrow, so the new keys keep the `as const` assertion.
  `verify:public-types` confirms the rolled `dist/public.d.ts` exposes the narrowed literal types.
- No runtime emission changes: the four added constants name channels that are *already* fired, so subscribers wired to the string literals see no behavioral change — only the typed constant is now available.

## Module-Level Changes

- `packages/pi-subagents/src/service/service.ts` — remove the `ACTIVITY` key; add `FAILED`, `COMPACTED`, `CREATED`, `STEERED` to `SUBAGENT_EVENTS`.
- `packages/pi-subagents/test/service/service.test.ts` — update the `SUBAGENT_EVENTS` assertion: drop the `ACTIVITY` expectation, add expectations for the four new constants.
- `packages/pi-subagents/docs/architecture/architecture.md` — replace the lifecycle-events table (remove the `activity` row, add `failed`/`compacted`/`created`/`steered`, correct the `completed` payload); mark Phase 18 Step 6 complete with a `✅ … — complete.` prefix and a `Landed:` bullet.

Grep confirmation that no other live reference to the removed symbol exists:

- `grep -rn "SUBAGENT_EVENTS.ACTIVITY\|subagents:activity"` across `src/`, `test/`, and `.pi/skills/package-*/SKILL.md`: the only live hits are `service.ts:100`, the `service.test.ts` assertion, and the `architecture.md` table — all three are updated here.
  Remaining `subagents:activity` matches live in historical/plan docs (`docs/plans/0048-*`, `docs/architecture/history/`, the structural-analysis finding #6 snapshot) and are intentionally left as historical record.
- `docs/comparison-with-upstream.md` already lists the lifecycle bus as `created, started, completed, failed, steered, compacted` (no `activity`) — it matches the reconciled set and needs no edit.
- The architecture structural-analysis finding #6 (the phase-start smell snapshot) is left as-is, consistent with how findings #1–5 remain present-tense snapshots while their steps are marked `✅`.

## Test Impact Analysis

This is a constant-map reconciliation, not an extraction, so no new lower-level test surface opens up.

1. New tests enabled: none beyond the expanded `SUBAGENT_EVENTS` assertion — the change adds no new function or collaborator.
2. Tests becoming redundant: none.
   The emission-site tests in `test/observation/subagent-events-observer.test.ts` (which assert `subagents:failed`/`compacted`/`created` are emitted) and the steer-tool test stay — they pin the *emission*, while the service test pins the *declaration*.
3. Tests that must stay as-is: the observer and steer-tool emission tests — they genuinely exercise the channels the constants now name, and are the other half of the "declared == emitted" invariant.

## Invariants at risk

This step touches the public-contract surface that Step 6 is itself responsible for; no earlier Phase 18 step (1–5) refactored `SUBAGENT_EVENTS`, so there is no prior `Outcome:`/`Landed:` invariant to regress.
The invariant this step establishes — declared channels equal emitted agent-lifecycle channels — is pinned from both sides:

- Declaration: the updated `test/service/service.test.ts` `SUBAGENT_EVENTS` assertion.
- Emission: existing `test/observation/subagent-events-observer.test.ts` (`failed`/`compacted`/`created`) and the steer-tool test (`steered`).

## TDD Order

1. **Reconcile the constant map (red → green → commit).**
   Test surface: `test/service/service.test.ts` — rewrite the `SUBAGENT_EVENTS` assertion to expect `STARTED`, `COMPLETED`, `FAILED`, `COMPACTED`, `CREATED`, `STEERED` and to assert `ACTIVITY` is absent (`expect("ACTIVITY" in SUBAGENT_EVENTS).toBe(false)` or drop the import-time reference).
   This fails to compile/assert against the current map (red).
   Then edit `src/service/service.ts`: remove `ACTIVITY`, add the four new keys (green).
   Run `pnpm --filter @gotgenes/pi-subagents run check`, `pnpm --filter @gotgenes/pi-subagents run test`, and `pnpm --filter @gotgenes/pi-subagents run verify:public-types` (public-surface gate).
   Commit: `feat!: reconcile SUBAGENT_EVENTS with emitted channels (#425)` with a `BREAKING CHANGE:` footer noting the removal of `SUBAGENT_EVENTS.ACTIVITY` and the migration (subscribe to the emitted channel constants `FAILED`/`COMPACTED`/`CREATED`/`STEERED`; there is no replacement for `ACTIVITY` — the activity tier was removed in Phase 18).
2. **Update the architecture doc (commit, no test).**
   Replace the lifecycle-events table and correct the `completed` payload; mark Phase 18 Step 6 `✅ … — complete.` with a `Landed:` bullet.
   Run `pnpm --filter @gotgenes/pi-subagents run lint` (rumdl).
   Commit: `docs: reconcile lifecycle-events table with SUBAGENT_EVENTS (#425)`.

## Risks and Mitigations

- **Risk:** the breaking removal of `ACTIVITY` surprises a consumer.
  **Mitigation:** the constant was never emitted, so no consumer could meaningfully act on it; the `BREAKING CHANGE:` footer documents the removal and the absence of a replacement, and release-please carries it to the CHANGELOG and the issue close comment.
- **Risk:** the rolled `dist/public.d.ts` drifts from the source `as const` shape.
  **Mitigation:** `verify:public-types` packs the tarball and type-checks a throwaway consumer against both entries — run it in Step 1 before committing.
- **Risk:** stale `subagents:activity` references linger in docs.
  **Mitigation:** the Module-Level Changes grep enumerates every live vs. historical hit; only the three live references are edited, historical snapshots are intentionally preserved.

## Open Questions

None.
The two design choices (remove vs. emit `ACTIVITY`; three vs. four added channels) were resolved during planning: remove `ACTIVITY`, and declare all four emitted agent-lifecycle channels (`failed`/`compacted`/`created`/`steered`).

[#426]: https://github.com/gotgenes/pi-packages/issues/426
[#427]: https://github.com/gotgenes/pi-packages/issues/427
