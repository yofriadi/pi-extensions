## ADDED Requirements

### Requirement: Persistent in-process stdio MCP transport manages tilth lifecycle with auto-healing

The extension SHALL manage an in-process MCP client backed by `@earendil-works/pi-mcp`'s `StdioTransport` and `McpClient`.
The transport SHALL connect to `tilth` running in MCP mode over stdio when requested in a session, maintain the connection across turns, and close the connection and child process on `session_shutdown`.
Concurrent tool calls SHALL await a single memoized in-flight connection promise so only one process is spawned.
The memoized connection promise SHALL be cleared on rejection or close so subsequent calls can retry.
If the underlying child process terminates unexpectedly or emits a connection error, the transport SHALL discard the closed client and lazily reconstruct a fresh client and stdio transport on the next call, retrying at most once per call before failing.
The close handler SHALL be identity-guarded (`if (client !== this.client) return`) to prevent a stale close event from nullifying a newer client.
An intentional close from session shutdown SHALL mark the transport as disposed so post-shutdown calls do not respawn child processes.

#### Scenario: Persistent connection established and reused

- **WHEN** a session requests a tilth tool call and tilth is available
- **THEN** an `McpClient` connects to `tilth --mcp` over stdio, and subsequent calls in that session reuse the open connection without spawning new processes

#### Scenario: Concurrent first calls share connection

- **WHEN** multiple tilth tools are invoked concurrently while no connection is yet active
- **THEN** all callers await the same in-flight `connect()` promise and exactly one child process is spawned

#### Scenario: Auto-healing on unexpected server exit

- **WHEN** the underlying `tilth` process dies during or between calls
- **THEN** the transport discards the dead client, constructs a fresh `StdioTransport` and `McpClient` on the next call, and proceeds without requiring a full session restart

#### Scenario: Clean teardown on session shutdown

- **WHEN** an idempotent `session_shutdown` handler fires (for any reason: quit, reload, new, resume, fork)
- **THEN** the transport calls `await client.close()`, which closes the stdio transport with its configured `closeTimeoutMs` (2,000 ms), terminating the child process group

### Requirement: Transport availability resolution and cold-start connect timeout

The extension SHALL probe tilth availability once per session at `session_start` in the following order:

1. `tilth` binary present on PATH (invoked as `tilth --mcp`)
2. `npx` present on PATH (invoked as `npx -y tilth --mcp`)
3. `unavailable` if neither executable is reachable

When creating the `McpClient`, the extension SHALL specify a `requestTimeoutMs` acting as the connection/initialize budget (`connectTimeoutMs`: user-configured in `TilthConfig`, or defaulting to 120,000 ms for `npx`, 30,000 ms for `binary`).
The connect phase SHALL be bounded by this timeout; individual tool calls SHALL enforce `callTimeoutMs` separately.
The extension SHALL NOT inspect or require `mcporter`.

#### Scenario: Local tilth binary is present

- **WHEN** `tilth` is on the system PATH
- **THEN** the transport resolves to mode `binary` and connects with a 30s connection budget

#### Scenario: npx fallback when binary is absent

- **WHEN** `tilth` is absent from PATH but `npx` is present
- **THEN** the transport resolves to mode `npx` and connects with a 120s connection budget, notifying the user once that package fetching may delay initial startup

#### Scenario: Neither binary nor npx available

- **WHEN** neither `tilth` nor `npx` is available
- **THEN** the transport resolves to `unavailable`, notifies the user with remediation commands (`cargo install tilth` / `npm i -g tilth`), and all tilth tools throw a static explanatory error without attempting process execution

### Requirement: Tool invocation via in-process JSON-RPC callTool with stderr surfacing

Each tilth tool execution SHALL call `client.callTool(toolName, scopedParams, { signal, timeoutMs: config.callTimeoutMs })` on the active `McpClient`.
The call timeout SHALL be enforced per call via `timeoutMs: config.callTimeoutMs` (default 60,000 ms).
If the caller's `signal` aborts while awaiting a tool call, `callTool` SHALL cancel the pending request and reject with an abort error.
The extension SHALL join text content blocks into the tool result.
If the result has `isError: true`, the tool SHALL throw a `ServerToolError` carrying the server's text verbatim.
If the transport fails or the server emits non-zero exit/connection loss, the tool SHALL throw a `TransportError` that includes the server's captured stderr from the transport instance bound to that attempt.

#### Scenario: Successful tool call returns text

- **WHEN** `client.callTool` completes successfully with text content blocks
- **THEN** the joined text is returned for processing and hashline annotation

#### Scenario: Server reports isError

- **WHEN** `client.callTool` returns a result with `isError: true`
- **THEN** the tool throws `ServerToolError` containing the server's text verbatim

#### Scenario: Transport failure surfaces captured stderr

- **WHEN** a call fails due to transport error or process crash
- **THEN** the thrown `TransportError` includes the server's captured stderr from the transport instance bound to that attempt

#### Scenario: Call timeout or cancellation during execution

- **WHEN** an in-flight tool call exceeds `callTimeoutMs` or the caller signal aborts
- **THEN** the client cancels the pending request, rejects with an abort/timeout error, and clears request state without wedging the persistent connection

### Requirement: All paths are scoped to the session working directory

For every tool call the extension SHALL supply `root` as the absolute pi session cwd when the caller did not provide `root`, and SHALL resolve any relative `path`, `paths`, `scope`, or `context` values to absolute paths against the session cwd before dispatching to the MCP client.
A caller-supplied `root` SHALL be honored: absolute values pass through unchanged (a deliberate escape hatch for cross-repo queries), and relative values are resolved against the session cwd like any other path.
The extension SHALL NOT send bare relative paths, scopes, or context paths to the server, and SHALL NOT apply path resolution to git references (`a`, `b`, `log`) or non-path parameters.
Because the server resolves an omitted `scope` to its own process cwd, the search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) SHALL additionally inject `scope: <resolved root>` (the caller-supplied `root`, else the session cwd) when the caller supplied no `scope`.
An explicitly supplied `scope` SHALL never be overridden.
`tilth_read` and `tilth_diff` SHALL receive no such scope injection: `tilth_read` has no scope parameter, and `tilth_diff`'s `scope` is an output filter, not a search root.

#### Scenario: Model omits root and passes a relative path

- **WHEN** a tool is called with `path: "src/index.ts"` and no `root`, from a session at `/repo`
- **THEN** the MCP call receives `path: "/repo/src/index.ts"` and `root: "/repo"`

#### Scenario: Relative context parameter in search

- **WHEN** `tilth_search` is called with `context: "src/index.ts"` from a session at `/repo`
- **THEN** the MCP call receives `context: "/repo/src/index.ts"`

#### Scenario: Bare search call injects default scope

- **WHEN** `tilth_search` is called with only `query: "x"` from a session at `/repo`
- **THEN** the MCP call receives `scope: "/repo"` in addition to `root: "/repo"`

#### Scenario: Diff scope is not injected

- **WHEN** `tilth_diff` is called with `a: "HEAD~1"` and no `scope`
- **THEN** the outgoing params contain no `scope`

#### Scenario: Git revisions are not path-resolved

- **WHEN** `tilth_diff` is called with `a: "HEAD~1"` and `b: "main"`
- **THEN** those values reach the server unchanged as git refs

### Requirement: Repeat-read dedup interaction with hashline annotation

When a persistent session produces `[shown earlier]` elisions on repeat reads of unchanged files, the annotator does not verify against disk lines and SHALL pass the output through unannotated without committing to `pi-hashline-edit`.
The extension SHALL NOT fabricate anchors or synthesize snapshots for elided content.

#### Scenario: Repeat read elision passes through unannotated

- **WHEN** `tilth_read` returns output containing `[shown earlier]`
- **THEN** the output passes through without hashline anchors and no snapshot is committed
