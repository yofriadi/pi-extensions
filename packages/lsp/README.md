# LSP Extension Scaffold
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@lsp-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@lsp-v<version>",
      "extensions": ["packages/lsp/src/index.ts"]
    }
  ]
}
```

Standalone package scaffold for pi LSP integration work.

## Scope

This extension package now includes:

- Runtime lifecycle management for an LSP subprocess (Bun `spawn` when available, Node `child_process.spawn` fallback) + JSON-RPC initialize/shutdown
- PATH/Mason-first server resolution with lightweight user/project config
- Multi-server registry with file-type routing and workspace fallback selection
- Full `lsp` tool action surface (`diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `status`, `reload`)
- Backward-compatible `lsp_health` status alias
- Write-through hooks that run format-on-write and diagnostics-on-write for successful `write`/`edit` results

The extension remains opt-in and does not alter default pi behavior unless loaded.

## Lightweight Server Config

Server resolution order:

1. User config: `~/.pi/agent/lsp.json|yaml|yml` (fallback: `~/.pi/lsp.json|yaml|yml`)
2. Project config: `<cwd>/.pi/lsp.json|yaml|yml` (overrides user config)
3. Mason bin directories before regular `PATH`
4. Small built-in candidate list (no large bundled server catalog)

Supported config keys:

- `serverCommand`: string or string array, e.g. `["typescript-language-server", "--stdio"]`
- `server`: command name/path with optional `args`
- `serverCandidates`: explicit command candidates in probe order
- `servers`: named multi-server map/array entries with `command`/`server`+`args`, optional `fileTypes`, and `disabled`

When `servers` is present, the extension starts each resolved server and routes document-scoped requests by `fileTypes` (extension or filename). Workspace-scoped requests target the first ready server.

## Package Layout

- `src/index.ts`: extension entrypoint and runtime/tool/hook wiring
- `src/client/runtime.ts`: single LSP client lifecycle, JSON-RPC request surface, diagnostics cache
- `src/client/registry.ts`: multi-server runtime orchestration and per-path routing
- `src/config/resolver.ts`: server command/config resolution (single and multi-server)
- `src/tools/lsp-tool.ts`: full `lsp` tool schema/action routing + `lsp_health` alias
- `src/hooks/writethrough.ts`: format-on-write and diagnostics-on-write hooks

## Install and Load

### Upstream `pi`

```bash
# Load for one run
pi -e ./packages/coding-agent/examples/extensions/lsp

# Install as local package source
pi install ./packages/coding-agent/examples/extensions/lsp
```

### Fork Workflow

Use whichever launcher your fork environment provides:

```bash
# Source-run from repo
bun packages/coding-agent/src/cli.ts -e ./packages/coding-agent/examples/extensions/lsp

# If your fork is installed as a separate binary (example name)
pib -e ./packages/coding-agent/examples/extensions/lsp
```

## Usage

After loading the extension:

- Run `/lsp-status` to inspect runtime/config/transport state, including per-server routing/status details.
- Use the `lsp` tool with action-based params:
  - `status`
  - `reload`
  - `hover` / `definition` / `references` / `rename` (require `path`, `line`, `character`)
  - `symbols` (use `query` for workspace mode or `path` for document mode)
  - `diagnostics`
- Successful `write`/`edit` tool results automatically trigger format+diagnostics hooks and show a summary notification.

## Test Coverage

Focused extension tests:

- `packages/lsp/test/runtime.test.ts`
  - lifecycle readiness and JSON-RPC id handling
- `packages/lsp/test/resolver.test.ts`
  - multi-server config resolution and project-over-user override behavior
- `packages/lsp/test/registry.test.ts`
  - per-file routing and workspace fallback selection

Run focused validation:

```bash
bunx vitest run packages/lsp/test/runtime.test.ts packages/lsp/test/resolver.test.ts packages/lsp/test/registry.test.ts
```
