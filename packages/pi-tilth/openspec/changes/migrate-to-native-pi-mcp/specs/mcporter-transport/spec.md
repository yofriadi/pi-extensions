## REMOVED Requirements

### Requirement: Server resolution prefers a configured mcporter server and falls back to ad-hoc stdio

**Reason**: `mcporter` is replaced entirely by in-process `@earendil-works/pi-mcp` in Pi 0.99.1+.
Ephemeral per-call `mcporter call` subprocesses caused repeat-read session dedup to fail (0.007% hit rate) and added ~1,200ms overhead per call.
**Migration**: Use `native-mcp-transport` backed by `McpClient` and `StdioTransport`.

### Requirement: Each tool invocation is a single mcporter call with JSON I/O

**Reason**: Invoking `mcporter call` CLI binaries via child processes on every tool execution is replaced by in-process JSON-RPC method calls on the persistent MCP client.
**Migration**: Handled internally by `native-mcp-transport` via `client.callTool()`.

### Requirement: All paths are scoped to the session working directory

**Reason**: The mcporter-specific scoping requirement is superseded by the equivalent requirement under `native-mcp-transport`.
**Migration**: Fully retained and enforced under `native-mcp-transport` ("All paths are scoped to the session working directory").

### Requirement: Host prerequisites are documented, never auto-installed

**Reason**: Prerequisites relating to `mcporter` installation and daemon keep-alive configuration are obsolete.
**Migration**: Prerequisites are updated to require only the `tilth` binary or `npx`.
