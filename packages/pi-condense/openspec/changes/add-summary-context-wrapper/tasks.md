## 1. Port wrapper primitives

- [x] 1.1 Add `SUMMARY_CONTEXT_OPEN`, `SUMMARY_CONTEXT_CLOSE`, `LEGACY_SUMMARY_CONTEXT_NOTICE_LINES` constants and `wrapSummaryForContext()` / `unwrapSummaryForDisplay()` to `src/summary-refs.ts`, ported from the original v1.4.0 implementation (tag-only wrap, idempotent, legacy-notice stripping, malformed-input passthrough)
- [x] 1.2 Add unit tests in `src/summary-refs.test.ts` (or extend the existing refs test file): wrap plain text, idempotent re-wrap, unwrap round-trip, legacy notice-line stripping, malformed wrapper passthrough, non-string content handling

## 2. Wrap at the flush point

- [x] 2.1 In `index.ts` `flushPending`, wrap `summaryText` with `wrapSummaryForContext(...)` at the single construction site (after `substituteInlineRefs` + `formatSummaryToolCallRefs`, before the oversized-skip length guard)
- [x] 2.2 Verify by test that both delivery paths (runtime `pi.sendMessage` steer and session `appendSummaryMessage`) and `indexer.registerSummaryBody` receive wrapped content

## 3. Chain compression integration

- [x] 3.1 In `src/chain-compressor.ts`, unwrap per-batch bodies (`unwrapSummaryForDisplay`) before joining them for the `fuseRange` call
- [x] 3.2 Wrap `rangeSummaryText` with `wrapSummaryForContext` before storing it on the chain entry — both the LLM-fused result and the deterministic backfill body (`buildDeterministicBody`). Note: there is no stored per-batch concatenation; on fusion failure the renderer concatenates at render time (handled in 3.3)
- [x] 3.3 In `src/pruner.ts`, unwrap at the `chainSummaryText` lambda (~line 153): unwrap `rangeSummaryText` once; for the fallback, map `unwrapSummaryForDisplay` over `getPerBatchSummariesForToolCallIds` results *before* joining with `\n\n` (unwrapping the joined string once would leave N−1 embedded tag pairs)
- [x] 3.4 Add a test asserting the fuser receives unwrapped bodies, the stored chain summary is wrapped exactly once (fused and deterministic paths), and a rendered synthetic chain message body contains no `<context-prune-summary>` tags. Update existing exact-match assertions on stored fused text (`src/chain-compressor.test.ts:250`, `src/range-compression.integration.test.ts:57,59`) to expect the wrapped form

## 4. Display unwrapping

- [x] 4.1 In `src/commands.ts` `registerMessageRenderer("context-prune-summary", ...)` expanded branch, render `unwrapSummaryForDisplay(message.content)` instead of raw content
- [x] 4.2 In `src/tree-browser.ts`, unwrap summary content in the Ctrl-O overlay (`openSelectedSummary` / `renderWithSummaryOverlay`) — collapsed rows are header-only, no preview to fix — and unwrap before measuring the header's char count in `buildPruneTree` (~line 130)
- [x] 4.3 Update existing renderer/tree tests that assert on raw content; add a test that legacy unwrapped content renders unchanged

## 5. Verification

- [x] 5.1 Run `pnpm run check` from the repo root and fix all errors/warnings/infos
- [x] 5.2 Run `bun test` for pi-condense (or its package.json test runner) and iterate until green
- [x] 5.3 Manual smoke: run a pi session with pruning enabled, flush a batch, confirm the persisted summary content is wrapped, `/pruner tree` expanded view shows no tags, and chain compression still compresses a multi-batch chain
