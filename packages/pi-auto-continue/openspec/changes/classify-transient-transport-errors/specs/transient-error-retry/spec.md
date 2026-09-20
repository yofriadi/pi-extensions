# ADDED Capability: `transient-error-retry`

## ADDED Requirements

### Requirement: Transient transport and gateway errors are retried

The extension SHALL classify transient transport and gateway errors
reported as `stopReason: "error"` as `RATE_LIMIT` so the session
auto-continues under the configured rate-limit policy instead of stalling
until the next user message.

#### Scenario: Upstream chain exhausted

- **WHEN** an assistant turn ends with `stopReason: "error"` and error
  text matching a transient transport pattern (e.g. `Error: upstream chain
  exhausted`, `Request timed out.`, `fetch failed`, `read ECONNRESET`,
  `502 "upstream error"`, `under maintenance`, `No healthy … route`)
- **THEN** the turn is classified `RATE_LIMIT` and retried with the
  configured backoff, deadline, and retry prompt

#### Scenario: Terminal texts stay terminal

- **WHEN** the error text signals permanent termination
  (`account/access/subscription/api key … terminated`), billing hard
  limits, or a provider rejection citing policy or safety
- **THEN** the turn is NOT classified `RATE_LIMIT` — it maps to
  `BILLING_HARD_LIMIT` or stays unclassified, per the existing precedence

#### Scenario: Gateway wrappers do not override policy or safety refusals

- **WHEN** an error reports a provider rejection citing policy, safety,
  prohibited content, or illegal content
- **AND** the error also contains a transient marker such as `upstream_error`,
  a timeout, or rate-limit text, or carries a retryable HTTP status or
  `Retry-After` header
- **THEN** the classification stays `NONE` regardless of `rateLimit.fatalFirst`
- **AND** generic provider rejections and temporarily unavailable policy/safety
  services without a refusal remain eligible for transient retries

#### Scenario: Aborted turns are never retried

- **WHEN** a turn ends with `stopReason: "aborted"` (regardless of the
  error text, including transient-looking texts like `Request timed out.`)
- **THEN** the turn is not retried; the classification stays `NONE`

#### Scenario: Reset hints are honored

- **WHEN** a transient-classified error carries an inline reset hint
  (e.g. `Try again in 2h 36m`) or the response carries a `Retry-After`
  header
- **THEN** the extracted delay and expected reset time flow into the
  retry evaluation exactly as for provider rate limits
