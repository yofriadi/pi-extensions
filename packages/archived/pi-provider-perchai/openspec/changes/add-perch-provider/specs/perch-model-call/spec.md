# perch-model-call

## ADDED Requirements

### Requirement: Model calls use the CLI request shape

`streamSimple` SHALL `POST {appUrl}/api/perch-terminal/model-call` with
`Content-Type: application/json`, `Accept: text/event-stream`,
`Authorization: Bearer <access>`, `User-Agent: perchai-cli/<version>`, and a
body containing at least:

```
{request:{lane:"chat", messages, tools?, toolChoice?, temperature?, maxOutputTokens?},
 runId, lane:"chat", strictManual:false, preferredModelId:null,
 avoidModelIds:[], attribution, clientSurface:"cli",
 manualModelOptionId?, roostModelChoice, roostReasoning, effort:{level, orchestration:false}}
```

#### Scenario: plain chat turn

- **WHEN** pi asks for `perch/standard` with a two-message context
- **THEN** the body carries `lane:"chat"`, `clientSurface:"cli"`,
  `roostModelChoice:"standard"`, no `manualModelOptionId`, and the
  messages converted per `messages.ts`

#### Scenario: pinned model turn

- **WHEN** pi asks for a pinned Starter model
- **THEN** `manualModelOptionId` carries that model's pin and
  `roostModelChoice` stays `"standard"`

#### Scenario: payload and response hooks honored

- **WHEN** the request is sent and headers arrive
- **THEN** `options.onPayload` is called before send (and a returned
  replacement payload is used without altering auth headers) and
  `options.onResponse` is called with status and headers

### Requirement: A turn ticket is minted per request

Before the model call the provider SHALL `POST {appUrl}/api/perch-terminal/turn-ticket`
with `{surface:"cli", profile:"standard"}` and, when a ticket is returned,
send it as `x-perch-turn-ticket` and reuse the ticket's `runId` for the
model call. The same ticket and `runId` SHALL be reused across that call's
5xx retries (CLI behavior: one header set per request, retried as-is;
single-use semantics unverified).

#### Scenario: enforced rate limit

- **WHEN** minting returns HTTP 429 with `enforced:true` and
  `errorCode:"turn_rate_limited"`
- **THEN** the turn fails with the server's message and no model call is
  attempted

#### Scenario: unenforced ticket failure

- **WHEN** minting fails but `enforced` is not true
- **THEN** the model call proceeds without the ticket header

### Requirement: Perch SSE is translated to pi events

The provider SHALL parse `data:` JSON lines and map them:
`reasoning_delta`→thinking, `answer_delta`→text,
`tool_call_delta`→toolcall start/delta keyed by tool-call id,
`tool_use_end`→sealed arguments (replacing streamed arguments only if not
already emitted) then toolcall end, `stream_restart`→reset local
accumulators without duplicating content, `continuation_seam`→ignored,
`model_call_failed`→track "recovering" (in-stream retry per the CLI's
auto-router) but **fail the turn with the mapped error if the body ends
without `done{ok:true}`** — never emit an empty success, `done`→stop
reason + usage, `error` or `done{ok:false}`→mapped failure.

#### Scenario: text answer

- **WHEN** the stream yields `answer_delta`s then `done{ok:true}`
- **THEN** pi receives start/text_*/done with `stopReason:"stop"`,
  `responseModel` = requested model id, and usage from
  `{inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens}`
  with `Usage.cost` an all-zero `ModelCostRates` object

#### Scenario: tool calls

- **WHEN** the stream yields `tool_call_delta`/`tool_use_end` pairs then `done`
- **THEN** pi receives one toolcall start/delta/end per id and
  `stopReason:"toolUse"` (pi's `StopReason` value — not OpenAI's
  `tool_use`), and the final message's tool-call arguments are
  valid JSON

#### Scenario: mid-stream restart is not duplicated

- **WHEN** `stream_restart` arrives after partial text
- **THEN** subsequent deltas do not repeat the pre-restart text in the
  completed message

#### Scenario: user abort

- **WHEN** `options.signal` aborts mid-stream
- **THEN** the event stream ends with `stopReason:"aborted"` and the HTTP
  request is cancelled

### Requirement: Perch failures map to actionable errors

The provider SHALL translate failures per the error table: `401`/
`invalid_grant` → re-authenticate; `starter_model_blocked` (403,
"Upgrade to Pro") → model unavailable on Starter, suggest `perch/standard`;
`usage_limit_reached` (429) → quota exhausted, quote the server message;
`turn_rate_limited` → quote the server message, no auto-retry;
`perch_surface_required` → internal protocol mismatch (debug: log full
body); `5xx`/network → up to 2 retries with 1s/4s backoff, then terminal.

#### Scenario: quota exhausted mid-month

- **WHEN** the account's 20,000 PT allowance is spent and the server
  returns `usage_limit_reached`
- **THEN** the assistant message errors with that code's message and the
  provider does not retry

#### Scenario: temporary upstream failure

- **WHEN** the endpoint returns 503 twice then succeeds
- **THEN** the turn completes with only the retries' latency added
