---
name: colgrep
disable-model-invocation: true
description: |
  Decision heuristics for choosing between colgrep (semantic/hybrid) and grep (exact match)
  during code exploration. Load before exploring unfamiliar code — contains the
  grep-vs-colgrep decision table and hybrid search strategies that prevent
  defaulting to grep for everything.
---

<!-- Adapted from ColGrep SKILL.md (https://github.com/lightonai/next-plaid)
     Copyright 2026, Raphael Sourty, LightOn — Apache-2.0
     See THIRD_PARTY_LICENSES/next-plaid-LICENSE.Apache-2.0.txt -->

# Semantic Code Search with ColGrep

ColGrep provides semantic and hybrid code search using ColBERT embeddings and tree-sitter parsing.
It complements the built-in `grep` tool — use `colgrep` for intent-based exploration, use `grep` for exact pattern matching.

## Why Load This Skill

This skill is not just a CLI reference — it contains decision heuristics for choosing the right search tool during exploration.
Without loading it, the default behavior is to reach for `grep` for all searches, missing opportunities where semantic search would find relevant code faster (e.g., "how does this package handle model resolution" vs. grepping for a symbol you already know).

Load this skill **before** starting exploration, not after.

## Quick Reference

```bash
# Semantic search (find code by intent)
colgrep "error handling for database connections" -k 10
colgrep "authentication middleware" -k 25          # More results for exploration
colgrep "query" ./src/parser                       # Search in specific directory
colgrep "query" ./src/main.ts                      # Search in specific file

# File filtering
colgrep --include="*.ts" "query"                   # Only TypeScript files
colgrep --include="*.{ts,tsx}" "query"             # Multiple file types
colgrep --exclude="*.test.ts" "query"              # Exclude test files
colgrep --exclude-dir=vendor "query"               # Exclude directory

# Pattern-only search (no semantic query needed)
colgrep -e "pattern"                               # Search by regex pattern
colgrep -e "async function" --include="*.ts"       # Pattern with file filter

# Hybrid search (text + semantic)
colgrep -e "handleError" "error handling patterns" # Combine text and intent
colgrep -e "regex" -E "semantic query"             # Extended regex (ERE)
colgrep -e "literal[0]" -F "semantic query"        # Fixed string (no regex)
colgrep -e "test" -w "testing utilities"           # Whole word match

# Output options
colgrep -l "query"                                 # List files only
colgrep -n 6 "query"                               # Show 6 context lines
colgrep --json "query"                             # JSON output
```

### Tool parameter mapping

When using the `colgrep` tool (not the CLI directly), parameters map as follows:

| Tool parameter | CLI flag                 | Example            |
| -------------- | ------------------------ | ------------------ |
| `query`        | positional               | `"error handling"` |
| `regex`        | `-e`                     | `"handleError"`    |
| `path`         | positional (after query) | `"./src"`          |
| `glob`         | `--include`              | `"*.ts"`           |
| `limit`        | `-k`                     | `25`               |
| `context`      | `-n`                     | `6`                |

## Grep-Compatible Flags

| Flag            | Description                                   | Example                                      |
| --------------- | --------------------------------------------- | -------------------------------------------- |
| `-e <PATTERN>`  | Text pattern pre-filter                       | `colgrep -e "async" "concurrency"`           |
| `-E`            | Extended regex (ERE) for `-e`                 | `colgrep -e "async\|await" -E "concurrency"` |
| `-F`            | Fixed string (no regex) for `-e`              | `colgrep -e "foo[bar]" -F "query"`           |
| `-w`            | Whole word match for `-e`                     | `colgrep -e "test" -w "testing"`             |
| `-k, --results` | Number of results (tool: `limit`)             | `colgrep -k 20 "query"`                      |
| `-n, --lines`   | Context lines (tool: `context`)               | `colgrep -n 10 "query"`                      |
| `-l`            | List files only                               | `colgrep -l "authentication"`                |
| `-r`            | Recursive (default)                           | `colgrep -r "query"`                         |
| `--include`     | Include files matching pattern (tool: `glob`) | `colgrep --include="*.py" "query"`           |
| `--exclude`     | Exclude files matching pattern (CLI only)     | `colgrep --exclude="*.min.js" "query"`       |
| `--exclude-dir` | Exclude directories (CLI only)                | `colgrep --exclude-dir=node_modules "query"` |

Notes:

- `-F` takes precedence over `-E` (like grep).
- Default exclusions always apply: `.git`, `node_modules`, `target`, `.venv`, `__pycache__`.
- Multiple `--include` patterns use OR logic.
- Brace expansion is supported: `*.{ts,tsx,js}`.
- Flags marked "CLI only" are available when running `colgrep` via bash but are not exposed as tool parameters.

## When to Use What

| Task                                     | Tool                                     |
| ---------------------------------------- | ---------------------------------------- |
| Find code by intent or description       | `colgrep` with `query`                   |
| Explore or understand a system           | `colgrep` with `query` and `limit=25`    |
| Find code matching a pattern             | `colgrep` with `regex` (no query needed) |
| Hybrid: text pattern + semantic intent   | `colgrep` with both `query` and `regex`  |
| Exact string or regex match              | `grep` (built-in)                        |
| Find all usages of a symbol              | `grep` (built-in)                        |
| Find files by name or glob               | `find` (built-in)                        |
| Find the area, then exact references     | `colgrep` first, then `grep` to narrow   |
| Verify a symbol exists in specific files | `grep` with a path                       |

## Key Rules

1. Prefer `colgrep` for intent-based searches and exploration — when you know *what* you want but not the exact text.
2. Use `grep` for exact pattern or symbol matching — when you know the precise string or regex.
3. Increase `limit` when exploring (25–30 results) to get broader coverage.
4. Use `regex` (the `-e` flag) for hybrid text+semantic filtering — combine a text anchor with semantic intent.
5. Use `-E` with `-e` for extended regex (alternation `|`, quantifiers `+?`, grouping `()`).
6. Use `-F` with `-e` when the pattern contains regex special characters you want taken literally.
7. Use `-w` with `-e` to avoid partial matches (e.g., "test" won't match "testing").
8. Combine both tools: use `colgrep` to find the relevant area of the codebase, then `grep` to find exact references within those files.

## Need Help?

Run `colgrep --help` for complete documentation on all flags and options.
