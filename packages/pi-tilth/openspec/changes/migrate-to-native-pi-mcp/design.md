## Context

`pi-tilth` provides six code-intelligence tools (`tilth_read`, `tilth_search`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`) plus the `/tilth-savings` command.
Currently, these tools execute by invoking `mcporter call <server.tool>` via child processes on every single call.

This CLI subprocess model has two fatal flaws:

1. **No session memory**: Tilth relies on an active MCP client connection to remember read fingerprints.
   Every `mcporter call` runs in an isolated client context, resetting tilth's session state.
   Out of 12,843 production calls in the user's workspace, repeat-read dedup (`[shown earlier]`) fired only once, and `/tilth-savings` permanently reported 0 reads.
2. **High latency and external burden**: Spawning a Node/CLI process costs ~1,200 ms per call and requires installing, configuring, and maintaining `mcporter` and its daemon socket.

Pi 0.99.1 bundles `@earendil-works/pi-mcp`, providing an in-process MCP client (`McpClient`) and transport (`StdioTransport`).

## Central Assumption

This entire design rests on the load-bearing assumption that `tilth` maintains its read fingerprint cache and token savings counters in memory across requests on an open MCP connection.
This assumption was validated during planning via an in-process spike: over a single persistent stdio connection, `tilth_read` on an outline-mode file and search queries produced ~22,959 saved tokens (95% reduction) in `tilth_savings`, whereas per-call CLI invocations permanently produced 0.
An early verification task in Phase 1/2 tests this contract directly.

## Goals / Non-Goals

**Goals:**

- Replace `mcporter` with an in-process `McpClient` managing a persistent `tilth --mcp` stdio process per session.
- Enable tilth's session read dedup (`[shown earlier]`) and accurate `/tilth-savings` tracking.
- Reduce tool invocation latency from ~1,200 ms to <10 ms.
- Eliminate the external `mcporter` installation and daemon prerequisite.
- Preserve all six tool names (`tilth_read`, `tilth_search`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`), parameter schemas, and scoping logic.
- Preserve `pi-hashline-edit` anchor annotations on normal and truncated reads.

**Non-Goals:**

- Exposing tools via Pi's generic `mcp__tilth__*` naming convention (this would break prompt templates, `p.fish`, and skills).
- Supporting remote HTTP or SSE transports for tilth (tilth is a local CLI tool designed for stdio).
- Auto-installing the `tilth` binary (remains documented as a prerequisite or handled via `npx`).
- Preserving hashline edit anchors on `[shown earlier]` elisions (elided content passes through unannotated by design, as disk verification cannot reconstruct elided regions).

## Decisions

### Decision 1: In-process `@earendil-works/pi-mcp` client vs declarative `mcp.json` or `pi.registerMcpServer()`

- **Chosen**: In-process `McpClient` managed within `pi-tilth`.
- **Rationale**:
  - Declarative `mcp.json` and programmatic `pi.registerMcpServer()` both expose tools as `mcp__tilth__tilth_*`, breaking user workflows, prompt guidelines, and shell aliases (`p.fish`).
  - Both built-in MCP integration surfaces pass tool results directly to the model, completely bypassing `pi-hashline-edit` anchor annotation and breaking the `edit` tool.
  - Both expose `tilth_savings` as a model-callable tool rather than a slash command, risking gratuitous LLM calls.
  - In-process `McpClient` keeps all custom formatting, parameter defaults, and anchor pipelines while providing a direct JSON-RPC transport over stdio.
- **Alternatives considered**:
  - *Declarative `mcp.json` with a `tool_result` event hook*: Feasible, but forces tool renaming to `mcp__tilth__*` and complicates scoping injection.

### Decision 2: Session-scoped client lifecycle with auto-healing and memoized connect

- **Chosen**: Manage one `TilthMcpTransport` singleton per extension instance:
  - Resolve availability at `session_start` (`binary` vs `npx` vs `unavailable`).
  - Initialize and connect `McpClient` lazily on the first tilth tool invocation, rooted at `sessionCwd`.
  - Memoize the in-flight `connectPromise` so concurrent tool calls safely share a single initialization without duplicate process spawning.
  - Clear `connectPromise` on rejection and on client close so subsequent calls can retry cleanly.
  - When a caller signal aborts during initial connect, race the memoized promise against the signal: the caller rejects immediately, but the in-flight connect continues in the background for subsequent calls.
  - Subscribe to `client.onClose()`.
    Guard the listener with an identity check (`if (client !== this.client) return`) to prevent a stale close event from nullifying a newer client.
  - If the child process dies unexpectedly, discard the dead instance and lazily reconstruct a fresh `StdioTransport` and `McpClient` on the next call (at most one reconnect per call), avoiding session-wide lockout.
  - On idempotent `session_shutdown` (for all reasons: quit, reload, new, resume, fork), set a `disposed` flag so post-shutdown calls do not respawn, and call `await client.close()`.
- **Rationale**: `McpClient` is single-use; once closed, it cannot reconnect.
  Auto-healing ensures the extension matches today's self-healing per-call behavior against transient panics or OOMs.
- **Alternatives considered**:
  - *Eager connect on `session_start`*: Slows down session initialization for sessions that never use tilth tools.

### Decision 3: Connect timeout for npx cold start vs per-call timeout

- **Chosen**: Add optional `connectTimeoutMs?: number` to `TilthConfig`.
  Resolve at connect time: `const connectTimeout = config.connectTimeoutMs ?? (mode === "npx" ? 120_000 : 30_000);` Pass this as `requestTimeoutMs` to `new McpClient({ requestTimeoutMs: connectTimeout })`, while individual tool calls pass `timeoutMs: config.callTimeoutMs` (default 60s) to `client.callTool()`.
- **Rationale**: `McpClient.connect()` issues the `initialize` request using the client-level `requestTimeoutMs`.
  In `npx` mode, downloading tilth on a cold cache takes ~33s.
  A 30s default causes initialization to time out and permanently closes the transport.
- **Alternatives considered**:
  - *Unified single timeout*: A 120s timeout on all tool calls would excessively delay failure reporting on hung searches.

### Decision 4: Dependency declaration

- **Chosen**: Declare `@earendil-works/pi-mcp` in `dependencies: "^0.99.1"` (runtime dependency) only.
  Do not duplicate in `devDependencies`.
- **Rationale**: `@earendil-works/pi-mcp` is **not** included in `HOST_PROVIDED_EXTENSION_PACKAGES` in Pi's loader.
  Listing it in `peerDependencies: "*"` with only `devDependencies` causes runtime module resolution failure when installed via `pi install @yofriadi/pi-tilth`.
  Declaring it as a regular runtime dependency ensures npm/pnpm installs it for consumers.
  This creates an isolated package copy at runtime, which is safe because `pi-tilth` never depends on cross-package `instanceof` checks against host-instantiated MCP classes.
  Duplicating in `devDependencies` is redundant and anti-pattern in this repo.
- **Alternatives considered**:
  - *peerDependencies with `*`*: Broken for standalone `pi install` users without host jiti aliases.

### Decision 5: Result parsing, stderr capture, and error mapping

- **Chosen**: Adapt `src/lib/result.ts` to transform `CallToolResult` into string output:
  - `McpClient` keeps its transport reference private, so `TilthMcpTransport` retains its own `StdioTransport` reference.
  - Join all `TextContent` blocks into a single string.
  - On `isError: true`, throw `ServerToolError` with the joined text.
  - Stderr is captured from the transport instance bound to *that attempt* before any reconnect/auto-heal occurs.
  - On transport error or process failure, rethrow as `TransportError` with the captured stderr.
  - Preserve `ServerToolError` and `TransportError` exports from `src/toolkit.ts` for backward compatibility.
  - Handle late responses arriving after `callTimeoutMs`: `client.onError` emits "Received response for unknown MCP request"; log at debug level without surfacing spurious warnings to the user.
- **Rationale**: Keeps error semantics identical to current behavior while leveraging `StdioTransport`'s built-in 64KB stderr ring buffer.

## Risks / Trade-offs

- **[Risk] Long-running child process could hang or leak on crash** → *Mitigation*: `StdioTransport` spawns with detached process groups and cleans up via its built-in `process.once("exit")` hook SIGTERMing live process groups.
  The extension's idempotent `session_shutdown` handler calls `await client.close()`, which closes the transport with its configured `closeTimeoutMs` (2,000 ms).
  We do not register custom process-level SIGINT/SIGTERM handlers, avoiding listener accumulation on reload/fork and avoiding turn-abort interference.
- **[Risk] Slower first call in `npx` mode**
  → *Mitigation*: When resolved mode is `npx`, notify the user once on session start that initial package fetching may take time, and use `connectTimeoutMs: 120_000`.
- **[Risk] Auto-heal reconnect resets tilth session counters** → *Mitigation*: When tilth crashes and is auto-healed, the fresh server process naturally starts with empty read history and savings counters.
  Document in README/troubleshooting that unexpected `/tilth-savings` resets indicate a background server restart.
- **[Risk] Subagent fan-out multiplies persistent tilth processes** → *Mitigation*: In Pi, subagents spawned via `pi-subagent-herdr` run in independent processes and load their own extension instances.
  Each subagent calling tilth spawns its own `tilth --mcp` process with isolated dedup state.
  `/tilth-savings` reports savings for the current process only.
  This trade-off is acceptable because tilth's idle memory footprint is low (~15-30MB) and subagent panes terminate on settlement.
- **[Risk] Hashline anchors missing on elided repeat reads (`[shown earlier]`)** → *Mitigation*: As previously documented, `[shown earlier]` elisions cannot be verified against disk lines and pass through unannotated (no snapshot committed).
  This is safe against file corruption, but users editing a file must re-read with `full: true` or `section` if the file was elided.

## Migration Plan

*Note on OpenSpec change archiving order: The baseline change `add-pi-tilth` should be archived (`openspec archive add-pi-tilth`) prior to archiving `migrate-to-native-pi-mcp` so that delta specifications resolve cleanly against authoritative baseline specs.*

1. Update `package.json`: Add `@earendil-works/pi-mcp` to `dependencies: "^0.99.1"` only.
   Bump `@earendil-works/pi-coding-agent` peer dependency to `>=0.99.1`.
2. Update `src/lib/config.ts`: Add optional `connectTimeoutMs?: number`, drop `serverName`.
   Note that `callTimeoutMs` now cancels the in-flight request rather than killing the process.
3. Implement `src/lib/transport.ts`: Create `TilthMcpTransport` class wrapping `McpClient` and `StdioTransport` with auto-healing, lazy memoized connect, identity-guarded close listener, and clean shutdown.
4. Update `src/lib/availability.ts`: Probe `tilth` binary and `npx` directly without `mcporter`.
   Remove `"config"` member of `TransportMode`, `AdHocDescriptor`/`getAdHocDescriptor`, `serverName` parameter of `refresh()`, and mcporter text inside `unavailableMessage()`.
5. Remove `src/lib/mcporter.ts` and repurpose `src/lib/result.ts` to convert `CallToolResult`.
6. Update `src/toolkit.ts` (`runTilthCall`) to route through `transport.callTool()`.
7. Update `src/index.ts`: Wire session lifecycle (`session_start`, idempotent `session_shutdown`).
8. Update `src/commands/savings.ts`: Query `tilth_savings` over the active transport.
9. Update test suite: Replace mcporter CLI mocks with in-process transport mocks, fix `AbortSignal` in `test/raw-param.test.ts`, add crash-recovery and concurrent-connect tests, preserve `scope` and `config` describes.
10. Update `README.md`, `CHANGELOG.md`, and module comments to remove all `mcporter` references and document native MCP operation.
