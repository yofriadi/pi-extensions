## Context

Pi extension factories can be evaluated while resources are being discovered without an active `AgentSession`. In that phase, the `ExtensionAPI` action methods intentionally point at throwing stubs until Pi binds the resource loader's runtime to a session.

The extension currently stores the factory argument in a process-global runtime slot as soon as the factory runs. `packages/pi-subagent-herdr/src/skills.ts` creates a standalone `DefaultResourceLoader` while validating an agent's selected skills. That loader evaluates configured extensions with its own unbound runtime. The Herdr factory therefore overwrites the live parent API with a discovery-only API. A later background completion calls that API and fails synchronously before Pi can accept the steer. Foreground completion is unaffected because it returns through the suspended tool call.

The existing reload coordinator intentionally keeps background watchers and pending deliveries alive across `/reload`, so delivery must also handle the interval between the old session runtime shutting down and the replacement session runtime becoming active. The fix must not reintroduce the earlier acknowledgement/wake ordering defects or duplicate sends.

## Goals / Non-Goals

**Goals:**

- Prevent any discovery-only or unbound extension API from becoming the process-global completion API.
- Resolve selected skills without executing configured extensions from the standalone validation loader.
- Make the active completion API explicitly session-bound and scoped to the current parent session.
- Defer background delivery while no active session API exists and retry it after `session_start` without consuming ordinary delivery attempts.
- Preserve exactly-once deduplication, the foreground delivery barrier, wake-before-ack ordering, queueing, and reload ownership.
- Add regressions that reproduce the actual extension-loader topology, not only a hand-built fake delivery call.

**Non-Goals:**

- Changing the public `subagent`, `subagent_resume`, `subagent_interrupt`, or child-control tool schemas.
- Replacing Pi's extension loader or changing Pi's runtime binding implementation.
- Adding durable cross-process delivery state or changing the existing bounded retry/dead-letter policy for an active runtime.
- Supporting skill paths generated dynamically by arbitrary `resources_discover` handlers in the standalone selected-skill resolver; the current resolver already reloads ordinary resources without invoking that session extension phase.
- Reconstructing a suspended blocking tool result after reload.

## Decisions

### 1. Session activation, not factory evaluation, owns delivery API state

Replace the meaning of the global completion API slot with an explicitly active, session-bound API record:

```text
activeCompletionRuntime = {
  api,
  parentSessionId,
  generation,
}
```

The extension factory registers tools and handlers only. It does not publish `pi` into global delivery state. The `session_start` handler is the activation boundary: Pi has already bound the extension runtime when it emits that event, so the handler records the factory's API, the current session ID, and a monotonically increasing generation. The `session_shutdown` handler clears the record only when it still owns the same API/session record. This identity check prevents an old extension instance from clearing a replacement runtime during reload or session replacement.

Delivery callers may retain their original factory closure for watcher callbacks, but that API is never a fallback. They must obtain the active record at send time and require its session ID to match the target parent session. This prevents stale APIs from being used after reload and prevents a completion from being sent to a replacement session.

The active-completion-runtime record lives under a NEW `Symbol.for` process-global key that the old implementation's `runtime.pi` slot never touches. This matters for mixed-version coexistence: a package-installed older Herdr copy plus a working-tree load can share the process. Because delivery no longer reads `runtime.pi` and the active record uses a distinct key, an older copy cannot poison the new record, and an old closure cannot clear or send through the new session's record.

**Assumption (load-bearing):** Pi re-emits `session_start` after a successful `/reload` and after session replacement, carrying the same parent session ID for a reload. This is the activation boundary the design depends on; the existing reload-adoption comments and `reconcileActive` path in `packages/pi-subagent-herdr/src/index.ts` already rely on it, and the integration tests assert it empirically.

**Alternative considered:** keep assigning `runtime.pi` in the factory and add a validity probe before sending. Rejected because the unbound stub has no reliable public validity signal, and merely probing it still lets discovery mutate ownership and race with a real session.

### 2. Standalone selected-skill resolution is extension-free

Construct the selected-skill `DefaultResourceLoader` with `noExtensions: true` (verified against the installed SDK typings at `packages/pi-subagent-herdr/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts:71`, a sibling of the `noPromptTemplates`/`noThemes`/`noContextFiles` options already in use), while retaining the exact cwd, agent directory, settings manager, project-trust state, and ordinary package/project/global skill discovery already used by the resolver. The current resolver does not run the session's `resources_discover` phase, so this removes the unsafe factory-evaluation side effect without removing any resource source it currently observes.

The resolver continues to validate every selected name, duplicate, missing resource, and collision before queue admission. It returns canonical metadata only; child launch and permission sanitization remain unchanged.

**Alternative considered:** run all configured factories with a separate isolated runtime and discard that runtime afterward. Rejected as weaker defense: arbitrary extension factories may have side effects, and it would preserve the possibility of another extension mutating Herdr's process-global state. The resolver has no current contract for session-generated resource paths, so extension-free discovery is the safer boundary.

### 3. Delivery has an explicit unavailable-runtime outcome

Introduce a private `SessionRuntimeUnavailableError` (or equivalent typed predicate). `deliverBackgroundMessage` resolves the active API record and checks that its session ID matches the target BEFORE entering the foreground delivery barrier. When no matching active record exists it throws this typed condition without touching the barrier, `sendMessage`, `sendUserMessage`, acknowledgement polling, or delivery bookkeeping. Placing the gate before the barrier prevents a deferred delivery from entering a drain batch, reserving the batch's wake slot, or running its async session-log dedup three times under the barrier's internal retry. A defensive session-bound check is retained immediately before `sendMessage` inside the callback to cover the case where the active record changes between the pre-check and the send.

The caller handles this condition through the existing pending-delivery path. The retry pump treats it as deferred availability, not as a failed send: it leaves `attempts`, `exhausted`, and `lastError` unchanged and schedules another check. The normal active-runtime errors continue to increment attempts and use the existing bounded retry policy.

Pending delivery state and its retry timer remain alive through a reload gap. `session_start` immediately re-drives pending entries and starts the timer if needed. A final shutdown still suppresses and clears pending entries exactly as before. Each pending entry records a `deferredSince` timestamp the first time it is deferred and CLEARS it on the first subsequent attempt that reaches a matching active session-bound runtime, so the budget measures one continuous unavailable interval and `awaiting runtime` only ever reflects the most recent outcome. A single bounded deferral budget (`DEFERRED_DELIVERY_MAX_MS`, one hour) is separate from the send-attempt budget. When a continuous deferral exceeds that budget the entry is marked exhausted/undeliverable and its `lastError` notes the cause. When such a deferral-exhausted entry is re-driven on a later reload or session start, its `deferredSince` is reset first, so it cannot immediately re-exhaust and oscillate between deferred and undeliverable.

**Alternative considered:** return a successful no-op while inactive. Rejected because it would violate the existing meaning of `delivered` and could permanently lose a result.

### 4. All asynchronous delivery paths use the same active-api gate

Completion results, `caller_ping`, stall/recovery status notifications, queued-launch errors, and resume-launch errors all pass through `deliverBackgroundMessage` or the same active-runtime selector. Remove calls that pass a stale API into `selectCompletionApi` as a fallback. The existing `selectCompletionApi` test helper is either replaced with the active-record selector or retained only as a pure compatibility helper that is not used for sends.

`wakeParent` also resolves the active record rather than reading a captured factory API; when the record is absent or session-mismatched it no-ops. The five current reads of the shared slot in `packages/pi-subagent-herdr/src/index.ts` (`deliverBackgroundMessage`, `wakeParent`, `startDeliveryRetry`, the `startDeliveryRetry` call inside `queuePendingDeliveryWithVerification`, and the retry-pump seed) are all moved to the active-record selector and the old `runtime.pi` slot is removed entirely. Status/recovery notifications are best-effort: when no active session-bound record exists, a status event is DROPPED rather than queued (status messages carry no run ID, so they do not fit the run-keyed pending store). Queued-launch errors and queued-resume errors DO carry a run ID and are routed through `queuePendingDeliveryWithVerification` so a failure during the reload gap remains recoverable. The detached promise at those sites is kept (the tool handler returns a queued result immediately), but its rejection handler is made terminal: it catches the delivery error, enqueues it, and ends with `.catch(() => undefined)` so no rejection escapes an un-awaited promise.

### 4a. Deferred deliveries are visible and bounded in the widget

The widget gains a distinct `awaiting runtime` state for pending entries whose `deferredSince` is set and which have not yet exhausted their deferral budget. Deferred entries are counted separately from actively-retrying and undeliverable rows, so a deferred delivery is never rendered as the misleading `delivery retry 0/1`. Because `deferredSince` clears on the first attempt that reaches a matching active runtime, `awaiting runtime` only ever reflects the most recent outcome — an entry actively retrying a real send error against a live runtime renders as an ordinary retry, not as awaiting the runtime. When a continuous deferral exceeds `DEFERRED_DELIVERY_MAX_MS` the entry is marked undeliverable with its `lastError`, so a broken or never-reactivated session surfaces the same bounded, labeled terminal state the earlier observability change introduced.

### 5. Test the real loader topology and the reload gap

Add unit coverage for:

- a discovery-only invocation of the extension factory not changing an already active API;
- selected-skill resolution retaining the active API and still resolving ordinary project/global/package skills;
- delivery while inactive making zero action calls and remaining pending;
- activation causing the pending delivery to send exactly once;
- an old session shutdown not clearing a newer active API.

Correct the integration harness's extension path from the nonexistent `packages/pi-subagent-herdr/src/subagents/index.ts` to `packages/pi-subagent-herdr/src/index.ts`. Add a production-like integration regression that wires a purpose-built fixture package (shipping both an ordinary skill and a marker-writing extension) into the parent via a project `.pi/settings.json` package entry, so the resolver's `DefaultResourceLoader` discovers it; Herdr itself stays on the harness's explicit `-e` path since a marker side effect cannot be added to it. The regression launches a parent with an agent declaring the fixture's selected skill, runs an asynchronous child to completion, and asserts one `subagent_result` with the expected run ID in the parent session log, alongside the in-process enumeration/marker non-vacuity assertions described in task 4.4. After decision 2 the standalone loader no longer evaluates factories, so this integration test guards end-to-end one-result delivery; the ownership-isolation guarantee itself is guarded by the unit regressions (discovery-only factory does not replace the active API). Retain the existing reload integration and verify a completion crossing reload is delivered by the replacement session runtime.

## Risks / Trade-offs

- **Standard-only skill resolution may not see skills added by a custom `resources_discover` handler.** → The current resolver never invokes that session extension phase, so this makes its existing behavior explicit rather than removing a currently observed source. A future feature can pass an authoritative parent resource snapshot instead of executing arbitrary factories during validation.
- **A long reload or session-start delay keeps pending rows visible longer.** → This is preferable to invoking an unbound API; the widget distinguishes deferred (`awaiting runtime`), retrying, and undeliverable states, and the retry pump does not consume attempts while the runtime is unavailable.
- **A stale watcher may continue running after reload.** → It can no longer send through its captured API; it resolves the active session record on every attempt. Existing generation/settlement/deduplication controls continue to prevent duplicate delivery.
- **A session ID mismatch can defer a result until its deferral budget expires.** → Session shutdown suppresses non-reload replacement work and reload session-start reactivates the same session ID; tests cover both transitions. If the runtime never reactivates, the entry exhausts its `DEFERRED_DELIVERY_MAX_MS` budget and is marked undeliverable with the mismatch recorded, so the failure stays bounded and visible.
- **Removing the old API fallback changes test and internal helper expectations.** → Update tests to activate a fake session API explicitly and keep the active-only rule centralized in one selector.

## Migration Plan

No persisted-data migration is required. Existing pending entries retain their shape. On `/reload`, the old session shutdown clears the active API while preserving watchers and pending deliveries; the replacement `session_start` activates the new API and re-drives them. A process restart still cannot recover in-memory pending state, consistent with the existing non-goal.

Rollback is a source revert. The only operational change is that delivery waits safely during runtime unavailability instead of attempting the unbound API.

## Open Questions

None for implementation. The scope of extension-generated skill resources is documented as a future capability rather than left ambiguous in this change. The `session_start`-on-reload activation boundary is recorded as an explicit assumption above rather than an open question; the integration tests validate it empirically.
