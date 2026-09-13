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
| **Runtime** | Node.js (>= 22.0.0) |
| **Language** | TypeScript 5.7+ |
| **Module System** | Pure ES Modules (`"type": "module"`) |
| **TypeScript Target** | `ES2022`, `module: NodeNext`, `moduleResolution: NodeNext` |
| **Import Syntax** | Relative imports require `.ts` extension (`import ... from "./types.ts"`) |
| **Test Runner** | Node.js built-in `node:test` + `node:assert/strict` |
| **Platform Target** | `@earendil-works/pi-coding-agent` (>= 0.80.0) |

---

## 3. Essential Agent Commands

Always run verification commands before completing tasks:

```bash
# Run all unit tests
npm test

# Run type-checking (no compilation output)
npm run typecheck

# Run full TypeScript compilation
npm run build

# Run a specific test file
node --test --experimental-strip-types tests/classifier.test.ts
node --test --experimental-strip-types tests/retry-manager.test.ts
node --test --experimental-strip-types tests/config.test.ts
node --test --experimental-strip-types tests/formatter.test.ts
node --test --experimental-strip-types tests/extension.test.ts
```

> **Note**: Do not install external test frameworks (Jest, Vitest, Mocha) or assertion libraries. Use the native `node:test` runner.

---

## 4. Repository Structure & Module Responsibilities

```
pi-auto-continue/
├── index.ts                 # Extension package entrypoint; re-exports modules and default extension fn
├── draft.ts                 # Scratch/reference implementation file
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
    ├── extension.test.ts    # Integration tests for Pi lifecycle events, prompt injection, commands
    ├── formatter.test.ts    # Tests for duration and delay string formatters
    └── retry-manager.test.ts# Tests for backoff math, jitter, retry limits, and reset state
```

---

## 5. Architectural Lifecycle & Data Flow

```
[Pi Coding Agent Session]
         │
         ├─── session_start ────────► loadConfig(), retryManager.reset(), resetTurnState()
         │
         ├─── after_provider_response ─► cache lastHttpResponse (status & headers for 30s)
         │
         ├─── before_agent_start ───► inject Auto-Continue guidance into systemPrompt
         │
         ├─── message_end ──────────► classifyInterruption(message, lastHttpResponse)
         │                               │
         │                               ├─► RATE_LIMIT:
         │                               │     retryManager.evaluateRetry() -> sleep(delayMs) -> sendUserMessage(retryPrompt)
         │                               │
         │                               ├─► TOKEN_LIMIT (stopReason: "length"):
         │                               │     retryManager.evaluateContinuation() -> sleep(delayMs) -> sendUserMessage(continuePrompt)
         │                               │
         │                               ├─► INCOMPLETE_TOOL_CALL:
         │                               │     retryManager.evaluateContinuation() -> sleep(delayMs) -> sendUserMessage(toolPrompt)
         │                               │
         │                               ├─► CONTEXT_OVERFLOW:
         │                               │     notify user -> defer to Pi auto-compaction
         │                               │
         │                               ├─► BILLING_HARD_LIMIT:
         │                               │     notify user -> stop immediately (fail fast)
         │                               │
         │                               └─► NONE: no-op
         │
         └─── agent_settled ────────► if recovered: notify success and retryManager.reset()
```

---

## 6. Detailed Component Mechanics

### 1. Interruption Classifier (`src/classifier.ts`)

Precedence: when `rateLimit.fatalFirst` is enabled (fork addition, default false)
the classifier first rejects terminal signals that would otherwise be masked by a
retryable HTTP status code — 401/403 by status, then quota-exhaustion/billing text
that carries **no** reset signal, then context overflow. Otherwise it proceeds
exactly as upstream. Remaining order: HTTP status 429/503/529 → context overflow →
billing hard limit → rate limit → incomplete tool call → token limit.

Classifies assistant messages into one of:
- `RATE_LIMIT`: HTTP 429, 503, 529, Anthropic `overloaded_error`/`rate_limit_error`, Google Gemini `RESOURCE_EXHAUSTED`, OpenAI/Copilot quota limits.
- `TOKEN_LIMIT`: Truncated outputs where `stopReason === "length"`.
- `INCOMPLETE_TOOL_CALL`: Messages ending with a `toolCall` that has empty or missing arguments while `stopReason !== "stop"`.
- `CONTEXT_OVERFLOW`: Error messages matching context window exhaustion (e.g. `maximum context`, `context window`).
- `BILLING_HARD_LIMIT`: Non-retryable errors (e.g., `payment required`, `insufficient funds`, `account suspended`, `invalid api key`).
- `NONE`: Regular message completion.

### 2. Header & Hint Extraction (`extractRetryAfterDelay`)
Extracts delays from:
- `Retry-After` header (integer/decimal seconds or HTTP date string).
- `retry-after-ms` header (explicit milliseconds).
- `x-ratelimit-reset` / `x-ratelimit-reset-requests` (delta seconds or Unix epoch timestamp).
- Inline error text patterns (e.g., `try again in 25s`, `retry after 1.5m`, `resets at 2026-09-01T14:30:00Z`).
- **Rolling quota windows** (fork addition): `within|per|every|limit of|max(imum) of <N> <unit>`, e.g. `Maximum 8 requests within 1 minutes`. The window start is unknown, so the full width is assumed and scaled by `rateLimit.windowRetryMargin` (default 1.15); the result sets `isWindowEstimate`.

### 3. Retry Manager (`src/retry-manager.ts`)
- **Consolidated `RetryState`**: Manages a single unified retry state tracking `attempt`, rate limit attempts, elapsed duration, backoff delay, and last interruption type across both rate limit retries and token continuations.
- **Quota Reset & Backoff Formula**:
  - **Base Delay Selection**: Rate limits default to 1 minute (60,000 ms) via `rateLimit.baseDelayMs` and do not fall back to global `baseDelayMs`. Token/tool continuations use global `baseDelayMs` (default: 5 seconds).
  - **First Rate Limit Attempt**: Delay respects expected quota reset times when present: $\text{delayMs} = \text{baseDelayMs} + \text{expectedResetTimeMs}$. Exception (fork addition): when `isWindowEstimate` is set, the estimate *is* the delay (it already spans the window plus margin), so $\text{delayMs} = \min(\text{resetDelayMs}, \text{maxDelayMs})$ with no base delay added.
  - **Subsequent Attempts & Continuations**: Follows exponential backoff: $\text{rawDelay} = \text{baseDelayMs} \times (\text{backoffMultiplier})^{\text{attempt} - 1}$.
- **Jitter**: Applies $\pm 15\%$ random variation ($0.85$ to $1.15$) on rate limits during exponential backoff to prevent synchronized retry stampedes.
- **Clamping**: $\text{delayMs} = \min(\text{maxDelayMs}, \max(\text{baseDelayMs}, \text{calculatedDelay}))$. Rate limits default to 10 minutes (600,000 ms) via `rateLimit.maxDelayMs`. First attempts with explicit quota reset time are not clamped to `maxDelayMs` to respect the full quota reset window.
- **Limit Enforcement**: Stops retries when attempt count exceeds numeric `maxRetries` or elapsed time exceeds duration-based `maxRetries`. Rate limits default to a 5-hour duration deadline (`"5h"`) via `rateLimit.maxRetries`, independent of global `maxRetries`. Rate limit errors can specify their own `baseDelayMs`, `maxDelayMs`, `maxRetries`, `jitter`, and `retryPrompt`.

### 4. Configuration & Retry Parser (`src/config.ts`)
- Parses human-readable durations (`"15m"`, `"30s"`, `"500ms"`, `"5h"`) and `maxRetries` values (`3`, `"5"`, `"15m"`).
- Reads `~/.pi/agent/settings.json` from the `autoContinue` block with global retry settings (`baseDelayMs`, `maxDelayMs`, `maxRetries`, `backoffMultiplier`).
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
   - Use `MockExtensionAPI` and `MockContext` to test event flow without spinning up the full Pi daemon.
   - Keep unit tests deterministic: avoid relying on real wall-clock sleeps in unit tests when testing state transitions.

---

## 8. Agent Checklist Before Submitting Code Changes

- [ ] All TypeScript types compile without errors (`npm run typecheck`).
- [ ] All 75+ unit and integration tests pass (`npm test`).
- [ ] Any new regex patterns are covered by test cases in `tests/classifier.test.ts`.
- [ ] New configuration options have defaults declared in `src/constants.ts` and types in `src/types.ts`.
- [ ] README.md is updated if command signatures or configuration options change.
