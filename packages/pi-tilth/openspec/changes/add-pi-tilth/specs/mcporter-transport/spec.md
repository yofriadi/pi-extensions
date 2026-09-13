## ADDED Requirements

### Requirement: Server resolution prefers a configured mcporter server and falls back to ad-hoc stdio

The extension SHALL resolve how to reach tilth's MCP server once per session, at `session_start`, in this order: (1) a configured mcporter server entry (default name `tilth`, overridable via config `serverName`); (2) ad-hoc stdio spawning a `tilth` binary found on PATH as `tilth --mcp`; (3) ad-hoc stdio spawning `npx -y tilth --mcp`; (4) unavailable.
The resolved mode SHALL be observable by tools at call time without re-probing.
The extension SHALL NOT write to the user's mcporter configuration.

#### Scenario: Configured server is preferred

- **WHEN** mcporter reports a configured server matching the configured `serverName`
- **THEN** all tilth calls in that session are invoked as `mcporter call <serverName>.<tool> --output json --args <json>` against that configured server

#### Scenario: Binary fallback when no config entry exists

- **WHEN** no configured mcporter server matches and a `tilth` binary is present on PATH
- **THEN** every call is invoked ad-hoc as `mcporter call --stdio tilth --stdio-arg --mcp --name <serverName> --tool <tool> --output json --args <json> --yes` without requiring or creating any configuration

#### Scenario: npx fallback when no binary exists

- **WHEN** neither a configured server nor a `tilth` binary is available but `npx` is present
- **THEN** every call is invoked ad-hoc as `mcporter call --stdio npx --stdio-arg -y --stdio-arg tilth --stdio-arg --mcp --name <serverName> --tool <tool> --output json --args <json> --yes`, and the extension notifies once per session that the first call may be slow (the download may exceed the per-call timeout; a retry after the download succeeds)

#### Scenario: Nothing available

- **WHEN** no configured server, no `tilth` binary, and no `npx` are available
- **THEN** the extension notifies the user with the exact remediation commands (tilth installation and the mcporter keep-alive config snippet) and every tilth tool throws the static explanatory error without attempting a call for the rest of the session

### Requirement: Each tool invocation is a single mcporter call with JSON I/O

Each tilth tool execution SHALL issue exactly one `mcporter call` following the pinned argv for the resolved mode (config: `["call", "<server>.<tool>", "--output", "json", "--args", json]`; ad-hoc: `["call", "--stdio", cmd, ...stdioArgs, "--name", serverName, "--tool", tool, "--output", "json", "--args", json, "--yes"]`), with the process cwd set to the pi session cwd and a per-call timeout from config (`callTimeoutMs`, default 60 seconds) enforced at the Exec seam via the host's process-exec timeout mechanism.
The extension SHALL parse the JSON envelope, SHALL join `text` content blocks into the tool result, and SHALL map an `isError` envelope to a thrown tool error carrying the server's own message.
Malformed JSON output, a non-zero exit, or a timeout SHALL produce a thrown tool error containing mcporter's stderr verbatim; the extension SHALL NOT fabricate, summarize, or retry tool output.

#### Scenario: Successful call returns server content

- **WHEN** mcporter exits 0 with a JSON envelope whose content is text blocks
- **THEN** the tool result content is the joined text of those blocks

#### Scenario: Server-reported error propagates as tool error

- **WHEN** the envelope has `isError: true`
- **THEN** the tool throws an error whose message contains the server's text (e.g. "missing required parameter: patterns")

#### Scenario: Transport failure surfaces stderr

- **WHEN** mcporter exits non-zero or emits output that is not a parseable envelope
- **THEN** the tool throws an error containing mcporter's raw stderr, and no content is invented

#### Scenario: Timeout is enforced at the Exec seam

- **WHEN** a call exceeds `callTimeoutMs`
- **THEN** the exec timeout (not any mcporter-internal timeout) terminates the process and the tool throws a timeout error

### Requirement: All paths are scoped to the session working directory

For every tool call the extension SHALL supply `root` as the absolute pi session cwd when the caller did not provide `root`, and SHALL resolve any relative `path`, `paths`, or `scope` values to absolute paths against the session cwd before invoking mcporter.
A caller-supplied `root` SHALL be honored: absolute values pass through unchanged (a deliberate escape hatch for cross-repo queries against the same server), and relative values are resolved against the session cwd like any other path.
The extension SHALL NOT send bare relative paths or scopes to the server, and SHALL NOT apply path resolution to git references (`a`, `b`, `log`) or non-path parameters.

Because the server resolves an omitted `scope` to its own process cwd — and a keep-alive mcporter daemon spawns the server in the daemon directory — the search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) SHALL additionally inject `scope: <resolved root>` (the caller-supplied `root`, else the session cwd) when the caller supplied no `scope`.
An explicitly supplied `scope` SHALL never be overridden.
`tilth_read` and `tilth_diff` SHALL receive no such injection: `tilth_read` has no scope parameter, and `tilth_diff`'s `scope` is an output filter, not a search root.
This behavior SHALL be identical across configured and ad-hoc server modes, so a keep-alive server rooted in another project cannot receive mis-scoped queries.

#### Scenario: Model omits root and passes a relative path

- **WHEN** a tool is called with `path: "src/index.ts"` and no `root`, from a session at `/repo`
- **THEN** mcporter receives `path: "/repo/src/index.ts"` and `root: "/repo"`

#### Scenario: Keep-alive server outlives the session that spawned it

- **WHEN** the configured tilth server was originally launched with cwd `/other-project` and the current pi session is at `/repo`
- **THEN** calls still carry `root: "/repo"`, absolute paths, and — on the search-root tools with no caller `scope` — `scope: "/repo"`, so results describe `/repo` rather than the server's own process cwd

#### Scenario: Bare search call in a keep-alive session

- **WHEN** `tilth_search` is called with only `query: "x"` from a session at `/repo` while the server's process cwd is `~/.mcporter`
- **THEN** mcporter receives `scope: "/repo"` in addition to `root: "/repo"`, and results describe `/repo`

#### Scenario: Diff scope is not injected

- **WHEN** `tilth_diff` is called with `a: "HEAD~1"` and no `scope`
- **THEN** the outgoing params contain no `scope`, because diff's scope filters the diff output and injecting the cwd would break file matching

#### Scenario: Git revisions are not path-resolved

- **WHEN** `tilth_diff` is called with `a: "HEAD~1"` and `b: "main"`
- **THEN** those values reach the server unchanged as git refs

### Requirement: Host prerequisites are documented, never auto-installed

The extension SHALL NOT install `mcporter` or `tilth`, SHALL NOT modify the user's mcporter configuration, and SHALL document in its README the keep-alive configuration that enables tilth's session dedup, including that a healthy mcporter daemon is required for keep-alive to function.

#### Scenario: User without keep-alive

- **WHEN** tilth is reached via ad-hoc mode (ephemeral server per call)
- **THEN** calls succeed and the README documents that session dedup (`[shown earlier]`) is only available with a configured keep-alive server
