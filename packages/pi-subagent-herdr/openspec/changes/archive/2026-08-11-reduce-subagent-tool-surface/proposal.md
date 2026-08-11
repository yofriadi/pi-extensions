## Why

Every subagent already runs in a visible Herdr pane or tab, where the user can press Escape to interrupt the active turn and type directly to continue it.
Exposing separate `subagent_interrupt`, `subagent_resume`, and child `caller_ping` tools duplicates controls that are available in the UI and makes the agent manage unnecessary lifecycle tools.

## What Changes

- **BREAKING**: Reduce the parent model-facing tool surface to `subagent` only; remove `subagent_interrupt` and `subagent_resume`.
- **BREAKING**: Reduce the child protocol tool surface to `subagent_done` only; remove `caller_ping` and its ping sidecar, notification, rendering, and settlement paths.
- Make interruption and continuation explicitly user-driven in the visible Herdr pane or tab.
- Remove agent-driven resume admission, ownership validation, and completion correlation that existed only for `subagent_resume`; initial sessions may retain provenance metadata but are no longer resumable through an extension tool.
- Keep user-observable interrupted panes and lifecycle projection intact, including stopped terminal presentation when an interruption is observed.
- Update documentation and tests to describe and enforce the reduced tool surface.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagent-dispatch`: parent and child tool visibility, admission, ping, resume, and interrupt requirements change to a single parent dispatch tool plus child completion control.
- `pane-surface`: surface options apply only to initial dispatch, and pane interruption/continuation become direct user interactions rather than extension tool operations.
- `completion-delivery`: after `agents-dashboard-widget` is archived, this change supersedes that capability's `caller_ping` and manual-resume sticky-row clauses while preserving its tree-widget contract; ping settlement and delivery paths are removed.
- `extension-runtime-safety`: asynchronous delivery no longer includes caller-ping or queued-resume outcomes.

## Impact

- `src/index.ts`, `src/subagent-done.ts`, `src/completion.ts`, `src/activity.ts`, and `src/session.ts` lose model-facing tool registrations and dead ping/resume/interrupt machinery.
- Parent agents see one extension tool (`subagent`); child agents receive only `subagent_done` from this package.
- Existing prompts or agents that call the removed tools must instead rely on the user interacting with the visible child pane.
- Unit and Herdr integration coverage removes ping/resume flows and verifies the reduced registration/allowlist contracts.
- **Archive dependency**: `agents-dashboard-widget` SHALL be archived first.
  This change's `completion-delivery` delta is intentionally written against that resulting dashboard contract and supersedes only its `caller_ping` and manual-resume sticky-row clauses.
- Existing base-spec resume wording is updated through this change's `subagent-dispatch` deltas and archive follow-up.
- No dependency or configuration changes.
