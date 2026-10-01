# Capability: extension-runtime-safety

## Purpose

Safety and lifecycle rules for extension runtime execution, preventing discovery-time runtime poisoning, restricting completion API ownership to active bound sessions, enforcing session-affine delivery, handling inactive runtime deferral and recovery, and reviving poisoned session-keyed delivery singletons on session reactivation.

## Requirements

### Requirement: extension-free standalone resource resolution

Standalone resource resolution used to validate an agent's selected skills SHALL NOT execute configured extension factories or invoke extension-owned resource discovery.
It SHALL retain the effective cwd, Pi agent directory, project-trust state, and ordinary skill resource precedence needed to resolve selected names, and SHALL complete validation before queue admission.

#### Scenario: selected skill resolution does not execute extensions

- **WHEN** a parent resolves an agent definition that declares one or more selected skills
- **THEN** the resolver loads the effective ordinary skill resources without invoking configured extension factories, and the active parent runtime API remains unchanged

#### Scenario: ordinary selected skill remains resolvable

- **WHEN** a selected skill exists in a trusted project, global, or configured ordinary skill resource visible to the resolver
- **THEN** the resolver returns its canonical name, description, location, and metadata in the declared order

#### Scenario: invalid selection remains pre-admission

- **WHEN** a selected skill is empty, duplicated, missing, or ambiguous
- **THEN** resolution fails before any pane, session, artifact, queue admission, or child process is created

### Requirement: session-bound completion API ownership

The extension SHALL publish a completion API for background delivery only after Pi has bound the extension to an active parent session and emitted `session_start`.
Evaluating the extension factory, loading resources, or constructing a discovery-only extension runtime SHALL NOT publish or replace the active completion API.

#### Scenario: discovery-only factory cannot claim delivery ownership

- **WHEN** Pi evaluates the Herdr extension factory during resource discovery without starting a session
- **THEN** the process-global active completion API is not replaced by that unbound API

#### Scenario: session start activates the current API

- **WHEN** Pi emits `session_start` for a parent session after binding the extension runtime
- **THEN** the extension records the current API and parent session identity as the active completion runtime

#### Scenario: old shutdown cannot clear a replacement API

- **WHEN** an older extension instance receives `session_shutdown` after a replacement session runtime has become active
- **THEN** the older instance does not clear or invalidate the replacement active completion runtime

### Requirement: session-affine asynchronous delivery

Every asynchronous completion and queued-launch error SHALL resolve the active completion API at send time and SHALL require that its parent session identity matches the target session.
A captured factory API SHALL NOT be used as a fallback after reload or session replacement.
Status and recovery notifications are best-effort and are not retained or retried when no matching active API exists.
Caller-ping and queued-resume outcomes SHALL NOT exist.

#### Scenario: delivery uses the active replacement runtime

- **WHEN** a background result settles after extension reload and the replacement session has emitted `session_start`
- **THEN** the result is sent through the replacement session's bound API exactly once

#### Scenario: stale session API is rejected

- **WHEN** a pending delivery targets a session whose active API is absent or belongs to a different session
- **THEN** no action method is called and the delivery remains pending for later activation

#### Scenario: status notification dropped while inactive

- **WHEN** a status or recovery notification would be emitted while no matching active session-bound API exists
- **THEN** the notification is dropped without queueing, retrying, or blocking completion delivery

#### Scenario: launch error remains recoverable while inactive

- **WHEN** a queued launch fails while no matching active session-bound API exists
- **THEN** the launch error is retained as a pending delivery keyed by its run ID and is delivered after the runtime becomes active

#### Scenario: removed lifecycle outcomes are absent

- **WHEN** the asynchronous delivery path is inspected
- **THEN** it contains no caller-ping or queued-resume outcome type, enqueue path, or retry path

### Requirement: inactive runtime is recoverable and bounded

When no matching session-bound completion API is available, asynchronous delivery SHALL remain pending without being marked delivered, without starting acknowledgement verification, and without consuming the ordinary bounded send-attempt budget.
The pending work SHALL be retried after the target session emits `session_start`.
Deferral SHALL NOT be unbounded: a delivery deferred past a bounded deferral budget SHALL be marked undeliverable with the cause recorded.

#### Scenario: completion settles during reload gap

- **WHEN** a child settles while the parent is between `session_shutdown` and replacement `session_start`
- **THEN** its result is retained as pending and is delivered after the replacement runtime becomes active

#### Scenario: deferral is bounded and visible

- **WHEN** a pending delivery remains deferred past its bounded deferral budget
- **THEN** it is marked undeliverable with the cause recorded and is not retried indefinitely, and deferred entries are displayed in the widget as awaiting the runtime rather than as an ordinary retry

#### Scenario: final shutdown suppresses inactive work

- **WHEN** the parent performs a final shutdown while an asynchronous delivery is waiting for an active runtime
- **THEN** the delivery is suppressed and no later wake is attempted

### Requirement: session-keyed singleton revival on activation

When `session_start` is emitted for a parent session, session-keyed process-global delivery singletons (the admission coordinator and the foreground delivery barrier) SHALL be usable for new work in that session, even when a previous terminal shutdown of the same session identity left those singletons shut down or suppressed.
Revival SHALL replace the poisoned singleton instance in the process-global registry with a fresh instance; it SHALL NOT mutate the poisoned instance in place, and SHALL NOT clear or redirect suppression or shutdown state on an instance that other closures may still reference.

Revival SHALL be conditional: a healthy singleton (including a live admission coordinator adopted across extension reload with active admission leases) SHALL be returned unchanged, so reload survival of background subagents is preserved.
The poisoned-instance check SHALL resolve the singleton through the existing getter (preserving legacy-instance migration and held-delivery adoption) rather than inspecting the raw registry cache.

#### Scenario: resume-back session can spawn again

- **WHEN** the parent switches away from a session, that session's coordinator is shut down and its delivery barrier is suppressed by terminal shutdown, and the parent later resumes the session (restoring the same session identity) and `session_start` is emitted
- **THEN** the session's admission coordinator accepts a new admission request and its foreground delivery barrier enters a foreground run, instead of rejecting them as shut down or suppressed

#### Scenario: poisoned instance is replaced, not revived in place

- **WHEN** `session_start` revival replaces a shut-down coordinator or a suppressed barrier
- **THEN** the registry entry is a fresh instance and the previously poisoned instance object is not reused, retains its terminal state, and any lease or held-delivery references to it remain fail-closed

#### Scenario: healthy singleton is preserved across reload

- **WHEN** `session_start` runs after extension reload for a session whose coordinator holds active background admission leases and whose barrier is not suppressed
- **THEN** the same singleton instances are returned unchanged (no eviction or replacement), and background subagents keep their admission ownership across the reload

#### Scenario: late watcher of a killed run stays suppressed after revival

- **WHEN** a subagent run was killed and its completion marked suppressed at terminal shutdown, and a late watcher of that run attempts delivery after `session_start` has revived the session's singletons
- **THEN** the delivery is still suppressed by the run's own recorded suppression state and is not delivered into the re-activated session

#### Scenario: legacy cached instance migrates before revival decision

- **WHEN** the process-global registry holds a legacy (pre-v2) singleton instance for the session at `session_start`
- **THEN** the existing getter's migration runs first (upgrading the instance or adopting its held deliveries), and the revival decision applies to the migrated result rather than reading the raw cache
