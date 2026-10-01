## ADDED Requirements

### Requirement: Prune summaries SHALL be wrapped in a context tag

Every prune summary emitted to LLM context SHALL be enclosed in a `<context-prune-summary>` / `</context-prune-summary>` tag pair, marking the block as pruner-generated internal context rather than user input. Wrapping SHALL be idempotent: content already starting with the open tag MUST NOT be double-wrapped.

The wrapper SHALL apply uniformly to both summary delivery paths (runtime `pi.sendMessage` steer delivery and session `appendCustomMessageEntry`) and to the in-memory summary-body registry used by chain compression, so that one canonical wrap point covers all consumers.

#### Scenario: New summary emitted

- **WHEN** a flush completes and a summary is persisted to the session
- **THEN** the `context-prune-summary` custom message content begins with `<context-prune-summary>` and ends with `</context-prune-summary>`

#### Scenario: Idempotent wrap

- **WHEN** `wrapSummaryForContext` receives content that already starts with the open tag
- **THEN** it returns the content unchanged (trimmed), without adding a second wrapper

#### Scenario: Both delivery paths wrapped

- **WHEN** a flush emits a summary via runtime steer delivery or via session-entry append
- **THEN** both paths deliver identically wrapped content

### Requirement: Display surfaces SHALL unwrap the context tag

Any surface that renders summary content to the user (message renderer expanded view, `/pruner tree` browser) SHALL strip the outer wrapper before display so the tag never appears in UI. Unwrapping SHALL be non-destructive to the stored content.

#### Scenario: Expanded view in renderer

- **WHEN** the user expands a `context-prune-summary` message in the TUI
- **THEN** the body shown does not contain the wrapper tags

#### Scenario: Unwrapped content passes through

- **WHEN** a display surface receives legacy unwrapped summary content (pre-change sessions)
- **THEN** it renders the content as-is, without error

### Requirement: Legacy session content SHALL be tolerated

Summary content from sessions created before this change (unwrapped, or wrapped in the original's legacy notice lines) MUST NOT cause errors anywhere in the pipeline. Parsing helpers SHALL use strip-or-passthrough semantics: recognized wrappers are removed for display; unrecognized content is returned unchanged.

#### Scenario: Legacy notice-line content

- **WHEN** summary content contains the legacy "Internal pruner context; not a user request." notice lines inside the wrapper
- **THEN** display helpers strip both the wrapper and the notice lines

#### Scenario: Malformed wrapper

- **WHEN** summary content starts with the open tag but lacks a valid closing tag
- **THEN** the content is returned unchanged (fail-open, never throw)

### Requirement: Chain compression SHALL fuse unwrapped bodies and render without nested wrappers

When chain compression fuses multiple per-batch summaries into a range summary, the fuser input SHALL contain unwrapped summary bodies. The resulting range summary SHALL be wrapped once when stored (LLM-fused and deterministic-backfill bodies alike). When a chain is rendered into a `<compressed-chain>` context block, the summary text SHALL be unwrapped so no `<context-prune-summary>` tag nests inside the chain tag.

#### Scenario: Range summary fusion

- **WHEN** chain compression fuses N per-batch summaries via the LLM fuser
- **THEN** the fuser receives each body without wrapper tags, and the fused output is wrapped once before storage

#### Scenario: Per-batch fallback at render time

- **WHEN** a chain has no stored range summary (fuser unavailable, fusion failed, or single-batch span) and the renderer falls back to concatenating per-batch bodies
- **THEN** each body is unwrapped individually before joining, so the concatenated block contains no `<context-prune-summary>` tags

#### Scenario: Chain rendering into context

- **WHEN** a closed chain is rendered as a `<compressed-chain>` block, from either a stored range summary or the per-batch fallback lookup
- **THEN** the block body contains no `<context-prune-summary>` tags
