# ADDED Capability: `retry-budgets`

## ADDED Requirements

### Requirement: Rate-limit and continuation budgets are independent

The extension SHALL count rate-limit retries and text/tool continuations
separately, so that recovering from one kind cannot exhaust the other's limit.
`RetryState.attempt` remains the aggregate used for user-facing summaries.

#### Scenario: A throttled session still continues truncated output

- **WHEN** `maxRetries` is a small count (e.g. `3`), `rateLimit.maxRetries` is a
  duration (e.g. `"90m"`), and three rate-limit retries have already been charged
- **THEN** a following `TOKEN_LIMIT` or `INCOMPLETE_TOOL_CALL` interruption is
  still continued, reported as its own attempt `#1`, `#2`, `#3`
- **AND** the continuation limit still applies to continuations: the fourth is
  refused with `Maximum retries limit of 3 attempt(s) exceeded`

#### Scenario: A continuation does not consume a numeric rate-limit budget

- **WHEN** `rateLimit.maxRetries` is a count (e.g. `2`) and a continuation has
  already been charged
- **THEN** both rate-limit retries are still available, and the third is refused
  with `Maximum retries limit of 2 attempt(s) exceeded`

#### Scenario: Continuation backoff uses the continuation count

- **WHEN** continuations are scheduled after rate-limit retries in the same cycle
- **THEN** the continuation delay is `baseDelayMs × backoffMultiplier^(continuation
  attempt − 1)` clamped to `maxDelayMs`, not driven by the aggregate counter

#### Scenario: Every counter is compared with its own limit

- **WHEN** recovery completes, stops, or is summarized
- **THEN** the per-wait notice (`attempt #N of M`), the stop message, and
  `getStatusSummary` all report the count for the recovery kind whose limit is being
  applied, so a count can never be printed above its own maximum
- **AND** the aggregate is labelled as such where it is shown: `Response completed
  after N retry/continuation attempt(s)`, `Recovery stopped after N total
  attempt(s)`, `Attempt: 3 / Max: 3 (all kinds: 6)`, and the `/auto-continue status`
  line, which lists the aggregate plus both per-kind counters

#### Scenario: The deadline stays shared

- **WHEN** a rate-limit retry starts a cycle and `maxRetries` is a duration
- **THEN** continuations are bounded by the same `startTime`, because only the
  counters were separated, not the clock
- **AND** a refusal still calls `reset()`, which clears the other kind's counter too
  — both behaviours are pre-existing and unchanged here
