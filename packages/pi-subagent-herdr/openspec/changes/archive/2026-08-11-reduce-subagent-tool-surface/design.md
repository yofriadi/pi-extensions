## Context

The extension currently exposes three parent lifecycle tools (`subagent`, `subagent_interrupt`, `subagent_resume`) and two child protocol tools (`subagent_done`, `caller_ping`).
That API was designed as if the parent model needed to mediate every lifecycle transition.
In Herdr, however, every admitted child runs in a visible pane or tab: the user can send Escape to that pane, inspect it, and type follow-up input directly.

The extra tools add schema and prompt surface, queue/resume state, ownership validation, ping-specific settlement and delivery, and model-facing guidance.
They also invite the parent model to operate a UI lifecycle that is more reliably and transparently controlled by the user.

## Goals / Non-Goals

**Goals:**

- Register only `subagent` in parent sessions.
- Register only `subagent_done` as a child protocol tool.
- Remove implementation paths that exist solely for agent-driven interrupt, resume, or ping.
- Preserve visible Herdr panes/tabs and user control of them.
- Preserve ordinary foreground/background dispatch, settlement, delivery, interruption observation, and sticky failure presentation.

**Non-Goals:**

- Adding a replacement lifecycle tool or listing tool.
- Automating user input into a child pane.
- Removing ordinary session JSONL, lineage, or provenance data used for diagnostics.
- Changing `subagent` parameters, admission limits, layout choices, or result delivery semantics.
- Rewriting existing base specs in this change; the delta records the contract transition.

## Decisions

### D1: One parent model-facing tool

Only `subagent` is registered for a parent session.
`subagent_interrupt` and `subagent_resume` are deleted rather than hidden behind configuration.
This makes the reduced surface deterministic and prevents tools from reappearing through permissions or agent definitions.

Alternative considered: retain the tools but discourage their use in descriptions.
Rejected because the model still pays the tool-selection cost and can still invoke redundant lifecycle paths.

### D2: One child protocol tool

The launch allowlist appends only `subagent_done`. `caller_ping` is removed from child registration, activity events, completion sidecars, parent notifications, renderers, and result types.

Alternative considered: retain `caller_ping` as notification-only.
Rejected because the child already has a visible pane, and without model-driven resume there is no protocol response path that justifies stopping the child and introducing a distinct settlement class.

### D3: Direct pane interaction is user-owned

Escape and follow-up input are performed by the user in the visible child pane or tab.
These interactions do not create new extension admission entries and are not represented as parent-agent tool calls.
Existing pane/activity observation can still project an interrupted state when Pi reports it.

This deliberately separates two authorities: the agent dispatches work through `subagent`; the user controls an already-visible child UI directly.

### D4: Remove resume-only correlation, retain session provenance

The extension removes session-owner reads, exclusive resume validation, resumed-run sticky correlation, queued resume launch logic, and resume-specific permission gating.
Initial session creation continues writing owner/provenance metadata because it records canonical lineage and does not expose or enable a model-facing resume operation.
That metadata is explicitly write-only provenance in this design; no extension runtime code may read it to authorize a lifecycle action.

Alternative considered: remove all owner metadata immediately.
Rejected because it is harmless provenance and may serve diagnostics; removing it is not necessary to reduce the tool surface.

### D5: Interrupted remains an observable lifecycle state

The lifecycle type, widget glyph, and sticky `stopped` classification remain.
A child whose latest assistant turn ends with `stopReason: "aborted"` SHALL publish an interruption activity snapshot; parent observation maps it to the interrupted state until newer child activity begins.
The child recorder SHALL preserve its run-specific activity sequence across extension reloads, so resumed activity remains fresher than the interruption snapshot.
This is not exclusive to `subagent_interrupt`: it records the user pressing Escape in the child pane.
Ping-specific stopped classification is removed; a watcher timeout takes precedence and is classified watch-abandoned.

### D6: Archive ordering with the dashboard change

`agents-dashboard-widget` SHALL archive before this change.
Its archived tree-widget/sticky-row contract becomes the base that this change modifies: retain terminal rows and whole-set eviction on the next admission, but remove `caller_ping`, ping-to-stopped classification, and single-row manual-resume correlation.
This avoids archive-order-dependent contracts without editing the active sibling change.

### D7: Child help no longer settles parent work early

Removing `caller_ping` intentionally removes the only child-initiated early-settlement path.
A child that needs help remains an active dispatched run until it completes through `subagent_done` or normal exit, the user drives it in the visible pane, or the watcher times out.
The watcher cap is a fixed code-owned four hours (`DEFAULT_COMPLETION_TIMEOUT_MS`) with no user-facing override; a timed-out child is watch-abandoned, its admission capacity is released, and its pane may remain for the user.
This is an explicit trade-off for eliminating model-driven lifecycle control.

## Risks / Trade-offs

- [A parent agent can no longer autonomously interrupt or continue a child] → This is intentional; the visible pane gives the user explicit control and avoids hidden model-driven UI actions.
- [A child needing guidance can hold the sole foreground slot] → With `caller_ping` removed, it remains dispatched until user-driven completion/exit or the fixed, code-owned four-hour watcher cap; timeout releases admission as watch-abandoned while preserving the pane for recovery.
- [Direct user continuation is outside parent admission/delivery tracking] → Keep pane and lifecycle observation best-effort; document that parent-agent orchestration ends at dispatch/result handling.
- [Prompts or agent definitions still mention removed tools] → Registration and allowlist tests enforce absence; migration guidance directs users to the pane.
- [Owner metadata appears resume-oriented after resume removal] → Treat it as write-only provenance only; no runtime code reads it to authorize a lifecycle action.
- [The active dashboard change still describes ping/manual-resume behavior] → Archive `agents-dashboard-widget` first, then archive this change's superseding delta; do not archive these changes in the reverse order.
- [Historical specs and changelog text still mention old behavior before archival] → The new change delta is authoritative for this proposal and does not rewrite history.

## Migration Plan

1. Archive `agents-dashboard-widget` first so its tree-widget contract is established in the base spec.
2. Remove parent and child tool registrations and their implementation paths.
3. Remove ping-specific sidecar, activity, settlement, renderer, delivery, and widget behavior, including manual-resume sticky-row correlation.
4. Remove resume/interrupt unit and integration fixtures; add reduced-surface assertions and a timeout/watch-abandoned capacity-release case.
5. Update the base `subagent-dispatch` Purpose during archive and apply this change's canonical-resolution/minimal-schema deltas so no resume wording remains.
6. Update package documentation and unreleased changelog guidance.
7. Validate the new OpenSpec change and run the commands recorded in the verification tasks.
8. On rollback, restore the removed registrations and their coupled ping/resume/interrupt machinery as one unit from pre-change commit `3c7a81c00d4bac6b2151d2d563bc20d75eeccb5f`; partial restoration is unsupported.

## Open Questions

None.
