## MODIFIED Requirements

### Requirement: deterministic multi-channel settlement

The extension SHALL poll the child exit sidecar (`exit.json` inside the session companion directory `<session_dir>/<stem>/`), terminal sentinel, and pane existence.
Settlement SHALL be atomically claimed once.
A valid sidecar observed in the same poll SHALL take precedence; sentinel and pane disappearance SHALL receive a bounded sidecar grace.
Nonzero exits, malformed sidecars, stale assistant text, and empty successful output SHALL produce explicit deterministic outcomes.
Watching SHALL be bounded by a per-attempt configurable deadline whose default is generous enough not to curtail legitimate long-running work; each attempt of an automatically retried run SHALL begin a fresh watch with the same configured deadline, and backoff delays SHALL NOT count toward any watch budget.
Every evidence probe SHALL itself be bounded, and a probe that exceeds its bound SHALL count as no reading rather than as evidence.
On expiry the extension SHALL first sweep every evidence channel it polls — exit sidecar (`exit.json`), sentinel file, and terminal tail — and prefer any real evidence found; only with no evidence SHALL it settle as a distinct abandoned-watch outcome that is not classified as a child or provider failure, routed through the normal delivery path.
When a subagent attempt ends with a well-formed child error sidecar (`type: "error"`) and fewer than 3 total attempts have run, the extension SHALL close the failed attempt's pane and relaunch the same session file through the post-admission launch segment with a fresh per-attempt id after an abort-aware stepped delay, without claiming settlement for the failed attempt; malformed sidecars, pane disappearance, abandoned watch, and aborted runs SHALL NOT be retried.
A well-formed child error sidecar whose `errorMessage` matches a conservative permanent-failure pattern — quota exhaustion, billing, or authentication/authorization — SHALL NOT be automatically retried; the run SHALL settle immediately as a failed run through the ordinary error path.
The pattern match is best-effort: an error the classifier does not recognize keeps the full 3-attempt retry policy unchanged, and the delivered failure still carries the permanent-error rule so the parent's judgment remains the final authority.
A failure of the relaunch mechanics itself — replacement surface creation, launch-script writing, pane run, or the failed attempt's pane persisting past its confirmed-absence bound — SHALL settle the run through the ordinary reported-error path.
The exit sidecar SHALL be consumed (unlinked) on every read attempt regardless of outcome — valid, malformed, or stale.
Sidecar-triggered settlement SHALL be gated on verified sidecar ownership: a sidecar whose run does not match the current owned run SHALL be consumed and rejected, never becoming the settlement outcome.
For sidecar settlement the ownership comparand is the run's current attempt id — the id each attempt's sidecar runId is stamped with.
Companion-directory deletion SHALL happen at exactly one settlement site: the run's settlement disposition, after transcript extraction and the final activity observation.
The disposition SHALL key artifact deletion on the full completion outcome, per channel: a sidecar-derived success deletes only with exit code zero AND a runId present and equal to the run's current attempt id (fail-closed — absent or mismatched means preserve); a sentinel success deletes on exit code zero alone, the sentinel being read from the run's own freshly launched pane tail and so inherently bound to this run; a nonzero exit on any channel never deletes.
Upon such a verified success the disposition SHALL recursively remove the companion directory `<stem>/`; upon settlement with a nonzero exit code, crash, or abandoned watch, it SHALL preserve the remaining companion directory `<stem>/` for manual inspection and debugging.
A run that settles as failed while its pane is still present SHALL close the pane and release its region membership and session lease as part of settlement — mirroring the success path's reap — so the failed session file is immediately available for ownership-gated `session`-parameter resume by the parent; the preserved sticky-launch-failure pane and the watch-abandoned pane are explicitly NOT reaped and keep today's preservation semantics.

#### Scenario: valid sidecar wins

- **WHEN** a valid sidecar and another completion signal are observable in one poll
- **THEN** the sidecar outcome is claimed and processed exactly once

#### Scenario: success deletes the companion directory

- **WHEN** an owned sidecar with exit code zero settles the run
- **THEN** the settlement disposition — after transcript extraction and the final activity observation — recursively removes the companion directory `<stem>/`; no run artifacts remain on disk beside the retained `<stem>.jsonl` (a late child write may still recreate a directory holding only the consumed sidecar — the guarantee is causal, not atomic)

#### Scenario: sentinel fallback

- **WHEN** no valid sidecar appears within grace and a sentinel reports exit code zero
- **THEN** the run settles successfully from the sentinel

#### Scenario: sentinel success deletes the companion directory

- **WHEN** a run settles successfully through the sentinel channel with exit code zero
- **THEN** the settlement disposition removes the companion directory `<stem>/` exactly as a sidecar success would — the sentinel result carries no runId and binds inherently to the run's own freshly launched pane tail

#### Scenario: nonzero sentinel

- **WHEN** no valid sidecar appears within grace and the sentinel has a nonzero code
- **THEN** the run settles as an error even if older assistant text exists

#### Scenario: nonzero sentinel preserves the companion directory

- **WHEN** the sentinel channel reports a nonzero exit code
- **THEN** the disposition's artifact decision keys on the exit code, not the channel, and the companion directory `<stem>/` is preserved intact on disk for inspection

#### Scenario: nonzero settlement preserves the companion directory

- **WHEN** a run settles with a nonzero exit code, a crash, a pane disappearance, or an abandoned watch
- **THEN** the companion directory `<stem>/` (minus the already-consumed `exit.json`) is preserved intact on disk for inspection

#### Scenario: stale sidecar never deletes the companion directory

- **WHEN** a sidecar is observed whose runId does not match the current owned run
- **THEN** the sidecar is consumed and rejected, never becomes the settlement outcome, and no companion-directory deletion occurs for the live run whose `launch.sh`, prompts, and `activity.json` remain intact

#### Scenario: unbound sidecar success preserves the companion directory

- **WHEN** a sidecar-derived success reaches the disposition without a runId equal to the run's current attempt id
- **THEN** deletion is fail-closed and the companion directory is preserved rather than removed (production ownership checks make this unreachable; the guard is belt-and-suspenders)

#### Scenario: pane disappears

- **WHEN** the pane disappears and no valid sidecar or sentinel wins during grace
- **THEN** the run settles with a pane-disappearance error and cleanup treats the already absent pane as cleaned

#### Scenario: malformed or stale sidecar

- **WHEN** a sidecar is malformed or does not belong to the current owned run
- **THEN** it is not accepted as successful settlement and the resulting error/race handling is visible

#### Scenario: consumed sidecar is removed deterministically

- **WHEN** any read attempt of `<stem>/exit.json` completes — valid, malformed, or stale
- **THEN** the sidecar file is unlinked as part of consumption, so a failed settlement leaves no readable sidecar behind

#### Scenario: auto-retry on retryable error succeeds

- **WHEN** a subagent attempt ends with a well-formed child error sidecar and fewer than 3 total attempts have run
- **THEN** the extension closes the failed attempt's pane, relaunches the session file after the stepped delay, and upon a subsequent successful completion delivers the final result without reporting an intermediate failure

#### Scenario: retry reuses the original launch configuration

- **WHEN** a failed attempt is automatically retried
- **THEN** the relaunched command reproduces the agent-owned flags, companion extension, launch environment, skills, model, identity, and terminal sentinel verbatim through the same post-admission launch segment, with a fresh per-attempt id so earlier attempts' sidecars are rejected by the ownership check while the run's parent-side identity stays stable

#### Scenario: non-retryable outcomes settle immediately

- **WHEN** an attempt ends through a malformed sidecar, pane disappearance, watch abandonment, or an aborted run rather than a well-formed error sidecar
- **THEN** the run settles immediately through its ordinary deterministic outcome and no automatic retry is attempted

#### Scenario: auto-retry exhausted settles as failure

- **WHEN** a subagent run encounters well-formed error sidecars on all 3 total attempts
- **THEN** the run settles as a terminal failure through the ordinary failure path, its pane is closed with region membership and session lease released so the session file is immediately resumable, the companion directory is preserved, and the result reports that extension auto-retries were exhausted after 3 attempts with the session log path and the resume-first delivery

#### Scenario: quota error skips automatic retry

- **WHEN** an attempt ends with a well-formed error sidecar whose `errorMessage` matches the conservative permanent-failure pattern (quota exhausted, billing, or authentication/authorization)
- **THEN** the run settles immediately as a failed run without any automatic retry attempt, its pane is closed with the session lease released, and the failure is delivered with the resume-first presentation carrying the permanent-error rule

#### Scenario: unrecognized error keeps the full retry policy

- **WHEN** an attempt ends with a well-formed error sidecar whose `errorMessage` the conservative pattern does not match
- **THEN** the run follows today's full retry policy unchanged — up to 3 total attempts — and the eventual exhaustion delivery still carries the permanent-error rule, so a classifier miss can waste attempts but never changes delivery semantics

#### Scenario: retry preserves capacity and lease across attempts

- **WHEN** a failed attempt is reaped and relaunched as a retry
- **THEN** the run keeps its admission slot and session lease without re-acquiring, the widget row persists under the same run identity, and earlier attempts' panes are closed as they are reaped — the final attempt's pane is treated by the final settlement outcome: closed on failure (making the session resumable) or on success, preserved only when the final outcome is watch-abandoned or a preserved launch failure

#### Scenario: relaunch failure settles as reported error

- **WHEN** the relaunch mechanics fail — the replacement surface cannot be created, the launch script cannot be written, the pane run fails, or the failed attempt's pane persists past its confirmed-absence bound
- **THEN** the relaunch's own cleanup runs (close the replacement pane, remove the new launch script), the pre-existing session file and companion directory are untouched, and the run settles through the ordinary reported-error path with any surviving pane preserved and its session lease retained until confirmed pane absence (the surviving pane may still hold a live writer; the delivered resume-first message must not unlock a concurrent writer)

#### Scenario: failed settlement reaps the pane

- **WHEN** a run settles as failed through a child error sidecar while its pane is still present
- **THEN** the pane is closed and its region membership and session lease are released as part of settlement, so a subsequent `subagent` call with the run's session path passes the ownership-gated resume validation immediately

#### Scenario: sticky launch failure pane is not reaped

- **WHEN** a launch fails before admission completes and its pane is captured as a sticky launch failure
- **THEN** the pane keeps today's preservation semantics and is not reaped by the failure-settlement rule

#### Scenario: watch-abandoned pane is not reaped

- **WHEN** a run settles as watch-abandoned with its pane still present
- **THEN** the pane keeps today's preservation semantics (the outcome is unknown; the child may still be alive) and is not reaped by the failure-settlement rule

#### Scenario: watch deadline applies per attempt

- **WHEN** an attempt exhausts its watch deadline while automatic retries remain
- **THEN** the timeout is not retried and the run settles as an abandoned watch per the base rules; watch bounds apply per attempt, so every attempt that begins starts a fresh watch of the same configured length, with backoff delays outside the watch budget

#### Scenario: watch deadline expires without evidence

- **WHEN** a watched run records neither completion evidence nor pane disappearance before the watch deadline
- **THEN** watching stops and the run settles as a distinct abandoned-watch outcome, separate from a reported failure, stating that no evidence was recorded, and that outcome is delivered through the ordinary delivery path rather than leaving the run unsettled

#### Scenario: evidence races the watch deadline

- **WHEN** a sidecar, sentinel file, or terminal-tail sentinel becomes observable at or immediately after the watch deadline
- **THEN** that real completion evidence is returned instead of an abandoned-watch outcome

#### Scenario: evidence probe hangs at the deadline

- **WHEN** an evidence probe used by the deadline sweep never resolves
- **THEN** the sweep abandons that probe within its bound and still settles, so a bounded watch cannot become unbounded through its own final check

#### Scenario: pane probe hangs during watching

- **WHEN** the pane inspection probe never resolves
- **THEN** it is recorded as an unavailable observation rather than a missing pane, and watching continues to its deadline instead of stalling

#### Scenario: watch deadline disabled

- **WHEN** the watch deadline is explicitly disabled
- **THEN** watching continues until completion evidence appears or the run is aborted

#### Scenario: abandoned watch releases capacity but keeps the pane

- **WHEN** a run settles as an abandoned watch while its pane is still present
- **THEN** its admission slot is released immediately so later work is not blocked, its session lease is retained until explicit pane disappearance (the pane may still hold a live writer), and its pane and companion directory are preserved for inspection rather than reaped

#### Scenario: abandoned watch is presented as unknown, not failed

- **WHEN** an abandoned-watch outcome is presented to the parent
- **THEN** it states that the outcome is unknown and the pane may still be alive, includes any output already recovered from the child session log, and does not claim the run produced no result or that a provider error occurred

#### Scenario: preserved error pane frees admission but keeps its session lease

- **WHEN** a run settles with a reported error (structured or unexpected) while its pane is preserved for inspection
- **THEN** its admission slot is released immediately rather than held until the pane is closed, and its session lease is retained until explicit pane disappearance

### Requirement: text-only result extraction

The extension SHALL walk the owned child JSONL backwards to the current run's final assistant message and join only text blocks.
It SHALL surface provider errors and SHALL NOT let stale text from a prior turn mask the current exit state.
When an error outcome is presented — whether after exhausting automatic retries, settling immediately through the permanent-failure short-circuit, or through a non-exhausted error outcome (malformed sidecar, pane disappearance) — the presentation SHALL keep the parseable provider/agent-error prefix, give an attempt-accurate statement (that extension auto-retries were exhausted after 3 attempts; that no further automatic retry was attempted because the error looked permanent, noting prior attempts when the short-circuit first matched after attempt 1; or no exhaustion claim at all for non-exhausted error outcomes), reference the session log path, and instruct the parent to resume the failed session rather than spawn a replacement: the presentation SHALL carry the exact resume invocation — `subagent({ agent: <canonical-id>, task: <a short continuation task>, session: <failed session path> })`, naming the canonical agent id (never the presentation-only label) — and SHALL state that if the error is permanent (quota exhausted, billing, invalid credentials), the parent SHALL NOT resume and SHALL NOT spawn a replacement, and SHALL surface the error to the user instead.

#### Scenario: thinking and tool blocks excluded

- **WHEN** the final assistant message contains thinking, tool, and text blocks
- **THEN** only its text blocks form the presented answer

#### Scenario: provider error without text

- **WHEN** the current turn ends with provider error and no text
- **THEN** the result presents the provider error message

#### Scenario: retry exhaustion presentation instructs resume

- **WHEN** the final attempt of an automatically retried run ends with a provider error and no text
- **THEN** the result presents the provider error message with the extension auto-retry-exhausted statement, the session log path, the exact `subagent({ agent, task, session })` resume invocation for the failed session, and the permanent-error rule (do not resume, do not respawn, surface to the user), with no instruction to spawn a new subagent

#### Scenario: quota short-circuit presentation

- **WHEN** a run settles immediately through the permanent-failure short-circuit (including when the pattern first matches on a later attempt, after earlier retries already ran)
- **THEN** the result presents the provider error message, states that no further automatic retry was attempted because the error looked permanent (accurately reflecting any earlier attempts), and carries the same resume invocation and permanent-error rule

#### Scenario: successful exit without assistant text

- **WHEN** the current run exits zero without a current assistant text message
- **THEN** the result explicitly reports missing output rather than reusing prior text

#### Scenario: blocking failure result carries the resume invocation

- **WHEN** a blocking run settles as failed after exhaustion or the permanent-failure short-circuit
- **THEN** the blocking tool result carries the same resume-first presentation as the async steer — provider error prefix, exhaustion/short-circuit statement, session log path, exact resume invocation, and the permanent-error rule — so the parent can resume within the same turn without a steer

#### Scenario: non-exhausted error outcome carries resume without exhaustion claim

- **WHEN** a run settles as failed through a malformed sidecar or pane disappearance — no automatic retries ran — and its pane was reaped or absent
- **THEN** the presented failure carries the resume invocation and permanent-error rule but makes no exhaustion or short-circuit statement, and its wording does not direct the parent to inspect a pane that no longer exists (the session log path stands in)
