# Capability: sound-configuration

## Purpose

The `sounds` settings.json schema for pi-event-sounds: settings-file lookup order, defaults and path normalization, the master enable switch, best-effort handling of invalid configuration, and the `--no-sounds` runtime flag.

## Requirements

### Requirement: Settings file lookup

The system SHALL read a `sounds` object from the first settings file that defines one, considering exactly two sources in order: `<cwd>/.pi/settings.json` (project) then `<agentDir>/settings.json` (global), where `agentDir` is resolved via `getAgentDir()` from `@earendil-works/pi-coding-agent` (i.e. `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`).
A settings file that exists but does not define a `sounds` object MUST NOT short-circuit the lookup — the next source is consulted.
No other settings locations SHALL be consulted.
Missing or unreadable files MUST be skipped without error.
The resolved configuration MUST be cached once per session and refreshed on each `session_start`.

#### Scenario: Project settings override global

- **WHEN** both `.pi/settings.json` and `<agentDir>/settings.json` define a `sounds` object
- **THEN** the project file's `sounds` object wins

#### Scenario: Project file without sounds key falls through to global

- **WHEN** `.pi/settings.json` exists but defines no `sounds` object, and `<agentDir>/settings.json` defines one
- **THEN** the global file's `sounds` object is used

#### Scenario: No settings anywhere

- **WHEN** no settings file defines a `sounds` object
- **THEN** the extension registers successfully and all triggers stay silent

### Requirement: Defaults and normalization

The system SHALL merge user configuration over defaults: `enabled: true`, `volume: 0.4`, `quotaPatterns: ["429", "rate.?limit", "too many requests", "overloaded", "service.?unavailable", "server.?error", "internal.?error", "provider.?returned.?error"]` (transient throttling, grounded in `@earendil-works/pi-ai`'s RETRYABLE_PROVIDER_ERROR_PATTERN), `exhaustedPatterns: ["insufficient_quota", "quota exceeded", "out of budget", "billing", "available balance", "GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached"]` (terminal quota exhaustion, grounded in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), all event file lists empty (including `quota` and `quotaExhausted`), `turns` and `elapsed` unconfigured.
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

### Requirement: Master enable switch

The system SHALL NOT fire any trigger when `sounds.enabled` is `false`.
Handlers MUST remain registered regardless, and every handler MUST read `enabled` (and all trigger configuration) from the session-scoped cached config at fire time — the cache itself is the only thing refreshed on `session_start`, so re-enabling via settings takes effect on the next `session_start` without per-event file I/O.

#### Scenario: Disabled config

- **WHEN** `sounds.enabled` is `false` and `agent_settled` fires with `agentSettled` configured
- **THEN** no sound plays

#### Scenario: Re-enable mid-session via settings edit

- **WHEN** `sounds.enabled` is changed from `false` to `true` and a new `session_start` occurs
- **THEN** subsequent events fire their configured triggers without restarting the extension

### Requirement: --no-sounds CLI flag

The system SHALL register a boolean `--no-sounds` flag that disables all playback for the current run regardless of configuration.
The flag value MUST be captured (not re-read on every event) to avoid stale-context errors after session reload: captured once in the extension factory and re-captured at the head of the `session_start` dispatch — the first event of each session, guaranteed to run on the live `pi` after CLI flag values are applied — after which all other handlers and timer callbacks use only the captured boolean.

#### Scenario: Flag set on CLI

- **WHEN** pi is launched with `--no-sounds` and a fully configured `sounds` block
- **THEN** no sounds play for the entire run

### Requirement: Invalid configuration is best-effort

The system MUST tolerate malformed `sounds` values (non-object, wrong types, non-array files) by falling back to defaults for the invalid parts and MUST NOT throw during settings parsing.

#### Scenario: Malformed sounds key

- **WHEN** `sounds` in settings.json is the string `"yes"`
- **THEN** defaults are used, all triggers stay silent, and the extension loads without error
