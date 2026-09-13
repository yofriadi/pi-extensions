# Tasks

## 1. Baseline

- [ ] 1.1 Run `pnpm test` from the repo root and record the passing count for `packages/pi-hashline-edit` as the refactor regression bar (design R3).
- [ ] 1.2 Capture a golden snapshot of today's `write` tool result text (single `write` call in a scratch dir) to prove the `autoRead: false` path stays byte-for-byte identical later.
- [ ] 1.3 Re-read `src/read.ts:200-250`, `src/config.ts`, `src/file-kind.ts` and `index.ts` in full so the extraction in group 2 is made against inspected code, not snippets (repo rule).

## 2. Extract the shared anchor-minting sequence (D3, behavior-preserving)

- [ ] 2.1 In `src/read.ts`, extract the mint-and-register body of `read.execute` (normalize → `formatHashlineReadPreview` → `resolveMutationTargetPath` → `rememberReadSnapshot` → `clearAppliedPayload`, plus the U+FFFD disclosure) into one exported async function taking an absolute path plus `{ offset?, limit?, raw? }` and returning `{ text, truncation?, nextOffset? }`.
- [ ] 2.2 Keep registration conditional on anchors actually being minted, preserving the existing raw-read rule at `src/read.ts:218-228`.
- [ ] 2.3 Rewrite `read.execute` to call the extracted function; delete no behavior, change no message text.
- [ ] 2.4 Re-run `pnpm test`: all group-1 tests must pass **unmodified**.
      If any test needs editing, stop and justify the behavior change before proceeding (R3).
- [ ] 2.5 Run `pnpm run check` with full output and fix any new `any` usage, inline import, or biome/knip complaint introduced by the extraction.

## 3. Configuration (D6)

- [ ] 3.1 Add `autoRead: boolean` to the `HashlineConfig` type and the `parseHashlineConfig` return object, defaulting to `true`.
- [ ] 3.2 Add the validation branch: non-boolean values fall back to enabled and push a warning phrased like the existing `replaceText` warning at `src/config.ts:81-90`.
- [ ] 3.3 Add module state `_autoRead`, set it in `loadConfig()`, and export `getAutoReadEnabled()`.
- [ ] 3.4 Extend the config doc comment at `src/config.ts:4-5` (schema + defaults line) to list `autoRead`.
- [ ] 3.5 Add tests: default when key absent, honored when `false`, invalid type yields enabled-plus-warning, warning text matches the established pattern.

## 4. Auto-read handler (D1, D2, D4, D5)

- [ ] 4.1 Create `src/write-auto-read.ts` exporting `registerAutoReadHook(pi: ExtensionAPI): void`, with top-level imports only.
- [ ] 4.2 Subscribe to `tool_result` and narrow with the root-exported `isWriteToolResult` guard (not a `toolName` string compare); return `undefined` for anything else.
- [ ] 4.3 Return `undefined` immediately when `isError` is set or `getAutoReadEnabled()` is false.
- [ ] 4.4 Read `event.input.path`, reject missing/non-string values, and resolve with `resolveToCwd(rawPath, ctx.cwd)`.
- [ ] 4.5 Load via `loadFileKindAndText` and return `undefined` for `binary`, `image` and `directory` kinds; let the zero-length file case flow through so the existing empty-file message is emitted (spec "Empty file is reported as empty").
- [ ] 4.6 Build the view with the group-2 extracted function (no new formatting logic), so snapshot registration and loop-guard clearing happen as a side effect of qualifying.
- [ ] 4.7 Compose the block per D4: path-naming header, the "edit directly, no read needed" payoff line, and the "do not copy the LINE#HASH prefixes" instruction (R2), then the anchored body.
- [ ] 4.8 Return `{ content: [...event.content, { type: "text", text: block }] }` and deliberately omit `details` and `isError` (D4, chaining contract).
- [ ] 4.9 Wrap view construction so any unexpected internal failure returns `undefined` rather than throwing (D5) — degrade to plain `write`, never surface an extension error for a successful write.

## 5. Wiring

- [ ] 5.1 Call `registerAutoReadHook(pi)` from `index.ts` next to the existing registrations; consult the flag per event (D6), not at load time.
- [ ] 5.2 Confirm the hook still registers when `grep` is disabled and when the package is loaded in any order relative to other extensions.

## 6. Prompt surface (D8)

- [ ] 6.1 Add guidance that a successful `write` of a text file returns fresh anchors and a follow-up `read` is unnecessary.
- [ ] 6.2 Gate that wording on `getAutoReadEnabled()` so a disabled flag cannot assert dead behavior (spec "Guidance stays honest when disabled").
- [ ] 6.3 Keep new prompt text in `prompts/` files following the existing `loadPrompt` + snippet/guidelines split; do not hardcode long strings in TS.
- [ ] 6.4 Test both prompt states (enabled includes the line, disabled omits it).

## 7. Spec coverage tests

- [ ] 7.1 Identity: auto-read anchors for a file equal a subsequent `read` of that file with no intervening change (spec "Immediate read reproduces the same anchors").
- [ ] 7.2 Bound: write a file exceeding `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`; assert truncation plus the `offset=` continuation notice and no unbounded block.
- [ ] 7.3 Lossy: non-UTF-8 bytes in the written file yield the U+FFFD disclosure.
- [ ] 7.4 Side effects: assert `rememberReadSnapshot` recorded for the canonical mutation path and `clearAppliedPayload` cleared for it.
- [ ] 7.5 Recovery: after an auto-read, mutate the file externally, then confirm the stale-anchor path offers snapshot-based recovery identically to the `read` case.
- [ ] 7.6 Loop guard: an intentionally repeated payload after a qualifying `write` is not blocked.
- [ ] 7.7 Skip matrix as table-driven tests: failed write, binary, image, directory, missing path, non-string path, flag off, foreign `tool_result` event — each asserts content unchanged.
- [ ] 7.8 Composition: a pre-existing second content block in the write result survives, ordered before ours; `details` is not overwritten.
- [ ] 7.9 Degradation: force an internal failure (unreadable path after write, or thrown dependency) and assert the write result is delivered intact with no thrown error.

## 8. Integration through the real loader

- [ ] 8.1 Add a test that loads `src/index.ts` via `loadExtensions` from `@earendil-works/pi-coding-agent` (do not mock the loader or the package) and asserts the `tool_result` handler is registered alongside `read`/`edit`.
- [ ] 8.2 End-to-end: a `write` followed directly by an `edit` using an auto-read anchor, asserting the edit applies and the file content is correct.
- [ ] 8.3 Assert the same flow with `autoRead: false` produces the golden `write` result from task 1.2 and requires a `read` (spec "Disabled by configuration").

## 9. Verification and docs

- [ ] 9.1 Measure the cost/benefit claim in R1: for a representative file, record tokens in context with (write + auto-read) vs (write + read).
      Use a script in `/tmp`, run it, then delete it.
- [ ] 9.2 Document `autoRead` in `README.md` alongside the other `hashline.json` keys, including the default and the rollback instruction from the migration plan.
- [ ] 9.3 State the Non-Goals boundary in docs: this observes `write`, it does not override it, and there is no anchor-echo refusal (R2, deferred).
- [ ] 9.4 Run `pnpm run check` (full output, no tail) and fix every error, warning and info.
- [ ] 9.5 Run `pnpm test` from the repo root and confirm the group-1 baseline count plus all new tests pass.
- [ ] 9.6 Confirm no `any`, no inline/dynamic imports, and no node-syntax violations (enum/namespace/parameter properties) in the diff.
- [ ] 9.7 Remove any scratch dirs or temp scripts created during verification.
