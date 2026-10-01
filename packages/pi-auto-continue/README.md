# pi-auto-continue

An extension for the [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) that automatically resumes and retries agent sessions interrupted by:

1. **Provider Rate Limits & Quota Exhaustion**: Provider plan/quota resets, HTTP 429 errors, `RESOURCE_EXHAUSTED`, temporary capacity overloads (503/529), requests-per-minute (RPM) / tokens-per-minute (TPM) thresholds, and transient transport & gateway failures (`upstream chain exhausted`, `upstream stream interrupted`, `Request timed out.`, `terminated`, dropped connections) reported as `stopReason: "error"`.
2. **Output Token Limits (`max_tokens`)**: Responses cut off when hitting model context output limits (`stopReason: "length"`).
3. **Incomplete Tool Calls**: Responses truncated mid-argument serialization during tool calls.
4. **Context Overflow & Fatal Limits**: Intelligently defers context window overflow to Pi's built-in auto-compaction and alerts immediately on non-retryable billing hard limits.

Requires **Pi >= 0.85.1** and **Node.js >= 22.19.0**. Pi loads the TypeScript source directly; no build step is needed.

---

> [!WARNING]
>
> ### ⚠️ AI Usage & Cost Considerations
>
> Automated session continuations and retries inevitably incur AI provider token usage and associated API costs:
>
> - **Output Token Continuations**: Resuming a truncated response or incomplete tool call submits a follow-up prompt alongside the conversation history, generating additional tokens.
> - **"Cold" Session Cache Misses**: Extended rate limit waits (such as waiting minutes or hours for quota reset windows) will exceed provider prompt cache TTLs (e.g., Anthropic's 5-minute ephemeral cache or OpenAI's prompt cache). When the retry fires, the full conversation context is re-evaluated as an uncached prompt, incurring full input token costs.

---

## Key Features

- **Flexible Retry Limits (Attempts or Duration)**: Retries until a configurable limit is reached. The limit can be specified as a number of attempts (e.g., `3`) or as a duration deadline (e.g., `"15m"`, `"5h"`). When a duration is configured, retrying stops once the total elapsed retry time reaches the deadline.
- **Informative UI Notifications**: Clear, real-time status notices displaying calculated backoff delays, elapsed time, observed provider errors, retry attempt counts, and remaining duration.
- **Header & Error Hint Parsing**: Automatically respects `Retry-After` HTTP headers and extracts inline delay hints from provider error messages (e.g., `try again in 25s`, `resets at 14:30`). The first retry attempt aligns with provider reset hints.
- **Exponential Backoff with Jitter**: Smooth backoff progression with random jitter (±15%) to prevent synchronized retry stampedes.
- **Slash Commands**: Interactive `/auto-continue` command with `status`, `on`, `off`, `reset`, and `at <HH:MM>` subcommands. The `at <HH:MM>` subcommand allows scheduling a retry at a specific local time (e.g., `/auto-continue at 14:30`).
- **Native recovery first**: Pi finishes its own retries, tool execution, and compaction before this extension considers a follow-up. Native recovery does not consume extension retry attempts.

## Recovery lifecycle and cancellation

`message_end` only records the latest assistant response and its request's HTTP
metadata. After `agent_settled`, an unrecovered error or actual `length` truncation
can schedule one follow-up. The wait runs outside the event handler, including
zero-delay waits. A successful native retry produces no extra user prompt.

Automatic dispatch requires an idle session with no queued messages, unchanged
session/model identity, and time remaining in the extension's retry budget.
Counters persist across this extension's continuations; fresh input starts an
independent budget. A normal zero-argument tool call is not an interruption.
Compaction recovery belongs to Pi; failed or cancelled compaction stops the
extension's recovery rather than scheduling another prompt.

HTTP hints belong to a request, not a 30-second cache. The first rate-limit
follow-up waits for the configured base delay plus the **remaining** explicit
reset delay, even if that exceeds `rateLimit.maxDelayMs`. Compound durations
such as `2h 36m` and `6m0s` are supported. Request/token reset headers and inline
hints are combined conservatively using the latest reset. Rolling-window
estimates are used only without an explicit reset and remain capped. Waits respect
the duration deadline and are re-checked before dispatch — but only when the
configured limit *is* a duration. With a numeric `rateLimit.maxRetries`, a
first-attempt reset hint has no deadline to clamp it, so a 7-day `Retry-After`
produces a 7-day wait (chunked and cancellable, and identical to HEAD). The tail is
unbounded: `retry-after: 999999999` is a 31.7-year wait. No such hint appears in
the corpus (the largest real value is a 27.6h window estimate, itself capped by
`maxDelayMs`), and capping it would contradict the decision above, so it is left
alone and documented instead.

Pending recovery is cancelled by new input (including another extension's input),
`/auto-continue off` or `reset`, session navigation/shutdown, model changes,
successful done-tools, observable aborts, and Pi being busy when a non-manual wait
comes due — that last one is reported as a warning rather than silently dropped. In the TUI, **Escape and Ctrl+C**
cancel recovery without consuming the key, so Pi can also stop its own work.
A matching prompt from another extension is never treated as this extension's
own submission. An internal per-submission marker is stripped by the input hook
before it reaches the model.

If a submitted continuation does not start within 30 seconds, recovery pauses
with a warning instead of silently sticking or sending duplicates. Pi's
`sendUserMessage` API is fire-and-forget: an intercepted input or asynchronous
preflight failure is not synchronously reported to this extension. A slow
submission that has already passed the input hook may still start; check Pi's
status before retrying manually.

### Pi 0.85.1 SDK/RPC cancellation limitation

**SDK `session.abort()` and RPC `abort` alone cannot reliably cancel this
extension while waiting.** During a native retry wait, `ctx.signal` is absent
and Pi's `auto_retry_end` cancellation event is not exposed to extensions.
During an extension-owned timer wait there is likewise no active agent signal.
The extension can therefore send a fallback after an SDK/RPC abort. TUI key
cancellation and aborts observed during an active turn are handled separately.

SDK/RPC callers should first submit `/auto-continue off` (or `reset` to cancel
only the current recovery), wait for that command to complete, then abort Pi:

```ts
await session.prompt("/auto-continue off", { source: "rpc" });
await session.abort();
```

These commands cancel this extension's work, not Pi's native retry loop.
Use `/auto-continue on` and fresh input when ready to resume. The real-runtime
tests explicitly characterize the limitation and verify the command workaround;
they do not claim that bare SDK/RPC abort is safe.

---

## Installation

Repository: [https://github.com/jellyhuck/pi-auto-continue](https://github.com/jellyhuck/pi-auto-continue)

### Option 1: Direct Install via Pi (Recommended)

Install directly from GitHub using Pi's package installer:

```bash
pi install git:github.com/jellyhuck/pi-auto-continue
```

### Option 2: Project-Local Installation

Install locally for a specific repository or workspace:

```bash
pi install -l git:github.com/jellyhuck/pi-auto-continue
```

### Option 3: Development / Local Symlink

Clone the repository, inspect and test the source, and symlink:

```bash
git clone https://github.com/jellyhuck/pi-auto-continue.git
cd pi-auto-continue
npm install
npm test

# Symlink to global extensions:
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-auto-continue

# Or test directly with the -e flag:
pi -e ./index.ts
```

---

## Fork notes

Fork of [`jellyhuck/pi-auto-continue`](https://github.com/jellyhuck/pi-auto-continue).

**Lineage.** Upstream changes are merged into this fork first; the
`pi-extensions` monorepo then vendors a byte-faithful copy of this fork at
`packages/pi-auto-continue` and re-syncs it with
`pnpm run update:pi-auto-continue` (the fork commit it holds is recorded in
`packages/pi-auto-continue/.synced-from`). Edits made only inside the vendored
copy are lost on the next sync.

**Changes against upstream.** This fork adds quota-window parsing, stricter
interruption classification, transient transport retries, subagent guards, and
native-aware recovery. Safety checks are always active; `rateLimit.fatalFirst`
is an additional opt-in policy for ambiguous quota-exhaustion messages.

### 1. Rolling quota windows

Providers such as z-ai state the limit *window* rather than a reset point:

```
Error: 429: {"message":"You have reached the request limit[z-ai/glm-5.3-free]:
Maximum 8 requests within 1 minutes."}
```

When no explicit reset hint is present, the fork recognizes request/token quota
windows such as `requests within 1 minutes` or `tokens per 1 hour`. It derives
the wait from the window width times `windowRetryMargin`, capped by
`rateLimit.maxDelayMs` and used directly rather than added to `baseDelayMs`.
Unrelated latency, pricing, and duration text do not count as quota windows.

### 2. `rateLimit.fatalFirst`

A quota-exhausted request can arrive as HTTP 429. With `fatalFirst: true`,
ambiguous exhaustion messages such as `insufficient_quota`, `quota_exhausted`,
`billing_error`, or `out of budget` stop the extension unless there is a parsed
reset hint or an explicit recurring quota (for example, RPM/TPM). Instructions
to "retry after topping up" are not a timed reset.

Regardless of `fatalFirst`, completed/aborted messages cannot trigger a retry.
For errors, cancellation, context overflow, hard billing/authentication failures
(including HTTP 401/402/403), invalid requests, and safety refusals take precedence
over retryable statuses. Context overflow is left to Pi; the extension never
retries a known permanent error simply because a gateway returned 429 or 5xx.

```json
{
  "autoContinue": {
    "rateLimit": {
      "fatalFirst": true,
      "windowRetryMargin": 1.15
    }
  }
}
```

### 3. Transient transport & gateway failures

Gateways and networks fail without any quota message: `upstream chain
exhausted`, `upstream stream interrupted`, `Upstream network`, `Request timed
out.`, `terminated`, `Connection error.`, `Stream ended without finish_reason`,
`Internal server error`, `An internal error occurred. Please try again later.`,
bare `"HTTP 429"`, `520/522 status code (no body)`, `under maintenance`,
`No healthy … route`, `unable to verify api key — try again shortly`,
`INFERENCE_CAP_ERROR` daily caps. Upstream has no pattern for these, so the
turn is left unclassified and the session stalls until the next user message.
The fork classifies them as `RATE_LIMIT`, so the existing `rateLimit.*` retry
path applies — backoff, delay caps, and the `rateLimit.maxRetries` deadline.
Explicit reset hints are honoured on the first attempt (`Try again in 2h 36m`
→ remaining 2h 36m plus the base delay, subject to the duration deadline).

Transient text matching runs only for `stopReason: "error"` turns, after
cancellation and permanent-error checks. Aborted messages are ignored, and
terminal text such as `account terminated` does not become a transport retry.

Interruption wording is retryable only when the component that broke is named
*before* the verb, within 40 characters and without a sentence break:
`upstream stream interrupted` and `The response was interrupted mid-stream`
retry. The component list is `stream`, `response`, `connection`, `socket`,
`transfer`, `relay`, `upstream`, `generation`. Everything else is left alone: a
bare `interrupted`, `The operation was interrupted`, `interrupted at user
request`, `This request was interrupted because the client disconnected`, and
`Ctrl+C interrupted the stream` (component after the verb) all stay
unclassified. `request interrupted` is deliberately not cancellation wording
either — gateways emit it alongside a retryable status (`429 … The request was
interrupted. Retry after 60s`), and the cancellation list outranks every status
check. The one cancellation phrasing that gives way to explicit transport
evidence is `operation interrupted`: `operation interrupted: ECONNRESET` and
`The operation was interrupted by a socket hang up` retry.

A missed retry costs one manual prompt; a wrong retry costs the whole
`rateLimit.maxRetries` deadline. At the 5h default — 60s base, ×2 backoff, 10m
cap, ±15% jitter — that is roughly 34 full-context requests before recovery
gives up (simulated against the real `RetryManager` at `DEFAULT_CONFIG`: 34
attempts over 300.0 min, stable across jittered runs). Which is why the
ambiguous wordings above are left alone.

The same reasoning guards the internal-error pattern, which exists for
provider-side 500s whose status was never observed (a 500 status is already
retryable on its own). Terminal wording outranks it: `Internal error: forbidden`
and `internal error: model requires a paid plan` are `BILLING_HARD_LIMIT`,
`InternalError.Algo.DataInspectionFailed: Input text data may contain
inappropriate content` stays unclassified, and `InternalError: request entity
too large` is `CONTEXT_OVERFLOW`, which sends nothing and defers to Pi's
compaction. Two limits are worth knowing. Permission, paywall, and entitlement
wording counts only inside an internal-error wrapper, because this list is
checked before every HTTP status branch and a bare match would silently discard
a confirmed rate limit: `upstream error: 403 Forbidden`, `Access Denied - Too
Many Requests`, `unable to verify api key — forbidden`, and `entitlement service
temporarily unavailable` all stay retryable. Money-and-account wording (`invalid
api key`, `payment required`, `account suspended`) stays global above it, since
that is never a rate limit. And a proxy body-limit 413 is indistinguishable from
context overflow at this layer: neither sends a continuation.

**Wrapped rate limits.** Gateways sometimes label a real 429 as a bad request:
`429: {"message":"Rate limited","type":"invalid_request_error","code":
"rate_limit_exceeded"}`. Upstream reads `invalid_request_error` as a permanent
request error and drops the retry, so explicit throttling language (`rate limit`,
`too many requests`, `throttl*`, `resource exhausted`, `rate limit exceeded`, per-minute/second/
day/hour limits, `RPM|TPM|RPD|TPD`) now outranks that one guard. Nothing else
moves: refusals, moderation rejections, unknown-model and credential errors stay
terminal even when the same body mentions a rate limit, an anchored permanent
status prefix (`404: …`) still wins, and the override is deliberately not keyed on
the HTTP status — a confirmed 429 carrying `invalid_request: unsupported
parameter` is still a permanent request error. Bare `quota` is excluded from the
override list for the same reason: `{"message":"Insufficient quota","type":
"invalid_request_error","code":"insufficient_quota"}` is an out-of-credit error,
and at the default `fatalFirst: false` a bare match would retry it for the whole
deadline. It stays unclassified, which is the known gap listed below.

Payload size outranks throttling wording. A body that says the prompt is longer
than the endpoint allows is `CONTEXT_OVERFLOW` even when the same body carries
`"code":"free_rate_limited"`, because re-sending the identical prompt cannot
succeed while compaction can.

**Dangling tool calls.** When a relay dies mid-tool-call, Pi keeps the partial
`toolCall` in history and forwards it to the next request unchanged — verified
through the real loader, where the continuation context is `[user,
assistant[thinking, toolCall:edit:{}], user]` with no tool result, and pi-ai
0.85.1 emits `tool_calls` without checking that a matching result follows
(`convertMessages()` in `dist/api/openai-completions.js`). An extension cannot
rewrite history, so a strict OpenAI-compatible endpoint could reject the orphan
with a 400. Such a 400 is not retryable — it hits the overridable request-shape
guard (`invalid_request`) or matches nothing — so recovery stops after one attempt
instead of looping, and says so (`Recovery stopped after N total attempt(s): the follow-up ended
in a non-retryable error …`) rather than going quiet. The one exception is a status-less body that reads as a provider 500,
e.g. `internal server error: tool_calls must be followed by tool messages`.
No `tool_calls`/`tool_result` validation error appears anywhere in the local
session corpus (4605 recorded errors in the 2026-09-23 snapshot; the total grows
with live traffic), and turns ending in an unmatched tool
call were followed by ordinary turns or by further transport errors. That scan
walked file order rather than the session tree, so treat gateway tolerance as
likely but unproven: in the session behind this change, no further request was
made at all.

### 4. Subagent session guards

When Pi runs as a supervised subagent (e.g. launched by
[pi-subagent-herdr](https://github.com/yofriadi/pi-extensions)), the parent
owns retry/settlement policy — an auto-continue loop inside the subagent
would fight it: after the subagent's done-tool ran, its provider
`ctx.shutdown()` is deferred until the session goes idle, and every
queued retry prompt resets that idle clock. Result: a session that finished
its work kept "resurrecting" on provider timeouts for over an hour until
manually aborted.

Two guards prevent this:

1. **Environment guard**: if `PI_SUBAGENT_SESSION` or `PI_SUBAGENT_ID` is
   set, the automatic retry/continuation wiring is disabled (no automatic
   prompts). `/auto-continue` stays available for
   manual use. Opt back in with `"subagent": true`.
2. **Done-tool guard**: when a done-tool (`subagent_done`) finishes
   executing, any pending retry wait is aborted and all later interruption
   handling is skipped — even if the env vars are absent. A fresh
   interactive/RPC user message re-arms the extension.

---

### 5. Independent retry budgets

Upstream keeps one attempt counter for every recovery kind, so three rate-limit
retries exhaust a global `maxRetries: 3` and every later truncation is refused with
`Maximum retries limit of 3 attempt(s) exceeded` for the rest of the retry cycle.
The refusal is announced, but nothing says *why* a fresh truncation is out of
attempts, which reads as a bug. The fork counts each kind separately:
`rateLimitAttempts` enforces `rateLimit.maxRetries`, `continuationAttempts`
enforces the global `maxRetries` for token-limit and incomplete-tool-call
continuations, and `attempt` remains the aggregate shown in summaries. Continuation
backoff uses the continuation count, so a throttled session no longer pushes
truncation recovery straight to the delay cap. `RetryCheckResult.attempt` reports
the count for its own kind, so `attempt #N of M` can never exceed `M`;
`getStatusSummary` compares the active kind's counter with that kind's limit and
shows the aggregate alongside it.

Two things are still shared, both pre-existing and unchanged here. There is one
`startTime`, so a duration deadline started by a rate-limit retry also bounds
continuations: with `maxRetries: "15m"` and `rateLimit.maxRetries: "5h"`, a
truncation 20 minutes into a throttled cycle is refused on the shared clock. And a
refusal calls `reset()`, which clears the *other* kind's counter too — a rate-limit
deadline ending a cycle gives later continuations a fresh budget.

### 6. Settings validation warnings

`loadConfig` accepts an `onWarning` callback and reports every value it cannot use —
a non-boolean `enabled`, a `backoffMultiplier` below 1, a negative or unparseable
`maxRetries`, a `baseDelayMs` above `maxDelayMs`, an unknown key such as
`rateLimit.maxRetry`, a blank prompt, an unreadable settings file — together with the
default it applied. The extension buffers these and notifies them as warnings at
`session_start` and after `/auto-continue reset`. Values fall back exactly as
before; the difference is that you are told.

## Configuration

Configure `pi-auto-continue` in your `~/.pi/agent/settings.json` under the `autoContinue` key.
If `PI_CODING_AGENT_DIR` is set, its `settings.json` is used instead. An explicitly
supplied settings path takes precedence. Unusable values fall back to defaults and
are reported: every coercion, unknown key, and unreadable settings file produces an
`[auto-continue]` warning at session start, so a setting that silently means
something else is never mistaken for an extension bug. Blank continuation prompts
use the default prompt.

```json
{
  "autoContinue": {
    "enabled": true,
    "subagent": false,
    "baseDelayMs": "5s",
    "maxDelayMs": "10m",
    "maxRetries": 3,
    "backoffMultiplier": 2,
    "rateLimit": {
      "enabled": true,
      "baseDelayMs": "1m",
      "maxDelayMs": "10m",
      "maxRetries": "5h",
      "jitter": true,
      "fatalFirst": false,
      "windowRetryMargin": 1.15,
      "retryPrompt": "The previous request was interrupted by a transient provider error or rate/quota limit. Resume from the last completed step without repeating completed work. Check existing tool results before retrying any operation."
    },
    "tokenLimit": {
      "enabled": true,
      "continuePrompt": "Continue from where you left off without repeating any text or code already provided. Do not add conversational preamble, explanations, or filler—resume output immediately at the exact point of interruption."
    },
    "incompleteToolCall": {
      "enabled": true,
      "continuePrompt": "Your previous response was truncated while emitting a tool call. Check existing tool results first; do not repeat completed operations. If the call has not run, issue it with complete arguments, otherwise continue from its result."
    }
  }
}
```

### Configuration Options

| Option                              | Type               | Default            | Description                                                                                                            |
| :---------------------------------- | :----------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `enabled`                           | `boolean`          | `true`             | Master switch to enable or disable the extension.                                                                      |
| `subagent`                          | `boolean`          | `false`            | Allow automatic retries inside subagent sessions (`PI_SUBAGENT_SESSION`/`PI_SUBAGENT_ID` set). Default keeps auto-continue inactive in subagents so the supervisor owns settlement. |
| `baseDelayMs`                       | `number \| string` | `5000` (`"5s"`)    | Global starting delay for exponential backoff (token continuations and tool calls).                                    |
| `maxDelayMs`                        | `number \| string` | `600000` (`"10m"`) | Global maximum delay cap for a single retry attempt.                                                                   |
| `maxRetries`                        | `number \| string` | `3`                | Maximum retries: either a numeric count of attempts (e.g., `3`) or a duration string deadline (e.g., `"15m"`, `"5h"`). |
| `backoffMultiplier`                 | `number`           | `2`                | Multiplier for exponential backoff calculations.                                                                       |
| `rateLimit.enabled`                 | `boolean`          | `true`             | Whether to automatically retry on rate limits and quota exhaustion.                                                    |
| `rateLimit.baseDelayMs`             | `number \| string` | `60000` (`"1m"`)   | Base delay for rate limit retries (default: 1 minute).                                                                 |
| `rateLimit.maxDelayMs`              | `number \| string` | `600000` (`"10m"`) | Cap for backoff (after jitter) and window estimates. First explicit reset hints and manual schedules may exceed it, but never the duration deadline. |
| `rateLimit.maxRetries`              | `number \| string` | `"5h"`             | Maximum retries or duration deadline for rate limits (default: 5 hours, matching provider quota reset windows).        |
| `rateLimit.jitter`                  | `boolean`          | `true`             | Adds ±15% random variation to rate limit delays to avoid synchronized thundering herds.                                |
| `rateLimit.fatalFirst`              | `boolean`          | `false`            | Stop ambiguous quota-exhaustion errors without a timed/recurring reset signal. Hard billing/authentication errors, cancellation, context overflow, and invalid requests are guarded regardless of this option. |
| `rateLimit.windowRetryMargin`       | `number`           | `1.15`             | Multiplier applied to a detected request/token quota window when no explicit reset hint is available. |
| `rateLimit.retryPrompt`             | `string`           | _(default prompt)_ | Follow-up prompt after a provider error's retry delay; it does not imply that the provider has recovered. |
| `tokenLimit.enabled`                | `boolean`          | `true`             | Whether to automatically continue responses truncated by max output tokens.                                            |
| `tokenLimit.continuePrompt`         | `string`           | _(default prompt)_ | Prompt sent to LLM to resume text/code generation seamlessly without repeating prior output.                           |
| `incompleteToolCall.enabled`        | `boolean`          | `true`             | Whether to continue a `length`-truncated response whose last content block is a tool call. Normal empty-argument calls are not retried. |
| `incompleteToolCall.continuePrompt` | `string`           | _(default prompt)_ | Prompt to inspect existing tool results before re-issuing an incomplete call or continuing from its result. |

---

## Slash Commands

| Command                     | Description                                                                         |
| :-------------------------- | :---------------------------------------------------------------------------------- |
| `/auto-continue status`     | Display current active status, retry state, elapsed time, and active configuration. |
| `/auto-continue at <HH:MM>` | Replace the current wait with one manual retry at the next occurrence of that local time. Waits for Pi to be idle without entering its queues, subject to the rate-limit deadline and counted as one rate-limit retry against `rateLimit.maxRetries`. Scheduling one is an explicit request for recovery, so it re-enables auto-continue if it was off and says so — even when the target is refused, because the flags are forced on either way; the refusal is reported separately. While the schedule waits, non-retryable and context-overflow outcomes are still reported; anything else that settles is silent by design, because the schedule is the user's own timing decision. |
| `/auto-continue on`         | Enable auto-continue in the current session; cancelled work is not resubmitted. |
| `/auto-continue off`        | Disable the extension and cancel its pending recovery. Does not abort Pi's native work. |
| `/auto-continue reset`      | Cancel the current extension recovery, reset counters, and reload settings. Fresh input re-arms recovery if enabled. |

---

## Development & Testing

Run the native test suite:

```bash
npm test
```

Type check TypeScript sources:

```bash
npm run typecheck
```

Pi loads source directly; there is no compilation/build script. The native test
suite uses deterministic timers. `tests/runtime.test.ts` loads the published
entry through `discoverAndLoadExtensions` and exercises a real `AgentSession`
with a local fake provider (no network), including native retry success and
exhaustion, cancellation, compaction, and intercepted submissions.

From the monorepo root, also run `pnpm test` and `pnpm run check`.

---

## Credits

- Inspired by [kasaiarashi/pi-auto-resume](https://github.com/kasaiarashi/pi-auto-resume), rewritten with duration deadlines, jittered backoff, unified retry state machines, and non-interfering extension message filtering.

## License

MIT
