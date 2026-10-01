---
name: tilth
description: Reference for tilth tool parameters (mode/section/sections/paths/full, glob kinds, callers, budget) and the in-process MCP transport knobs. Tool *selection* is in the system prompt; load this when you know which tilth tool you want and need its exact arguments.
---

# tilth tool reference

The system prompt's `### Search & Discovery` already covers which tool to pick.
This file covers arguments.

## tilth_read

- `path` (or `paths` for several files in one call), `root` absolute, `section` / `sections`.
- `mode`: `auto` (default; small files whole, large files outlined) | `full` | `signature` (hashline-prefixed declarations) | `stripped` (code minus comments and blank lines).
- `section` accepts a range (`45-89`) or a heading (`## Architecture`). `sections` takes several disjoint ranges from one file, emitted in the order given, capped at 20.
- `budget` caps response tokens; if output is truncated, narrow the range instead of guessing at unseen lines.
- Repeat reads over the persistent session connection may come back elided (`[shown earlier]`).
  To edit the file afterwards, re-read with `full: true` or `section`.

## tilth_list

- `patterns` (up to 20) renders several globs into one tree; `depth` caps directory depth; per-directory token-size rollups show what a recursive read would cost.

## tilth_search

- `kind`: `symbol` (definitions first, then usages) | `callers` | `content` (literal) | `regex`.
- `query` takes comma-separated symbol names, up to 5, for cross-file tracing.
- `expand` = how many top matches get full source inlined (default 2); `context` = context lines.
- `glob` filters paths: `*.rs`, `!*.test.ts`, `*.{go,rs}`, `src/**/*.ts`.
- Pass the file you are editing as `context` — it reranks matches from that directory higher.

## Transport

Tools run over a persistent in-process MCP stdio connection to `tilth --mcp` (`src/lib/transport.ts`): the server process spawns on the first tool call of the session and stays open, enabling session dedup and `/tilth-savings`.

- `--search` / `--no-search` (default **on**, a tilth CLI flag): disables the MCP server, so `tilth_list` and `tilth_search` (all kinds) return unavailable while `tilth_read` keeps working.
- Connect budget (`connectTimeoutMs`, default 120s npx / 30s binary) and per-call budget (`callTimeoutMs`, default 60s) are set in `~/.pi/agent/extensions/pi-tilth/config.json` or `<project>/.pi/extensions/pi-tilth/config.json`.

## When NOT to use tilth

- Exact-pattern greps over unindexed or non-code files: `rg` is faster and needs no tree-sitter grammar.
