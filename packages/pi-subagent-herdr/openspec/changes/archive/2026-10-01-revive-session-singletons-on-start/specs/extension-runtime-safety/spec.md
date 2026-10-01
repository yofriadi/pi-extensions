## ADDED Requirements

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
