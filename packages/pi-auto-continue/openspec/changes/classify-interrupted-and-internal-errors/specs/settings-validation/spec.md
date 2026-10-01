# ADDED Capability: `settings-validation`

## ADDED Requirements

### Requirement: Unusable settings are reported, not silently coerced

`loadConfig` SHALL accept an optional `onWarning` callback and report every
setting value it cannot use, naming the setting, the offending value, and the
default that was applied. Fallback behaviour is unchanged: the extension still
loads and runs with defaults rather than crashing.

#### Scenario: A value of the wrong type is reported with its fallback

- **WHEN** a setting is present but unusable — `enabled: 0`, `jitter: "yes"`,
  `fatalFirst: 1`, `backoffMultiplier: 0.5`, `windowRetryMargin: 0.9`,
  `maxRetries: -1`, `maxRetries: "abc"`, `baseDelayMs: "soon"`, `maxDelayMs: -5`,
  or a blank `retryPrompt`/`continuePrompt`
- **THEN** the documented default is applied and one warning names the setting,
  the value, and the fallback
- **AND** a valid configuration produces no warnings at all

#### Scenario: A typo'd key is reported instead of ignored

- **WHEN** `autoContinue`, `rateLimit`, `tokenLimit`, or `incompleteToolCall`
  contains a key that is not part of the schema (e.g. `rateLimit.maxRetry`)
- **THEN** a warning reports `unknown autoContinue.rateLimit setting "maxRetry";
  ignored` and the corresponding default applies

#### Scenario: An unreadable settings file is reported

- **WHEN** the settings file cannot be parsed, or `autoContinue` is not an object
- **THEN** defaults are used and a warning says so, instead of the extension
  starting silently misconfigured

#### Scenario: Contradictory delays are reported

- **WHEN** `baseDelayMs` exceeds `maxDelayMs` (globally or under `rateLimit`)
- **THEN** a warning explains that every delay will be clamped to the cap

### Requirement: Warnings reach the user

The extension SHALL buffer warnings from the load that happens before any context
exists and deliver them as `warning` notifications when a context is available.

#### Scenario: A limit value the limit parser would discard is reported

- **WHEN** `maxRetries` or `rateLimit.maxRetries` is a value `parseMaxRetries`
  cannot turn into a limit — `"5.5"`, `"0.0"`, `"abc"`, `""`, `"-1"`,
  `"99999999999999999999"` — or a fractional number such as `2.4`
- **THEN** the configured default applies and a warning says so
- **AND** the loader's acceptance test and the parser agree, so no value is stored
  whose effective limit is a different default: before this change
  `rateLimit.maxRetries: "0.0"` silently meant a 5-hour deadline
- **AND** the one deliberate asymmetry is that `parseMaxRetries` also accepts a
  `{type, count|durationMs}` object while the loader rejects it, because
  `AutoContinueConfig.maxRetries` is typed `number | string`

#### Scenario: Sections and roots that are not objects are reported

- **WHEN** `autoContinue.rateLimit`, `.tokenLimit`, or `.incompleteToolCall` is
  present but not an object, or the settings file parses to a non-object
- **THEN** that scope falls back to defaults and a warning names it

#### Scenario: Warnings surface at session start and on reload

- **WHEN** the extension loads settings at startup and again at `session_start` or
  `/auto-continue reset`
- **THEN** that load's warnings are delivered as ONE aggregated `warning`
  notification through `ctx.ui.notify` when `ctx.hasUI`, so five bad settings do not
  produce five toasts on every session start
- **AND** the buffer is refilled on every load and cleared after delivery, so a
  single load cannot report the same problem twice
- **AND** when `ctx.hasUI` is false nothing is delivered and the buffer is NOT
  cleared, so a later interactive session still reports it
