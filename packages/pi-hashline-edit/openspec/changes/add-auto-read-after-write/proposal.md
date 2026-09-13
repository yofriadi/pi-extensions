# Auto-read after write

## Why

Today the extension overrides `read`, `edit` and `grep`, but leaves pi's built-in `write` alone.
That leaves an asymmetry in the anchor protocol: a model that creates or replaces a file with `write` gets back only a bare success message, holds no anchors for the file it just wrote, and therefore **must spend an extra full `read` round-trip before it can make any edit**.
In practice the common "scaffold a file, then refine it" flow pays a whole re-read (the file's entire content, twice in context) purely to mint anchors the model could have been handed for free.

The idea is validated externally: `pi-hashline-edit-pro` ships exactly this as `src/write-hook.ts`, and it was the single item that survived a code-level audit of that fork as worth adopting into this package (the rest of its differences are welded to its own allocated-anchor architecture).

## What Changes

- A new `tool_result` handler observes pi's built-in `write` tool.
  On a **successful** write of a text file, the result is extended with a hashline-anchored view of the file as written on disk — the same bytes, formatting, truncation limits and continuation notices a real `read` would have produced.
- The auto-read block **registers the read snapshot and clears the no-op loop guard** for the target, exactly as `read` does, so a follow-up `edit` validates and recovers against it identically.
- Anchors are minted through the **existing** `formatHashlineReadPreview` code path — no second implementation of the anchor format, so the two can never drift.
- A new `autoRead` boolean in `hashline.json` (default **enabled**) turns the block off; disabling it restores today's byte-for-byte behavior.
- Prompt guidance tells the model that a successful `write` already returns anchors, so it should not re-read before editing.
- Non-breaking: no tool schemas change, no existing behavior is removed, and `edit`/`read`/`grep` are untouched when the flag is off or the write does not qualify.

## Capabilities

### New Capabilities

- `auto-read-after-write`: The whole behavior — when an anchored view is appended to a `write` result, what it must contain, which cases must be skipped (failed writes, binary/image/unreadable targets, disabled flag), how it reuses `read`'s formatting and snapshot side effects, how it composes with other extensions' `tool_result` handlers, and the configuration that governs it.

### Modified Capabilities

None.
This package has no `openspec/specs/` baseline yet, so there are no existing requirement sets to delta.
`read`, `edit` and `grep` keep their current requirements; the new capability only observes `write`, which this extension does not own.

## Impact

- **New code**: `src/write-auto-read.ts` (the `tool_result` handler + qualification rules), registered from `index.ts` alongside the existing `registerReadTool`/`registerEditTool`/`registerGrepTool` calls.
- **Touched**: `src/config.ts` (new `autoRead` key: parse, validate, warn, `getAutoReadEnabled()`), `src/read.ts` (export the anchor-minting sequence so the hook reuses it verbatim — extraction only, no behavior change), `prompts/*` (guidance line), `README.md`.
- **Verified against the installed host** (`@earendil-works/pi-coding-agent@0.74.2`, read from `node_modules`, not assumed): `pi.on("tool_result", …)` accepts `ToolResultEventResult` (`dist/core/extensions/types.d.ts:812`); `WriteToolResultEvent` exists with `input: Record<string, unknown>` and `details: undefined` (`types.d.ts:641-643`); the event is documented "Fired after a tool executes.
  Can modify result." (`types.d.ts:668`); the runtime applies the handler's `content` as a **replacement** of the result array (`dist/core/agent-session.js:192-212`) and **chains** handlers cooperatively, overriding only fields that are not `undefined` (`dist/core/extensions/runner.js:546-566`).
  Consequence: the handler must return the original content plus the appended block, and must omit `details` to leave it intact.
- **No new dependencies**, no schema/protocol change, no change to the anchor format or hash alphabet.
- **Risk surface**: added tokens on every qualifying `write` (bounded by the existing `read` limits), and a second writer of the read-snapshot store.
