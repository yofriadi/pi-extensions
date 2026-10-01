# Delta: sound-configuration

## MODIFIED Requirements

### Requirement: Defaults and normalization

The system SHALL merge user configuration over defaults: `enabled: true`, `volume: 0.4`, `quotaPatterns: ["429", "rate.?limit", "too many requests", "overloaded", "service.?unavailable", "server.?error", "internal.?error", "provider.?returned.?error"]` (transient throttling, grounded in `@earendil-works/pi-ai`'s RETRYABLE_PROVIDER_ERROR_PATTERN), `exhaustedPatterns: ["insufficient_quota", "quota exceeded", "out of budget", "billing", "available balance", "GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached"]` (terminal quota exhaustion, grounded in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), all event file lists empty (including `quota` and `quotaExhausted`), `turns: []`, and `elapsed: []`.
Bare-string file values MUST be normalized to arrays, `~` MUST be expanded to the home directory, and relative paths MUST be resolved per source: against the project root for the project settings file (parent of `.pi/`), and against `agentDir` itself for the global settings file.
`turns` and `elapsed` MUST each accept a single trigger block or an array of blocks; a single block normalizes to a one-element list.
Within a turn block, `every` MUST be a single positive number (periodic semantics per event-sound-triggers) and `at` MUST be a positive number or an array of positive numbers; within an elapsed block, `seconds` MUST be a positive number or an array of positive numbers and `repeat` MUST be a boolean defaulting to false.
Value arrays are deduped and sorted ascending, and non-positive or non-numeric entries are dropped.
A block with no files or no valid condition is dropped; non-object entries are dropped; a dropped block never affects its siblings; and normalization never throws.

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

#### Scenario: A single block normalizes to a one-element list

- **WHEN** `turns` is `{ every: 50, files: ["t.wav"] }` and `elapsed` is `{ seconds: 300, repeat: true, files: ["e.wav"] }`
- **THEN** the resolved `turns` is a one-element list carrying `every: 50` and the resolved files, `elapsed` likewise for `seconds: 300, repeat: true`, and loading does not throw

#### Scenario: A list of blocks keeps each block's files

- **WHEN** `turns` is `[{ at: 25, files: ["a.wav"] }, { every: 100, at: [200], files: ["b.wav"] }]`
- **THEN** the resolved `turns` is a two-element list, the first block `at`-only and the second combining `every` and `at`, each with its own resolved files

#### Scenario: Value list is deduped and sorted

- **WHEN** `turns.at` is `[100, 25, 50, 25]` (or `elapsed.seconds` is `[1000, 300, 1000]`)
- **THEN** the resolved value is the list `[25, 50, 100]` (respectively `[300, 1000]`), and configuration loading does not throw

#### Scenario: Invalid list entries are dropped

- **WHEN** `turns.at` is `[0, -5, "x", 100]`
- **THEN** the resolved value is `[100]`; the invalid entries are dropped and loading does not throw

#### Scenario: A value list with nothing valid drops the block

- **WHEN** `elapsed` is `{ seconds: [null, "soon"], files: ["e.wav"] }`
- **THEN** the block is dropped, `elapsed` resolves to an empty list, and the trigger stays silent

#### Scenario: Malformed blocks are dropped without affecting siblings

- **WHEN** `turns` is `[{ every: 5 }, { at: 7, files: ["t.wav"] }, 42]` and `elapsed` is `["nope", { seconds: 9, files: ["e.wav"] }]`
- **THEN** `turns` resolves to the one valid block and `elapsed` to the one valid block (`repeat: false` by default), and loading does not throw

#### Scenario: Defaults are empty lists

- **WHEN** no `turns` or `elapsed` is configured anywhere
- **THEN** both resolve to empty lists and the triggers stay silent

#### Scenario: A single number stays a scalar

- **WHEN** `turns.every` is `50` and `elapsed.seconds` is `300`
- **THEN** both resolve as scalars (periodic turn semantics and scalar elapsed semantics respectively), unchanged from the single-value behavior
