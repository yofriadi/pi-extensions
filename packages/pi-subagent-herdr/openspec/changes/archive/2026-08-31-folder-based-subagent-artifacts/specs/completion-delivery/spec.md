## MODIFIED Requirements

### Requirement: deterministic multi-channel settlement

The extension SHALL poll the child exit sidecar (`exit.json` inside the session companion directory `<session_dir>/<stem>/`), terminal sentinel, and pane existence.
Settlement SHALL be atomically claimed once.
A valid sidecar observed in the same poll SHALL take precedence; sentinel and pane disappearance SHALL receive a bounded sidecar grace.
Nonzero exits, malformed sidecars, stale assistant text, and empty successful output SHALL produce explicit deterministic outcomes.
Watching SHALL be bounded by a per-run configurable deadline whose default is generous enough not to curtail legitimate long-running work.
Every evidence probe SHALL itself be bounded, and a probe that exceeds its bound SHALL count as no reading rather than as evidence.
On expiry the extension SHALL first sweep every evidence channel it polls — exit sidecar (`exit.json`), sentinel file, and terminal tail — and prefer any real evidence found; only with no evidence SHALL it settle as a distinct abandoned-watch outcome that is not classified as a child or provider failure, routed through the normal delivery path.
The exit sidecar SHALL be consumed (unlinked) on every read attempt regardless of outcome — valid, malformed, or stale.
Sidecar-triggered settlement SHALL be gated on verified sidecar ownership: a sidecar whose run does not match the current owned run SHALL be consumed and rejected, never becoming the settlement outcome.
Companion-directory deletion SHALL happen at exactly one settlement site: the run's settlement disposition, after transcript extraction and the final activity observation.
The disposition SHALL key artifact deletion on the full completion outcome, per channel: a sidecar-derived success deletes only with exit code zero AND a runId present and equal to the run's own id (fail-closed — absent or mismatched means preserve); a sentinel success deletes on exit code zero alone, the sentinel being read from the run's own freshly launched pane tail and so inherently bound to this run; a nonzero exit on any channel never deletes.
Upon such a verified success the disposition SHALL recursively remove the companion directory `<stem>/`; upon settlement with a nonzero exit code, crash, or abandoned watch, it SHALL preserve the remaining companion directory `<stem>/` for manual inspection and debugging.

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

- **WHEN** a sidecar-derived success reaches the disposition without a runId equal to the run's own id
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
