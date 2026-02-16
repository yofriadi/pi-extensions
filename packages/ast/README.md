# AST Extension

This extension provides integration with `ast-grep` (sg).

## Features

- Health check for `sg` binary (`sg_health` tool)
- AST Search (`ast_search` tool): search code using `sg run --pattern`
- AST Rewrite (`ast_rewrite` tool): rewrite code using `sg run --pattern --rewrite` (safe default: dry-run)

## Prerequisites

- `sg` (ast-grep) must be installed and available in your PATH.
