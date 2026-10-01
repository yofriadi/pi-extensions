# AGENTS.md — pi-auto-continue

Pi extension that resumes a session after a provider interruption: rate limits
and transient gateway/transport failures, output-token truncation, and tool calls
truncated mid-argument.

README.md is the behavioural reference (recovery lifecycle, cancellation,
configuration, slash commands, and the fork's classifier deltas). Change
proposals live in `openspec/changes/<id>/`. This file only covers what an agent
needs to work here without breaking things.

## Commands

```bash
npm test           # node:test + --experimental-strip-types over tests/*.test.ts
npm run typecheck  # tsc --noEmit
```

From the repo root: `pnpm run check` after any code change, `pnpm test` for every
package. There is no build step and no `dist/` — Pi loads `./index.ts` (declared
in `package.json` → `pi.extensions`) directly from source.

Do not add Jest, Vitest, Mocha, or an assertion library. This package uses the
native runner and `node:assert/strict`.

## Layout

| Path | Responsibility |
| --- | --- |
| `index.ts` | Package entry; re-exports `src/` and the default extension factory |
| `src/index.ts` | Event lifecycle, recovery scheduling, `/auto-continue` command |
| `src/classifier.ts` | Interruption classification; Retry-After and reset-hint extraction |
| `src/constants.ts` | Defaults and every regex list the classifier consults |
| `src/retry-manager.ts` | `RetryState`, backoff, limit and deadline enforcement |
| `src/config.ts` | settings.json loader, duration/maxRetries parsers, validation warnings |
| `src/formatter.ts` | Duration, delay, and error-string formatting for notifications |
| `src/types.ts` | Shared interfaces, re-exported from `index.ts` |
| `tests/*.test.ts` | One file per module, plus `runtime.test.ts` (real loader + AgentSession) |

## Rules that are easy to get wrong

- Relative imports carry the `.ts` extension; Node builtins use `node:`.
  Strip-only TypeScript: no `enum`, `namespace`, or parameter properties.
- Classification precedence in `src/classifier.ts` is deliberate and pinned by
  tests: cancellation → context overflow → billing/401-403 → permanent status →
  permanent request text → opt-in ambiguous quota (`fatalFirst`) → retryable
  status or rate-limit text → transient transport text (only when
  `stopReason: "error"`). After both permanent checks sits the request-shape guard,
  which explicit throttling language may override and nothing else may. Three lists
  are consulted before every HTTP status branch — cancellation, context overflow,
  and billing — so a broad pattern in any of them silently discards a confirmed
  429/5xx. Keep new patterns narrow, and scope a terminal-wording guard to the
  wrapper that motivated it.
- Every new or changed regex needs a test that fails without it. A negative test
  whose string matches nothing else pins nothing: prefer inputs where the pattern
  is the only thing standing between the message and a retry, and mutation-check
  pattern edits (delete the pattern, confirm a test fails).
- Evidence before patterns. The corpus is every `errorMessage` in assistant message
  records under `~/.pi/agent/sessions/*/*.jsonl`. Classify HEAD against the working
  tree over all of it and inspect every flip before keeping a change; the recipe is
  in `openspec/changes/classify-interrupted-and-internal-errors/proposal.md`.
- `RetryState` keeps three counters: `rateLimitAttempts` and `continuationAttempts`
  enforce their own limits, `attempt` is the aggregate used in summaries. Do not
  merge them — a throttled session would otherwise exhaust the continuation budget.
- Never block a lifecycle hook. Waits are chunked timers, rechecked at dispatch
  (generation, session/model, idle and pending queues, deadline). Never enqueue a
  follow-up while Pi is busy.
- No unhandled rejection may escape a listener: wrap async handlers in try/catch
  (`commandHandler` delegates to `runCommand` inside one) and report through
  `ctx.ui.notify` when `ctx.hasUI`. Levels as the code actually uses them: `info`
  for successful recovery, status output, context overflow, and continuation waits;
  `warning` for a detected rate limit, a rate-limit wait, a settings problem, a
  re-enable the user should know about, or a stop that needs no action from them (Pi
  busy at dispatch, an unacknowledged submission); `info` also carries the two
  cancellations the user caused themselves (fresh input, TUI Escape/Ctrl+C);
  `error` for a deadline, a non-retryable failure, or a stop the user must act on.
  A recovery loop that ends must say why. Notifications are best-effort: `notify`
  guards both the `ctx.hasUI` accessor and `ctx.ui.notify`, because a disposed
  context throws and a throw from a timer callback is an uncaughtException.
- `loadConfig` reports unusable settings through its `onWarning` callback;
  `src/index.ts` buffers them and flushes at `session_start` and after
  `/auto-continue reset`. Keep that path: a
  silently coerced value is indistinguishable from an extension bug.

## Platform limitations (verified — do not "fix" blindly)

Full detail in README → "Recovery lifecycle and cancellation".

- Pi 0.85.1 gives extensions no abort event during native retry waits or our own
  timer waits; `ctx.signal` exists only while streaming. TUI Escape/Ctrl+C listeners
  cover interactive cancels (detach them on restart and shutdown); SDK/RPC callers
  must run `/auto-continue off|reset` before aborting. Do not claim a bare SDK/RPC
  abort is safe.
- `sendUserMessage` is fire-and-forget. If an input hook intercepts a submission or
  preflight fails asynchronously, a 30s watchdog pauses recovery without resending;
  a submission already past the input hook can still start late.
- Pi forwards a dangling `toolCall` from an interrupted turn into the next request
  unchanged, and pi-ai's `convertMessages()` emits `tool_calls` without checking
  that a matching result follows. An extension cannot rewrite history; a strict
  endpoint may reject the continuation with a 400, which classifies as
  non-retryable and is reported to the user.
- Native retries do not consume extension attempts, and native `auto_retry_end` is
  an SDK event, not an extension event.
- Tests run inside supervised sessions: snapshot and restore `PI_SUBAGENT_SESSION`
  and `PI_SUBAGENT_ID` (see `tests/extension.test.ts`), or the subagent guards
  disable recovery and the tests pass for the wrong reason.
- Third-party extension input does not re-arm recovery after a successful
  `subagent_done`; only fresh `interactive` or `rpc` input does.
- Pi renders consecutive `info` notifications in place: a second one replaces the
  first when nothing was drawn between them (`interactive-mode.js` → `showStatus`).
  Rate-limit waits are `warning` and always append; continuation waits are `info`
  and can be replaced by the `Retrying request (attempt #N)…` notice.
- The first rate-limit attempt honours a provider reset hint uncapped
  (`baseDelayMs` + remaining reset delay) by design; later attempts back off and are
  capped by `rateLimit.maxDelayMs`.

## Vendoring

Synced from `yofriadi/pi-auto-continue` (fork commit recorded in `.synced-from`).
`pnpm run update:pi-auto-continue` from the repo root overwrites local edits, so
port changes to the fork before re-syncing.

## Before submitting

- [ ] `npm test` and `npm run typecheck` pass; `pnpm run check` from the root.
      Run the suite under `TZ=Etc/UTC` too — CI is `ubuntu-latest` with no `TZ` set,
      so a zone-dependent expectation passes locally and fails there.
- [ ] New regexes are covered by tests that fail without them.
- [ ] New config options have a default in `src/constants.ts`, a type in
      `src/types.ts`, a loader branch with a warning in `src/config.ts`, a key in
      `CONFIG_SECTIONS` (otherwise every user gets an `unknown setting` warning),
      and a row in README.md.
- [ ] Behaviour changes have an `openspec/changes/<id>/` delta.
