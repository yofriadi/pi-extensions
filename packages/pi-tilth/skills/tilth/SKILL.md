---
name: tilth
description: |
  Decision guidance for using the six tilth tools (search, read, list,
  deps, grok, diff) in pi via mcporter. Load before exploring an unfamiliar
  repo — contains the tool-selection table, root/scope semantics, and the
  section-before-edit flow that keeps context small.
---

# Code intelligence with tilth

Tilth gives pi six tools backed by a tree-sitter + ripgrep MCP server: one invocation returns AST-aware outlines, definitions, callees, and usages instead of raw text dumps.

## Tool selection

| Question                               | Tool                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "Where is X defined/used?"             | `tilth_search` (kind=symbol)                                                                       |
| "Find all call sites of X"             | `tilth_search` (kind=callers)                                                                      |
| "What does this file look like?"       | `tilth_read` (auto: outline for large files, full for small)                                       |
| "Show me lines 45-89"                  | `tilth_read` with `section`                                                                        |
| "What's in this project?"              | `tilth_list`                                                                                       |
| "What breaks if I change this export?" | `tilth_deps` — blast radius before renaming/removing/signature changes                             |
| "Everything about this one symbol"     | `tilth_grok` — definition, body, callees, callers, siblings, tests in one call                     |
| "What changed, function-level?"        | `tilth_diff` — uncommitted (`no args`), `HEAD~1`, `main..feat`, `--log HEAD~5..HEAD`, `--expand 3` |

Search before reading: a `tilth_search` returns definitions, usages, and callee footers in one call — often removing the need to read the file at all.

## Root and scope

Every tool takes an absolute `root` (defaults to the session working directory) and most take `scope` for a subdirectory.
Relative `path`/`scope` values are resolved against the session cwd by the extension before the call, so pass paths the way the user said them — but prefer `scope` over `..` chains when narrowing.

Do not pass `scope` when you want the current working directory; the extension anchors an omitted scope to the session cwd for you (search, list, grok, deps).

## Section-before-edit

Before editing a file you have not fully read:

1. `tilth_read` the file (auto mode) — small files come back whole; large files return an outline with `[start-end]` ranges.
2. `tilth_read` with `section: "<start>-<end>"` for the region you will edit.
3. Edit.
   The shown content is hashline-annotated (`NN#HASH:content`) when pi-hashline-edit is active, so its `edit` accepts anchors copied straight from tilth output.

## When NOT to use tilth

- Exact-pattern line greps over unindexed files — the built-in grep is faster and does not depend on tree-sitter grammars.
- Reading images or non-code text files — use the built-in read.
- Simple file existence/size checks — built-in ls/read is cheaper.
- Anything write/edit — tilth tools are read-only here; edits go through pi-hashline-edit's edit tool.

tilth complements, never replaces: tool precedence among your extensions is your call.
