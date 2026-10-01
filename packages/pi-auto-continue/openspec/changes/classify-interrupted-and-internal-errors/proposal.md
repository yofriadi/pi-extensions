# Change: classify-interrupted-and-internal-errors

## Why

A gpot session stalled on `stopReason: "error"` with
`errorMessage: "upstream stream interrupted"` (inferhub, mid-stream relay
failure while emitting an `edit` tool call). `classifyInterruption` returned
`NONE`, so `agent_settled` took the healthy-stop branch and scheduled nothing;
the user sent a manual `.` 2m44s later. The string appears 17 times across 8
sessions in `~/.pi/agent/sessions` (2026-09-01 through 2026-09-22 — the newest
occurrence landed while this change was under review), and `interrupt` had never appeared
in a transient pattern — this is a classifier gap, not a Pi regression.

Auditing every distinct `errorMessage` in the local session corpus (1341
strings, 4605 occurrences in the 2026-09-23 snapshot; the distinct-string set is
stable, the totals grow with live traffic) found three more transient texts that stalled
sessions the same way: `An internal error occurred. Please try again later.`
(10x), `Internal server error` (3x), `Upstream network` (3x, truncated by the
relay).

Three adversarial review rounds shaped the result. Round 1: widening the
transient list naively launders terminal errors into a retry loop that burns the
whole `rateLimit.maxRetries` deadline — a bare `interrupted` also matches
cancellation, auth, and billing wording, and `internal … error` matches
moderation and paywall rejections. Round 2: the round-1 guards overshot in the
other direction. Because `USER_ABORT` and `BILLING_HARD_LIMIT` are checked
before every status branch, broad wording there silently discards confirmed
retryable statuses — measured regressions included `{429, "Rate limit exceeded.
The request was interrupted. Retry after 60s"}` → `NONE`, `{503, "Forbidden"}` →
`BILLING_HARD_LIMIT`, and `content moderation service temporarily unavailable` →
`NONE` while the analogous pinned policy/safety-service outage stayed retryable.
Round 3: mutation-tested the suite (32 pattern edits, 13 survivors) and found
that most new negative tests passed by omission rather than by exercising the
pattern, that three of the lookahead's exclusion alternatives and both bounds of
the component-interrupt pattern were load-bearing but unpinned, that one
lookahead alternative was provably inert, and that four doc claims were wrong —
including the deadline cost, which is 34 attempts, not 60. All 16 mutants now
die; the six authorization-flavoured billing patterns are folded into one
wrapper-scoped pattern; `|network` is gone from the lookahead.

A fourth review round explained a second symptom in the same session: five `.`
continuation prompts ~946s apart, against a configured schedule of 70s
escalating to a 5m cap. That Pi process started at 2026-09-20T16:34:55Z, 27
minutes before the recovery rework was committed (`da2f0d532`,
2026-09-20T17:02:01Z), so it ran pre-rework code for its whole life. That version
cleared its own-input flag in a synchronous `finally` while `sendUserMessage` is
fire-and-forget, so each own follow-up looked like fresh user input, reset the
budget, and re-ran attempt #1 — which re-applies the deliberately uncapped
first-attempt delay. HEAD escalates correctly (70s -> 105s -> 157.5s -> 236.25s ->
300s cap, exact because backoff is unrounded without jitter; verified against the
maintainer's real config), so this change does not need
to address it; a runtime test now pins it.

## What Changes

- `src/constants.ts`
  - `TRANSIENT_ERROR_PATTERNS`: `network` added to the upstream alternation for
    relays that truncate the message mid-phrase; new component-named
    interruption pattern
    (`stream|response|connection|socket|transfer|relay|upstream|generation`
    named before `interrupt`, gap bounded to 40 characters without a sentence
    break); new provider-side `internal[\s_]*(?:server[\s_]*)?error` pattern.
  - `USER_ABORT_PATTERNS`: `operation … interrupted` (with a lookahead that
    yields to explicit transport evidence such as `ECONNRESET` or
    `socket hang up`), `interrupted at|on|per (the) user|client`, and
    `interrupt(ed)? by (the) user|client` are cancellations. `request …
    interrupted` is deliberately excluded: gateways emit it alongside retryable
    statuses, and this list outranks every status check.
  - `BILLING_HARD_LIMIT_PATTERNS`: exactly one new pattern, scoped to an
    internal-error wrapper, covering `forbidden`, `entitlement`,
    `unauthenticated`, `not authorized`, `access|permission denied`, and `paid
    plan|subscription|tier`. Nothing was added to the unscoped part of the list,
    so no new wording can veto an observed 429/5xx.
  - `PERMANENT_REQUEST_ERROR_PATTERNS`: input-moderation rejections
    (`data_inspection_failed`, `inappropriate content`).
  - `CONTEXT_OVERFLOW_PATTERNS`: `request entity too large` alongside
    `request too large`.
- `src/classifier.ts`: one precedence correction. Explicit throttling language
  (`EXPLICIT_RATE_LIMIT_PATTERNS`, a deliberately narrow subset of
  `RATE_LIMIT_PATTERNS`) now outranks the request-shape guard only, so a gateway
  that labels a real 429 `invalid_request_error` is retried. Refusals, moderation,
  unknown-model and credential errors keep priority, the anchored permanent-status
  prefix still wins, and an observed status alone changes nothing —
  `{429, "invalid_request: unsupported parameter"}` stays permanent.
- `src/retry-manager.ts` + `src/types.ts`: `RetryState` gains
  `continuationAttempts`. Rate-limit retries are limited by `rateLimitAttempts`
  against `rateLimit.maxRetries`; continuations by `continuationAttempts` against
  the global `maxRetries`; `attempt` stays the aggregate for summaries. Continuation
  backoff now uses the continuation count. The dead public `decrementAttempt()` is
  deleted (its only caller was a test, and it nulled `startTime`, which would
  restart the deadline).
- `src/config.ts`: `loadConfig` takes an optional `onWarning` callback and reports
  every unusable value, unknown key, unreadable settings file, and contradictory
  delay pair, naming the fallback it applied. Fallback behaviour is unchanged.
- `src/index.ts`: buffers those warnings and flushes them as `warning`
  notifications at `session_start` and after `/auto-continue reset`; plus the
  non-retryable-follow-up notification described above.
- `src/index.ts`: notification and command-handling changes (below). Recovering an interrupted turn
  makes a previously rare outcome reachable — the follow-up itself fails with
  something non-retryable (a 400 rejecting the dangling tool call Pi forwarded).
  That path reset the retry state without notifying, so the last thing the user
  saw was `Retrying request (attempt #1)…` and then silence. It now reports
  `Recovery stopped after N attempt(s): the follow-up ended in a non-retryable
  error ("<message>"). No further continuation will be sent.` The context-overflow
  notice now carries the provider's own text too, since for a free-tier prompt cap
  the remedy is in that message. Settings warnings are aggregated into one
  notification per load, kept buffered when there is no UI to deliver them to, and
  `/auto-continue status` now lists the aggregate plus both per-kind counters.
  `commandHandler` delegates to `runCommand` inside a try/catch so no rejection can
  escape the command path.
- `tests/classifier.test.ts`: positives pin `reason` as well as `type`;
  cancellation-wording negatives; terminal-wording negatives that would have
  been laundered; a precedence suite proving ambiguous interruption and
  permission wording cannot veto an observed 429/5xx; 413 relay wrapper stays
  retryable; moderation-service outage sits beside the pinned policy/safety
  analogues.
- `tests/runtime.test.ts`: three real-loader regressions. (1) The actual
  transcript shape (thinking block + dangling `toolCall` with `{}` arguments on a
  200 response), asserting exactly one tagged follow-up, tag stripping, an idle
  session, no extra timer after the healthy reply, and — as a labelled
  characterization of a Pi limitation — that the orphaned tool call is forwarded
  unchanged. (2) Budget preservation across own follow-ups: attempts escalate
  `#1 -> #2`, then the configured limit stops the loop with a reason. (3) The
  non-retryable-follow-up notification, mutation-checked (it fails without the
  `src/index.ts` branch).
- `README.md`: §3 lists the new transient texts, the interruption rule and its
  cost asymmetry, the wrapper scoping, the 413/body-limit caveat, and the
  dangling-tool-call limitation with its evidence and its limits.

## Deliberately not changed

- 413 is NOT added to the permanent status list. The corpus contains 45
  occurrences of `413: {"message":"Upstream request failed","type":"api_error",
  "code":"upstream_error"}` — this gateway reuses 413 for relay failures, so
  treating it as payload-too-large regressed all 45 to `NONE` (measured).
- No `retry|try again (later|shortly|soon)` pattern: zero corpus support (the
  one matching string is already caught by the internal-error pattern, and all 8
  corpus strings containing that wording already classify `RATE_LIMIT`). It would
  also have made `Access denied. Try again later.` retryable.
- No `server[_\s-]?error` pattern, despite `server_error` being OpenAI's
  canonical 500 `type`: that snake_case token appears 0 times in the corpus (the
  3 `server error` hits are `Internal server error`, already covered). Revisit if
  it appears.
- No blanket "4xx suppresses transient text" gate: the existing suite requires
  `400: {"message":"Provider rejected the request","code":"upstream_error"}` to
  stay retryable.
- `interrupt` was NOT added to the legacy `stream.{0,40}` / `upstream.{0,30}`
  alternations. Those use `.`, which crosses sentence breaks, so
  `Stream finished successfully. The user then interrupted.` became retryable
  (measured). The component-named pattern covers the evidenced strings.
- Bare `\bforbidden\b` / `\bentitlement\b` / `access denied` / `not authorized` /
  `unauthenticated` / `paid plan` were NOT kept as standalone billing patterns.
  None of those words appears anywhere in the corpus, and because the billing
  guard outranks every status branch they turned `{503, "Forbidden"}`, `{429,
  "Access Denied - Too Many Requests"}`, `upstream error: 403 Forbidden`, `unable
  to verify api key — forbidden`, and `entitlement service temporarily
  unavailable` terminal. All six are folded into ONE pattern scoped to the
  internal-error wrapper that motivated them.
- Known residual, accepted: `Upstream OK. The stream was interrupted by the
  operator.` retries, because `USER_ABORT_PATTERNS` attributes cancellation only
  to `user|client`. `operator` occurs 3 times in the corpus, all in Cloudflare 524
  prose ("the website operator should check…"), and all classify `RATE_LIMIT`
  before and after; a Pi-side cancel would carry `stopReason: "aborted"` and be
  filtered before any pattern runs.

## Maintainer decisions (after review 4)

Round 4 reported four findings that needed a decision rather than a patch. All
four were decided and are implemented above, except the first-attempt delay:

- Shared attempt counter (rate-limit retries exhausting the continuation budget):
  **fixed** with a separate `continuationAttempts`, accepting the change to the
  "single unified `RetryState`" design that upstream documents.
- Dead public `decrementAttempt()`: **deleted**.
- `src/config.ts` coercion traps (`enabled: 0` meaning true, `backoffMultiplier:
  0.5` becoming 2, `windowRetryMargin: 0.9` becoming 1.15, `maxRetries: -1`
  becoming 3, typo'd keys dropped): **validate and warn**, keeping every existing
  fallback so behaviour only gains messages.
- Uncapped first-attempt delay: **kept as designed**. Clamping a provider reset
  hint to `maxDelayMs` guarantees a wasted request into the same limit and burns
  the deadline faster; the defect in the motivating session was the repetition, not
  the 15.4m. The optional clarifying line in the wait notice was declined — the
  notice already prints the delay, the attempt, and the expected reset time.

Also decided: of the four remaining classifier gaps, only the wrapped-429 case is
fixed here. Still open, deliberately: the unparseable non-ISO reset timestamp in
`usage exceeds frequency limit … will reset at 2026-09-14 23:55:33 UTC+8`; silent
`NONE` (instead of a `BILLING_HARD_LIMIT` notification) for 402/403 balance text
reached through the bare status-prefix guard; and `404: {"message":"Upstream
request failed","code":"upstream_error"}`.

## Review 5: the maintainer-decision implementation

A fifth review round examined the round-5 work and found one regression I had
introduced plus eight unpinned behaviours. All are fixed and mutation-checked:

- **Regression:** `getStatusSummary` still compared the aggregate `attempt` against
  a per-kind limit, printing `Attempt: 6 / Max: 3`. It now uses the active kind's
  counter and shows the aggregate alongside it.
- **Bare `/quota/i` dropped** from the override list. It was the only entry not
  verbatim from `RATE_LIMIT_PATTERNS`, and it turned
  `{"message":"Insufficient quota","type":"invalid_request_error"}` — an
  out-of-credit error — into a retry loop for the whole deadline at the default
  `fatalFirst: false`. Zero corpus support for keeping it.
- **`request` dropped** from the `longer than` subject list. Because
  `CONTEXT_OVERFLOW_PATTERNS` is consulted before every status branch, `The request
  is longer than the gateway timeout` vetoed a confirmed 429/504 and sent a timeout
  to compaction that had nothing to compact. `prompt` and `input` are the evidenced
  subjects; the free-tier string uses `prompt`.
- **`readMaxRetries` now uses `parseMaxRetries` as its oracle.** The previous test
  accepted strings the parser would discard, so `rateLimit.maxRetries: "0.0"` was
  stored verbatim and silently meant a 5-hour deadline with no warning — the exact
  failure this change exists to remove. Fractional numbers now report the rounding.
- **Non-object sections and roots are reported** (`rateLimit: 5`, a settings file
  that parses to `5`), matching the existing `autoContinue` check.
- **`readPrompt`'s warning names the value**, as the spec requires and every other
  helper already did.
- **Wording and delivery:** the new stop message says `total attempt(s)` so it
  cannot be confused with the per-kind counts; warnings are one aggregated notice
  per load and are not discarded when `ctx.hasUI` is false; the cycle-init blocks
  clear all three counters (unreachable today, a trap now that there are three).
- **Docs corrected:** "every fallback value is unchanged" is false for eight
  garbage `maxRetries` strings that HEAD stored verbatim — the *effective limits*
  are unchanged, and the wording now says so. AGENTS.md's precedence chain gained
  the request-shape override step and the third pre-status list, its notification
  levels match the code, its checklist gained `CONFIG_SECTIONS`, and the two
  orphaned testing rules (subagent env snapshot/restore, third-party input not
  re-arming a completed subagent) were restored. The repo-root `AGENTS.md` now lists
  this package's test runner, entry point, and test directory.

Two mutants survive by construction and are documented rather than pinned: the
`!ctx.hasUI` early return (unobservable in the mock, because a reload regenerates
the same warnings) and the cycle-init counter clearing (unreachable through the
public API, since only `reset()` clears `isRetrying`).

## Review 6: the round-5 fixes and the never-reviewed modules

A sixth review round verified the round-5 fixes and then read the modules no round
had touched (`formatter.ts`, the hint parser, `parseTargetTime`, the dispatch
machinery, the subagent guards, the transport token). It found one regression from
round 5, four documentation defects in artefacts this change added, one unpinned
round-5 behaviour, and five pre-existing defects worth fixing while the context was
loaded. All ten are fixed and mutation-checked (8 mutants, 8 killed):

- **Regression:** the manual-schedule refusal (`Scheduled retry time exceeds
  maximum retry duration`) reported the *prospective* attempt, so `/auto-continue
  at` beyond the deadline claimed `after 1 attempt(s)` when nothing had been
  charged. It now reports the charged count, consistent with its sibling
  early-returns and with the `retry-budgets` requirement that a count can never be
  printed above its own maximum.
- **Docs:** README listed `quota` among the override patterns two paragraphs before
  saying bare `quota` is excluded; the spec still named `request` as a `longer
  than` subject; AGENTS.md placed the request-shape guard "between" the permanent
  checks instead of after both.
- **Unpinned:** the per-kind counters in `/auto-continue status` survived mutation.
  Now pinned by a test that charges one rate-limit retry and one continuation and
  asserts `attempt #2 total`, `rate limit #1`, `continuation #1`.
- **Watchdog:** the 30s submission watchdog fired even when Pi had already opened
  the turn (`phase === "started"`), reporting "Continuation did not start within
  30s" — false — and wiping the retry budget mid-turn, which restarts the next
  cycle at the deliberately uncapped first attempt. That is the same symptom the
  pre-rework bug had. It now checks the phase.
- **Manual schedules silenced everything:** while `/auto-continue at` waited
  (possibly for hours), `agent_settled` returned before classification, so a
  non-retryable billing failure and a context overflow produced no notification at
  all — the two reports nothing else makes. Terminal outcomes are now reported
  during a manual wait; scheduling and retry state are still untouched.
- **Silent stops:** a non-manual wait that found Pi busy at dispatch time called
  `stopRecovery()` with no notification, contradicting the
  `recovery-status-reporting` requirement. It now says why.
- **Silent re-enable:** `/auto-continue at` sets `config.enabled = true`, undoing an
  explicit `/auto-continue off` without a word. It still re-enables (scheduling a
  retry is an explicit request for recovery) but now says so.
- **Fabricated reset time:** a rolling-window estimate published
  `expectedResetTime = now + delayMs`, so a 27.6h window estimate whose wait is
  capped at `maxDelayMs` printed `Waiting 10m … Expected token reset time: +27.6h`.
  The window's start is unknown, so no instant is published now. `index.ts` falls
  back to the full `retryAfterMs` instead of subtracting elapsed time from a
  fabricated instant, so the wait is longer by the classification-to-settlement
  interval — milliseconds in practice, and still capped by `maxDelayMs`.
  `hasResetSignal` is unaffected because it tests `delayMs`.
- **Timezone ambiguity:** `formatDateTime` renders local time with no zone, so
  `Expected token reset time: 2026-09-21 04:43:12` could be read as UTC. It now
  appends the offset (`(UTC+07:00)`), pinned by a test that reconciles the rendered
  local time and the label against the original instant.

Recorded, not changed: absurd reset hints are unbounded when `rateLimit.maxRetries`
is numeric (`retry-after: 999999999` → 31.7 years; none in the corpus, and a
duration deadline absorbs them); the inline-duration regex backtracks quadratically
on ~30k spaces after a keyword (1.4s, byte-identical at HEAD, unreachable from real
bodies); `formatter.ts` has cosmetic warts on unreachable inputs (`formatDelay(
3_599_999)` → `"60m"`, `formatDuration(NaN)` → `"NaNh NaNm"`, `truncateErrorMessage`
broken for `n <= 3`); and Pi replaces a consecutive `info` notification in place, so
a continuation's wait notice can be overwritten by `Retrying request (attempt #N)…`.

`getStatusSummary` has no production caller — `/auto-continue status` builds its own
text — so the `Attempt: 6 / Max: 3` regression was visible only to consumers of the
exported API, not inside Pi.

### Breaking changes for consumers of the published package

Four, all deliberate: `RetryManager.prototype.decrementAttempt` removed; the dead
`ContinuationState` alias removed (root AGENTS.md forbids keeping compatibility
shims unasked, and nothing in the repo referenced it); `getStatusSummary`'s text
format changed; `RetryCheckResult.attempt` changed meaning from the aggregate to the
per-kind count. `loadConfig`'s new second parameter and
`RetryState.continuationAttempts` are additive. The package version is not bumped
here — that is a release decision.

## Review 7: no major issues; thirteen minor observations

A seventh round audited the round-6 changes, the state machine's invariants under
event sequences, the nine heaviest tests, and the whole diff against the specs. Its
verdict was **no major issues remain**. It proved, against real Pi rather than the
comments: one armed timer per wait; `pending.generation === generation`;
`pending.manual` XOR `dispatched`; `suppressRecovery ⇒ no pending/dispatched`; no
double or stale notification from the new manual-wait branch (three consecutive
settlements of one billing message → one notice); `lastAssistant` cannot be stale
because `agent_start` clears it and a native retry emits a fresh
`agent_start`/`turn_start` per attempt, so the **last** attempt's headers win; all
five silent early exits in `dispatchRecovery` are unreachable with an armed wait
except the busy branch round 6 closed; a cancelled compaction emits
`session_compact_failed`, so `compacting` cannot stick; and the watchdog's
`phase === "started"` case self-heals on the next turn's `message_start`. Both test
harnesses honour the `PI_SUBAGENT_*` rule, and `node --test` isolates files.

Thirteen minor observations followed. Nine were acted on (7 mutants, 7 killed):

- **A notification could kill the process.** `notify` read `ctx.hasUI` and called
  `ctx.ui.notify` unguarded, and `flushConfigWarnings` read `ctx.hasUI` directly. A
  `ctx` that outlives its session — an embedded caller disposing without
  `session_shutdown` — throws on those reads, and a throw from inside a `setTimeout`
  callback is an `uncaughtException`. Proven against real Pi after
  `session.dispose()`; identical at HEAD. Every Pi-named staleness path emits an
  event this extension handles, so the residual trigger is narrow, but the cost of
  the guard is nothing: `hasUsableUI` wraps the accessor and `notify` wraps the call,
  covering all 27 call sites. A lost message is the worst outcome now.
- **Status claimed a watchdog that could no longer fire.** After round 6 made the
  30s watchdog skip `phase === "started"`, `/auto-continue status` still printed
  "waiting for a turn to start (30s acknowledgement timeout)". It is now
  phase-aware.
- **A refused manual schedule still announced a re-enable.** `/auto-continue at`
  beyond the deadline forced `config.enabled`/`rateLimit.enabled` true, was refused,
  and then said "re-enabled it for this session" about a schedule that does not
  exist. The announcement now requires `scheduled.canRetry`. The flags stay forced —
  the user asked for recovery — and the refusal message keeps its truthful
  "after 0 attempt(s)" from round 6.
- **A finished cycle kept publishing its provider hint.** `retryManager.reset()` on
  a healthy stop left the closure's `lastExpectedTokenResetTime` set, so status
  printed the previous cycle's instant as "(passed)" indefinitely. It is cleared on
  healthy completion only: after a billing hard limit or context overflow the hint
  is still the most useful thing on screen.
- **The `recovery-status-reporting` SHALL over-promised.** It required "the reason
  and the attempt count" for every stop, but three stops charge nothing. Scoped to
  "wherever one was charged", naming the two that report a reason alone.
- **AGENTS.md's level taxonomy** implied `error` for every stop; the busy-at-dispatch
  and unacknowledged-submission stops need no user action and are `warning`. Said so.
- **README** omitted Pi-busy-at-dispatch from the cancellation list, and did not say
  that a manual schedule is counted as one rate-limit retry or that other
  classifications are silent while it waits. All three added.
- **Two weak tests strengthened.** `formatter.test.ts`'s `zone()` helper duplicated
  `utcOffsetLabel`'s own arithmetic, so the exact-string tests could not catch a sign
  or padding bug; it now derives the offset from `Intl.DateTimeFormat` with
  `timeZoneName: "longOffset"`. `retry-manager.test.ts`'s refusal test asserted
  `attempt === 0`, which cannot distinguish the charged count from the prospective
  one when both are zero; it now charges an attempt first and asserts `1` not `2`.

Recorded, not changed: the untracked transcript and `NOTE.md` remain the
maintainer's decision (tasks §7); the reviewer could not re-run the corpus audit or
the mutation runs inside its sandbox, and both were re-run here (1341 distinct
strings, 7 flips at either `fatalFirst`, and 7/7 mutants killed for this round).

## Review 8: one major regression from review 7, fixed

An eighth round confirmed the guard work (no reachable throw can escape a listener or
a timer callback; `notify` was the only escape and it predates HEAD; Pi's
`runner.js:68-83` catches listener throws and reports them as `ExtensionError`, which
`runtime.test.ts` asserts away in all 21 real-runtime tests) and enumerated
`dispatched.phase`, the four refusal kinds, and every cycle-ending path. It found one
**major** issue, introduced by review 7's own test strengthening:

- The `Intl`-derived zone helper treated bare `"GMT"` as zero offset, but
  `timeZoneName: "longOffset"` renders `"GMT+00:00"`, so the expectation disagreed
  with `utcOffsetLabel`'s `"UTC"` and two tests failed under `TZ=Etc/UTC` — which is
  what CI runs (`ubuntu-latest`, no `TZ`). Reproduced red in `Etc/UTC`,
  `Africa/Abidjan` and `Europe/London`, fixed by folding the zero forms to `UTC`,
  then verified green in eight zones. The machine's `Asia/Jakarta` (+07:00) hid it,
  and every "237/237 pass" claim recorded up to that point was zone-local. AGENTS.md's
  checklist now requires a `TZ=Etc/UTC` run.

Eleven minors followed; the substantive ones: review 7's suppression of the re-enable
notice on a refused `/auto-continue at` inverted a true statement (the flags are
forced on before scheduling, so recovery is live again and the user was no longer
told) — it is now announced whenever the command re-enabled, worded so it cannot
imply a wait is armed, and pinned by a test that then proves ordinary recovery still
works; status distinguishes the `accepted` phase from `submitted`; the `ui.notify`
call itself is guarded and tested from inside a timer callback; `/auto-continue
reset` flushing settings warnings is now tested; README and one spec quoted `N
attempt(s)` where the code says `N total attempt(s)`; and the
`recovery-status-reporting` SHALL, which claimed every non-healthy stop notifies, is
scoped to the stops the extension decides, naming the cancellations that stay silent
by design. All seven code and test fixes were mutation-checked under `TZ=Etc/UTC`
(7 mutants, 7 killed).

Recorded without changing: `pi.on("session_before_switch", stopRecovery)` and its four
siblings hand the event object to a nullary function (harmless; the
`keepAbortListener` parameter belongs to `resetRecovery`, never used as a bare
listener), and `ctx.ui.onTerminalInput` stays unguarded because a failure there is
reported by Pi as an `ExtensionError` and swallowing it would hide the loss of
Escape/Ctrl+C cancellation.

## Review 9: no major issues

A ninth round — the final one under the maintainer's three-round limit — confirmed
the review-8 timezone fix and swept for the same class of defect. It ran the suite in
**all 418 IANA zones** (`Intl.supportedValuesOf("timeZone")`): 239/239 in every one,
0 failures; plus `LANG=C`, `LC_ALL=tr_TR.UTF-8` (the dotted-I locale),
`de_DE.UTF-8`, `ja_JP.UTF-8`, a bogus `--icu-data-dir`, reverse file order,
`--test-concurrency=1`, six repeat full runs and 25 repeats of the jitter-sensitive
file — all green. `src/**` contains no `Intl` or `toLocale*` use at all; the only
non-ISO `Date.parse` is an RFC 1123 HTTP-date; no test date falls on a DST
transition in any zone. It also re-verified 51 classification claims from README and
all four spec deltas against the working-tree classifier at both `fatalFirst` values
(51/51), re-simulated README's cost claim against the real `RetryManager` (33
attempts / 300.0 min unjittered, median 34 over 400 jittered runs), enumerated all 26
`notify` call sites against every notification assertion in the tests, and cleared the
state-machine hazards around the `phase === "started"` watchdog skip.

Verdict: no major issues. Its fourteen minors were bookkeeping and wording, and the
substantive ones were fixed:

- **A notice could misstate which flag was off.** `/auto-continue at` said
  "Auto-continue was off" whenever `wasDisabled` was true, but that is also true when
  only `rateLimit.enabled` was false while auto-continue as a whole stayed on. It now
  names the flag that was actually off, pinned by a test for the rate-limit-only case.
- **The evidence table mixed occurrences with distinct strings**, which is how "6
  rows" and "7 flips" disagreed. Re-derived from the corpus: 7 distinct strings, 38
  occurrences, with the two `free_rate_limited` bodies differing only in request id.
  Table columns and corpus counts corrected everywhere.
- **A stale guard name.** README, tasks §6 and one spec still called
  `invalid_request` the *permanent* guard; this change moved it into the overridable
  request-shape list. The behaviour described was right, the name was not.
- **An imprecise claim about the window-estimate wait** (see review 8 above): it is
  longer by the classification-to-settlement interval, not unchanged.
- **The escalation chain was rounded two different ways** in three documents
  (`158s` / `157s` for the same run). Backoff is unrounded without jitter, so the
  exact chain is `70s -> 105s -> 157.5s -> 236.25s -> 300s cap`.
- **AGENTS.md's level taxonomy** did not match the code: two user-caused cancellations
  are `info`, and the re-enable notice is `warning` fitting no listed category. Both
  stated; and warnings flush after `/auto-continue reset` too, not only at
  `session_start`.
- **The dead `ContinuationState` alias** was removed rather than kept "for backward
  compatibility", per the root rule; recorded as the fourth breaking change.
- **`commandHandler`'s comment** claimed the command body touches the filesystem;
  `loadConfig` is synchronous. Corrected.

Recorded, not changed: the scoped billing guard inside a provider-500 wrapper does
not list credit/balance/trial/key-revocation wording, so invented strings like
`Internal error: you have no credits` classify `RATE_LIMIT` — corpus-unmotivated
(no such string appears in 1341), the same class as the recorded `operator`
residual, and adding patterns without evidence is exactly what AGENTS.md forbids;
every wording in the unscoped money-and-account list *is* correctly terminal inside
the wrapper. `"Continuation submitted; Pi opened the turn"` is reachable only in the
narrow window between `before_agent_start` and the user's `message_start`. Node 22
(CI) could not be exercised locally — only v26.9.0 is installed — and the residual
risk is nil: nothing in the diff uses an API newer than Node 17, and every construct
the tests rely on (`--experimental-strip-types`, `node --test`, `mock.timers` with
`apis: ["Date"]`) is already used at HEAD, where CI is green.

## Evidence reproduction

Counts come from every *assistant message record* in the session transcripts,
not from a regex sweep of the raw files — a raw sweep also matches `errorMessage`
JSON echoed inside tool output and prose, which inflated `upstream stream
interrupted` to 17. Classify each string with HEAD's and the working tree's
classifier at `{stopReason: "error", fatalFirst: true}` and diff:

```sh
python3 - <<'PY'   # distinct assistant errorMessage strings -> /tmp/errmsgs.json
import glob, json, collections
c = collections.Counter()
for f in glob.glob('/Users/<you>/.pi/agent/sessions/*/*.jsonl'):
    for line in open(f, encoding='utf-8', errors='replace'):
        if '"errorMessage"' not in line: continue
        try: d = json.loads(line)
        except Exception: continue
        if d.get('type') != 'message': continue
        m = d.get('message') or {}
        if m.get('role') == 'assistant' and isinstance(m.get('errorMessage'), str):
            c[m['errorMessage']] += 1
json.dump([[v, k] for k, v in c.items()], open('/tmp/errmsgs.json', 'w'))
print('distinct', len(c), 'total', sum(c.values()))
PY
```

Then diff `classifyInterruption` results between `git show HEAD:…/src/*.ts` and
the working tree. Result: 7 distinct strings flipped (38 occurrences in the
2026-09-23 snapshot), every one intended, identical at `fatalFirst: false`:

| occurrences | distinct | string | before → after |
| --- | --- | --- | --- |
| 19 | 1 | `upstream stream interrupted` | `NONE → RATE_LIMIT` |
| 10 | 1 | `An internal error occurred. Please try again later.` | `NONE → RATE_LIMIT` |
| 3 | 1 | `Internal server error` | `NONE → RATE_LIMIT` |
| 3 | 1 | `Upstream network` | `NONE → RATE_LIMIT` |
| 1 | 1 | `429: {"message":"Rate limited","type":"invalid_request_error",…,"code":"rate_limit_exceeded"}` | `NONE → RATE_LIMIT` |
| 1 | 2 | `400: {"message":"This prompt is longer than the free tier allows…","code":"free_rate_limited"}` — two strings differing only in the request id | `NONE → CONTEXT_OVERFLOW` |

Counts are occurrences, not strings: earlier revisions of this table mixed the two,
which is how "6 rows" and "7 flips" came to disagree.

The last row is a bug the override exposed rather than caused: that body carries
both a payload-size complaint and throttling wording, so letting throttling outrank
the request-shape guard would have re-sent the identical prompt for the whole
deadline. `CONTEXT_OVERFLOW_PATTERNS` is consulted first, so a prompt/input/request
"longer than" phrasing now defers to compaction.

## Capability

### Added
- `recovery-status-reporting`: a stopped recovery loop always says why, and an
  own follow-up preserves the retry budget.
- `retry-budgets`: rate-limit and continuation limits are counted separately.
- `settings-validation`: unusable settings are reported with the fallback applied.

### Modified
- `transient-error-retry` (introduced by the sibling change
  `classify-transient-transport-errors`, not yet archived): component-named
  interruptions and provider-side internal errors classify as `RATE_LIMIT`;
  cancellation-flavoured and terminal wording keep their existing
  classification, and neither may outrank an observed retryable status.
