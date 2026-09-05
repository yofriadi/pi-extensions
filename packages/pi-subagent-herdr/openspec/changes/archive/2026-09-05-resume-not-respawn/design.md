# Design: resume-not-respawn

## Context

Today's exhaustion-delivery pipeline ends in `resolveResultPresentation` (`src/index.ts:294-308`) with the sentence "You can retry by spawning a new subagent; the user can inspect or continue it directly from its pane."
The parent obeys it, respawns fresh, and the failed child's transcript is discarded.
Meanwhile `subagent({session})` resume exists (ownership-gated: parent-session + agent-id + no live lease, validated side-effect-free pre-admission in `tool-execute.ts:168`), but two things block it at exactly the failure moment: the delivery never mentions it, and failure settlement preserves the pane with the child still alive, retaining the session lease — so resume validation would reject with "held by a live run".

Relevant existing mechanics (verified against the code):

- `shouldRetryCompletion` (`subagent-launch.ts:839`) retries only well-formed error sidecars, attempt < 3, not aborted; the relaunch already reuses the same session file (transcript, flags, env verbatim) — the extension's "retry" already resumes; the waste begins only at the exhaustion delivery.
- `resolveSettlementDisposition` (`subagent-launch.ts:215`) currently returns `preservePane: true, releaseAdmissionNow: true` for `reason: "error"`; the success path (`preservePane: false, releaseAdmissionNow: false`) runs `safeCloseAndReap` + `releaseRunOwnership` inside `applySettlementDisposition`.
- `safeCloseAndReap` (l.160) touches only pane/region — never leases; the blocking watcher runs with `releaseOwnership: false` (`tool-execute.ts:638`), so `completeBlockingRun`'s `sessionLease.transition("finalizing")` (l.666) always runs on a live lease.
  **The reap happens at exactly one site** (`applySettlementDisposition`), which is what makes flipping the error disposition safe for both blocking and background paths (background mirrors via `finishBackgroundResult`, l.1521).
- `settleRelaunchFailure` (l.927) and `handleBackgroundWatchError` (l.1525) settle through `preserveErrorPane` + `releaseAdmissionOnly`/conditional release; `handleWatchFailure`/`settleWatchFailure` is the primary watcher-threw path for both call styles, and its result uses `error` (not `errorMessage`) so it presents via the exit-code branch.
- `writeCompletionSidecar` writes `{type: "error", errorMessage}`; `isRetryableCompletion` treats every well-formed error sidecar as retryable.
- Widget heuristics: `providerFailurePrefix` (`widget.ts:655`) already strips the exhausted parenthetical; the `Session log:` strip expects that line last — both verified compatible with the new message shape.
- `SubagentResult` (`types.ts:13-30`) has **no `agent` field** — only `name`, which is the presentation-only label.
  The resume invocation needs the canonical agent id threaded through.
- Retained launch inputs (`launchParams`, `agentDefinition`, `selectedSkills`, `agentDir`, `effectiveCwd`) already live on `RunningSubagent`; a `session`-param resume is a *new run* with a new runId and fresh `entryCountBefore` — no lineage continuation machinery needed.

Constraints: strip-only TS, no new deps, Phase 1 must not change tool schema or validation; every presentation string must survive the widget's prefix-strip heuristics (notably: `Session log:` line stays last).

## Goals / Non-Goals

**Goals:**

- Phase 1: presented failures (exhausted, short-circuited, or non-exhausted) tell the parent to resume with an exact invocation naming the canonical agent id, or — for permanent errors — to do nothing and surface to the user; no respawn-new instruction anywhere.
- Phase 1: failure settlement reaps the pane (region + session lease) so the session is immediately resumable; sticky-launch-failure, relaunch-mechanics-failure, and watch-abandoned panes keep today's preservation.
- Phase 1: conservative quota/billing/auth regex short-circuits the 3-attempt retry (0 wasted attempts on obvious permanent errors); misses degrade gracefully to today's behavior.
- Phase 1: result plumbing — canonical `agent` + attempt-accurate `permanentError`/exhaustion signals reach the presentation.
- Phase 2: hard validation gate — fresh `subagent({agent})` rejected when a failed, settled, lease-free session of that agent exists for this parent, unless `fresh: true`.
- Both phases: blocking tool results carry the same resume-first shape as async steers.

**Non-Goals:**

- No hold state, no silent terminals — the failed run settles, delivers, and clears exactly like today; only the destination of follow-up work changes (resume vs respawn).
- No change to the 3-attempt retry policy for non-quota errors, backoff schedule, or per-attempt watch deadlines.
- No extension-side intelligent error classification — conservative regex only; parent judgment remains final via the permanent-error rule.
- No change to `session`-param validation gates themselves (Phase 2 adds a gate on *fresh* spawns, not on resume).
- No in-pane human-rescue workflow post-settlement (pre-settlement in-pane interaction remains exactly as today; the trade is accepted and documented).

## Decisions

### D1: Fix the message, not the model

The respawn behavior is not model misbehavior — it is obedience to an explicit instruction in the tool-result text, reinforced by a tool-level description that never mentions `session` (the schema param description exists; the tool description does not).
The fix rewrites `resolveResultPresentation`'s failure branch to:

```text
Sub-agent "name" [id] failed after <elapsed> (<attempt-accurate qualifier>).
Error: <errorMessage>
Resume it — do not spawn a replacement: subagent({ agent: "<canonical-id>", task: "continue the task", session: "<sessionFile>" })
If the error is permanent (quota exhausted, billing, invalid credentials): do not resume, do not spawn a replacement — surface this error to the user.
Session log: <sessionFile>
```

The attempt-accurate qualifier: "provider/agent error — auto-retry exhausted after N attempts" (exhausted); "provider/agent error — no further automatic retry attempted because the error looked permanent" (short-circuit, mentioning earlier attempts when the pattern first matched after attempt 1); plain "provider/agent error" (non-exhausted outcomes — malformed sidecar, pane disappearance — with no exhaustion claim and no "inspect its pane" wording, since the pane is gone).
The `Session log:` line stays last for the widget strip.
Alternative rejected: holding/silence (the withdrawn design) — removes the nudge but parks the work behind a human.
Alternative rejected: "notify + let the parent figure it out" — the instruction asymmetry is the bug.

### D2: One disposition flip, four intentionally-untouched paths

The only pane-lifecycle change is `resolveSettlementDisposition`'s `reason: "error"` branch flipping to `preservePane: false, releaseAdmissionNow: false` — the error path then runs the *same* reap the success path has always run, at the same single site (`applySettlementDisposition`), in the same order (reap → lease transition → markDelivery → sticky → delete → release → barrier release).
No new release site exists, so the blocking continuation's `sessionLease.transition("finalizing")` sees the same lease lifecycle a successful blocking run does — the released-lease throw is impossible by construction.

| path                                                           | Phase 1 behavior                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| error sidecar, pane present (`resolveSettlementDisposition`)   | reap pane + full ownership release (**the one change**)                                                        |
| relaunch-mechanics failure (`settleRelaunchFailure`)           | **intentionally unchanged** — `preserveErrorPane` + `releaseAdmissionOnly`                                     |
| background delivery/watch error (`handleBackgroundWatchError`) | **intentionally unchanged** — conditional preservation                                                         |
| watcher-threw (`handleWatchFailure`/`settleWatchFailure`)      | **intentionally unchanged** — child state unknown; result has no `errorMessage` so it never shows respawn text |
| sticky launch failure (`captureStickyLaunchFailure`)           | **unchanged** — nothing settled, the pane is the diagnostic                                                    |
| watch-abandoned (`reason: "timeout"`)                          | **unchanged** — outcome unknown, child may be alive; reaping kills live work                                   |

Why `settleRelaunchFailure` stays untouched (adversarial-review finding): when the relaunch fails because the old pane *survived the 30s confirmed-absence wait*, the old child may still be writing the shared `.jsonl`.
Today's code fails closed — the session lease is held until the pane's monitor confirms disappearance — and this change keeps that.
Releasing there would unlock a concurrent writer, which the delivered resume command would promptly create.
When the pane is genuinely gone, the existing conditional path already releases fully — so "unchanged" is also the *correct* behavior, not just the safe one.

Why `handleBackgroundWatchError` stays untouched: it fires when the *delivery chain* throws after settlement — possibly after a watch-abandoned settlement whose pane D2 preserves.
Its existing conditional (`errorPanePreserved` → `releaseAdmissionOnly`, else full release) already handles both cases correctly; a blanket reap would self-contradict.

Trade accepted and owned: the user's in-pane rescue of a *settled* failed run is gone (the child is an idle shell after an error turn; the transcript is durable).
Pre-settlement in-pane interaction (Escape, typing, backoff window) is untouched.

### D3: Reap happens only inside `applySettlementDisposition` — never ad hoc

Explicit invariant for implementers and reviewers: the failure-sidecar reap and ownership release happen **only** in the disposition (task 2.1).
Every other settlement path keeps its current preservation/release semantics.
This is what keeps the blocking lease-transition ordering safe and the single-writer guarantees intact on the surviving-pane paths.
Any future change that adds a second release site must re-derive the `completeBlockingRun` ordering proof.

### D4: Quota short-circuit — conservative regex, message as final authority

A well-formed error sidecar whose `errorMessage` matches `PERMANENT_ERROR_RE` **and does not match `TRANSIENT_HINT_RE`** is excluded from retry (`isRetryableCompletion` or its caller); the run settles immediately through the ordinary error path (which, after D2, reaps the pane).
Pattern (case-insensitive): quota co-occurring with exhaust/exceed (bounded word gap allowed, bare `limit` excluded — "quota limit resets at midnight" is transient), billing, and auth families (invalid api key, unauthorized, authentication + failure verb).
`TRANSIENT_HINT_RE` (retry/reset/per-minute/temporarily/cooldown/backoff) vetoes any classification — a message that explicitly says it retries or resets can never be permanent.
Post-review tightenings; both only ever REMOVE matches.
Deliberately narrow:

- Misses (429 phrased as plain "rate limit", provider-specific billing text) → full 3-attempt policy; the delivered permanent-error rule still lets the parent stop early.
  Degradation = today's behavior; never wrong delivery.
- The regex is an *attempt-saving optimization*, not the classifier of record — the parent's judgment via the delivered rule is the authority.
  Regex-classifying every provider's phrasing is fragile (429-rate vs 429-quota are textually near-identical); miss-side bias is the only safe direction.
- A pattern that first matches on attempt 2+ (after earlier retries ran) is handled attempt-accurately by D1's qualifier wording.

### D5: Result plumbing — canonical agent id + attempt-accurate signals

`SubagentResult` gains `agent?: string` (canonical id, distinct from presentation `name`/label) and `permanentError?: boolean`; `resolveResultPresentation`'s signature gains the canonical id (thread from `RunningSubagent.agent` at the blocking result site and the background message site), and its Pick extends to `permanentError`.
`completionResult` stamps both at construction from `running.agent` and the short-circuit decision.
A labeled run must emit the correct `agent:` in the invocation — the label is presentation-only and may differ arbitrarily.
The tool-level `subagent` description gains one sentence for `session` (the schema param description already exists — no schema change).

### D6: Phase 2 gate — reject fresh spawns when a resumable failed session exists

Validation (in `resolveLaunchContext`, alongside existing `session` gates, side-effect-free pre-admission): a call *without* `session` and *without* `fresh: true`, whose `agent` has a failed, settled, lease-free session under this parent → error naming the most recent such session's path and the resume invocation.
**State derivation: the child session JSONL's terminal stopReason + the lease registry — not sticky terminal entries**, which any admission wipes and reload drops (sticky-derived state silently disarms the gate; JSONL-derived state is durable).
`fresh: true` (new optional param, default absent) documents discard-intent and bypasses the gate.
Multiple failed sessions of one agent → name the most recent, offer `fresh: true`.
Resumed sessions move out of failed state (new run, lease held while live), so the gate must not fire on them.
Phase 2 is staged behind Phase 1 observation precisely so the schema change lands only if soft force disappoints.

### D7: Resumed runs are new runs

A `session`-param resume launches a new pane with the failed transcript in place, a new runId, fresh `entryCountBefore`, and `expectedRunId` equal to the new runId.
The failed run's sticky row clears at the *next admission* (which the resume itself triggers — self-cleaning; not at settlement).
No attempt-count carryover, no `resumedFrom` provenance — the parent asked to resume; it knows the lineage.

## Risks / Trade-offs

- [Parent still respawns-new despite the instruction] → Soft force is Phase 1's bet; compliance with explicit tool-result commands is high.
  Phase 2's validation gate is the staged hard backstop.
- [Human loses in-pane rescue of settled failures] → Accepted (D2): post-settlement the child is idle-waiting on an error turn; the transcript survives; parent `session` resume supersedes.
  Pre-settlement interaction untouched.
- [Regex misclassification] → Miss-side: quota retried 3 times (today's behavior; no output tokens burned on quota rejections).
  False-positive side: the membership is deliberately narrow — quota verbs are exhaust/exceed only (bare `limit` excluded: "quota limit resets at midnight" is transient), authentication requires a failure verb, and any explicit transient marker (retry/reset/per-minute/temporarily) vetoes a permanent classification.
  A plain "rate limit" 429 does not match.
  Residual ambiguity is bounded: a false positive skips retries but the delivered permanent-error rule leaves the parent the final judge, and a false negative merely burns today's attempts.
- [Sticky-row accumulation while parent resumes] → Self-cleaning: each resume is an admission, and admissions evict the sticky set — the row that instructed the resume is cleared by acting on it.
- [Phase 2 gate disarms silently] → Mitigated by design (D6): gate state derives from durable session JSONL + lease registry, not from transient sticky entries.
- [Tool description grows] → One sentence; bounded.
- [Failed pane close on the reap path] → `safeCloseSubagentPane` swallows close failures (a transient herdr control-plane error must never stall settlement), so a reaped pane is not guaranteed gone.
  Mitigated post-review: for error sidecars — the settled outcome whose delivery advertises the session as resumable — the disposition probes the pane once after the reap, and an explicit `present` reading escalates to the preserve semantics (pane monitor, admission-only release, session lease retained until confirmed disappearance) instead of releasing ownership against a possibly-live pane.
  An unavailable probe does not escalate (fail-open only toward the normal path); successes/sentinels keep the unconditional release.
- [Settlement releases the session lease without confirmed pane absence] → Accepted asymmetry with the retry path (which waits for `waitForPaneAbsence` before creating a new writer): realistically safe because the child is already terminal on a settled error turn and the parent's resume takes a model-turn of latency; the success path has always had this shape.
  The post-reap probe above narrows the window further.

## Migration Plan

1. Phase 1 (no schema, no validation change): presentation rewrite + disposition flip + quota regex + result plumbing.
   Ship; observe whether the parent resumes as instructed.
2. If real sessions show the parent ignoring the instruction, land Phase 2 (fresh-gate + `fresh: true`) as a follow-up.
3. Rollback: Phase 1 is presentation text + one disposition branch + one regex; reverting the commit restores prior behavior with no state migration (sticky rows and leases are transient).

## Open Questions

- Exact `PERMANENT_ERROR_RE` membership — pin during implementation against real sidecar phrasings in test fixtures; keep miss-side bias.
- Continuation `task` string in the generated invocation — lean fixed-short ("continue the task from where it failed"); the transcript carries the original.
- Phase 2: whether the gate should also fire for `stopped` (user-interrupted) sessions — lean no: interrupted-before-settle means the user is the in-pane actor; gating fresh spawns would fight the user, not help the parent.
