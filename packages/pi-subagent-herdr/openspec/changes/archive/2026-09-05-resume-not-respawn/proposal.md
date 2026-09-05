# Change: resume-not-respawn

## Why

After automatic retries exhaust, a failed subagent run is delivered to the parent as a failure steer whose text explicitly instructs it — "You can retry by spawning a new subagent" — with no mention that the `session` resume parameter exists.
The parent obeys, respawns the task from scratch, and the failed child's transcript — the only artifact holding its partial work — is discarded.
Meanwhile the failed pane is preserved with the child process still alive, holding the session lease, so the resumable session is mechanically blocked from `session`-parameter resume exactly when it would be most useful.
The parent never resumes because it is *told not to* and *cannot*.

## What Changes

- **Resume-first failure delivery.**
  When a run's failure outcome is presented after attempts exhausted (background steer or blocking tool result), the delivery no longer says "retry by spawning a new subagent."
  It instructs the parent to resume the same session — with the exact `subagent({ agent, task, session })` invocation (naming the canonical agent id, not the presentation label), session path, and failure reason — or, if the error is permanent (quota/billing/auth), to not resume and not respawn, and surface it to the user instead.
- **Failed panes are reaped, not preserved, once the run settles as failed.**
  Failure settlement with a live pane closes the pane (releasing the region and the session lease) instead of preserving it, so the failed session file becomes immediately resumable through the ownership-gated `session` parameter.
  Sticky launch-failure panes, relaunch-mechanics failure panes (the surviving pane may still hold a live writer — its lease stays retained until confirmed pane absence), and watch-abandoned panes keep today's preservation untouched.
- **Message shape is spec'd, not implied.**
  The failure presentation carries: the preserved provider/agent-error prefix, the auto-retry-exhausted statement (only when retries actually exhausted; the permanent short-circuit instead states that no further automatic retries were attempted), the session log path, the exact resume command, and the permanent-error rule.
  Non-exhausted error outcomes (malformed sidecar, pane disappearance) carry the same resume-first shape without the exhaustion claim.
  The blocking tool result carries the same shape.
- **A cheap quota short-circuit inside the extension's retry decision.**
  A well-formed error sidecar whose `errorMessage` matches an obvious quota/billing/auth pattern is not retried — it settles immediately (pane reaped, resume-first failure delivered).
  Non-matching errors keep the full 3-attempt policy.
  The classifier is a conservative, best-effort regex; anything it doesn't match behaves exactly as today.
  The parent retains final judgment (its message still carries the permanent-error rule), so classifier misses degrade to today's 3-wasted-attempts behavior, never to wrong delivery.
- **Result plumbing for the new presentation.** `SubagentResult` gains the canonical `agent` id and a `permanentError` flag so the presentation can emit the exact invocation and the attempt-accurate short-circuit statement.
- **A hard force, phase-gated.**
  Phase 1 is the delivery-wording change plus pane reap (above).
  Phase 2 adds a validation gate: a fresh `subagent({ agent })` call is rejected — with an error naming the resumable session path — when a failed, settled, lease-free session of that exact agent exists for this parent, unless the call opts out with a new `fresh: true` parameter.
  `fresh: true` discards lineage and spawns a new session as today.
  Gate state is derived from the child session files' terminal state and the lease registry — not from sticky terminal entries, which any admission wipes and reload drops.

## Capabilities

### New Capabilities

*(none — behavioral change to existing delivery and pane-lifecycle requirements)*

### Modified Capabilities

- `completion-delivery`: the text-only-extraction requirement's failure presentation changes from "you can retry by spawning a new subagent" to the resume-first message (exact resume command, canonical agent id, permanent-error rule, attempt-accurate statements); failure settlement with a live pane gains pane-reap semantics (lease released so the session is resumable) with explicit carve-outs for sticky launch failures, relaunch-mechanics failures, and watch-abandoned runs; the retry decision gains the quota/permanent short-circuit (no attempts burned on obvious quota/billing/auth errors).
- `pane-surface`: the pane-lifecycle requirement's failure-settlement behavior changes — a settled failed run closes its pane rather than preserving it — while preserving the existing exceptions (sticky launch failures, relaunch-mechanics failures, watch-abandoned runs), and adding a provenance rule so a resumed session's pane lineage continues from the failed run's session file as a new dispatched run.

## Impact

- `src/index.ts` — `resolveResultPresentation`: replace the respawn-new instruction with the resume-first message (resume command with canonical agent id, session path, permanent-error rule, attempt-accurate exhaustion/short-circuit statements) for all presented error outcomes and blocking tool results; one sentence added to the tool-level `subagent` description for the `session` parameter (the schema param description already exists).
- `src/types.ts` — `SubagentResult` gains `agent?: string` (canonical id) and `permanentError?: boolean`; presentation Pick extended.
- `src/subagent-launch.ts` — settlement disposition for `reason: "error"` with pane present (close pane + release session lease, mirroring the success path's reap); stamp `agent`/`permanentError` at result-construction sites; `settleRelaunchFailure`, `handleBackgroundWatchError`, and `handleWatchFailure` are intentionally unchanged (verified correct post-disposition-change); `isRetryableCompletion`/`shouldRetryCompletion` quota short-circuit (conservative regex on the sidecar `errorMessage`).
- `src/completion.ts` — `PERMANENT_ERROR_RE` (conservative, case-insensitive quota/billing/auth patterns) gating `isRetryableCompletion`, exported for tests.
- `src/agent-definition.ts` / tool schema (`src/index.ts` `SubagentParams`) — Phase 2 only: add optional `fresh` flag; fresh-spawn gate in `resolveLaunchContext` deriving failed-session state from the child session JSONL + lease registry.
- Tests: presentation text (resume command present with canonical agent id under a label, permanent rule present, attempt-accurate short-circuit wording, quota short-circuit no-retry, pane reap on failure settlement, carve-out preservation), blocking-path lease-transition safety, validation gate tests (Phase 2).
- README: failure-resume workflow documented in the auto-retry/exhaustion sections (README.md:64–72); quota short-circuit noted.
- Tool schema change is Phase 2 only (`fresh` flag).
  Phase 1 changes no tool schema, no validation, no new state.
