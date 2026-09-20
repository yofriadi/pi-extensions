# AGENTS.md

Welcome to **pi-auto-continue**! This file serves as the definitive reference and operational guide for AI coding agents working on this codebase.

---

## 1. Project Overview

`pi-auto-continue` is an official-grade extension for the [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`).

### Core Purpose
When AI coding agents execute complex or long-running tasks, they frequently encounter interruptions:
1. **Provider Rate Limits & Quota Exhaustion**: HTTP 429, `RESOURCE_EXHAUSTED`, transient server overloads (503/529), RPM/TPM limits, or daily/hourly quota limits.
2. **Output Token Truncation**: Messages cut off when the LLM reaches its maximum output token limit (`stopReason: "length"`).
3. **Incomplete Tool Calls**: Responses truncated mid-argument emission during tool invocation.
4. **Context Overflow & Fatal Hard Limits**: Intelligently deferring context overflow to Pi's built-in auto-compaction while immediately failing fast on non-retryable billing hard limits.

### Core Philosophy
- **Duration-Based Retry Deadline**: Instead of arbitrary retry counts, rate-limited sessions retry with exponential backoff + jitter until a configurable time deadline (default: **5 hours**, matching standard AI quota reset cycles).
- **Zero Runtime Dependencies**: Depends strictly on Node.js standard libraries and Pi's extension peer dependency.
- **Pure Native Tooling**: Uses native Node.js test runner (`node:test`) and native TypeScript execution (`--experimental-strip-types`).

---

## 2. Technology Stack & Environment

| Component | Specification |
| :--- | :--- |
| **Runtime** | Node.js (>= 22.19.0) |
| **Language** | TypeScript 5.7+ |
| **Module System** | Pure ES Modules (`"type": "module"`) |
| **TypeScript Target** | `ES2022`, `module: NodeNext`, `moduleResolution: NodeNext` |
| **Import Syntax** | Relative imports require `.ts` extension (`import ... from "./types.ts"`) |
| **Test Runner** | Node.js built-in `node:test` + `node:assert/strict` |
| **Platform Target** | `@earendil-works/pi-coding-agent` (>= 0.85.1) |

---

## 3. Essential Agent Commands

Always run verification commands before completing tasks:

```bash
# Run package unit tests and real-loader runtime regressions
npm test

# Run type-checking (no compilation output)
npm run typecheck

# From the monorepo root: run every package's tests and checks
pnpm test
pnpm run check

# Run a specific test file
node --test --experimental-strip-types tests/classifier.test.ts
node --test --experimental-strip-types tests/retry-manager.test.ts
node --test --experimental-strip-types tests/config.test.ts
node --test --experimental-strip-types tests/formatter.test.ts
node --test --experimental-strip-types tests/extension.test.ts
node --test --experimental-strip-types tests/runtime.test.ts
```

> **Note**: Pi loads source directly; there is no build script or `dist/`. Do not install external test frameworks (Jest, Vitest, Mocha) or assertion libraries. Use the native `node:test` runner.

---

## 4. Repository Structure & Module Responsibilities

```
pi-auto-continue/
├── index.ts                 # Extension package entrypoint; re-exports modules and default extension fn
├── package.json             # Package configuration, scripts, and dependencies
├── tsconfig.json            # NodeNext + allowImportingTsExtensions configuration
├── src/
│   ├── index.ts             # Main extension registration & Pi event lifecycle orchestration
│   ├── types.ts             # All TypeScript interfaces, types, and state models
│   ├── constants.ts         # Defaults and regex matchers for rate limits, billing, and context
│   ├── config.ts            # Settings loader (reads ~/.pi/agent/settings.json) & duration parser
│   ├── classifier.ts        # Interruption classification & Retry-After header/hint extractor
│   ├── retry-manager.ts     # RetryState state-machine, backoff calculation, and deadline enforcement
│   └── formatter.ts         # Human-readable formatting for ms durations, delays, and error strings
└── tests/
    ├── classifier.test.ts   # Tests for header parsing, text regexes, and error classifications
    ├── config.test.ts       # Tests for duration string parsing and configuration loading/fallbacks
    ├── extension.test.ts    # Mock API unit tests for lifecycle, cancellation, and commands
    ├── formatter.test.ts    # Tests for duration and delay string formatters
    ├── retry-manager.test.ts# Tests for backoff math, jitter, retry limits, and reset state
    └── runtime.test.ts      # Real Pi loader + AgentSession tests with a local fake provider
```

---

## 5. Architectural Lifecycle & Data Flow

```text
[Pi Coding Agent Session]
  session_start             -> loadConfig(), resetRecovery(), attach TUI input listener
  before_agent_start        -> preserve own continuation budget or reset for fresh input; add guidance
  turn_start                -> observe the assistant turn and attach ctx.signal abort listener
  before_provider_request   -> clear previous request's HTTP metadata
  after_provider_response   -> associate status/headers with this assistant request, not summaries
  message_end               -> record latest assistant + HTTP response only; never wait or send
  session_before_compact    -> leave recovery to Pi, clear stale request metadata
  session_compact[_failed]  -> resume observation or stop recovery on failure/cancellation
  agent_settled             -> classify latest unprocessed assistant after native recovery finishes
    RATE_LIMIT              -> evaluateRetry() and schedule one timer
    TOKEN_LIMIT / TOOL      -> evaluateContinuation() and schedule one timer
    CONTEXT_OVERFLOW        -> report; Pi owns compaction, no continuation
    BILLING_HARD_LIMIT      -> report; no continuation
    healthy stop            -> report recovery and reset budget
  timer due                 -> recheck generation, session/model, idle/queues, and deadline
                            -> send one tagged follow-up; start 30s submission watchdog
  own input                 -> validate transport token, strip it, preserve retry budget
  own user message_start    -> clear watchdog; continuation is acknowledged
  external input / cancel   -> invalidate timer and submission; fresh input gets a new budget
```

Pending waits use chunked timers, not sleeps inside lifecycle hooks. Automatic
follow-ups are never enqueued while Pi is busy. Manual schedules wait for idle
via settlement events and polling. Duplicate settlement of the same assistant
does not consume another attempt.

Cancellation: active-turn abort signals, aborted assistant messages, new input,
session/model changes, compaction failure, successful done-tools, and
`/auto-continue off|reset` stop extension recovery. In TUI mode, Escape/Ctrl+C
listeners also stop recovery without consuming the key; detach them on restart
and shutdown.

**Pi 0.85.1 limitation:** SDK/RPC aborts during native retry waits or extension
timer waits are not observable by extensions. `ctx.signal` exists only while
streaming; native `auto_retry_end` is an SDK event, not an extension event.
Do not claim bare SDK/RPC abort is safe. Callers must complete
`/auto-continue off` (or `reset`) before aborting Pi. Runtime tests characterize
this limitation and separately verify TUI cancellation and the command workaround.

`sendUserMessage` is fire-and-forget. If an input hook intercepts a submission
or preflight fails asynchronously, a 30s watchdog pauses recovery without
resending. A submission already past the input hook can still start late;
avoid promises of retracting every submitted prompt.

---

## 6. Detailed Component Mechanics

### 1. Interruption Classifier (`src/classifier.ts`)

Completed, tool-use, deferred, and aborted messages return `NONE` regardless
of stale HTTP metadata. Actual `length` truncation selects text/tool continuation.
For errors, precedence is cancellation -> context overflow -> hard billing/auth
or HTTP 401/402/403 -> permanent status/request/refusal -> opt-in ambiguous
quota exhaustion (`fatalFirst`, only without reset signal) -> retryable status
or rate-limit text -> transient transport text (only `stopReason: "error"`).

Classifies assistant messages into one of:
- `RATE_LIMIT`: HTTP 429, transient 408/5xx statuses, provider throttling/quota errors, and transient transport/gateway failures.
- `TOKEN_LIMIT`: Truncated outputs where `stopReason === "length"` and the final block is not a tool call.
- `INCOMPLETE_TOOL_CALL`: `length`-truncated responses ending in a `toolCall`, regardless of partially parsed arguments. A normal zero-argument call is not incomplete.
- `CONTEXT_OVERFLOW`: Error messages matching context window exhaustion (e.g. `maximum context`, `context window`).
- `BILLING_HARD_LIMIT`: Non-retryable errors (e.g., `payment required`, `insufficient funds`, `account suspended`, `invalid api key`).
- `NONE`: Regular message completion.

### 2. Header & Hint Extraction (`extractRetryAfterDelay`)
Extracts delays from:
- `Retry-After` header (integer/decimal seconds or HTTP date string).
- `retry-after-ms` header (explicit milliseconds).
- `x-ratelimit-reset`, `x-ratelimit-reset-requests`, and `x-ratelimit-reset-tokens` (delta seconds, epoch seconds/milliseconds, or compound durations such as `6m0s`).
- Inline error hints, including compound durations (`try again in 2h 36m`), ISO timestamps, and local clock times.
- **Rolling quota windows**: request/token quotas such as `Maximum 8 requests within 1 minutes`, only without an explicit reset hint. Scale the full window width by `rateLimit.windowRetryMargin` (default 1.15); set `isWindowEstimate`. Do not infer windows from unrelated latency or pricing text.
- Reject malformed/overflowing durations instead of reading numeric prefixes. Choose the latest request/token/inline reset; `retry-after-ms` takes precedence over `Retry-After` when both exist.
- Associate hints with the provider request time and subtract elapsed time at settlement. Never expire request metadata using an arbitrary 30-second TTL.

### 3. Retry Manager (`src/retry-manager.ts`)
- **Consolidated `RetryState`**: Manages a single unified retry state tracking `attempt`, rate limit attempts, elapsed duration, backoff delay, and last interruption type across both rate limit retries and token continuations.
- **Quota Reset & Backoff Formula**:
  - **Base Delay Selection**: Rate limits default to 1 minute (60,000 ms) via `rateLimit.baseDelayMs` and do not fall back to global `baseDelayMs`. Token/tool continuations use global `baseDelayMs` (default: 5 seconds).
  - **First Rate Limit Attempt**: Delay is `baseDelayMs + remainingResetDelayMs`. A rolling-window estimate already includes the window plus margin, so its delay is `min(remainingResetDelayMs, maxDelayMs)` without adding the base delay.
  - **Subsequent Attempts & Continuations**: Exponential backoff uses the rate-limit attempt count for provider errors and the shared attempt count for text/tool continuations.
- **Jitter**: Applies $\pm 15\%$ random variation ($0.85$ to $1.15$) on rate limits during exponential backoff to prevent synchronized retry stampedes.
- **Clamping**: $\text{delayMs} = \min(\text{maxDelayMs}, \max(\text{baseDelayMs}, \text{calculatedDelay}))$. Rate limits default to 10 minutes (600,000 ms) via `rateLimit.maxDelayMs`. First attempts with explicit quota reset time are not clamped to `maxDelayMs` to respect the full quota reset window.
- **Limit Enforcement**: Stops retries when attempt count exceeds numeric `maxRetries` or elapsed time exceeds duration-based `maxRetries`. Rate limits default to a 5-hour duration deadline (`"5h"`) via `rateLimit.maxRetries`, independent of global `maxRetries`. Rate limit errors can specify their own `baseDelayMs`, `maxDelayMs`, `maxRetries`, `jitter`, and `retryPrompt`.
- **Extension budget only**: Native retries do not consume extension attempts. The extension deadline begins at its first recovery evaluation, persists across its own follow-ups, and is rechecked at dispatch. Fresh user/third-party input starts a new budget.

### 4. Configuration & Retry Parser (`src/config.ts`)
- Parses human-readable durations (`"15m"`, `"30s"`, `"500ms"`, `"5h"`) and `maxRetries` values (`3`, `"5"`, `"15m"`).
- Reads the `autoContinue` block from an explicit settings path, otherwise `$PI_CODING_AGENT_DIR/settings.json`, otherwise `~/.pi/agent/settings.json`. Validates finite delays/limits, normalizes nested settings, and replaces blank recovery prompts with defaults.
- **Subagent guards**: `PI_SUBAGENT_SESSION`/`PI_SUBAGENT_ID` disables automatic recovery unless `subagent: true`. A successful `subagent_done` blocks automatic and manual recovery and cancels waits; failed done-tools do not. Fresh interactive/RPC input re-arms even while disabled; third-party extension input does not re-arm a completed subagent.
- Safe fallbacks ensure zero crash behavior on malformed JSON or missing configuration files.

---

## 7. Coding Standards & Conventions

1. **Import Paths**:
   - Always include the `.ts` extension for relative imports (e.g., `import { loadConfig } from "./config.ts";`).
   - Use `node:` protocol for Node built-in imports (e.g., `import * as fs from "node:fs";`, `import { describe, it } from "node:test";`).

2. **TypeScript & Types**:
   - Maintain strict typing. Avoid `any` whenever explicit interfaces exist in `src/types.ts`.
   - Export all reusable types from `src/types.ts` and re-export them from `index.ts`.

3. **Error Handling & Resilience**:
   - Never let an unhandled rejection escape an event listener. Wrap asynchronous handlers in `try/catch` and notify via `ctx.ui.notify` when UI is available (`ctx.hasUI`).
   - UI notifications must be polite and informative:
     - `info`: Successful recovery, standard continuations, status commands.
     - `warning`: Rate limit detected, retry waiting notice.
     - `error`: Deadline exceeded, non-retryable billing errors, critical failures.

5. **Testing Strategy**:
   - Test files live in `tests/` and end in `.test.ts`.
   - Mock the Pi API only in lifecycle unit tests. Loader/runtime regressions must use `discoverAndLoadExtensions` and a real `AgentSession` with a local fake provider; never mock the extension loader.
   - Keep tests deterministic: use `node:test` timers for waits and drain I/O with `setImmediate`, not wall-clock sleeps. Snapshot/restore subagent env vars so tests work inside supervised sessions.

---

## 8. Agent Checklist Before Submitting Code Changes

- [ ] All TypeScript types compile without errors (`npm run typecheck`).
- [ ] All package unit and runtime integration tests pass (`npm test`), including under subagent env vars.
- [ ] Any new regex patterns are covered by test cases in `tests/classifier.test.ts`.
- [ ] New configuration options have defaults declared in `src/constants.ts` and types in `src/types.ts`.
- [ ] README.md is updated if command signatures or configuration options change.
