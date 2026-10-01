# Delta: sound-configuration

## MODIFIED Requirements

### Requirement: Defaults and normalization

The system SHALL merge user configuration over defaults: `enabled: true`, `volume: 0.4`, `quotaPatterns: ["429", "rate.?limit", "too many requests", "overloaded", "service.?unavailable", "server.?error", "internal.?error", "provider.?returned.?error"]` (transient throttling, grounded in `@earendil-works/pi-ai`'s RETRYABLE_PROVIDER_ERROR_PATTERN), `exhaustedPatterns: ["insufficient_quota", "quota exceeded", "out of budget", "billing", "available balance", "GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached"]` (terminal quota exhaustion, grounded in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), all event file lists empty (including `quota`, `quotaExhausted`, `agentFailed`, and `agentAborted`), `turns` and `elapsed` unconfigured.
The accepted `sounds.events` key set MUST include `agentFailed` and `agentAborted` alongside the existing trigger names; keys outside the set MUST continue to be ignored without error.
Bare-string file values MUST be normalized to arrays, `~` MUST be expanded to the home directory, and relative paths MUST be resolved per source: against the project root for the project settings file (parent of `.pi/`), and against `agentDir` itself for the global settings file.

#### Scenario: Bare string normalization

- **WHEN** `events.promptSubmit` is the string `"~/sounds/yes.wav"`
- **THEN** it is treated as `["<home>/sounds/yes.wav"]`

#### Scenario: Tilde expansion

- **WHEN** any configured path begins with `~/`
- **THEN** it is expanded to the current user's home directory before use

#### Scenario: Relative path in global settings

- **WHEN** `<agentDir>/settings.json` configures `"sounds/song.wav"` as a relative path
- **THEN** it is resolved to `<agentDir>/sounds/song.wav`

#### Scenario: Invalid regex in quotaPatterns

- **WHEN** a `quotaPatterns` entry is not a valid regular expression
- **THEN** that entry is ignored, remaining entries still apply, and configuration loading does not throw

#### Scenario: New settle triggers default to empty

- **WHEN** no settings file mentions `agentFailed` or `agentAborted`
- **THEN** both resolve to empty file lists

#### Scenario: New settle trigger paths are resolved

- **WHEN** a settings file lists `"agentFailed": ["death.wav"]`
- **THEN** that path is resolved against the settings source base directory and available to the `agentFailed` trigger

#### Scenario: Unknown event key ignored

- **WHEN** `sounds.events` contains a key that is not a known trigger name
- **THEN** it is ignored, the remaining keys still resolve, and configuration loading does not throw

## ADDED Requirements

### Requirement: Runtime mute input

The system SHALL treat a runtime mute as a third independent gate on playback, so that a sound plays only when `sounds.enabled` is true, the `--no-sounds` flag is not set, and the mute is off.
The mute MUST NOT be able to force playback: while `sounds.enabled` is `false` or `--no-sounds` is set, the system stays silent whatever the mute state.
Every playback path MUST consult the mute at fire time through the shared gate, including the elapsed-time timer callback and the turn-milestone handler, so that muting mid-run silences a reminder that was armed before the mute.
The mute state MUST be held at module scope rather than in the extension factory's closure, because Pi re-invokes the factory for every new session; held in the closure the mute would silently reset on `/new` and `/resume`.
Module scope makes the mute survive `session_start`, `/new`, `/resume`, and `/fork` while Pi's extension cache is intact, and the mute MUST NOT be written to any settings file.
The mute is NOT required to survive a clear of Pi's extension cache — `reload()`, or session replacement into a different working directory — and after either, playback resumes.

#### Scenario: Mute silences a configured run

- **WHEN** the mute is on, `agentSettled` lists one file, and `agent_settled` fires with outcome `settled`
- **THEN** no playback occurs

#### Scenario: Mute cannot un-silence a disabled config

- **WHEN** `sounds.enabled` is `false` and the user turns the mute off
- **THEN** playback remains suppressed

#### Scenario: Mute is applied at fire time

- **WHEN** an elapsed reminder is armed for 300 seconds and the mute is turned on at 100 seconds
- **THEN** the elapsed sound never plays

#### Scenario: Mute survives a new session

- **WHEN** the mute is on, the user runs `/new`, and the new session's `session_start` event arrives
- **THEN** the mute is still on and no sound plays for that session's events

#### Scenario: Mute does not have to survive an extension-cache clear

- **WHEN** the mute is on and the user runs `/reload`
- **THEN** playback resumes and no settings file was modified to get there

### Requirement: Sounds mute command

The system SHALL register a `sounds` slash command and an `event-sounds` alias, both handled identically, accepting `toggle`, `on`, `off`, and `status`, and treating a bare invocation with no argument as `toggle`.
The command SHALL provide argument completions for `on`, `off`, and `status`, and MUST report the resulting state to the user through the extension UI notification API when that API is available while still applying the change when it is not.
`status` MUST report the effective state and which input is responsible for it, distinguishing mute, `--no-sounds`, and `sounds.enabled: false`.
An unrecognized argument MUST print a usage line without throwing, and no handler of this command MUST throw.

#### Scenario: Bare invocation toggles

- **WHEN** the user runs `/sounds` while all sounds are active
- **THEN** the mute turns on and the resulting state is reported

#### Scenario: Explicit on and off

- **WHEN** the user runs `/sounds off` and then `/sounds on`
- **THEN** playback is muted after the first command and permitted again after the second

#### Scenario: Alias behaves identically

- **WHEN** the user runs `/event-sounds toggle`
- **THEN** the mute flips exactly as it does for `/sounds toggle`

#### Scenario: Status names the responsible input

- **WHEN** pi was launched with `--no-sounds` and the user runs `/sounds status`
- **THEN** the reported state identifies the CLI flag as the reason playback is off

#### Scenario: Unknown argument

- **WHEN** the user runs `/sounds frobnicate`
- **THEN** a usage line is reported, the mute state is unchanged, and no error propagates
