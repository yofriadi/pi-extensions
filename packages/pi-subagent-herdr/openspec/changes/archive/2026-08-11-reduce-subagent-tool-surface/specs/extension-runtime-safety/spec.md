## MODIFIED Requirements

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
