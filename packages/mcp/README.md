# MCP Extension
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@mcp-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@mcp-v<version>",
      "extensions": ["packages/mcp/src/index.ts"]
    }
  ]
}
```

Standalone MCP extension package for `pi` and the Bun fork workflow.

This package provides:

- MCP config discovery and validation
- MCP runtime with stdio and HTTP JSON-RPC transport support
- HTTP session header propagation (`Mcp-Session-Id`) and SSE response parsing for streamable MCP endpoints
- MCP manager lifecycle orchestration (startup/reload/shutdown)
- MCP command/tool utilities and discovered-tool bridge registration

## Install and Load

### Upstream `pi`

```bash
# Load extension for one run
pi -e ./packages/coding-agent/examples/extensions/mcp

# Persist extension as an installed package source
pi install ./packages/coding-agent/examples/extensions/mcp
```

### Bun fork source workflow

```bash
# Run coding-agent CLI directly via Bun with extension loaded
bun packages/coding-agent/src/cli.ts -e ./packages/coding-agent/examples/extensions/mcp
```

## Configuration

### Native config merge order

The resolver loads files in this order (later entries override earlier by server name):

1. `~/.pi/agent/mcp.json`
2. `<cwd>/.mcp.json`
3. `<cwd>/.pi/mcp.json`

Supported top-level shapes:

- `mcpServers` object
- `servers` object
- `servers` array (`[{ "name": "...", ... }]`)

Example:

```json
{
  "mcpServers": {
    "context7": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "timeoutMs": 30000
    },
    "mcp.grep.app": {
      "transport": "http",
      "url": "https://mcp.grep.app",
      "timeoutMs": 30000
    }
  }
}
```

### Optional external discovery adapters (opt-in)

By default, external Claude/Cursor configs are ignored.

To opt in:

```bash
export PI_MCP_DISCOVERY_ADAPTERS=claude,cursor
```

Supported adapter values:

- `claude`
- `cursor`
- `none` (disables adapter loading)

Adapter-derived servers are loaded before native pi config files, so native pi files can override imported definitions.

## Commands

- `/mcp-status` show manager/runtime/config/tool-cache health
- `/mcp-tools <server>` list MCP tools from one server
- `/mcp-call <server> <method> [jsonParams]` issue JSON-RPC call
- `/mcp-reload` reload config and restart MCP runtime

## Agent Tools

- `mcp_list_tools`
- `mcp_call`

At startup/reload, discovered MCP tools are bridged into regular agent tools with stable names (for example: `mcp_context7_resolve_library_id`).

## Security Notes

- Only configure MCP servers you trust. MCP tools can execute external processes or requests.
- Review local config files before enabling adapters (`PI_MCP_DISCOVERY_ADAPTERS`) because this imports external definitions.
- Prefer pinned commands/versions (for example explicit npm package versions) when possible.
- Treat MCP server output as untrusted input in downstream prompts and scripts.

## Troubleshooting

### No MCP servers appear

1. Run `/mcp-status`.
2. Check `Configured servers` and `Diagnostics` output.
3. Verify file paths and JSON validity for `~/.pi/agent/mcp.json`, `.mcp.json`, or `.pi/mcp.json`.

### Server is configured but not active

1. Run `/mcp-status` and inspect the server reason.
2. For stdio servers, verify command + args locally.
3. For HTTP servers, verify endpoint accepts JSON-RPC POST and returns valid responses.

### Tool bridge did not register expected tools

1. Run `/mcp-status` and inspect `Discovered MCP tools` and `Bridged MCP tools`.
2. Run `/mcp-tools <server>` to confirm server `tools/list` output.
3. Run `/mcp-reload` after config/server changes.

### Adapter-based discovery not working

1. Confirm `PI_MCP_DISCOVERY_ADAPTERS` is set in the runtime environment.
2. Use supported values only: `claude,cursor`.
3. Re-run `/mcp-reload` and inspect `/mcp-status` diagnostics for unknown adapter warnings.
