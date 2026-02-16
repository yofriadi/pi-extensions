# LSP Extension Scaffold

Standalone package scaffold for pi LSP integration work.

## Scope

This extension package now includes:

- Runtime lifecycle management for an LSP subprocess (Bun `spawn` when available, Node `child_process.spawn` fallback) + JSON-RPC initialize/shutdown
- PATH/Mason-first server resolution with lightweight user/project config
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

## Package Layout

- `src/index.ts`: extension entrypoint and runtime/tool/hook wiring
- `src/client/runtime.ts`: LSP client lifecycle, JSON-RPC request surface, diagnostics cache
- `src/config/resolver.ts`: server command/config resolution
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

- Run `/lsp-status` to inspect runtime/config/transport state.
- Use the `lsp` tool with action-based params:
  - `status`
  - `reload`
  - `hover` / `definition` / `references` / `rename` (require `path`, `line`, `character`)
  - `symbols` (use `query` for workspace mode or `path` for document mode)
  - `diagnostics`
- Successful `write`/`edit` tool results automatically trigger format+diagnostics hooks and show a summary notification.

## Test Coverage

Focused extension tests:

- `packages/coding-agent/test/lsp-runtime.test.ts`
  - lifecycle start/stop, lspmux wrapping/fallback behavior
- `packages/coding-agent/test/lsp-tool-router.test.ts`
  - `lsp` tool schema/action routing and reload/status behavior
- `packages/coding-agent/test/lsp-writethrough.test.ts`
  - write-through formatting/diagnostics hooks and fallback behavior

Run focused validation:

```bash
bun --cwd=packages/coding-agent run test -- lsp-runtime lsp-tool-router lsp-writethrough
```

If `vitest` is not available in your current worktree, run `bun install` in repo root before re-running tests.
