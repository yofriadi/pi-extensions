# pi-auto-continue

An extension for the [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) that automatically resumes and retries agent sessions interrupted by:

1. **Provider Rate Limits & Quota Exhaustion**: Provider plan/quota resets, HTTP 429 errors, `RESOURCE_EXHAUSTED`, temporary capacity overloads (503/529), requests-per-minute (RPM) / tokens-per-minute (TPM) thresholds, and transient transport & gateway failures (`upstream chain exhausted`, `Request timed out.`, `terminated`, dropped connections) reported as `stopReason: "error"`.
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
estimates are used only without an explicit reset and remain capped. All waits
respect the duration deadline, which is checked again before dispatch.

Pending recovery is cancelled by new input (including another extension's input),
`/auto-continue off` or `reset`, session navigation/shutdown, model changes,
successful done-tools, and observable aborts. In the TUI, **Escape and Ctrl+C**
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
exhausted`, `Request timed out.`, `terminated`, `Connection error.`, `Stream
ended without finish_reason`, bare `"HTTP 429"`, `520/522 status code (no
body)`, `under maintenance`, `No healthy … route`, `unable to verify api key
— try again shortly`, `INFERENCE_CAP_ERROR` daily caps. Upstream has no
pattern for these, so the turn is left unclassified and the session stalls
until the next user message. The fork classifies them as `RATE_LIMIT`, so
the existing `rateLimit.*` retry path applies — backoff, delay caps, and the
`rateLimit.maxRetries` deadline. Explicit reset hints are honoured on the first
attempt (`Try again in 2h 36m` → remaining 2h 36m plus the base delay, subject
to the duration deadline).

Transient text matching runs only for `stopReason: "error"` turns, after
cancellation and permanent-error checks. Aborted messages are ignored, and
terminal text such as `account terminated` does not become a transport retry.

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

## Configuration

Configure `pi-auto-continue` in your `~/.pi/agent/settings.json` under the `autoContinue` key.
If `PI_CODING_AGENT_DIR` is set, its `settings.json` is used instead. An explicitly
supplied settings path takes precedence. Malformed values fall back to defaults;
blank continuation prompts use the default prompt.

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
| `/auto-continue at <HH:MM>` | Replace the current wait with one manual retry at the next occurrence of that local time. Waits for Pi to be idle without entering its queues, subject to the rate-limit deadline. |
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
