## ADDED Requirements

### Requirement: extension-free standalone resource resolution

Standalone resource resolution used to validate an agent's selected skills SHALL NOT execute configured extension factories or invoke extension-owned resource discovery. It SHALL retain the effective cwd, Pi agent directory, project-trust state, and ordinary skill resource precedence needed to resolve selected names, and SHALL complete validation before queue admission.

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

The extension SHALL publish a completion API for background delivery only after Pi has bound the extension to an active parent session and emitted `session_start`. Evaluating the extension factory, loading resources, or constructing a discovery-only extension runtime SHALL NOT publish or replace the active completion API.

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

Every asynchronous completion, caller-ping, queued-launch error, and queued-resume error SHALL resolve the active completion API at send time and SHALL require that its parent session identity matches the target session. A captured factory API SHALL NOT be used as a fallback after reload or session replacement. Status and recovery notifications are best-effort and are not retained or retried when no matching active API exists.

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

- **WHEN** a queued launch or queued resume fails while no matching active session-bound API exists
- **THEN** the launch error is retained as a pending delivery keyed by its run ID and is delivered after the runtime becomes active

### Requirement: inactive runtime is recoverable and bounded

When no matching session-bound completion API is available, asynchronous delivery SHALL remain pending without being marked delivered, without starting acknowledgement verification, and without consuming the ordinary bounded send-attempt budget. The pending work SHALL be retried after the target session emits `session_start`. Deferral SHALL NOT be unbounded: a delivery deferred past a bounded deferral budget SHALL be marked undeliverable with the cause recorded.

#### Scenario: completion settles during reload gap

- **WHEN** a child settles while the parent is between `session_shutdown` and replacement `session_start`
- **THEN** its result is retained as pending and is delivered after the replacement runtime becomes active

#### Scenario: deferral is bounded and visible

- **WHEN** a pending delivery remains deferred past its bounded deferral budget
- **THEN** it is marked undeliverable with the cause recorded and is not retried indefinitely, and deferred entries are displayed in the widget as awaiting the runtime rather than as an ordinary retry

#### Scenario: final shutdown suppresses inactive work

- **WHEN** the parent performs a final shutdown while an asynchronous delivery is waiting for an active runtime
- **THEN** the delivery is suppressed and no later wake or send is attempted
