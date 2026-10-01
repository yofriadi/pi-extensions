# ADDED Capability: `recovery-status-reporting`

> New capability delta introduced by this change. It exists because recovering an
> interrupted turn makes a previously unreachable outcome reachable: the follow-up
> itself can fail with something the extension will not retry, and that path was
> silent.

## ADDED Requirements

### Requirement: Recovery reports why it stopped

When an active recovery loop ends because of something the extension decided -- a
terminal classification, the retry deadline, Pi being busy when a wait came due, an
unacknowledged submission, or a send that threw -- the extension SHALL notify the
user with the reason, and with the attempt count wherever one was charged, so a
stopped loop is never indistinguishable from a stalled one. Stops that charge
nothing report the reason alone.

Cancellations the user or Pi caused stay silent by design: session navigation,
model changes, a successful done-tool, shutdown, an aborted turn, and the
dispatch-time guards (context changed, disabled, suppressed, shutting down). Fresh
input and the TUI Escape/Ctrl+C handler are the exceptions -- each reports its own
cancellation notice -- and README lists all of them.


#### Scenario: The follow-up ends in a non-retryable error

- **WHEN** a retry or continuation was in progress (`isRetrying`, `attempt > 0`)
  and the settled assistant turn has `stopReason: "error"` that classifies as
  `NONE` — for example a `400` whose body matches the overridable request-shape
  `invalid_request` guard, such as the rejection of a dangling tool call that Pi
  forwarded from the interrupted turn
- **THEN** the extension notifies `Recovery stopped after N total attempt(s): the
  follow-up ended in a non-retryable error ("<message>"). No further
  continuation will be sent.` at `error` level
- **AND** the retry state is reset, no timer is left armed, and nothing is queued

#### Scenario: Aborted and healthy turns keep their existing reporting

- **WHEN** the settled turn was aborted by the user, or completed with
  `stopReason: "stop"`
- **THEN** the new branch does not fire: an abort stays silent (cancellation is
  the user's own action and `stopRecovery` already ran), and a healthy
  completion still reports `Response completed after N retry/continuation
  attempt(s)`

#### Scenario: Context overflow and billing limits are unaffected

- **WHEN** the settled turn classifies as `CONTEXT_OVERFLOW` or
  `BILLING_HARD_LIMIT`
- **THEN** their existing notifications fire instead, and the non-retryable
  follow-up branch does not double-report

### Requirement: An own follow-up preserves the retry budget

The extension SHALL treat its own continuation prompt as its own input, so the
attempt counter and deadline escalate across cycles instead of restarting.

#### Scenario: Consecutive rate-limit follow-ups escalate

- **WHEN** a rate-limited turn is followed by the extension's own tagged
  continuation prompt, which is itself rate-limited
- **THEN** the second wait reports `attempt #2`, not `attempt #1`, and the delay
  follows the configured backoff rather than repeating the first-attempt delay
- **AND** when the configured limit is reached the extension reports
  `Rate limit retry stopped: <reason> after N attempt(s).` and sends nothing
  further
- **AND** the transport tag never reaches the provider payload; the persisted
  user message is exactly the configured `retryPrompt`

> Rationale: a real session recorded five `.` continuation prompts ~946s apart
> (947s, 946s, 984s, 946s between prompts) where the configured schedule was 70s
> escalating to a 5m cap. That session's Pi process started at 2026-09-20T16:34:55Z,
> 27 minutes before the recovery rework was committed (`da2f0d532`,
> 2026-09-20T17:02:01Z), so it ran the pre-rework code for its whole life: that
> version cleared its own-input flag in a synchronous `finally` while
> `sendUserMessage` is fire-and-forget, so every own follow-up looked like fresh
> user input, reset the budget, and re-ran attempt #1 — which re-applies the
> deliberately uncapped first-attempt delay (`baseDelayMs` + remaining provider
> reset hint). A hint of roughly 850-920s reproduces the observed 922s waits;
> transcripts do not persist response headers, so the exact hint value is
> unknowable from the log. HEAD escalates correctly (70s -> 105s -> 157.5s ->
> 236.25s -> 300s cap under this config) and the scenario above pins it.
