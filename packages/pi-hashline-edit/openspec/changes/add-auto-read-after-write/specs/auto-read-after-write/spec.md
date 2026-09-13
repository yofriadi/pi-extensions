## ADDED Requirements

### Requirement: Successful write returns a hashline-anchored view

When the built-in `write` tool completes successfully for a text file and the `autoRead` configuration is enabled, the extension SHALL extend that tool result with a hashline-anchored view of the file as it now exists on disk, so the model can address lines for `edit` without issuing a separate `read`.

The appended view SHALL be a distinct text block that preserves the original `write` result content unchanged and ahead of it.

#### Scenario: Model edits a freshly written file without re-reading

- **WHEN** the model calls `write` to create `src/widget.ts` and the write succeeds
- **THEN** the tool result contains an anchored view of the written file
- **AND** the model can issue an `edit` using an anchor from that view without calling `read`
- **AND** that `edit` succeeds

#### Scenario: Original write message is preserved

- **WHEN** a qualifying `write` result is extended
- **THEN** the text the `write` tool itself returned is still present, before the appended view
- **AND** the `details` field of the `write` result is left untouched

### Requirement: The anchored view is byte-identical to a read

The appended view SHALL be produced by the same code path that `read` uses to mint anchors, including the configured hash length, region formatting, truncation limits, and continuation notices.
It SHALL NOT be a second, independent rendering of the anchor format.

#### Scenario: Immediate read reproduces the same anchors

- **WHEN** the model receives an auto-read view and then calls `read` on the same file with no intervening modification
- **THEN** every `LINE#HASH` anchor in the `read` output matches the corresponding anchor in the auto-read view

#### Scenario: Large written file is bounded by the read limits

- **WHEN** a qualifying `write` produces a file larger than the `read` line or byte limits
- **THEN** the appended view is truncated to those same limits
- **AND** it carries the same `[Showing lines … Use offset=… to continue.]` continuation notice that `read` would emit
- **AND** no unbounded copy of the file is added to context

#### Scenario: Lossy decoding is disclosed

- **WHEN** the written file contains bytes that do not decode as UTF-8
- **THEN** the appended view carries the same non-UTF-8/U+FFFD disclosure that `read` emits

### Requirement: Anchor state is registered exactly as a read registers it

Producing the appended view SHALL perform the same state side effects as a `read` of that file: it SHALL record the read snapshot against the canonical mutation-target path, and SHALL clear the duplicate-edit no-op guard for that path.

#### Scenario: Stale-anchor recovery works against an auto-read anchor

- **WHEN** the model edits using an anchor taken from an auto-read view, and the file changes underneath it before a retry
- **THEN** stale-anchor recovery can consult the snapshot recorded by the auto-read, identically to the `read` case

#### Scenario: A repeated identical payload is not mistaken for a retry loop

- **WHEN** the model sends an `edit` payload identical to one already applied, after a qualifying `write` reset the file
- **THEN** the no-op loop guard does not block it, because the auto-read registered a fresh view of the current state

### Requirement: Non-qualifying writes are left untouched

The extension SHALL append nothing, and SHALL register no state, when the write does not qualify.
A write qualifies only if it targeted the built-in `write` tool, completed without error, and its resolved path is a readable text file.

#### Scenario: Failed write gets no anchors

- **WHEN** a `write` call ends with `isError` set
- **THEN** the result content is returned unchanged

#### Scenario: Binary or image target is skipped

- **WHEN** a successful `write` targets a path that resolves to binary or image content
- **THEN** no anchored view is appended
- **AND** the `write` still reports success

#### Scenario: Unresolvable or missing path is skipped

- **WHEN** the `write` input has no usable path, or the path cannot be read back after the write
- **THEN** no anchored view is appended
- **AND** the model receives no spurious tool error caused by the extension

#### Scenario: Empty file is reported as empty

- **WHEN** a qualifying `write` results in a zero-length file
- **THEN** the appended view carries the same empty-file guidance `read` emits, rather than an anchor list

#### Scenario: Other tools are ignored

- **WHEN** any `tool_result` event other than a built-in `write` fires, including `edit`, `read`, or a custom tool that happens to be named `write`
- **THEN** the extension returns no modification

### Requirement: Auto-read composes cooperatively with other extensions

Because the host applies a handler's returned `content` as a full replacement of the result array while chaining handlers cooperatively, the extension SHALL return the content it received plus its appended block, and SHALL omit `details` and `isError` unless it intentionally needs to change them.

#### Scenario: Another extension's contribution survives

- **WHEN** an extension that runs before this one has already appended content to the `write` result
- **THEN** that content is still present in the final result
- **AND** the anchored view appears after it

#### Scenario: An internal failure degrades to plain write behavior

- **WHEN** the auto-read logic fails unexpectedly while building the view
- **THEN** the `write` result is still delivered to the model with its original content and its reported success intact

### Requirement: The behavior is governed by an autoRead configuration flag

The extension SHALL read an `autoRead` boolean from `hashline.json`, defaulting to enabled, exposed through the same accessor pattern as the existing `grep` and `replaceText` keys.
When disabled, `write` results SHALL be byte-for-byte what they were before this change.

#### Scenario: Disabled by configuration

- **WHEN** `hashline.json` contains `"autoRead": false`
- **THEN** no anchored view is appended to any `write` result
- **AND** no read snapshot or loop-guard state is registered by the auto-read path

#### Scenario: Invalid value falls back with a warning

- **WHEN** `hashline.json` contains an `autoRead` value that is not a boolean
- **THEN** the effective value is the enabled default
- **AND** a configuration warning is reported in the same manner as existing invalid-key warnings

### Requirement: Prompt guidance reflects the auto-read behavior

The extension's prompt surface SHALL inform the model that a successful `write` to a text file already returns anchored lines, and that a separate `read` is therefore not required before editing.
The guidance SHALL describe the actual configured behavior rather than asserting the feature when it is disabled.

#### Scenario: Model is told not to re-read after write

- **WHEN** the system prompt is assembled with `autoRead` enabled
- **THEN** it states that `write` results include fresh anchors for the written file

#### Scenario: Guidance stays honest when disabled

- **WHEN** `autoRead` is disabled
- **THEN** the prompt no longer claims that `write` returns anchors
