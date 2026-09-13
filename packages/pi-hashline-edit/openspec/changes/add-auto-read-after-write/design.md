## Context

This extension owns pi's `read`, `edit` and `grep` tools but not `write`.
The anchor protocol is therefore lopsided: `read` mints `LINE#HASH` anchors, `edit` consumes them, and `write` — which produces exactly the file content the model will want to edit next — produces none.
The model's only recourse after a `write` is a full `read`, duplicating the file in context (once as the `write` argument, once as the `read` result) purely to obtain addressing information the extension could generate itself.

Current state, verified in this package rather than assumed:

- `index.ts` registers `read`, `edit`, and conditionally `grep`, and subscribes only to `session_start`.
  Nothing observes `write`.
- `src/read.ts:65` exports `formatHashlineReadPreview(text, { offset, limit, raw })` — a pure function returning `{ text, truncation?, nextOffset? }`, applying `truncateHead` with `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` and emitting continuation notices.
- `src/read.ts:209-228` is the canonical anchor-minting sequence: `normalizeToLF(stripBom(file.text).text)` → `formatHashlineReadPreview` → `resolveMutationTargetPath(absolutePath)` → `rememberReadSnapshot(canonical, normalized)` → `clearAppliedPayload(canonical)`.
  Raw reads deliberately skip the snapshot registration because they mint no anchors.
- `src/read.ts:230-236` appends the U+FFFD disclosure when the decoder reported invalid bytes.
- `src/config.ts` holds a `hashline.json` singleton with `hashLength` / `grep` / `replaceText`, per-key validation that pushes human-readable warnings, and `get*()` accessors; `loadConfig()` runs once at module init from `getAgentDir()`.
- `src/file-kind.ts` classifies paths (`text` / `image` / `binary` / `directory`) before any anchor work.

Host facts, verified against the installed `@earendil-works/pi-coding-agent@0.74.2`:

- `pi.on("tool_result", handler)` is typed `ExtensionHandler<ToolResultEvent, ToolResultEventResult>` (`dist/core/extensions/types.d.ts:812`).
- `ToolResultEvent` is documented *"Fired after a tool executes.*
  *Can modify result."* (`types.d.ts:668`).
- `WriteToolResultEvent` carries `input: Record<string, unknown>` and `details: undefined` (`types.d.ts:641-643`).
- `ToolResultEventResult` is `{ content?, details?, isError? }` (`types.d.ts:725-729`).
- `dist/core/agent-session.js:192-212` applies the handler's `content` as a **wholesale replacement** of the tool result content array.
- `dist/core/extensions/runner.js:546-589` chains handlers cooperatively over a threaded `currentEvent`, overriding a field only when the returned value is not `undefined`, and catching handler exceptions into `emitError` (the write result survives, minus that handler's contribution).
- `isWriteToolResult` is re-exported from the package root (`dist/index.d.ts:7`), alongside the note that raw `event.toolName === "write"` comparison does not narrow because the custom-tool variant widens `toolName` to `string`.

## Goals / Non-Goals

**Goals:**

- A successful `write` of a text file hands the model anchors it can immediately `edit` with, with no extra `read` call.
- The anchors, truncation behavior, continuation notices, lossy-decoding disclosure, snapshot registration and loop-guard clearing are **indistinguishable** from what the same file would yield through `read` — enforced by sharing code, not by matching two implementations by eye.
- Every non-qualifying case (failed write, binary/image/directory, unreadable path, disabled flag, foreign `tool_result` events) degrades to exactly today's behavior without surfacing a spurious tool error.
- Composition-safe with other extensions' `tool_result` handlers.
- One config flag reverts to today's byte-for-byte behavior.

**Non-Goals:**

- Do not register, override, wrap or replace pi's `write` tool.
  This change only observes its result.
- No change to the anchor format, hash alphabet, hash length semantics, or the `read`/`edit`/`grep` tool schemas.
- No new persistent state (no registry, sidecars or on-disk store — this is the part of `pi-hashline-edit-pro` we deliberately are not adopting).
- No anchor-echo write refusal, no dedup bypass, no regex safety guard, no undo.
  Those were audited as inapplicable to this package.
- No auto-read after `edit` (its result already carries a diff preview) or after `bash`-initiated mutations.

## Decisions

### D1: Seam is a `tool_result` handler on the built-in `write`, not a `write` tool override

Chosen over:

- **Registering our own `write`** (mirroring how `read`/`edit` are overridden): would put us in the business of owning pi's write semantics — content normalization, size limits, image handling, `pi.extensions` shadowing — for a tool that has nothing to do with the anchor protocol.
  It also converts every future upstream `write` improvement into a fork we must track.
  Rejected.
- **`tool_execution_end`**: fires with `result` for observability, but its handler has no result channel (`ExtensionHandler<ToolExecutionEndEvent>`, `types.d.ts:806`), so it cannot contribute content to the model.
  Rejected.
- **`tool_call`**: fires *before* execution and can only mutate input or block (`ToolCallEventResult`), not extend output.
  Rejected.

`tool_result` is the only event documented as able to modify a result, and it is already typed for `write`.
Narrowing uses the exported `isWriteToolResult` guard rather than a `toolName` string comparison, per the union-widening caveat.

### D2: Read the file back from disk instead of formatting `input.content`

The handler resolves `event.input.path` with `resolveToCwd(rawPath, ctx.cwd)`, then loads via `loadFileKindAndText` and normalizes exactly as `read` does.

Chosen over formatting the `content` string the model passed in, which saves one file read.
Rejected because anchors are a function of **on-disk bytes**: write may transform line endings or encoding, a terminal newline may be added or dropped, and `edit` validates hashes computed from the file.
Minting anchors from the argument instead of the result would risk anchors that are stale the instant they are handed over — reintroducing precisely the silent-edit-failure class this package exists to prevent, in exchange for one local file read.
Reading back also gives us the `binary` / `image` / `directory` classification for free, which is how we skip non-text targets.

### D3: Achieve identity by extracting `read`'s sequence, not by duplicating it

Extract the mint-and-register body of `read.execute` (`src/read.ts:209-228`, plus the U+FFFD disclosure) into one exported function that takes an absolute path and the `{ offset?, limit?, raw? }` options and returns the display text alongside the truncation/`nextOffset` metadata, registering snapshot and loop-guard state when anchors were minted. `read.execute` then calls it, and so does the auto-read handler.

Chosen over a second small implementation in the new module (faster to write, but the two would drift on exactly the edge cases the existing 48 test files cover — empty file, offset past EOF, first-line-too-long, raw mode, mixed endings).
The extraction is behavior-preserving; the existing read suite is the regression net, and any test that needs changing signals a real behavior change rather than a cosmetic refactor.

Consequence for `raw`: the auto-read always mints anchors, so it always takes the registering branch; the extracted function keeps `raw` for `read`'s own use.

### D4: Append a separate `TextContent` block, and return the full array

The handler returns `{ content: [...event.content, { type: "text", text: block }] }` and deliberately omits `details` and `isError`, relying on the runner's "only non-`undefined` fields override" chaining.
That satisfies both "original write message preserved" and "another extension's contribution survives".

Block shape: the `write` result's own text stays first, then a delimited view:

```text

[Anchors for src/widget.ts as written. Edit these directly — no read needed.
 Do not copy the LINE#HASH prefixes into any file content.]
1#PZ:export function widget() {
2#WK:  return 1;
3#MN:}
```

The header is short, names the path, states the payoff (skip `read`), and pre-empts the one new failure mode this feature creates (see R2).
A separate content item — rather than string-concatenating into `write`'s own text — keeps the original block byte-identical and keeps rendering and assertions simple.

### D5: Never throw for an expected skip; wrap the whole builder

Every qualification decision (non-`write` event, `isError`, missing/non-string `path`, non-text kind, read-back failure) returns `undefined` from the handler, i.e. "no modification".
The construction of the view is additionally wrapped so an unexpected internal error degrades to plain `write` behavior.
Rationale: the runner converts handler exceptions into `emitError`, which surfaces an extension-error to the user for what is, from the model's point of view, a perfectly good write.
Failure must be silent-but-degraded here, unlike in `read`/`edit` where a thrown error *is* the useful signal.

### D6: `autoRead` defaults to enabled, following the existing config pattern

Add `autoRead: boolean` to `HashlineConfig` with `_autoRead = true`, a `parseHashlineConfig` branch that validates the type and pushes the same style of warning on garbage, and `getAutoReadEnabled()`.
Registration in `index.ts` is then unconditional and the handler consults the flag per event (mirroring how `getGrepEnabled()` is consulted at registration, but per-event so the flag is not a load-order artifact).

Chosen over default-disabled.
Counter-argument considered: this package defaults `grep` to off.
The difference is that `grep` **replaces the shape of a built-in tool the user already relies on**, whereas `autoRead` only adds a block to a tool this package does not own, and the cost is bounded by the existing `read` limits (D7).
Users who prefer minimal write results set `"autoRead": false`.

### D7: Token ceiling is inherited, not invented

No new limit.
`formatHashlineReadPreview` already applies `truncateHead`, so the appended view can never exceed what one `read` would have cost, and it emits its own `offset=` continuation notice.
The saving is unconditional: one fewer full-file round trip in context, since the model would otherwise `write` the content and then `read` it back.

### D8: Prompt guidance is added and made conditional on the flag

Add a guideline line to the read/edit prompt surface stating that a successful `write` of a text file already returns anchors, so a follow-up `read` is unnecessary — and gate that wording on `getAutoReadEnabled()` so disabling the flag cannot leave the prompt asserting a dead behavior.

### D9: Tests load through the real host path

Per this repo's rules, integration coverage goes through `loadExtensions` from `@earendil-works/pi-coding-agent` (no mocking of the loader), asserting that the extension registers the handler and that a qualifying `write` yields anchors which a subsequent `edit` consumes successfully.
Unit coverage takes the skip matrix (failed write, binary, image, directory, missing path, flag off, foreign event, non-string path), the identity-with-`read` assertion, the snapshot/loop-guard side effects, and the append-not-replace composition contract.
Ad-hoc scripts go to a temp file, not inline in shell commands.

## Risks / Trade-offs

- **R1: Every qualifying `write` grows context.**
  A 5,000-line generated file now costs one bounded `read`-sized block it might not have needed. → Mitigated by D7 (hard cap identical to `read`, with continuation notice), by the skip matrix, and by the single `autoRead: false` switch.
  Expected to be net-negative for cost, since the alternative is a full `read` anyway.
- **R2: Handing over anchors invites anchor echo.**
  A model that later rewrites the same file with `write` may paste `LINE#HASH:` prefixes into the content — corrupting the file.
  This risk is genuinely *created* by this feature. → Mitigated in v1 by the explicit header instruction (D4).
  A durable fix (detecting and refusing/scrubbing echoed anchors on write, which `pi-hashline-edit-pro` does with `[E_WRITE_HASH_ECHO]`) is deliberately deferred; see Open Questions.
- **R3: Refactoring `read.ts` could change anchor behavior.**
  The extraction in D3 touches the most load-bearing code in the package. → Mitigated by extracting without edits to logic, running the existing 48-file suite unchanged as the net, and treating any test edit as a red flag requiring justification in the diff.
- **R4: Read-back can observe a concurrent mutation.**
  If something changes the file between the write and our read-back, anchors reflect the newer bytes, not what `write` authored. → Accepted: `edit` already validates against live content, so a mismatch fails loudly instead of silently mis-editing.
  This is strictly safer than minting from `input.content`.
- **R5: Host contract drift.** `tool_result` exists in the pinned `0.74.2` and satisfies the `>=0.74.0` peer, but is not part of a stability promise. → Mitigated by D5 (if the event ever stops firing, the worst case is today's behavior) and by an integration test that would catch a renamed event.
- **R6: Interaction with another extension that owns `write`** (e.g. a fork that refuses anchor echo) — both are cooperative under the runner's chaining, order-dependent only for block placement. → Accepted and documented; no locking, no assumptions about position beyond "ours is last".
- **Trade-off accepted:** we gain statelessness (nothing to migrate, nothing to GC, no `~/.config` footprint) precisely by refusing the allocated-anchor model; the cost is that anchors remain content-derived and therefore neighbor-sensitive, exactly as in `read`.

## Migration Plan

Additive and reversible; no data or protocol migration.

1. Land the extraction (D3) with zero behavior change; `pnpm test` must pass untouched.
2. Land config + handler + prompts behind the default-on flag.
3. Rollout requires no user action.
   Rollback is `"autoRead": false` in `hashline.json`, or deleting the single `registerAutoReadHook(pi)` line in `index.ts`.
   Sessions holding pre-change anchors are unaffected — anchors are recomputed from content on every read.

## Open Questions

- **Confirm the default.**
  D6 argues enabled; this changes what every `write` costs in context, so it is worth an explicit yes before release.
  Flipping the default is a one-line change (`_autoRead = false`) with no other edits.
- **Does v1 need anchor-echo protection (R2)?**
  Decide after observing real usage; if echo appears, port the *refusal* idea (scrub or reject `LINE#HASH:`-prefixed lines on write) rather than pro's whole write-override design.
- **Should `edit` results that create files, or `bash` writes, also auto-read?**
  Out of scope for v1; `edit` already shows a diff preview, and `bash` has no reliable file-level signal.
