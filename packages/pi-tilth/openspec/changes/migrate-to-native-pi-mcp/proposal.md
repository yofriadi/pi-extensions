## Why

`pi-tilth` currently shells out to `mcporter call <server.tool>` via child processes on every single tool execution.
An audit of 657 coding sessions (over 47,800 turns) revealed two critical structural flaws with this design:

1. **Broken session dedup**: Each `mcporter call` CLI invocation connects as an isolated client, resetting tilth's internal session memory.
   Across 12,843 `tilth_read` calls, tilth's headline repeat-read dedup (`[shown earlier]`) triggered exactly once (0.007%), and `/tilth-savings` permanently reports 0 saved tokens.
2. **Subprocess latency and external dependency**: Every tool call pays ~1,200 ms of Node and CLI startup overhead and requires users to install, configure, and maintain `mcporter` and its daemon socket.

Pi 0.99.1 bundles `@earendil-works/pi-mcp`.
By migrating `pi-tilth` to an in-process persistent `McpClient` (`StdioTransport`), the extension holds a single long-lived stdio connection to `tilth` for the duration of the Pi session.
This delivers sub-10ms tool calls, eliminates the `mcporter` dependency completely, and activates tilth's repeat-read dedup and session savings as originally intended, all while preserving all six tool names (`tilth_read`, `tilth_search`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`), cwd/root scoping injection, and `pi-hashline-edit` anchor compatibility.

## What Changes

- **Replace mcporter with bundled `@earendil-works/pi-mcp`**: Remove `callMcporter` and all shell-out logic in `src/lib/mcporter.ts`.
  Connect directly to `tilth --mcp` via `StdioTransport` and `McpClient` from `@earendil-works/pi-mcp`.
- **Session-scoped persistent lifecycle with auto-healing**: Spawn and connect the tilth stdio process lazily or at `session_start`, keep it alive across turns, and close it cleanly on `session_shutdown`.
  If the underlying child process terminates unexpectedly, the transport automatically reconstructs a fresh client and stdio process on the next call rather than wedging the session.
- **Connect budget for npx cold starts**: Configure `requestTimeoutMs` on client initialization with a dedicated `connectTimeoutMs` (default 120s for `npx`, 30s for `binary`) so cold-cache package downloads don't fail initialize requests.
- **Concurrent connect memoization**: In-flight `connect()` promises are memoized so parallel tool calls safely share a single connection initialization, with clear rejection/closure cleanup rules.
- **Automatic fallback resolution**: Resolve transport availability at session start: (1) `tilth` binary on PATH; (2) `npx -y tilth --mcp` fallback; (3) graceful unavailable notification if neither is found.
  Drop mcporter server inspection.
- **Enable genuine session dedup & savings**: Because the stdio process remains active throughout the session, repeat reads of unmodified files trigger tilth's `[shown earlier]` elisions, and the `/tilth-savings` slash command reports real accumulated session savings.
- **Preserve tool interface and hashline compatibility**: All six tool names (`tilth_read`, `tilth_search`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`), parameter schemas, cwd/root/context scoping injection, and `pi-hashline-edit` anchor annotations remain intact.
  Elided repeat reads (`[shown earlier]`) pass through unannotated by design without committing to the snapshot store.
- **Drop external `mcporter` requirement**: Remove `mcporter` from installation prerequisites, documentation, and troubleshooting guides.

## Capabilities

### New Capabilities

- `native-mcp-transport`: Persistent in-process stdio MCP transport using `@earendil-works/pi-mcp`, managing the lifecycle, auto-healing, signal handling, and JSON-RPC dispatch to `tilth`.

### Modified Capabilities

- `tilth-tools`: Updates per-call timeout enforcement to use in-process `callTool`'s `timeoutMs` instead of child-process CLI execution, and updates unavailability scenarios.
- `tilth-savings-command`: Queries session token savings from the persistent in-process MCP client rather than a spawned mcporter CLI command.
- `mcporter-transport`: Deprecated and replaced by `native-mcp-transport`.

## Impact

- **Dependencies**: Add `@earendil-works/pi-mcp` to runtime `dependencies: "^0.99.1"` (since Pi loader does not export it as a host-provided package).
  Do not duplicate it in `devDependencies`.
  Bump `@earendil-works/pi-coding-agent` peer dependency to `>=0.99.1`.
- **Runtime code**: Replace `src/lib/mcporter.ts` with `src/lib/transport.ts`.
  Refactor `src/lib/availability.ts` to probe binary/npx directly.
  Repurpose `src/lib/result.ts` to adapt `CallToolResult` to text and errors with stderr capture.
  Wire lifecycle in `src/index.ts`.
- **Tests**: Update test suite to use the in-process transport seam, add crash-recovery and concurrent-connect tests, preserve `scope` and `config` test coverage, and assert `@earendil-works/pi-mcp` is in `dependencies` in `test/host-deps.test.ts`.
- **Performance**: Tool invocation latency drops from ~1,200 ms to <10 ms. Duplicate file reads in long sessions will be elided via `[shown earlier]`.
- **User experience**: Zero-configuration setup without `mcporter`.
