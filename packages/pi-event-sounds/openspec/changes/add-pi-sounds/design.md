# Design: add-pi-sounds

## Context

`packages/pi-event-sounds` exists as an empty placeholder.
The Pi extension API (`@earendil-works/pi-coding-agent` `ExtensionAPI`, verified against the `on(event: ...)` overloads in `dist/core/extensions/types.d.ts` and the 0.85.1 runtime) provides typed events covering all planned triggers except elapsed time: `session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_start`, `tool_result` (with `isError`), `message_end` (assistant error messages), `turn_start` (`turnIndex`), and `session_shutdown`.
**Version floor:** `ui_prompt_start` (`UIPromptStartEvent { reason: "ui_prompt", kind: "select"|"confirm"|"input"|"editor"|"custom", title? }`) was added in `@earendil-works/pi-coding-agent` **0.85.1** and does not exist in ≤ 0.84.x, so the package pins that peer range (per repo policy: upgrade the dep, never design around an outdated one).
**Quota detection caveat:** `after_provider_response` is emitted only with success statuses (2xx) on Stainless-SDK providers — 429 manifests as a thrown, retried error, and the Google adapter never emits the event at all (verified in `pi-ai@0.85.1` `dist/api/*.js`) — so quota detection uses assistant `errorMessage` text instead (D3).
The cross-platform playback pattern (`afplay` on macOS, `paplay --volume` on Linux, PowerShell on Windows, OSC/bell fallback) is proven by the third-party `pi-notify` package.
This package follows repo conventions: no build step, entry `./src/index.ts` declared in `pi.extensions`, strip-only TypeScript (no enums/namespaces/parameter properties), vitest tests under `test/`, zero runtime deps beyond Node built-ins.

## Goals / Non-Goals

**Goals:**

- Per-event sound mapping driven by a `sounds` key in settings.json (project `.pi/settings.json` first, then `~/.pi/agent/settings.json`), with multiple file paths per event and random selection per fire.
- Derived triggers without dedicated Pi events: provider quota/rate-limit (via assistant `errorMessage` text matching against patterns grounded in `@earendil-works/pi-ai`'s retry classifier), turn-count milestones (via `turn_start.turnIndex`), elapsed-time timers (via `setInterval` scoped to the agent run).
- Best-effort contract: no sound failure can ever throw out of an event handler or break the agent loop.
- Cross-platform playback with graceful degradation (desktop binary → terminal bell).

**Non-Goals:**

- Desktop notification banners/toasts (that is pi-notify's job; users can run both).
- Sound file discovery, downloading, or bundling of audio assets — users point at their own files (e.g. claude-code's `~/.claude/hooks/*.wav` files are directly reusable).
- Volume normalization or mixing; volume is a hint passed only to backends that support it.
- Per-agent or per-model sound profiles.
- Windows `.mp3` playback (PowerShell path is wav-only via `SoundPlayer`; documented limitation).

## Decisions

### D1: Module split

Four small modules, each independently testable:

- `src/config.ts` — read/merge `sounds` settings, expose `resolveConfig`.
  Two lookup sources: project `<cwd>/.pi/settings.json` first (mirroring pi's own use of project `.pi/settings.json` for `packages`), then `<agentDir>/settings.json` where `agentDir` comes from `getAgentDir()` exported by `@earendil-works/pi-coding-agent` (resolves `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; the global-source resolution matches pi-hashline-edit, pi-cc-ui, and pi-condense).
  The first file *defining a `sounds` key* wins — a project settings file without the key falls through to the global source.
- `src/player.ts` — `playSound(file, volume, backend)`: pick backend once (memoized PATH probe like pi-notify), `execFile` the player binary, swallow all errors.
  Missing file → silent no-op (checked with `accessSync` before spawn).
- `src/triggers.ts` — pure mapping logic: given resolved config + an event, decide whether to fire (turn-threshold arithmetic, elapsed-time timer setup/teardown, quota error-text matching, per-turn error dedupe, random file pick).
  Random selection injectable for tests.
- `src/index.ts` — extension factory: register `--no-sounds` flag, capture the flag value once (not re-read inside handlers; touching a captured `pi` inside event handlers risks stale-runner errors after session replacement).
  **Implementation note (verified against the 0.85.1 loader):** the factory runs *before* `applyExtensionFlagValues` copies CLI flag values into the runtime store, so a strictly-factory-time `getFlag` read would always see the default and `--no-sounds` would never take effect.
  The value is therefore captured at factory time *and re-captured at the head of every `session_start` dispatch* — the first event of each session, guaranteed to run on the live `pi` — after which all handlers and timer callbacks use only the captured boolean.
  Subscribe to events, wire triggers to player.

*Why over a single file:* the trigger logic (timers, thresholds, dedupe) is the novel part vs pi-notify and deserves unit tests without spawning processes.
*Alternative considered:* one 300-line file like pi-notify — rejected because timer lifecycle tests would need heavy mocking.

### D2: Config shape

```jsonc
{
  "sounds": {
    "enabled": true,            // master switch; --no-sounds overrides for one run
    "volume": 0.4,              // hint, 0..1 (Linux paplay only)
    "events": {
      "sessionStart":  ["/Users/d/.claude/hooks/PeonReady1.wav"],
      "promptSubmit":  ["/Users/d/.claude/hooks/PeonYes3.wav"],
      "agentStart":    [],
      "agentSettled":  ["/Users/d/.claude/hooks/PeonBuildingComplete1.wav"],
      "question":      ["/Users/d/.claude/hooks/PeonWhat3.wav"],
      "error":         ["~/sounds/err1.wav", "~/sounds/err2.wav"],
      "quota":         ["~/sounds/quota.wav"]
    },
    "turns":  { "every": 100, "files": ["~/sounds/century.wav"] },
    "elapsed": { "seconds": 300, "repeat": true, "files": ["~/sounds/tick.wav"] },
    "quotaPatterns": ["429", "rate.?limit", "too many requests", "insufficient_quota",
                      "quota exceeded", "out of budget", "usage.?limit", "billing",
                      "available balance"]
  }
}
```

- Every trigger value is an **array of absolute-or-`~` paths**; empty array (or absent key) = trigger silent.
  A bare string is accepted and normalized to a one-element array for convenience.
- `turns.every: N` fires when `turnIndex > 0 && turnIndex % N === 0`; `elapsed.seconds: M` arms a timer on `agent_start`, fires after M seconds (repeating if `repeat`), cleared on `agent_settled`/`session_shutdown`.
- `quotaPatterns` defaults to the list above (case-insensitive substring/regex matching against the assistant `errorMessage`); users may extend or replace it.
  See D3 for why HTTP status detection was abandoned.

*Why arrays-per-event:* the user explicitly asked for "multiple sounds for one event, fire randomly".
*Alternative considered:* `{"files": [...], "enabled": bool}` per event — rejected as redundant (empty array already means disabled).

### D3: Quota detection via assistant `errorMessage` text matching

`after_provider_response` was abandoned as the quota signal after runtime verification (pi-ai 0.85.1): every Stainless-SDK adapter (Anthropic, OpenAI responses/completions, Azure, Mistral) calls `onResponse` only after `retryProviderRequest()` resolves a *successful* response — non-2xx responses throw inside the SDK and are retried internally, then surface as an assistant message with `stopReason: "error"`.
The Google adapter never emits the event at all.
The event therefore only ever carries 2xx, making status-based detection dead code.

Instead, on `message_end` with `message.role === "assistant" && message.stopReason === "error"`, match `message.errorMessage` case-insensitively against `quotaPatterns`.
The default patterns are grounded in `@earendil-works/pi-ai`'s retry classifier (`@earendil-works/pi-ai` `dist/utils/retry.js`: `RETRYABLE_PROVIDER_ERROR_PATTERN` / `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`), so they track what the runtime itself treats as rate-limit/quota failures.
This works uniformly across all providers including Gemini (which emits no `after_provider_response`).
Trade-off accepted: text matching is provider-fragile, mitigated by user-configurable `quotaPatterns` and by pattern provenance from upstream.
The trigger fires on each matching message (including mid-retry attempts), deduped within a 5-second window; because pi's retry backoff is exponential, gaps eventually exceed the window and the sound re-fires on later retry rounds — accepted as a persistent-quota signal rather than suppressed.

### D4: Elapsed-time via run-scoped timers, not polling

`setInterval`/`setTimeout` armed on `agent_start`, cleared on `agent_settled` and `session_shutdown`, and `unref()`'d so they never hold the process open.
*Alternative considered:* checking elapsed time inside `turn_start` — rejected: a turn can run minutes without new events, so the sound would fire late; timers fire on time regardless of event flow.

### D5: Random selection with injectable RNG

`pick(files, rng = Math.random)` in `triggers.ts`; tests pass a seeded stub.
Avoids test flakiness without a dependency.

### D6: Playback is fire-and-forget `execFile`

Never `execSync` (would block the agent loop), never await the child.
Volume is a 0..1 hint applied where the backend supports it: macOS `afplay -v <v>` takes 0..1 natively; Linux `paplay --volume` takes 0..65536, so the hint is scaled (`Math.round(v * 65536)`) — passing the raw 0..1 value would render playback effectively silent; Windows beep and `aplay` have no volume control.
Backend detection memoized per process (PATH probing on every sound is wasteful).

### D7: Terminal bell fallback gated to interactive TTY

The last-resort backend writes `\x07` to **stderr** (not stdout) and only when stderr is a TTY.
Pi's stdout is a structured channel in print/rpc modes, so a bell on stdout would pollute piped output or the JSON-RPC stream; stderr is the conventional out-of-band channel for exactly this.
When stderr is not a TTY, the bell degrades to a silent no-op (consistent with the best-effort contract).

## Risks / Trade-offs

- [Quota text matching may misfire on provider-specific phrasing or miss novel quota errors] → patterns grounded in `@earendil-works/pi-ai`'s retry classifier; user-configurable `quotaPatterns`; documented.
- [`ui_prompt_start` covers only extension UI prompts, not built-in permission dialogs] → verified in `runner.js`: the event fires only inside `withUIPrompt()`, which wraps the extension-facing `ctx.ui` context.
  Pi's built-in tool-permission dialogs are not extension UI prompts and never emit it, so `question` does not fully reproduce claude-code's `Notification` coverage for permission asks.
  Accepted limitation (no permission event exists upstream); documented in README.
- [Timers could leak if `agent_settled` never fires (crash)] → also clear on `session_shutdown`; `unref()` prevents process hang regardless.
- [Overlapping sounds when triggers fire close together (e.g. turn milestone + settled)] → accepted: each fire spawns an independent short-lived player process; OS audio stacks mix them.
  A per-fire serialization queue is out of scope.
- [`input` event fires for extension/RPC-originated input too, not just interactive submit] → `InputEvent.source` distinguishes; default is to play for all sources (matches "prompt submitted" intuition), config can gate to `"interactive"` later if requested.
- [Windows playback only supports `.wav`] → documented in README; PowerShell beep fallback.
- [Settings read on every event would re-stat files] → config is cached once per session and refreshed only on `session_start`; every event handler reads the cached config (including `enabled`) at fire time, so a settings edit + new session flips behavior without a restart while no per-event I/O occurs.

## Migration Plan

New package, nothing to migrate.
Ship: add to pnpm workspace, `pnpm run check`, `pnpm test`.
Users opt in by adding a `sounds` block to settings.json; with no config the extension registers and stays silent.

## Open Questions

- ~~Should `question` also fire for permission prompts?~~
  Resolved (corrected after runtime verification): `ui_prompt_start` fires only for **extension-facing** UI prompts (`ctx.ui.select/confirm/input/editor/custom` wrapped by `withUIPrompt()` in the extension runner); Pi's built-in tool-permission dialogs never emit it.
  The `question` trigger therefore covers extension questions (e.g. pi-accounts login select) but not permission asks — accepted as a documented limitation since no permission event exists upstream.
- Is per-event volume needed?
  (Plan: no, single global volume hint until asked.)
