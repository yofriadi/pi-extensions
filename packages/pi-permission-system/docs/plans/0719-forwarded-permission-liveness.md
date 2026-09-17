---
issue: 719
issue_title: "Subagent `ask` permissions stall for 10 minutes, then auto-deny without parent prompt"
---

# Forwarded-permission liveness and truthful abandonment

## Release Recommendation

**Release:** ship independently

This issue is a third-party bug report, not a numbered step in `docs/architecture/architecture.md`, so no `Release:` batch annotation applies.
The user-visible payoff (a subagent that fails in seconds with an honest reason instead of stalling for ten minutes and blaming the user) is worth releasing on its own.

## Problem Statement

A `@gotgenes/pi-subagents` child hit an `ask` rule on its first `bash` call.
No permission dialog appeared in the parent session.
The child sat without a tool result for exactly ten minutes, then received `[pi-permission-system] User denied bash command 'pwd'`.
The user denied nothing.

The report asks for two things.
The parent should display the forwarded request; failing that, the child should fail immediately with an explicit unsupported-authority error rather than waiting out `PERMISSION_FORWARDING_TIMEOUT_MS` and claiming a denial that never happened.

This plan delivers the second half in full and makes the first half diagnosable.
It does not claim to fix the underlying stall — see Non-Goals.

## Goals

- Every `ParentAuthorizer` abandonment path (unresolved target, unusable directory, request-write failure, corrupt response, poll timeout) carries `confirmationUnavailable: true` and a specific `denialReason`, so the child's tool result and review log say what actually happened.
- A forwarded `denialReason` reaches the block message the model sees, not just the review log.
- An **in-process** child detects that no session is draining its inbox and abandons within a short grace window instead of waiting the full timeout, naming the target session id in the reason.
- The serving side announces the session id it polls to the review log, so a target/serving mismatch is a one-line diff against the child's `request_created` entry.
- `PERMISSION_FORWARDING_TIMEOUT_MS` becomes a configurable default rather than a hard-coded constant.

This change is **not** breaking.
The fast-fail path replaces a ten-minute wait that already ended in a denial with a fast denial carrying a better message; the outcome is unchanged, only its latency and its wording.
The new config field is optional with the current value as its default.

## Non-Goals

- **Root-causing the stall itself.**
  Why the parent's `ForwardedRequestServer` never drained the request is not determinable from the report plus static reading, and this plan does not depend on finding out.
  Tracked in [#722], which carries the evidence gathered during planning.
- **Out-of-process children.**
  The chosen liveness signal is process-global, so a child spawned as a separate `pi` process (the `PI_SUBAGENT_PARENT_SESSION` env-var path) keeps today's behavior.
  A filesystem claim or heartbeat protocol for that case is parked in [#721].
- **Any change to `@gotgenes/pi-subagents`.**
  The issue carries both `pkg:` labels, but every change here lands in `pi-permission-system`; pi-subagents' side of the contract (the `subagents:child:session-created` event carrying `parentSessionId`) is already correct and untouched.
  This is therefore a single-package plan.
- **Prompt rendering.**
  The unbounded inline tool input in forwarded prompts is [#710] and stays there.
- **The `hasUI` branch of forwarding target resolution.**
  It is reachable only from tests today; the tidy step preserves it rather than removing it.

## Background

### The forwarding round trip

A child session with no UI that is detected as a subagent gets a `ParentAuthorizer` (`src/authority/authorizer.ts`, `selectAuthorizer`).
`ParentAuthorizer.waitForForwardedApproval` (`src/authority/approval-escalator.ts`) resolves a target session id, ensures `<forwardingDir>/sessions/<target>/{requests,responses}/`, writes a request file, and then polls `responses/<id>.json` every `PERMISSION_FORWARDING_POLL_INTERVAL_MS` (250 ms) until `PERMISSION_FORWARDING_TIMEOUT_MS` (10 min).

The serving side is `ForwardingManager` (`src/authority/forwarding-manager.ts`), a `setInterval` started from `PermissionSession.activate` whenever the context has a UI and is not a subagent.
Each tick calls `ForwardedRequestServer.processInbox` (`src/authority/forwarded-request-server.ts`), which resolves the request against recorded authority and escalates an `ask` to the serving session's own `Authorizer`.

### What the report pins down

The ten-minute wait proves the child selected `ParentAuthorizer`, since `selectAuthorizer` tests `ctx.hasUI` before `isSubagent` and an unresolved target denies immediately.
It also proves the parent never wrote a response: `resolveDecision` wraps the escalation in a `try`/`catch` and writes a denial on failure, so an escalation that threw would have answered in milliseconds.
So `processInbox` returned early — either its timer was not running, or `getExistingPermissionForwardingLocation(forwardingDir, ownSessionId)` did not resolve to the directory the child wrote into.

Pi's `showExtensionCustom` (`../pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2659`) has no turn-state gating and the TUI reads stdin non-blockingly, so "the parent was idle, so the dialog could not render" is ruled out.

### Existing machinery this plan reuses

`PermissionPromptDecision.confirmationUnavailable` already exists (`src/authority/permission-dialog.ts`) and already flips the block message from `buildUserDeniedBody` to `buildUnavailableBody` (`src/permission-gate.ts`, `src/denial-messages.ts`) and the review-log resolution from the decision state to `confirmation_unavailable` (`src/authority/permission-prompter.ts`).
`DenyingAuthorizer` sets it; `ParentAuthorizer` never does.
That single omission is why a forwarding timeout is reported as a user denial.

The process-global `SubagentSessionRegistry` (`src/authority/subagent-registry.ts`) is the established pattern for state that must cross the per-session jiti/event-bus split ([#296]): a `globalThis` slot keyed by `Symbol.for()`, obtained through an accessor and never constructed directly.
The serving registry introduced here follows it exactly.

### AGENTS.md constraints that apply

- Adding a config field means editing `src/config-schema.ts` (with `.meta({ description, markdownDescription })`), running `pnpm run gen:schema`, carrying it through `PermissionSystemExtensionConfig` and `mergeUnifiedConfigs()`, and updating `config/config.example.json` plus `docs/configuration.md`.
  A field on the runtime type but not the merge intermediate is silently dropped.
- Module-scoped mutable state does not reset per session.
  The serving registry is deliberately process-global (that is the point), but its entries are per-session-id and cleared on `session_shutdown`, so nothing leaks between sessions in the same cwd.
- `docs/architecture/architecture.md` module-tree entries describe current behavior; a new module gets an entry, and an issue ref only where it encodes an active constraint.

## Design Overview

### 1. `ServingSessionRegistry` — who is draining an inbox

A new process-global registry records, by session id, which sessions are currently polling their forwarded-permission inbox.

```typescript
/** Announce-side seam: the polling session marks and clears itself. */
export interface ServingAnnouncer {
  markServing(sessionId: string): void;
  clearServing(sessionId: string): void;
}

/** Query-side seam: a forwarding child asks whether its target is draining. */
export interface ServingLookup {
  isServing(sessionId: string): boolean;
  /** All currently-serving session ids, for the diagnostic review entry. */
  servingIds(): readonly string[];
}

export class ServingSessionRegistry
  implements ServingAnnouncer, ServingLookup {}

export function getServingSessionRegistry(): ServingSessionRegistry;
```

Two narrow seams rather than one wide interface: `ForwardingManager` announces and never queries, `ParentAuthorizer` queries and never announces (ISP).
`servingIds()` sits on the lookup seam because only the abandonment diagnostic reads it.

The backing store is `globalThis[Symbol.for("@gotgenes/pi-permission-system:serving-registry")]`.
Like `getSubagentSessionRegistry()`, the accessor has no teardown hook — a child's `session_shutdown` must not be able to wipe the parent's mark.

### 2. `ForwardingManager` announces what it polls

`ForwardingManager` gains the announcer and a logger, and tracks the session id it is currently serving:

```typescript
start(ctx: ExtensionContext): void {
  if (!ctx.hasUI || this.deps.detection.isSubagent(ctx)) {
    this.stop();
    return;
  }
  this.context = ctx;
  this.announce(getSessionId(ctx)); // clears a previous id, marks the new one
  if (this.timer) return;
  this.timer = setInterval(/* unchanged */);
}
```

`announce` is a no-op when the id is unchanged, so the per-turn `activate` calls from `AgentPrepHandler` and `PermissionGateHandler` cost one map lookup.
`stop()` clears the mark and logs `forwarded_permission.serving_stopped`; the first `announce` of a session logs `forwarded_permission.serving_started` with the session id.

That log line is the missing diagnostic: comparing it against the child's existing `forwarded_permission.request_created` `targetSessionId` distinguishes "the parent was not polling" from "the parent was polling a different id".

### 3. Forwarding target resolution returns its provenance

The fast-fail must not fire for an out-of-process child, whose parent lives in another process and can never appear in this process's serving registry.
The information needed to tell them apart already exists inside `resolvePermissionForwardingTargetSessionId` — it tries the in-process registry first and env vars second — and is then thrown away.

Rather than re-deriving it in `ParentAuthorizer` (two places that must agree about what "in-process" means — connascence of algorithm), the resolver returns a product:

```typescript
export interface PermissionForwardingTarget {
  sessionId: string;
  /** `"registry"` means the requester is an in-process child of `sessionId`. */
  source: "registry" | "env" | "self";
}

export function resolvePermissionForwardingTarget(
  options: /* unchanged */,
): PermissionForwardingTarget | null;
```

`"self"` is the existing `hasUI` branch, preserved unchanged.

### 4. `ParentAuthorizer` fast-fails and tells the truth

The poll loop gains a liveness check, folded into the existing 250 ms tick rather than added as a second timer:

```typescript
// inside pollForForwardedResponse, per tick, when target.source === "registry"
if (this.serving.isServing(target.sessionId)) {
  unservedSince = null;
} else {
  unservedSince ??= Date.now();
  if (Date.now() - unservedSince >= PERMISSION_FORWARDING_SERVING_GRACE_MS) {
    return this.abandon(/* … */, "no_serving_session");
  }
}
```

Checking inside the loop rather than once before the write makes the decision race-tolerant: a brief window between a session switch's `stop()` and the next `start()` does not abandon a request the parent is about to pick up.
`PERMISSION_FORWARDING_SERVING_GRACE_MS` is `2000` — eight poll ticks — and stays a constant, not a config key.

A stale mark (a session that died without `session_shutdown`) suppresses the fast-fail and falls back to the full timeout, which is today's behavior.
The failure mode of the new signal is therefore conservative in the safe direction.

Every abandonment returns the same shape:

```typescript
{
  approved: false,
  state: "denied",
  confirmationUnavailable: true,
  denialReason: "…",
}
```

with one reason per path:

| Path                          | `denialReason`                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------- |
| target unresolved             | `Could not resolve a parent session to forward this permission request to.`       |
| forwarding directory unusable | `Permission forwarding directories could not be prepared for session '<target>'.` |
| request write failed          | `The forwarded permission request could not be written.`                          |
| no serving session            | `Session '<target>' is not serving forwarded permission requests.`                |
| corrupt response              | `The parent session's permission response could not be read.`                     |
| poll timeout                  | `Session '<target>' did not answer within <n>s.`                                  |

The review log gains `forwarded_permission.no_serving_session` carrying `targetSessionId`, `requesterSessionId`, and `servingIds()`.
The id list stays in the log and out of the model-visible reason.

### 5. The unavailable block message carries the reason

`applyPermissionGate` already takes `userDeniedReason` as `(decision) => string` but `unavailableReason` as a precomputed `string`, so a `denialReason` on an unavailable decision is dropped before the model sees it.
Removing that asymmetry is the whole change:

```typescript
messages: {
  denyReason: string;
  unavailableReason: (decision: PermissionPromptDecision) => string;
  userDeniedReason: (decision: PermissionPromptDecision) => string;
};
```

`formatUnavailableReason(ctx, denialReason?)` appends the existing `reasonSuffix`, exactly as `formatUserDeniedReason` does.
The resulting child-visible message becomes, for the reported scenario:

```text
[pi-permission-system] Running bash command 'pwd' requires approval, but no
interactive UI is available. Reason: Session 'abc123' is not serving forwarded
permission requests.
```

### 6. `forwardingTimeoutMs` config field

A flat scalar, matching the existing `doublePressToConfirm` / `yoloMode` / `authorizerChain` shape rather than introducing a nested `permissionForwarding` object.
Default `600000`, unchanged from `PERMISSION_FORWARDING_TIMEOUT_MS`, which stays exported as the default constant.

It is read live, per ask, through a thunk — the same pattern `getPromptPreferences` and `getAuthorizerChain` already use — so a settings edit takes effect on the next forwarded request:

```typescript
// index.ts, into AuthorizerSelection's deps
getForwardingTimeoutMs: () => configStore.current().forwardingTimeoutMs,
```

`selectAuthorizer` threads it into `ParentAuthorizerDeps.getTimeoutMs`.
This injection is what finally makes the timeout path unit-testable: today a test that exercised it would run for ten minutes.

### Consumer call sites

`ParentAuthorizer`'s interaction with the two new collaborators, to confirm Tell-Don't-Ask holds:

```typescript
// composition (selectAuthorizer)
new ParentAuthorizer(ctx, {
  forwardingDir: deps.forwardingDir,
  registry: deps.registry,
  serving: deps.servingRegistry, // ServingLookup, not the class
  getTimeoutMs: deps.getForwardingTimeoutMs,
  logger: deps.logger,
});

// use (poll loop) — one question, one answer; no reaching through
if (!this.serving.isServing(target.sessionId)) { /* … */ }
```

No consumer reaches through the registry into a map or an entry, and neither seam is mutated by its reader.

## Module-Level Changes

### New files

| File                                      | Contents                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/authority/serving-registry.ts`       | `ServingAnnouncer`, `ServingLookup`, `ServingSessionRegistry`, `getServingSessionRegistry()` |
| `test/authority/serving-registry.test.ts` | Registry unit tests, including the process-global accessor identity                          |

### Changed source files

| File                                     | Change                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/authority/permission-forwarding.ts` | `resolvePermissionForwardingTargetSessionId` → `resolvePermissionForwardingTarget` returning `PermissionForwardingTarget \| null`; add `PERMISSION_FORWARDING_SERVING_GRACE_MS`; keep `PERMISSION_FORWARDING_TIMEOUT_MS` as the config default |
| `src/authority/forwarding-manager.ts`    | Constructor takes a `ForwardingManagerDeps` bag; announce/clear the served session id; `serving_started` / `serving_stopped` review lines                                                                                                      |
| `src/authority/approval-escalator.ts`    | Consume the target product; add `serving` + `getTimeoutMs` deps; liveness check in the poll loop; `confirmationUnavailable` + `denialReason` on all six abandonment paths; `no_serving_session` review entry                                   |
| `src/authority/authorizer.ts`            | `AuthorizerSelectionDeps` gains `servingRegistry: ServingLookup` and `getForwardingTimeoutMs: () => number`; `selectAuthorizer` threads both into `ParentAuthorizer`                                                                           |
| `src/authority/permission-dialog.ts`     | Widen the `confirmationUnavailable` doc comment — it is no longer `DenyingAuthorizer`-only                                                                                                                                                     |
| `src/permission-gate.ts`                 | `messages.unavailableReason` becomes `(decision) => string`                                                                                                                                                                                    |
| `src/denial-messages.ts`                 | `formatUnavailableReason(ctx, denialReason?)` appends `reasonSuffix`                                                                                                                                                                           |
| `src/handlers/gates/runner.ts`           | Pass `(decision) => formatUnavailableReason(descriptor.denialContext, decision.denialReason)`                                                                                                                                                  |
| `src/config-schema.ts`                   | `forwardingTimeoutMs: z.number().int().positive().optional().meta({ … })`                                                                                                                                                                      |
| `src/extension-config.ts`                | `forwardingTimeoutMs: number` on `PermissionSystemExtensionConfig`, in `DEFAULT_EXTENSION_CONFIG`, read in `normalizePermissionSystemConfig`, merged in `mergeUnifiedConfigs()`                                                                |
| `src/index.ts`                           | Construct/obtain the serving registry; pass the deps bag to `ForwardingManager`; wire `servingRegistry` and `getForwardingTimeoutMs` into `AuthorizerSelection`                                                                                |

### Changed test files

| File                                                                               | Change                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `test/authority/permission-forwarding.test.ts`                                     | Mechanical: ~20 assertion sites move from a bare id to `?.sessionId`, plus new `source` assertions                                   |
| `test/authority/forwarding-manager.test.ts`                                        | Deps-bag construction; announce/clear assertions                                                                                     |
| `test/authority/approval-escalator.test.ts`                                        | New `serving` / `getTimeoutMs` deps; fast-fail, timeout, and denial-reason cases                                                     |
| `test/authority/authorizer.test.ts`, `test/authority/authorizer-selection.test.ts` | New `AuthorizerSelectionDeps` fields                                                                                                 |
| `test/helpers/forwarding-fixtures.ts`                                              | Fixture gains a fake `ServingLookup` and a short default timeout                                                                     |
| `test/permission-gate.test.ts`                                                     | `unavailableReason` becomes a function                                                                                               |
| `test/denial-messages.test.ts`                                                     | `formatUnavailableReason` reason-suffix cases                                                                                        |
| `test/handlers/gates/runner.test.ts`                                               | Assert the unavailable message carries the decision's reason                                                                         |
| `test/composition-root.test.ts`                                                    | Clear the new `Symbol.for()` slot in `afterEach`; add a "parent not serving → immediate deny" case alongside the existing round trip |
| `test/config-schema.test.ts`                                                       | Passes automatically once the schema is regenerated                                                                                  |

### Documentation and generated files

| File                                               | Change                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/permissions.schema.json`                  | Regenerated via `pnpm run gen:schema` — never hand-edited                                                                                                 |
| `config/config.example.json`                       | Add `forwardingTimeoutMs`                                                                                                                                 |
| `docs/configuration.md`                            | New row in the scalar-field table; add `forwardingTimeoutMs` to the scalar-replacement sentence at line 39 and the example block at line 59               |
| `docs/subagent-integration.md`                     | Document liveness detection, the fast-fail grace, and the new denial messages                                                                             |
| `docs/architecture/architecture.md`                | Module-tree entry for `authority/serving-registry.ts`; refresh the module count                                                                           |
| `.pi/skills/package-pi-permission-system/SKILL.md` | Update the testing note that names the "10-minute timeout" (line 194) and extend the "Event-based subagent integration" section with the serving registry |

Verified by grep: `PERMISSION_FORWARDING_TIMEOUT_MS` appears in `src/` only in `permission-forwarding.ts` and `approval-escalator.ts`; the only prose that names the ten-minute wait outside historical retros is the SKILL.md testing note and a comment in `test/composition-root.test.ts:181`.
`resolvePermissionForwardingTargetSessionId` has exactly one production caller (`approval-escalator.ts`) and one test file.
`unavailableReason` has one production construction site (`runner.ts:136`) and one consumption site (`permission-gate.ts:68`).
No file listed above is claimed as unchanged in Non-Goals.

## Test Impact Analysis

**Newly possible tests.**
Injecting `getTimeoutMs` makes `ParentAuthorizer`'s timeout branch testable for the first time — today a test covering it would run for ten minutes, which is why `test/composition-root.test.ts` had to build a fire-without-await round trip to avoid it.
Injecting `ServingLookup` makes the abandonment decision a pure function of an injected predicate, so the fast-fail is a fast unit test with no filesystem timing.
`ServingSessionRegistry` is a pure value object with trivial tests.

**Tests that become redundant.**
None.
The composition-root round trip still earns its place: it is the only test that exercises the real file protocol end to end across two extension instances, and it is precisely the class of coverage that would have caught the reported bug had it also asserted the serving side.

**Tests that must stay as-is.**
`test/authority/denying-authorizer.test.ts` pins the `confirmationUnavailable` marker on the no-authority path; widening the marker's producers must not change it.
`test/composition-root.test.ts`'s `subagent registry sharing` test pins the [#296] cross-instance registry contract and the [#302] publication guard, both untouched here.
`test/authority/forwarded-request-server.test.ts` pins the ADR 0008 serving-side resolution; this plan does not touch the serving node's decision logic.

## Invariants at risk

| Invariant                                                                        | Source                                               | Pinned by                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Absent authority denies with `confirmationUnavailable`, never a silent allow     | `DenyingAuthorizer`, #556                            | `test/authority/denying-authorizer.test.ts`       |
| A forwarded ask emits a non-degraded `permissions:ui_prompt`                     | `LocalUserAuthorizer`, #292                          | `test/authority/local-user-authorizer.test.ts`    |
| `responses/` is never removed while a request is pending (the ENOENT write loop) | `cleanupPermissionForwardingLocationIfEmpty`, [#398] | `test/authority/forwarding-io.test.ts`            |
| A registered child never publishes over its parent's service slot                | `PermissionServiceLifecycle`, [#302]                 | `test/composition-root.test.ts`                   |
| The serving node resolves a forwarded request against child-fixed match values   | ADR 0008                                             | `test/authority/forwarded-request-server.test.ts` |

The fast-fail path deletes its own request file and runs the same `cleanupPermissionForwardingLocationIfEmpty` the timeout path already does, so the [#398] ordering is preserved rather than re-derived.

The one quantitative claim in this plan is the grace window: `PERMISSION_FORWARDING_SERVING_GRACE_MS = 2000` is eight ticks of the existing 250 ms poll interval, both read from `permission-forwarding.ts` — a code fact, not an estimate.
The ten-minute figure is likewise the current constant.
No latency or token measurement is claimed.

## TDD Order

Steps 1 and 2 are preparatory refactorings with no behavior change, landed first so the feature steps are small (Tidy First).

1. **Forwarding target provenance.**
   `refactor(pi-permission-system): return forwarding target provenance` Replace `resolvePermissionForwardingTargetSessionId` with `resolvePermissionForwardingTarget` returning `{ sessionId, source }`.
   Because this removes an export, the sole production caller (`approval-escalator.ts`) and `test/authority/permission-forwarding.test.ts` update in the same commit; the test change is a mechanical `?.sessionId` suffix at each assertion plus new `source` assertions.
2. **`ForwardingManager` deps bag.**
   `refactor(pi-permission-system): give ForwardingManager a deps bag` Positional `(detection, forwarder)` → `ForwardingManagerDeps`, matching `ParentAuthorizerDeps` and `ForwardedRequestServerDeps`.
   Updates `index.ts` and `test/authority/forwarding-manager.test.ts` in the same commit.
3. **Serving registry.**
   Red: `test/authority/serving-registry.test.ts` — mark/clear/query, `servingIds()`, and accessor identity across two calls.
   Green: `src/authority/serving-registry.ts`.
   `feat(pi-permission-system): add a process-global serving-session registry`
4. **Announce the served session.**
   Red: `test/authority/forwarding-manager.test.ts` — marks on qualifying start, clears on stop, re-marks on a session-id change, logs `serving_started` once per session.
   Green: `ForwardingManager` announces; `index.ts` wires `getServingSessionRegistry()`; `test/composition-root.test.ts` clears the new symbol slot in `afterEach`.
   `feat(pi-permission-system): announce the session serving forwarded requests`
5. **Widen the unavailable message.**
   Red: `test/denial-messages.test.ts` and `test/permission-gate.test.ts` — an unavailable denial carrying a reason renders the reason suffix.
   Green: `formatUnavailableReason(ctx, denialReason?)`, `PermissionGateParams.unavailableReason` becomes a function, `runner.ts` and `test/handlers/gates/runner.test.ts` updated in the same commit (the interface change breaks the caller at the type level).
   `fix(pi-permission-system): carry the denial reason into the unavailable block message`
6. **Truthful abandonment.**
   Red: `test/authority/approval-escalator.test.ts` — each of the five existing abandonment paths returns `confirmationUnavailable: true` with its specific reason.
   Green: `ParentAuthorizer`; widen the `confirmationUnavailable` doc comment on `PermissionPromptDecision`.
   `fix(pi-permission-system): report forwarding failures as unavailable, not user-denied`
7. **Fast-fail on an unserved target.**
   Red: `test/authority/approval-escalator.test.ts` — an in-process target that is not serving abandons after the grace window; a serving target keeps waiting; an env-resolved target never fast-fails.
   Green: `ServingLookup` dep on `ParentAuthorizerDeps`, the poll-loop check, the `no_serving_session` review entry, `selectAuthorizer` + `index.ts` wiring, fixture update.
   `fix(pi-permission-system): fail fast when no session serves a forwarded request`
8. **Configurable timeout.**
   Red: `test/config-schema.test.ts` parity plus an `extension-config` merge test for `forwardingTimeoutMs`, and an `approval-escalator` test that a short injected timeout abandons with the timeout reason.
   Green: schema field, `pnpm run gen:schema`, `extension-config.ts` carry-through, `getForwardingTimeoutMs` thunk, `config/config.example.json`.
   `feat(pi-permission-system): make the forwarding timeout configurable`
9. **Composition-root coverage.**
   Red: `test/composition-root.test.ts` — a forwarded ask whose target is not serving denies immediately rather than hanging.
   Green: no production change expected; if one is needed the wiring is wrong.
   `test(pi-permission-system): cover the unserved forwarding target end to end`
10. **Documentation.**
    `docs/configuration.md`, `docs/subagent-integration.md`, `docs/architecture/architecture.md`, and `.pi/skills/package-pi-permission-system/SKILL.md`.
    `docs(pi-permission-system): document forwarding liveness and the timeout field`

## Risks and Mitigations

| Risk                                                                                      | Mitigation                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The fast-fail abandons a request the parent was about to serve                            | The check runs inside the existing poll loop and requires the target to be continuously unserved for the full grace window, so a momentary gap between `stop()` and `start()` does not trigger it                 |
| A stale mark from a session that died without `session_shutdown` suppresses the fast-fail | Falls back to the current ten-minute timeout — the conservative direction. Noted in the module doc comment                                                                                                        |
| A second process-global slot compounds the cross-session state surface                    | Entries are keyed by session id, written only by the owning session's `ForwardingManager`, and cleared on shutdown; the accessor has no teardown hook so one session cannot wipe another's mark, mirroring [#296] |
| A nested (depth-2) child now fast-fails where it previously stalled                       | Its parent is itself a subagent, so its `ForwardingManager` is stopped by design — the request was never going to be served. The new message says so                                                              |
| The mechanical test-file rewrite in step 1 silently drops an assertion                    | The change is a suffix at each call site, not a rewrite; `pnpm run check` plus a test-count comparison before and after guards it                                                                                 |
| `forwardingTimeoutMs` is declared but never read                                          | It is read through the `getTimeoutMs` thunk in the same step that adds it, and step 8's test asserts a short injected value actually shortens the wait                                                            |

## Open Questions

- Whether the underlying stall in [#722] turns out to be a session-id mismatch or a stopped timer.
  The `serving_started` log line added here is the instrument; the answer does not change this plan.
- Whether out-of-process children ever need the same signal.
  Parked in [#721] until someone reports the stall on a process-based subagent extension.

[#296]: https://github.com/gotgenes/pi-packages/issues/296
[#302]: https://github.com/gotgenes/pi-packages/issues/302
[#398]: https://github.com/gotgenes/pi-packages/issues/398
[#710]: https://github.com/gotgenes/pi-packages/issues/710
[#721]: https://github.com/gotgenes/pi-packages/issues/721
[#722]: https://github.com/gotgenes/pi-packages/issues/722
