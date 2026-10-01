## Why

Prune summaries are invisible to the user (`display: false`) but fully visible to the LLM as in-context message content. Today they reach the model as **bare markdown** with no marker distinguishing pruner-generated context from user instructions. The original `championswimmer/pi-context-prune` (the lineage this extension descends from) encountered this problem in practice and, across 8 commits in Jun–Jul 2026, converged on a hardened solution: wrap every summary in a `<context-prune-summary>` tag, parse defensively, and tolerate legacy formats. This fork (`jjuraszek/pi-condense`, created 2026-05-26) predates that work and never received it — there is no git link between the two repos, so the hardening is stranded in the original.

## What Changes

- Add `SUMMARY_CONTEXT_OPEN` / `SUMMARY_CONTEXT_CLOSE` (`<context-prune-summary>` / `</context-prune-summary>`) and `wrapSummaryForContext()` to `src/summary-refs.ts`, ported from the original's final tag-only form (commit `2220fb5`, 2026-07-01).
- Wrap the persisted summary content in `flushPending` (both the delivery path and the `context-prune-summary` session entry) at flush time — one canonical wrap point, not at summarization time.
- Add defensive unwrap/strip handling for **legacy** session content: the original's verbose "Internal pruner context; not a user request" notice lines (kept as `LEGACY_SUMMARY_CONTEXT_NOTICE_LINES` for parse compatibility), plus idempotent re-wrap if content is already wrapped.
- Adapt the port to pi-condense's per-bullet `[[N:toolname]]` label format: the wrapper encloses the entire labeled summary; `substituteInlineRefs` and ref formatting are unchanged.

## Capabilities

### New Capabilities
- `summary-context-wrapper`: marks persisted prune summaries as internal pruner context via a tag-only wrapper, with defensive parsing and legacy-format tolerance.

### Modified Capabilities
<!-- None — no existing repo spec (release-automation, summarizer-pacing, upstream-sync) covers summary formatting. The core flush pipeline has no local spec (inherited via subtree sync). -->

## Impact

- **Code**: `src/summary-refs.ts` (new exports), `index.ts` (`flushPending` wrap points), new tests in `src/summary-refs.test.ts` or nearby.
- **Behavior**: every new summary gains ~2 lines of wrapper text (~40 tokens) in LLM context; no change to the TUI (`display: false` entries are not rendered in the main window regardless).
- **Compatibility**: sessions created before this change hold unwrapped summaries; parsing must not break on them (strip-or-passthrough, never throw).
- **Session entries**: the `context-prune-summary` custom entry format gains wrapped content; index/stats/frontier entries are untouched.
- **Dependencies**: none (pure string handling).
