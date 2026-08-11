# Delta: subagent-telemetry (new capability)

## ADDED Requirements

### Requirement: child sessions report run telemetry through the activity sidecar

The child session SHALL record telemetry into its existing versioned activity sidecar as additive optional fields: cumulative tool-call count, cumulative compaction count, and the latest sampled context usage (context tokens, context window, context percent).
Turn count SHALL come from the already-recorded turn index.
Telemetry writes SHALL ride the existing throttled atomic-write path; the schema version SHALL NOT change for these additions, and unknown fields SHALL be tolerated by readers.

#### Scenario: tool calls are counted

- **WHEN** a child session completes a tool execution
- **THEN** the activity sidecar's tool-call count increments and is flushed through the normal throttled write path

#### Scenario: compactions are counted

- **WHEN** the child session completes a context compaction
- **THEN** the activity sidecar's compaction count increments

#### Scenario: context usage is sampled on settle points

- **WHEN** a turn ends, a provider response completes, or a tool execution ends in the child session
- **THEN** the current context usage (tokens, window, percent) is sampled into the activity sidecar

#### Scenario: older readers ignore telemetry fields

- **WHEN** a parent running an older extension version reads an activity file that contains telemetry fields
- **THEN** validation succeeds and the unknown fields are ignored

### Requirement: widget degrades gracefully when telemetry is absent

When an activity file lacks telemetry fields (older child, pre-migration fixture, or unavailable model metadata), the parent widget SHALL render the row without the missing metric chunks and SHALL NOT fail, blank the row, or fabricate values.

#### Scenario: old child produces a metric-less row

- **WHEN** a running subagent's activity file contains no telemetry fields
- **THEN** its widget row shows identity, class, duration, and run label (when provided) with no turn/tool/token chunks

#### Scenario: percent is derived when only tokens and window are known

- **WHEN** the sidecar reports context tokens and a nonzero context window but no percent
- **THEN** the widget derives the utilization percent locally from tokens divided by window

### Requirement: context utilization presentation carries urgency by color tier

The widget SHALL render current context tokens as `◈` followed by a human-readable count, annotated with the window-utilization percent in parentheses when known.
The percent SHALL be color-coded: below 70% dim, 70–85% warning, 85% and above error.
The percent chunk SHALL be omitted when the model declares no context window or while the sidecar's latest compaction).
The compaction count SHALL render as `⇊N` only when greater than zero, and SHALL always be dim regardless of the percent's tier.
`⇊N` appears inside the percent's parentheses when the percent is present (`◈91.0k (84% · ⇊2)`), alone in parentheses when the percent is absent (`◈33.8k (⇊2)`), and is omitted entirely when the count is zero.

#### Scenario: utilization tiers

- **WHEN** a run's utilization is 62%, 84%, and 91% across three runs
- **THEN** the percents render dim, warning, and error respectively

#### Scenario: compaction count is visible but never urgent

- **WHEN** a run has compacted twice with 62% current utilization
- **THEN** the annotation reads `(62% · ⇊2)` with the percent dim and `⇊2` dim

#### Scenario: percent omitted while the sample is absent

- **WHEN** the sidecar's latest sample carries no percent value (for example immediately after a compaction, before the next sample)
- **THEN** the widget keeps the last-known token count and omits only the percent chunk until a fresh sample arrives

#### Scenario: no declared context window

- **WHEN** the model declares no context window
- **THEN** the token count renders without any percent annotation
