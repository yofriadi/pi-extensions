# Tasks

## 1. Evidence

- [x] Reproduce the reported stall: `classifyInterruption({ stopReason: "error",
  errorMessage: "upstream stream interrupted" })` → `NONE`.
- [x] Rule out a Pi regression: the string occurs 17x across 8 sessions
  (2026-09-01 -> 2026-09-22) in
  `~/.pi/agent/sessions` back to 2026-09-01; `git log -S interrupt` on
  `src/constants.ts` shows the word never appeared in a transient pattern; the
  same session shows the extension retrying `503 no_capacity` on schedule under
  Pi 0.86.1.
- [x] Corpus audit: classify every distinct `errorMessage` in
  `~/.pi/agent/sessions/*/*.jsonl` (1341 strings / 4605 occurrences in the
  2026-09-23 snapshot; counts grow with live traffic) with the
  pre-change and post-change classifier and diff the results. Recipe committed
  in `proposal.md` → "Evidence reproduction". Re-run after every pattern edit;
  final result is 7 flips and every one is intended: 4 transient recoveries
  (`NONE → RATE_LIMIT`), the wrapped 429 (`NONE → RATE_LIMIT`), and 2 payload-size
  errors (`NONE → CONTEXT_OVERFLOW`). Identical at `fatalFirst: false`.
- [x] Confirm the flip counts are real traffic, not echoes of this investigation:
  per-file grep for each of the 4 strings resolves to sessions from 2026-08 and
  2026-09 in `gpot`, `wedding-website`, `pi-cc-ui`, `pi-provider-cline`, `.pi`,
  and an orbstack sandbox — none of them a review session.

## 2. Classifier patterns (review 1)

- [x] Add `interrupt` to the stream and upstream alternations in
  `TRANSIENT_ERROR_PATTERNS`; add `network` for relay messages truncated
  mid-phrase.
- [x] Add a component-named interruption pattern instead of a bare `interrupted`.
- [x] Add a provider-side `internal[_ ]?[server[_ ]?]?error` pattern.
- [x] Extend `USER_ABORT_PATTERNS` for user/client-attributed interruption.
- [x] Extend `BILLING_HARD_LIMIT_PATTERNS`, `PERMANENT_REQUEST_ERROR_PATTERNS`,
  and `CONTEXT_OVERFLOW_PATTERNS` so the new transient patterns cannot launder a
  terminal failure.
- [x] Rejected after measurement: adding 413 to the permanent status list
  (regressed 45 real `413 … upstream_error` relay failures to `NONE`); a
  `retry|try again later|shortly|soon` pattern (no corpus support); a blanket
  4xx gate on transient text (breaks the documented `400 … upstream_error`
  retry).

## 3. Classifier patterns (review 2 remediation)

- [x] Revert `interrupt` from the legacy `stream.{0,40}` and `upstream.{0,30}`
  alternations: `.` crosses sentence breaks, so `Stream finished successfully.
  The user then interrupted.` became retryable. The component-named pattern
  already covers every evidenced string.
- [x] Drop `request` from the interruption cancellation pattern; it vetoed
  observed retryable statuses (`{429, "Rate limit exceeded. The request was
  interrupted. Retry after 60s"}` → `NONE`, `{502, "upstream request
  interrupted"}` → `NONE`). Keep `operation`.
- [x] Add a transport-evidence lookahead to the `operation … interrupted`
  cancellation pattern so `operation interrupted: ECONNRESET` and `The operation
  was interrupted by a socket hang up` stay retryable.
- [x] Scope `forbidden` to an internal-error wrapper and `entitlement` to a
  terminal verb: bare matches outranked every status branch and turned
  `{503, "Forbidden"}`, `upstream error: 403 Forbidden`, `unable to verify api
  key — forbidden`, `entitlement service temporarily unavailable`, and
  `{504, "entitlement check failed: upstream timed out"}` terminal. Neither word
  appears anywhere in the corpus, so nothing real is lost.
- [x] Drop `content[_\s-]?moderation` from the permanent list: it contradicted
  the pinned behaviour for policy/safety *service* outages.
  `data_inspection_failed` and `inappropriate content` still catch the evidenced
  Alibaba rejection.
- [x] Re-run the differential probe (29 rows covering every round-2 finding) and
  the corpus audit: all adverse flips reversed except the documented `operator`
  residual; the 4 intended flips intact.
- [x] Rejected: `server[_\s-]?error` (0 corpus occurrences); scoping
  `not authorized` to the internal-error wrapper (turns the common `You are not
  authorized to use this model` into a silent stall); fixing cancellation-beats-
  status precedence in `src/classifier.ts` (pinned as intentional by
  `tests/classifier.test.ts`, needs the maintainer's decision).

## 3b. Review 3: mutation testing and consolidation

- [x] Mutation-tested the pattern set: 16 targeted edits to `src/constants.ts`
  (drop each new pattern, drop each lookahead alternative, widen the gap bound,
  let the component pattern cross sentences, revert the attribution patterns to
  HEAD). 13 survived the round-2 suite — they passed by omission, not by
  exercising the pattern. All 16 now die.
- [x] Pin the survivors: five cancellation strings that co-occur with a transient
  marker (`The operation was interrupted. fetch failed`, `operation interrupted:
  server is overloaded`, `interrupted at user request: fetch failed`, `user
  interrupted the request; upstream error`, `client interrupted: socket hang
  up`); three `operation …` rows, one per load-bearing lookahead alternative
  (`reset by peer`, `upstream`, `timed out`); the 38-vs-39-character boundary
  pair; two cross-sentence strings; `Internal error: unauthenticated`; and every
  entry of the component list.
- [x] Delete `|network` from the lookahead exclusion: provably inert, since no
  `TRANSIENT_ERROR_PATTERNS` entry matches a bare `network …`, so the comment's
  "keeps explicit transport evidence retryable" claim was false for it.
- [x] Fold the six authorization/paywall billing patterns into one
  internal-error-scoped pattern. Nothing new remains in the unscoped part of
  `BILLING_HARD_LIMIT_PATTERNS`, so no added wording can veto an observed
  429/5xx. This also makes the spec's "only inside an internal-error wrapper"
  claim true for `entitlement`, which the terminal-verb scoping had violated.
- [x] Correct four doc claims: the deadline cost is 34 attempts, not 60
  (simulated against the real `RetryManager` at `DEFAULT_CONFIG`: 34 attempts /
  300.0 min, stable across 40 jittered runs; 20–21 attempts at the maintainer's
  `90m`/`70s`/`5m` settings); `operator` occurs 3x in the corpus, not 0x; the
  `server_error` rejection is about the snake_case token, not `server error`; a
  400 orphan rejection falls through to `NONE` via the `invalid_request` guard
  rather than a permanent-status match.
- [x] Relax the runtime test's orphan assertion from an exact role list to an
  ordering check, so an unrelated Pi change (extra system message, compaction)
  does not break a test whose only claim is "the orphan is still there".
- [x] Review scaffolding (`.review-fixtures/`, `.review-scratch/`) is temporary
  and was deleted before finishing; it is untracked and unignored, so it must
  never be staged. Round 4 restaged `.review-fixtures/` with a privacy-stripped
  timeline of the motivating session (structure, timing, errors only — no project
  text) and the maintainer's `autoContinue` block; deleted afterwards as well.

## 3c. Review 4: scheduling, budget accounting, real-session replay

- [x] Explain the motivating session's ~946s cadence. Verdict: the Pi process
  started 2026-09-20T16:34:55Z, 27 minutes before `da2f0d532` was committed
  (2026-09-20T17:02:01Z), so it ran pre-rework code, which cleared its own-input
  flag before Pi delivered the fire-and-forget follow-up. Every cycle was therefore
  attempt #1 and re-applied the uncapped first-attempt delay (`baseDelayMs` +
  remaining provider reset hint; a hint of ~850-920s reproduces the observed 922s
  waits). Transcripts do not persist response headers, so the exact hint value is
  unknowable from the log — the mechanism is verified, the header value is inferred.
- [x] Verify HEAD escalates instead: 70s -> 105s -> 157.5s -> 236.25s -> 300s cap
  under the maintainer's real config, one `startTime` for the whole run.
- [x] Add the missing runtime test for that regression class: consecutive
  RATE_LIMIT follow-ups report `attempt #1` then `#2`, then the configured limit
  stops the loop with a reason, the transport tag never reaches the provider, and
  the persisted prompt is exactly `.`.
- [x] Fix the silent stop (`src/index.ts`): a follow-up that classifies `NONE` with
  `stopReason: "error"` during an active loop reset the retry state without
  notifying. Now reports `Recovery stopped after N attempt(s): …` at error level.
  Scoped to `stopReason === "error"` so aborts stay silent and healthy completions
  keep their existing message.
- [x] Mutation-check that fix: removing the branch makes the new runtime test fail.
- [x] Load the maintainer's real settings through `loadConfig` and confirm every
  value lands as documented (rate limit 5,400,000ms / 70,000 / 300,000;
  continuations 3 attempts / 5,000 / 300,000; `windowRetryMargin` 1.15;
  `fatalFirst` true; `retryPrompt` "."; both continuation prompts verbatim).
  `backoffMultiplier: 1.5` applies to rate-limit backoff AND continuations.
- [x] Confirm the 400 path is genuinely non-retryable in code, not just in prose:
  `invalid_request` hits `PERMANENT_REQUEST_ERROR_PATTERNS`; a bare `400 Bad
  Request` falls through to `NONE` because 400 is in neither the retryable status
  list nor the anchored permanent-status pattern.
- [x] Recorded for the maintainer, not fixed here: shared `attempt` counter (3
  rate-limit retries disable token/tool continuations under `maxRetries: 3`),
  uncapped first-attempt delay, dead public `decrementAttempt()`, and the
  `config.ts` coercion traps. Details in `proposal.md`.
- [x] Version skew: only 0.85.1 is installed against a 0.86.1 CLI, so 0.86.1
  behaviour is unverifiable here. All 21 registered event names and every
  `ExtensionContext` member used exist in the 0.85.1 typings; the assumptions that
  would break silently on a minor bump are `agent_settled` firing once per run,
  native retry persisting each errored message, `deliverAs: "followUp"` running
  immediately when idle, `ctx.signal` being undefined outside a stream, and TUI
  escape encodings. The one assumption that would resurrect the original bug —
  `source: "extension"` on `sendUserMessage` — is covered by two runtime tests.

## 3d. The maintainer's decisions, implemented

- [x] Separate the retry budgets (`src/types.ts`, `src/retry-manager.ts`):
  `continuationAttempts` added; `evaluateContinuation` limits and backs off on it;
  `evaluateRetry` limits on `rateLimitAttempts` instead of the shared `attempt`;
  `attempt` stays the aggregate for summaries. `RetryCheckResult.attempt` now
  reports the count for its own recovery kind, so `attempt #N of M` is coherent.
- [x] Delete the dead public `RetryManager.decrementAttempt()` and its test.
- [x] Validate and warn in `src/config.ts`: `loadConfig(path?, onWarning?)` reports
  unusable booleans, durations, multipliers, margins and `maxRetries` values,
  unknown keys per section, a non-object `autoContinue`, an unreadable settings
  file, a blank prompt, and `baseDelayMs > maxDelayMs`. Every fallback is unchanged.
- [x] Surface them in `src/index.ts`: warnings are buffered at load and flushed as
  `warning` notifications at `session_start` and after `/auto-continue reset`.
- [x] Fix the wrapped 429: `EXPLICIT_RATE_LIMIT_PATTERNS` (narrow subset of
  `RATE_LIMIT_PATTERNS`) outranks the request-shape guard, which moved out of
  `PERMANENT_REQUEST_ERROR_PATTERNS` into `REQUEST_SHAPE_ERROR_PATTERNS`. Refusals,
  moderation, unknown-model, credential errors and the anchored permanent-status
  prefix keep priority; an observed status alone overrides nothing.
- [x] Keep the uncapped first-attempt delay (decision: clamping wastes a request
  into the same limit and burns the deadline faster); no clarifying notice added.
- [x] Leave the other three classifier gaps open: the non-ISO reset timestamp in
  `usage exceeds frequency limit … will reset at 2026-09-14 23:55:33 UTC+8`,
  silent `NONE` for 402/403 balance text behind the bare status-prefix guard, and
  `404: {"message":"Upstream request failed","code":"upstream_error"}`.
- [x] Rewrite `AGENTS.md` (221 lines / 15 KB -> 110 lines / 6 KB): dropped the
  inherited fork overview, technology-stack table, lifecycle diagram and component
  prose that duplicate README.md; kept commands, layout, the precedence and
  mutation-testing rules, the corpus-evidence recipe, the independent-counter rule,
  the verified platform limitations, the vendoring warning, and the pre-submit
  checklist.
- [x] Re-run the corpus audit after the classifier change. It exposed a latent
  misclassification the override made reachable:
  `400: {"message":"This prompt is longer than the free tier allows for a single
  request…","code":"free_rate_limited"}` would have re-sent the identical prompt for
  the whole deadline. Added `/(?:prompt|input|request)\s+(?:is\s+)?longer\s+than\b/i`
  to `CONTEXT_OVERFLOW_PATTERNS`, which is consulted before throttling wording, so it
  now defers to compaction. Pinned by a test case carrying both signals.
- [x] Mutation-checked this round's changes: 8 mutants (drop the new context pattern,
  drop the wrapped-429 override, restore either shared-counter limit check, silence
  config warnings, accept any `backoffMultiplier`, drop unknown-key warnings, never
  flush warnings to the UI) — all 8 killed.
- [x] Leave the two untracked package-root files alone (maintainer decision):
  `2026-09-20T16-34-55-880Z_….jsonl` and `NOTE.md`. They remain untracked and
  unignored, so `git add -A` in this package would still stage them.

## 3e. Review 5: the maintainer-decision implementation

- [x] Fix the `getStatusSummary` regression (aggregate compared against a per-kind
  limit, printing `Attempt: 6 / Max: 3`); it now reports the active kind's counter
  with the aggregate labelled alongside.
- [x] Drop bare `/quota/i` from `EXPLICIT_RATE_LIMIT_PATTERNS` and `request` from the
  `longer than` subject list; both were measured to misroute real shapes (an
  out-of-credit 400 into a full-deadline retry loop; a latency complaint into
  compaction, vetoing a confirmed 429/504).
- [x] Make `readMaxRetries` use `parseMaxRetries` as its oracle and report fractional
  rounding; add non-object section and root warnings; name the value in `readPrompt`'s
  warning.
- [x] Aggregate settings warnings into one notification per load, keep them buffered
  when `ctx.hasUI` is false, say `total attempt(s)` in the new stop message, include
  the provider text in the context-overflow notice, list both per-kind counters in
  `/auto-continue status`, guard `commandHandler` with a try/catch around a new
  `runCommand`, and clear all three counters in both cycle-init blocks.
- [x] Mutation-check this round: 13 mutants (restore `/quota/i`, restore `request`,
  status summary back to the aggregate, loose `readMaxRetries`, drop either object
  warning, drop the `readPrompt` value, drop the fractional warning, continuation
  backoff back to the aggregate, context-overflow notice without the error text,
  unguarded command handler, one toast per warning) — 13 killed. Two further mutants
  survive by construction and are documented in `proposal.md` rather than pinned.
- [x] Correct the docs: "every fallback value is unchanged" -> "every effective limit
  is unchanged" (eight garbage `maxRetries` strings were stored verbatim at HEAD);
  AGENTS.md precedence chain, notification levels, checklist, and the two orphaned
  testing rules; repo-root `AGENTS.md` lists for this package.

## 3f. Review 6: the round-5 fixes and the never-reviewed modules

- [x] Fix the manual-schedule refusal reporting an uncharged attempt
  (`src/retry-manager.ts`); pinned by extending the existing duration-deadline test.
- [x] Fix four documentation defects this change introduced: README's override list
  still named `quota`; the spec still named `request` as a `longer than` subject;
  AGENTS.md misplaced the request-shape guard in the precedence chain; corpus counts
  had drifted with live traffic.
- [x] Pin the `/auto-continue status` per-kind counters, which survived round 5's
  mutation run undocumented.
- [x] Watchdog: skip the 30s pause once `dispatched.phase === "started"`, so a turn
  Pi already opened cannot be reported as never starting and cannot lose the budget.
- [x] Manual schedules: report `CONTEXT_OVERFLOW` and `BILLING_HARD_LIMIT` while
  waiting (extracted `classifyObserved`, `contextOverflowNotice`, `billingNotice` so
  both paths share one implementation), without scheduling or touching retry state.
- [x] Notify when a non-manual wait finds Pi busy at dispatch and stops.
- [x] Notify when `/auto-continue at` re-enables recovery that was off.
- [x] Stop publishing `expectedResetTime` for a rolling-window estimate.
- [x] `formatDateTime` appends the local UTC offset; pinned by an invariant test that
  reconciles the rendering and the label against the instant.
- [x] Mutation-checked all eight fixes: 8 mutants, 8 killed. Two round-5 mutants
  still survive by construction and remain documented rather than pinned.
- [x] Recorded without changing: unbounded absurd reset hints under a numeric
  `rateLimit.maxRetries`, quadratic backtracking in the inline-duration regex
  (identical at HEAD), unreachable `formatter.ts` warts, and Pi replacing a
  consecutive `info` notification in place.
- [x] Recorded the three breaking changes for consumers of the published package;
  version bump left as a release decision.

## 3g. Review 7: no major issues, nine minor fixes

- [x] Verdict recorded: no major issues remain. Invariants, hook sequences, the nine
  heaviest tests, and the whole diff were audited; the findings that needed real Pi
  were verified against `node_modules/@earendil-works/pi-coding-agent/dist/`.
- [x] Guard notifications: `hasUsableUI` wraps the `ctx.hasUI` accessor and `notify`
  wraps `ctx.ui.notify`, so a disposed context cannot turn a lost message into an
  `uncaughtException` from a timer callback (`src/index.ts`).
- [x] Make `/auto-continue status` phase-aware instead of promising a 30s watchdog
  that no longer fires once Pi opened the turn.
- [x] Reword the "re-enabled it for this session" notice so it describes the
  re-enable, not the schedule (completed in §3h: it is announced whenever the command
  re-enables, refused or not).
- [x] Clear `lastExpectedTokenResetTime` on a healthy completion so status stops
  printing the previous cycle's instant as "(passed)"; keep it after billing and
  overflow, where the hint is still actionable.
- [x] Scope the `recovery-status-reporting` SHALL to "the attempt count wherever one
  was charged" and name the stops that report a reason alone.
- [x] AGENTS.md: cancellation-style stops are `warning`; notifications are
  best-effort and why.
- [x] README: Pi-busy-at-dispatch joins the cancellation list; the manual schedule is
  counted as one rate-limit retry and is silent for other classifications by design.
- [x] Strengthen `formatter.test.ts`'s zone expectation (derive from `Intl` rather
  than mirror the implementation) and `retry-manager.test.ts`'s refusal count (charge
  one attempt first, assert 1 not 2).
- [x] Mutation-checked all seven code and test-integrity fixes: 7 mutants, 7 killed.
- [x] Re-ran the corpus audit and the package suite here, since the reviewer's
  sandbox could reach neither: 1341 distinct strings, 7 flips at either
  `fatalFirst`; 237/237 tests.
- [x] Recorded without changing: the untracked transcript and `NOTE.md` (maintainer's
  decision, §7).

## 3h. Review 8: one major regression from §3g, and eleven minors

- [x] **Major, introduced by §3g and fixed:** the strengthened `formatter.test.ts`
  zone helper treated bare `"GMT"` as the zero-offset form, but
  `Intl.DateTimeFormat` with `timeZoneName: "longOffset"` renders `"GMT+00:00"`,
  so the helper returned `UTC+00:00` where `utcOffsetLabel` prints `UTC`. Two tests
  failed under `TZ=Etc/UTC` and `Africa/Abidjan` and one under `Europe/London` in
  winter — i.e. on CI, which is `ubuntu-latest` with no `TZ`. Verified red in three
  zones, fixed by folding `""`/`+00:00`/`-00:00` to `UTC`, then verified green in
  eight zones including `Asia/Kathmandu` (+05:45) and `Pacific/Chatham` (+12:45).
  AGENTS.md's checklist now says to run the suite under `TZ=Etc/UTC` as well.
- [x] Re-enable notice: §3g suppressed it when the target was refused, which inverted
  a true statement — `at` forces `config.enabled`/`rateLimit.enabled` on before
  scheduling, so auto-recovery *is* live again after a refusal and the user was no
  longer told. It is announced whenever the command re-enabled, worded so it cannot
  imply a wait is armed, with the refusal reported separately. Pinned by a test that
  also proves the claim: ordinary continuation recovery still works after a refused
  `at`.
- [x] `/auto-continue status` distinguishes `phase === "accepted"` (the input hook
  took the prompt, Pi has not opened the turn, the watchdog still runs) from
  `"submitted"`, and says the 30s counts from submission. Pinned inside the existing
  accepted-but-not-started test.
- [x] Guard the `ctx.ui.notify` call itself, not only the `hasUI` accessor, with a
  test that throws from `notify` inside a timer callback — the process-killing case
  §3g described but did not pin.
- [x] Pin `/auto-continue reset` flushing buffered settings warnings, which the
  `settings-validation` spec already required and nothing tested.
- [x] README and `recovery-status-reporting/spec.md` quoted `Recovery stopped after
  N attempt(s)`; the code says `N total attempt(s)` (the "total" wording landed in
  review 5 of this same change). Both corrected.
- [x] Scope the `recovery-status-reporting` SHALL to the stops the extension decides,
  and name the cancellations that stay silent by design (navigation, model change,
  done-tool, shutdown, aborted turn, dispatch-time guards) plus the two that do
  report (fresh input, TUI Escape/Ctrl+C).
- [x] Document in code that a failed settings-warning delivery drops the buffer, and
  that the next `session_start` or `reset` re-derives it from settings.
- [x] §3g's justification for clearing `lastExpectedTokenResetTime` only on healthy
  completion named billing and overflow but not the non-retryable follow-up path,
  which also keeps the hint. Corrected.
- [x] Mutation-checked all seven code and test fixes under `TZ=Etc/UTC`: 7 mutants,
  7 killed.
- [x] Recorded without changing: `pi.on("session_before_switch", stopRecovery)` and
  its four siblings pass the event object as the first argument, which is harmless
  because `stopRecovery` is nullary (`keepAbortListener` belongs to `resetRecovery`,
  which is never used as a bare listener); `ctx.ui.onTerminalInput` stays unguarded
  because it runs inside a listener, so Pi reports a failure as an `ExtensionError`
  rather than crashing, and swallowing it would hide the loss of Escape/Ctrl+C
  cancellation; the refused-`at` "after 0 attempt(s)" wording is truthful and
  predates HEAD.

## 3i. Review 9: no major issues, wording and bookkeeping

- [x] Verdict recorded: no major issues remain. The suite was run in all 418 IANA
  zones (239/239 each), four locales, a bogus ICU data dir, reverse file order,
  `--test-concurrency=1`, and repeated runs; 51 classification claims, README's cost
  simulation, all 26 notification strings, and the state-machine hazards were
  re-verified.
- [x] Name the flag that was actually off in the re-enable notice (`rateLimit.enabled`
  alone can be false while auto-continue stayed on); pinned by a new test.
- [x] Re-derive the evidence table from the corpus and separate occurrences from
  distinct strings: 7 distinct strings, 38 occurrences; the two `free_rate_limited`
  bodies differ only in request id. Corpus counts corrected in three documents.
- [x] Rename the stale "permanent `invalid_request` guard" to the overridable
  request-shape guard in README, tasks §6, and `recovery-status-reporting`.
- [x] Correct the review-6 claim that the window-estimate wait is unchanged: it is
  longer by the classification-to-settlement interval, still capped by `maxDelayMs`.
- [x] Make the escalation chain exact and identical in all three documents
  (`70s -> 105s -> 157.5s -> 236.25s -> 300s cap`; backoff is unrounded without
  jitter).
- [x] AGENTS.md: level taxonomy matches the code (two user-caused cancellations are
  `info`, the re-enable notice is `warning`); warnings flush after `/auto-continue
  reset` as well as at `session_start`.
- [x] Remove the dead `ContinuationState` alias; recorded as the fourth breaking
  change for consumers.
- [x] Correct `commandHandler`'s comment: `loadConfig` is synchronous.
- [x] Soften the formatter test's claim about how ICU renders a zero offset; both
  forms are handled.
- [x] Recorded without changing: the scoped billing guard's missing credit/balance/
  trial wording (corpus-unmotivated, same class as the `operator` residual, and
  evidence-before-patterns forbids adding it); the narrow reachability of the
  "Pi opened the turn" status line; Node 22 not exercisable locally.

## 4. Tests

- [x] `tests/classifier.test.ts`: relay-failure positives assert `reason` as well
  as `type`; component-named interruption and internal-error positives;
  cancellation-wording negatives; terminal-wording negatives; a precedence suite
  proving ambiguous interruption and permission wording cannot veto an observed
  429/5xx; `content moderation service temporarily unavailable` added beside the
  pinned policy/safety analogues; 413 relay wrapper stays retryable; a
  classifier-level test that `stopReason: "error"` + a partial tool call is
  `RATE_LIMIT`, not `INCOMPLETE_TOOL_CALL`.
- [x] `tests/runtime.test.ts`: real-loader regression with the actual transcript
  shape (thinking block + dangling `toolCall` with `{}` arguments, 200
  response), asserting one follow-up, tag stripping, `pendingMessageCount === 0`,
  no extra timer after the healthy reply, and — labelled as a characterization of
  a Pi limitation, with instructions to delete it if Pi ever repairs the orphan —
  that the continuation context still carries the orphaned call id ahead of the
  follow-up prompt (ordering check, not an exact role list).
- [x] New tests: independent budgets in both directions plus the aggregate;
  wrapped-429 recovery and the five terminal wordings that must keep priority;
  config warnings for every coercion class, an unknown key, an unreadable file, a
  non-object section, contradictory delays, and a valid config that stays quiet;
  and an `extension.test.ts` case proving the warnings reach `ctx.ui.notify` at
  `session_start` and are re-reported (not duplicated) on reload.
- [x] Package `npm test`: 240/240 pass, in all 418 IANA zones including `Etc/UTC`,
  and under four locales plus a bogus ICU data dir. `npm run typecheck`: clean.
- [x] Root `pnpm run check`: clean.

## 5. Docs

- [x] README §3: new transient texts, the component-before-verb rule, the cost
  asymmetry (a wrong retry burns the whole deadline — roughly 34 full-context
  requests at the 5h default), the wrapper scoping of all permission/paywall/
  entitlement wording, the 413 body-limit vs context-overflow caveat, and the
  dangling-tool-call limitation.
- [x] README §3 dangling-tool-call paragraph rewritten to state what is proved
  (Pi forwards the orphan; no validation error appears in the corpus) and what is
  not (gateway tolerance — the motivating session made no further request). The
  earlier 40/38 recovery split was dropped: it came from a file-order scan that
  ignored `parentId`, so forks and compaction could inflate it.
- [x] README fork notes: §3 gained the "Wrapped rate limits" paragraph; new §5
  "Independent retry budgets" and §6 "Settings validation warnings"; the
  Configuration intro now says unusable values are reported.
- [x] OpenSpec deltas: `specs/retry-budgets/spec.md` and
  `specs/settings-validation/spec.md` added, plus a "rate limit wrapped as a
  request error" requirement in `specs/transient-error-retry/spec.md`.
- [x] OpenSpec delta: `specs/transient-error-retry/spec.md`, declared
  `# MODIFIED Capability` with a cross-reference to the sibling change that
  introduced the capability, so archiving both cannot create it twice.

## 6. Known limitation recorded, not fixed here

- [x] Pi forwards a dangling `toolCall` from an interrupted turn into the next
  request unchanged (verified through the real loader: the continuation context
  is `[user, assistant[thinking, toolCall:edit:{}], user]` with no tool result),
  and pi-ai 0.85.1 emits `tool_calls` without checking for a matching result
  (`convertMessages()` in `dist/api/openai-completions.js`). Strict
  OpenAI-compatible endpoints may reject that with a 400; such a 400 is not
  retryable (it hits the overridable request-shape `invalid_request` guard or
  matches nothing),
  so recovery stops after one attempt. Fixing the orphan belongs in Pi/pi-ai, not
  here.

## 7. Repository hygiene (needs the maintainer's decision)

- [ ] Two untracked files sit at the package root and are NOT covered by
  `.gitignore` (which lists `node_modules/ dist/ *.log .DS_Store auth.json
  models-store.json`): the 1.4 MB third-party transcript
  `2026-09-20T16-34-55-880Z_01a0bfab-….jsonl` (a verbatim session from the
  unrelated `gpot` project; scanned — no API keys, tokens, or emails) and
  `NOTE.md` (a saved 429 message naming an internal endpoint and project).
  `package.json` publishes a public homepage, so a `git add -A` would ship both.
  Delete or ignore deliberately; do not paper over it with a blanket `*.jsonl`
  rule.

## 8. Process (post-merge)

- [ ] Port this diff to `yofriadi/pi-auto-continue` and re-sync the vendored
  copy (`pnpm run update:pi-auto-continue`) so it survives the next sync from
  fork commit `0ff0216`. The sibling `classify-transient-transport-errors`
  change carries the same outstanding task; if neither is ported, the next
  re-sync reverts both.
