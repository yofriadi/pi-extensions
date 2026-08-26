# Spec Delta: thinking-level-resolution

## ADDED Requirements

### Requirement: pi-ai canonical thinking-level types

The extension SHALL use `GoogleApiThinkingLevel` and `ResolvedGoogleThinkingLevel` imported from `@earendil-works/pi-ai` as the types for Gemini wire thinking levels and clamped pi efforts.
It SHALL NOT declare local duplicates of these unions.
`GoogleGeminiCliOptions.thinking.level` SHALL be typed `GoogleApiThinkingLevel`.

#### Scenario: Upstream renames or extends the enum

- **WHEN** pi-ai changes its Google thinking-level types
- **THEN** the extension picks up the change through the import, with no mirrored local type to drift

### Requirement: Clamp unsupported efforts to high

The extension SHALL clamp pi `ThinkingLevel` values not resolvable for Google APIs (`"xhigh"`, `"max"`) to `"high"` before any use, mirroring pi-ai's `clampReasoning`.
The clamped value SHALL have type `ResolvedGoogleThinkingLevel`.

#### Scenario: User selects xhigh or max

- **WHEN** `streamSimpleGoogleGeminiCli` receives `reasoning: "xhigh"` or `reasoning: "max"`
- **THEN** the effort is clamped to `"high"` for both Antigravity wire-model routing and the tiered `thinkingConfig.thinkingLevel`, so the request uses the high wire model with `thinkingLevel: "HIGH"`

#### Scenario: Effort within the resolvable set

- **WHEN** the effort is `"minimal"`, `"low"`, `"medium"`, or `"high"`
- **THEN** it passes through unchanged

### Requirement: Per-model Gemini 3 level mapping

For Gemini 3 Pro models, `"minimal"` and `"low"` SHALL map to wire `LOW`, and `"medium"`/`"high"` to wire `HIGH`.
For other Gemini 3 models (Flash), efforts SHALL map 1:1 to `MINIMAL`/`LOW`/`MEDIUM`/`HIGH`.
Gemini 2.x models SHALL use `thinkingBudget` instead of `thinkingLevel`.

#### Scenario: Minimal effort on Gemini 3 Pro

- **WHEN** a Gemini 3 Pro model is used with effort `"minimal"`
- **THEN** the request carries `thinkingLevel: "LOW"` (Gemini 3 Pro has no MINIMAL level)

#### Scenario: Minimal effort on Gemini 3 Flash

- **WHEN** a Gemini 3 Flash model is used with effort `"minimal"`
- **THEN** the request carries `thinkingLevel: "MINIMAL"`

### Requirement: String-enum cast discipline

Assignments of `GoogleApiThinkingLevel` to `@google/genai`'s `ThinkingConfig.thinkingLevel` MAY cast through `any` because the genai type is a nominal string enum; the cast site SHALL carry a comment stating that `GoogleApiThinkingLevel` mirrors Google's `ThinkingLevel` enum values.

#### Scenario: Assigning a resolved level to the genai request config

- **WHEN** a `GoogleApiThinkingLevel` value is written to `generationConfig.thinkingConfig.thinkingLevel`
- **THEN** the site casts through `any` with a comment noting the enum-value mirroring, matching pi's own adapter
