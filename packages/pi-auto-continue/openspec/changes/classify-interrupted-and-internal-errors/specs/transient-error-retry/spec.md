# MODIFIED Capability: `transient-error-retry`

> Builds on the sibling change `classify-transient-transport-errors`, which
> introduced this capability and is not yet archived. Archive that change first;
> both deltas declare the same capability. Its `#### Scenario: Aborted turns are
> never retried` (stopReason gate) still governs — the scenarios below only cover
> interruption and internal-error *wording* inside `stopReason: "error"` turns.

## ADDED Requirements

### Requirement: Component-named interruptions and provider-side internal errors are retried

The extension SHALL classify a `stopReason: "error"` turn as `RATE_LIMIT` when
the error text names the component that broke and reports an interruption, or
when it reports a provider-side internal error, so relay failures recover under
the configured rate-limit policy instead of stalling until the next user
message.

#### Scenario: Relay interruption mid-stream

- **WHEN** an assistant turn ends with `stopReason: "error"` and error text
  such as `upstream stream interrupted`, `The response was interrupted
  mid-stream`, or `connection interrupted by remote peer`
- **THEN** the turn is classified `RATE_LIMIT` with reason `Transient transport
  or gateway failure` and retried with the configured backoff, deadline, and
  retry prompt
- **AND** this holds when the interruption arrived on a `200` response, since a
  broken stream carries no retryable HTTP status

#### Scenario: Truncated relay text

- **WHEN** the relay truncates the message mid-phrase (`Upstream network`)
- **THEN** the turn is classified `RATE_LIMIT`

#### Scenario: Provider-side internal error without an observed status

- **WHEN** the error text reports an internal error (`Internal server error`,
  `An internal error occurred. Please try again later.`,
  `internal_server_error`, `InternalError`) and no HTTP status was observed for
  the request
- **THEN** the turn is classified `RATE_LIMIT`

#### Scenario: Cancellation-flavoured interruption is not retried

- **WHEN** the error text attributes the interruption to the user or client
  (`stream interrupted by user`, `interrupted at user request`, `This request was
  interrupted because the client disconnected`), or reports an interrupted
  operation with no transport evidence (`The operation was interrupted`)
- **THEN** the turn stays unclassified
- **AND** a component-named interruption remains retryable only when the
  component (`stream`, `response`, `connection`, `socket`, `transfer`, `relay`,
  `upstream`, `generation`) is named before the verb `interrupt`, within 40
  characters and without a sentence break
- **AND** explicit transport evidence overrides the cancellation reading
  (`operation interrupted: ECONNRESET`, `The operation was interrupted by a
  socket hang up`)

#### Scenario: Wording that matches nothing is left alone

- **WHEN** the error text carries an interruption word that no pattern claims
  (`interrupted`, `request interrupted`, `Ctrl+C interrupted the stream`, `Your
  authentication session was interrupted. Sign in again.`, `Subscription upgrade
  interrupted`, `Aborted after 1 retry attempt`)
- **THEN** the turn stays unclassified by omission, not because a cancellation
  pattern matched it

#### Scenario: Ambiguous non-cancellation wording never outranks an observed retryable status

> Cancellation wording DOES outrank an observed status, by design and pinned by
> `tests/classifier.test.ts` (`{429, "Request was cancelled by the user; fetch
> failed"}` → `NONE`): a user cancel must never be resumed. This scenario covers
> ambiguous interruption and permission wording only.

- **WHEN** the response carried a retryable HTTP status (429 or 5xx) and the
  body also contains interruption, permission, or entitlement wording — `429 …
  The request was interrupted. Retry after 60s`, `503` with `Forbidden`,
  `entitlement check failed: upstream timed out`, `upstream error: 403 Forbidden`
- **THEN** the turn is still classified `RATE_LIMIT`
- **AND** permission, paywall, and entitlement wording is terminal only inside
  an internal-error wrapper, because the billing guard outranks every status
  branch

### Requirement: Terminal wording is not laundered by generic transient patterns

Adding a generic transient pattern SHALL NOT make a permanent failure retryable.
Terminal wording keeps its existing classification even when it is wrapped in
interruption or internal-error text, and even when a gateway pairs it with a
retryable-looking status.

#### Scenario: Permission, entitlement, and paywall text stays terminal

- **WHEN** an internal-error message also carries permission, paywall, or
  entitlement wording — `Internal error: forbidden`, `Internal error: permission
  denied for this workspace`, `Internal error: request is not authorized for this
  workspace`, `Internal error: unauthenticated`, `internal error: model requires a
  paid plan`, `internal error: entitlement expired`
- **THEN** the turn is classified `BILLING_HARD_LIMIT`, never `RATE_LIMIT`
- **AND** the same wording outside that wrapper does not change the
  classification, so throttled and transport failures that mention it stay
  retryable (`upstream error: 403 Forbidden`, `Access Denied - Too Many
  Requests`, `entitlement service temporarily unavailable`, `Access denied. Try
  again later.`)
- **AND** money-and-account wording (`invalid api key`, `payment required`,
  `account suspended`, `credit card`, `insufficient funds`) stays terminal
  without any wrapper, because it is never a rate limit

#### Scenario: Input moderation stays terminal

- **WHEN** the error text reports an input-moderation rejection, e.g. `400:
  {"message":"<400> InternalError.Algo.DataInspectionFailed: Input text data
  may contain inappropriate content.","type":"data_inspection_failed"}`
- **THEN** the turn stays unclassified despite the `InternalError` prefix
- **AND** a moderation *service* outage (`content moderation service
  temporarily unavailable`) stays retryable, exactly like the pinned policy and
  safety service outages

#### Scenario: Oversized payloads defer to compaction

- **WHEN** the error text reports `request entity too large` or `request too
  large`
- **THEN** the turn is classified `CONTEXT_OVERFLOW` so Pi's compaction owns
  recovery and no continuation is sent

#### Scenario: Gateway status reuse does not become a payload verdict

- **WHEN** a gateway reports an upstream relay failure under a status it reuses
  for that purpose, e.g. `413: {"message":"Upstream request
  failed","type":"api_error","code":"upstream_error"}`
- **THEN** the turn stays classified `RATE_LIMIT`
- **AND** `413` is not treated as a permanent status, because the observed
  traffic uses it for transient relay failures

### Requirement: A rate limit wrapped as a request error is still retried

Explicit throttling language SHALL outrank the request-shape guard
(`invalid_request`, `invalid_argument`, `invalid_schema`, `unsupported
model|parameter`), because gateways reuse that wrapper `type` for real 429s. No
other permanent pattern may be overridden, and an observed HTTP status alone SHALL
NOT override it.

#### Scenario: A 429 labelled invalid_request_error

- **WHEN** the error text is `429: {"message":"Rate limited","type":
  "invalid_request_error","code":"rate_limit_exceeded"}`, with or without an
  observed `httpStatus: 429`
- **THEN** the turn is classified `RATE_LIMIT`

#### Scenario: Terminal wording keeps priority over throttling language

> Including quota exhaustion: bare `quota` is not part of the override list, so
> `{"message":"Insufficient quota","type":"invalid_request_error","code":
> "insufficient_quota"}` stays unclassified at the default `fatalFirst: false`
> instead of retrying an out-of-credit error for the whole deadline.

- **WHEN** a refusal, moderation rejection, unknown-model error, or credential
  error shares a body with rate-limit wording (`Provider rejected the request for
  safety reasons; rate limit exceeded`, `invalid_grant: rate limit exceeded`,
  `model not found: rate limit exceeded`), or an anchored permanent status prefix
  is present (`404: {"message":"Rate limited","type":"invalid_request_error"}`)
- **THEN** the turn keeps its existing classification (`NONE`)

#### Scenario: A confirmed 429 that is really a bad request stays permanent

- **WHEN** `httpStatus: 429` arrives with `invalid_request: unsupported parameter`
  and no throttling language
- **THEN** the turn stays unclassified

#### Scenario: A payload-size complaint outranks throttling wording in the same body

- **WHEN** the error text reports that the prompt or input is longer than
  the endpoint allows and also carries throttling wording — the observed case is
  `400: {"message":"This prompt is longer than the free tier allows for a single
  request. Shorten it, or add credits…","type":"invalid_request_error","code":
  "free_rate_limited"}`
- **THEN** the turn is classified `CONTEXT_OVERFLOW`, so Pi's compaction owns
  recovery and the identical prompt is never re-sent
