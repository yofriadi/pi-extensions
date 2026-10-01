## Context

pi-condense descends from `championswimmer/pi-context-prune` (forked as `jjuraszek/pi-condense` on 2026-05-26, at original v0.10.0). After the fork, the original hardened its summary format across 8 commits (Jun 25 – Jul 1): every summary is wrapped in `<context-prune-summary>` tags so the model can distinguish pruner-generated context from user instructions. This fork never received that work — the two repos share no git history, so nothing syncs automatically.

Current state (verified against the working tree):

- `src/summary-refs.ts` (108 lines) has no wrapper constants; summaries enter context as bare markdown with `[[N:toolname]]` per-bullet labels (substituted to `` `tN` `` refs by `substituteInlineRefs`).
- `index.ts` `flushPending` builds `summaryText = decorated + formatSummaryToolCallRefs(refs)` (line ~513) — one string feeding both the runtime steer path (`pi.sendMessage`) and the session path (`appendSummaryMessage`), plus `indexer.registerSummaryBody` for chain compression.
- Chain compression (`src/chain-compressor.ts:279`) joins stored per-batch bodies with `\n\n` and passes them to the LLM range fuser; the fused text becomes chain summary content.
- Display surfaces: the `registerMessageRenderer` callback in `src/commands.ts:1320` (expanded view prints `message.content` raw) and `/pruner tree` (`src/tree-browser.ts`).
- Constraints: Node strip-only TypeScript (no parameter properties, enums, namespaces); no new dependencies; tests use the repo's existing runner.

## Goals / Non-Goals

**Goals:**
- Port the original's tag-only wrapper (`SUMMARY_CONTEXT_OPEN`/`CLOSE`, `wrapSummaryForContext`, `unwrapSummaryForDisplay`, `LEGACY_SUMMARY_CONTEXT_NOTICE_LINES`) into `src/summary-refs.ts`, byte-compatible where practical.
- One canonical wrap point in `flushPending` covering both delivery paths and the in-memory summary-body registry.
- Unwrap-before-fuse in chain compression so the LLM fuser never sees wrapper tags, and re-wrap fused/concatenated output.
- Display surfaces never show the wrapper.
- Zero breakage for pre-change sessions (unwrapped or legacy-notice content).

**Non-Goals:**
- Changing the `[[N:toolname]]` label format, `substituteInlineRefs`, or ref-allocation logic.
- Adopting the original's verbose legacy preamble for *new* summaries (original abandoned it; tag-only is the final form).
- Re-wrapping summaries already stored in existing sessions (leave history untouched; tolerance, not migration).
- Any change to the `context-prune-summary` customType, entry `details`, or the index/stats/frontier entry formats.

## Decisions

### D1: Port from the original's final form, not its history

Take the implementation as it stands at original v1.4.0 (`src/summary-refs.ts`), not the intermediate Jun-25 commits. The original's saga (verbose notice → defensive parsing → tag-only) ended with the verbose lines demoted to `LEGACY_SUMMARY_CONTEXT_NOTICE_LINES` used *only* by the unwrap helper. Alternatives considered: writing our own marker (rejected — the original already paid the debugging cost, and byte-compatibility keeps a future cherry-pick diff trivial); keeping the verbose preamble for new summaries (rejected — the original itself removed it for token cost).

### D2: Wrap at the single `summaryText` construction site in `flushPending`

`const summaryText = wrapSummaryForContext(decorated + formatSummaryToolCallRefs(summaryRefs))`. This one line covers runtime delivery, session append, and `registerSummaryBody`, since all three consume the same variable. Alternative considered: wrapping inside each delivery helper (rejected — three call sites to keep in sync; the steer path and session path could drift).

### D3: Chain compression unwraps before fuse, wraps before store; rendering unwraps at the boundary

Three touch points, all following one rule — **wrapper tags exist on stored content, never on text handed to an LLM or nested inside another marker tag**:

1. **Fuser input** (`src/chain-compressor.ts:279`): map `getPerBatchSummariesForToolCallIds` results through `unwrapSummaryForDisplay` before joining for the fuser. Rationale: the fuser is an LLM call — feeding it our own control tags invites echoing/mangling; bodies in the registry are wrapped because of D2, so unwrapping at the fuse boundary keeps each side of the boundary clean.
2. **Stored range summary**: wrap with `wrapSummaryForContext` before storing on the chain entry — both the LLM-fused text and the deterministic backfill body (`buildDeterministicBody`, `bodySource: "deterministic"`), so "stored chain summary is wrapped exactly once" holds for every `rangeSummaryText`. There is no stored per-batch concatenation: on fusion failure `rangeSummaryText` is omitted and concatenation happens at render time (point 3).
3. **Rendering** (`src/pruner.ts:153`, the `chainSummaryText` lambda): unwrap before interpolation into the `<compressed-chain>` block. `entry.rangeSummaryText` unwraps once. The fallback is a render-time concatenation of N individually wrapped bodies — a single outer unwrap on the joined string would leave N−1 tag pairs embedded (the unwrap helper strips exactly one outer pair), so map `unwrapSummaryForDisplay` over `getPerBatchSummariesForToolCallIds` results **before** joining with `\n\n`. Without this, wrapped bodies nest `<context-prune-summary>` inside `<compressed-chain>` in LLM context (redundant marking, wasted tokens).

### D4: Display surfaces unwrap at render time, stored content stays wrapped

Add `unwrapSummaryForDisplay(message.content)` to the renderer's expanded branch and to tree-browser summary rendering. Content on disk and in context remains wrapped — unwrap is a pure view transform. Alternative considered: storing unwrapped and wrapping only at context-render time (rejected — there is no single context-render interception point; the summary goes through pi's message pipeline verbatim, so the wrap must live in the persisted content).

### D5: Oversized-skip guard measures the wrapped text

The guard (`summaryText.length > batchRawCharCount`) compares against what actually lands in context, so wrap *before* the comparison. The ~40-char wrapper makes the guard negligibly stricter — honest accounting.

## Risks / Trade-offs

- **Double-wrap in chain fusion** (wrapped bodies joined, fused output re-wrapped) → D3 unwraps fuser inputs; `wrapSummaryForContext` is idempotent as a second line of defense.
- **Nested tags in chain rendering** (wrapped range summary or per-batch fallback interpolated into `<compressed-chain>`) → D3 point 3 unwraps at the `chainSummaryText` lambda in `pruner.ts`, per body before joining on the fallback path so no wrapper survives into the block.
- **Renderer tests assert on raw content** → update affected tests; the expanded view now shows unwrapped body.
- **Chain regression via `registerSummaryBody` content change** (bodies now wrapped) → the only consumer is the fuse path, covered by D3; add a test asserting the fuser receives unwrapped bodies.
- **+~40 tokens per summary in context** → accepted; the wrapper is the point. Net still strongly negative vs. the pruned raw outputs.
- **Cosmetic char-count drift** → `src/tree-browser.ts:130` measures `summaryText.length` including the wrapper; unwrap before measuring so the header's "X chars" stays accurate.

## Migration Plan

No data migration. Old sessions keep unwrapped summaries in history; they prune/render exactly as before (unwrap is passthrough on unwrapped content). New sessions get wrapped summaries from the next flush. Rollback: revert the change; wrapped summaries already written remain harmless (the tag is inert text to the model, and stripping the port leaves the unwrap calls behind only if implemented carelessly — the port keeps old renderers working because wrapped content renders fine, tags included).

## Open Questions

None. (Review resolved the tree-browser question: summary bodies render only in the Ctrl-O overlay — collapsed rows are header-only — so the overlay and the header char count are the unwrap points; see task 4.2.)
