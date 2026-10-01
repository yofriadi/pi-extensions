# @yofriadi/pi-event-sounds

Configurable sound effects for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) — like claude-code's hook sounds, but driven by Pi's lifecycle events.

Play your own sound files on: session start, prompt submit, agent start, run outcome (settled, failed, or aborted), extension questions, tool errors, provider quota/rate-limit responses, turn-count milestones (e.g. every 100 turns), and elapsed-time reminders (e.g. every 5 minutes while the agent works).
Multiple files per trigger → one is picked at random each time it fires.

Everything is best-effort: a missing file, a missing player, or a crashing player never breaks the agent loop.

## Install

```sh
pi install @yofriadi/pi-event-sounds
```

or add this repo checkout to your pi packages.
No build step — pi loads `src/index.ts` directly (strip-only TypeScript).

Requires `@earendil-works/pi-coding-agent` ≥ 0.85.1.

## Configuration

Add a `sounds` object to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global).
Project settings win when both define `sounds`; a project file *without* the key falls through to the global one.
Configuration is cached per session and refreshed on every `session_start` — edit settings, start a new session, no restart needed.

```jsonc
{
	"sounds": {
		// Master switch. --no-sounds overrides for one run; /sounds mutes at runtime.
		"enabled": true,

		// Volume hint, 0..1. Applied by backends that support it
		// (afplay natively, paplay scaled to 0..65536); others use system volume.
		"volume": 0.4,

		// Sound files per event. Each value is an array of paths
		// (a bare string also works); one is picked at random per fire.
		// Absent key or empty array = that trigger stays silent.
		"events": {
			"sessionStart": ["/Users/you/.claude/hooks/PeonReady1.wav"],   // session_start
			"promptSubmit": ["/Users/you/.claude/hooks/PeonYes3.wav"],    // input (all sources)
			"agentStart":   [],                                            // agent_start
			"agentSettled": ["/Users/you/.claude/hooks/PeonBuildingComplete1.wav"], // agent_settled
			"agentFailed":  [],                                             // run failed; falls back to the "error" files
			"agentAborted": [],                                             // run aborted; no fallback — silent when empty
			"question":    ["/Users/you/.claude/hooks/PeonWhat3.wav"],    // ui_prompt_start
			"error":       ["~/sounds/err1.wav", "~/sounds/err2.wav"],   // tool_result isError (per-turn dedupe)
			"quota":       ["~/sounds/quota.wav"],                       // transient throttling (429, rate limit, overloaded…)
			"quotaExhausted": ["~/sounds/exhaust.wav"]                    // terminal quota exhaustion (insufficient_quota, billing…)
		},

		// Turn-count milestones. One block = one trigger with its own files:
		//   "every": N          fires when turnIndex > 0 and turnIndex % N === 0 (periodic)
		//   "at": N | [N, ...]  fires exactly at the listed turn(s), once each
		// A block may combine both; a list of blocks gives each one its own sound.
		"turns": { "every": 100, "files": ["~/sounds/century.wav"] },
		// "turns": [
		// 	{ "at": 25, "files": ["~/sounds/quarter.wav"] },
		// 	{ "at": [50, 100], "files": ["~/sounds/big.wav"] }
		// ],

		// Elapsed-time reminders: fires N seconds after agent_start, repeating
		// every N seconds while the agent runs when repeat is true. "seconds"
		// accepts a list (one timer per value); a list of blocks gives each
		// mark its own sound. Cleared when the run settles or the session
		// shuts down.
		"elapsed": { "seconds": 300, "repeat": true, "files": ["~/sounds/tick.wav"] },
		// "elapsed": [
		// 	{ "seconds": 300, "repeat": true, "files": ["~/sounds/tick.wav"] },
		// 	{ "seconds": 1000, "files": ["~/sounds/gong.wav"] }
		// ],

		// Patterns matched case-insensitively against assistant error
		// messages. Each entry is a regular expression.
		// quotaPatterns → the transient `quota` trigger (these are the defaults):
		"quotaPatterns": ["429", "rate.?limit", "too many requests", "overloaded", "service.?unavailable"],

		// exhaustedPatterns → the terminal `quotaExhausted` trigger (defaults):
		"exhaustedPatterns": [
			"insufficient_quota", "quota exceeded", "out of budget", "billing",
			"available balance", "GoUsageLimitError", "FreeUsageLimitError"
		]
	}
}
```

Notes on paths:

- `~/` expands to your home directory.
- Relative paths resolve against the settings file's root: the **project root** for `.pi/settings.json`, the **agent directory** (`~/.pi/agent`) for global settings.
- claude-code's hook sounds (`~/.claude/hooks/*.wav`) are directly reusable — just point entries at them.

Invalid values never break loading: malformed parts fall back to defaults and the extension stays silent rather than erroring.
An invalid regex in `quotaPatterns` is ignored while the remaining entries still apply.

## Trigger reference

| Trigger          | Pi event                     | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionStart`   | `session_start`              | Fires after the config cache refresh, so a settings edit governs the same session-start sound                                                                                                                                                                                                                                                                                                  |
| `promptSubmit`   | `input`                      | All input sources (interactive, rpc, extension)                                                                                                                                                                                                                                                                                                                                                |
| `agentStart`     | `agent_start`                |                                                                                                                                                                                                                                                                                                                                                                                                |
| `agentSettled`   | `agent_settled`              | **Success-only**: the run's last assistant message ended with neither `error` nor `aborted` stopReason (classified from `agent_end`); failure and abort route to the rows below                                                                                                                                                                                                                |
| `agentFailed`    | `agent_settled`              | The run's last assistant message stopped with `stopReason: "error"` (retries exhausted). Falls back to the `error` list when `agentFailed` is unset or empty                                                                                                                                                                                                                                   |
| `agentAborted`   | `agent_settled`              | The run's last assistant message stopped with `stopReason: "aborted"`. No fallback — silent when unset                                                                                                                                                                                                                                                                                         |
| `question`       | `ui_prompt_start`            | **Extension UI prompts only** — e.g. pi-accounts login prompts. Built-in tool-permission dialogs never emit this event (no upstream permission event exists), so permission asks are not covered                                                                                                                                                                                               |
| `error`          | `tool_result` (`isError`)    | At most once per turn, regardless of how many tools fail                                                                                                                                                                                                                                                                                                                                       |
| `quota`          | `message_end`                | **Transient provider throttling** — assistant error text matching a `quotaPatterns` entry (default: `429`, `rate.?limit`, `too many requests`, `overloaded`, `service.?unavailable`, …). Retries within a 5-second window play once                                                                                                                                                            |
| `quotaExhausted` | `message_end`                | **Terminal quota exhaustion** — assistant error text matching an `exhaustedPatterns` entry (default: `insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, `available balance`, `GoUsageLimitError`, …). Takes precedence over `quota` when both match; shares the same 5-second dedupe window                                                                                   |
| `turns`          | `turn_start`                 | One block or a list of blocks, each with its own files. Within a block: `every: N` fires periodically (`turnIndex > 0 && turnIndex % N === 0`), `at: N` or `at: [N, ...]` fires exactly at the listed turn(s) once each — e.g. `at: [25, 50, 100]` plays at turns 25, 50, and 100 and nowhere else (not at 75 or 125); a block may combine both, and matching blocks each play their own files |
| `elapsed`        | timer armed on `agent_start` | One block or a list of blocks, each with its own files. A block fires after its `seconds` value(s) (scalar or list — a list arms one timer per value), each repeating on its own interval when that block's `repeat` is true; cleared on `agent_settled` / `session_shutdown`; timers are unref'd so they never hold the process open                                                          |

## Platform and format support

| Platform         | Player                         | Volume                          | Formats                                                                   |
| ---------------- | ------------------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| macOS            | `afplay`                       | `afplay -v` (0..1)              | `.wav`, `.mp3`, `.m4a`, `.aiff`, … (anything afplay/AVFoundation handles) |
| Linux            | `paplay` (PulseAudio)          | `--volume` (scaled to 0..65536) | `.wav`, and whatever PulseAudio's server handles                          |
| Linux (fallback) | `aplay` (ALSA)                 | system volume                   | `.wav`                                                                    |
| Windows          | PowerShell `Media.SoundPlayer` | system volume                   | `.wav` only — a documented limitation                                     |
| Any (fallback)   | terminal bell on stderr        | —                               | Only when stderr is a TTY; silent no-op in print/rpc modes                |

Backend detection probes PATH once per process and memoizes.
Playback is fire-and-forget (`execFile`, never awaited, never blocking); missing files are checked before spawning and skipped silently.

## CLI flag

```text
pi --no-sounds
```

Disables all playback for the run, regardless of configuration.

## Runtime mute (`/sounds`)

```text
/sounds              # toggle mute
/sounds on           # unmute for this session
/sounds off          # mute for this session
/sounds status       # report whether sounds are active and why
```

`/event-sounds` is an alias.

Playback is gated by three inputs, checked in order: `sounds.enabled` (settings), `--no-sounds` (CLI — overrides everything for the run), and the runtime mute.
The command can only silence; it never forces playback on when `enabled` is false or `--no-sounds` was given.

The mute lives in memory: it never touches `settings.json`, survives `/new` and `/resume` (Pi reuses the loaded extension module), and resets only when the extension is truly reloaded.

## claude-code hook mapping

If you are coming from claude-code's sound hooks, this maps the familiar events:

| claude-code hook                     | pi-event-sounds                                                         |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `SessionStart` → `PeonReady1.wav`    | `events.sessionStart`                                                   |
| `UserPromptSubmit` → `PeonYes3.wav`  | `events.promptSubmit`                                                   |
| `Notification` → `PeonWhat3.wav`     | `events.question` (extension questions only — see the table note above) |
| `Stop` → `PeonBuildingComplete1.wav` | `events.agentSettled` (success-only — failed runs play `agentFailed`)   |

```json
{
	"sounds": {
		"volume": 0.4,
		"events": {
			"sessionStart": ["~/.claude/hooks/PeonReady1.wav"],
			"promptSubmit": ["~/.claude/hooks/PeonYes3.wav"],
			"agentSettled": ["~/.claude/hooks/PeonBuildingComplete1.wav"],
			"question": ["~/.claude/hooks/PeonWhat3.wav"],
			"error": ["~/.claude/hooks/PeonNo1.wav"]
		}
	}
}
```

## Why quota detection reads error text

`after_provider_response` only ever carries success statuses (non-2xx responses are retried inside the provider SDKs and surface as assistant error messages; the Google adapter never emits the event at all).
So the quota trigger matches the assistant `errorMessage` text instead — with default patterns grounded in `@earendil-works/pi-ai`'s provider-error retry classifier, so they track what the runtime itself treats as rate-limit/quota failures.
Text matching is provider-fragile by nature; extend `quotaPatterns` for your provider's phrasing.

## License

MIT
