# AST Extension
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@ast-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@ast-v<version>",
      "extensions": ["packages/ast/src/index.ts"]
    }
  ]
}
```

This extension provides integration with `ast-grep` (sg).

## Features

- Health check for `sg` binary (`sg_health` tool)
- AST Search (`ast_search` tool): search code using `sg run --pattern`
- AST Rewrite (`ast_rewrite` tool): rewrite code using `sg run --pattern --rewrite` (safe default: dry-run)

## Prerequisites

- `sg` (ast-grep) must be installed and available in your PATH.
