# @yofriadi/pi-tilth

Tilth code-intelligence tools for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent), connected to tilth's MCP server through a persistent in-process stdio transport ([`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi)).

Six model-callable tools backed by tilth's tree-sitter + ripgrep MCP server — search, smart read, list, blast-radius, symbol deep-dive, structural diff — plus a `/tilth-savings` command.
When [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) is installed, `tilth_read` output is annotated with hashline anchors so edits can reference them directly.

## Install

```sh
pi install @yofriadi/pi-tilth
```

or add the repo checkout to your pi extensions.
No build step — pi loads `src/index.ts` directly (strip-only TypeScript).

## Prerequisites

- **Node >= 22.19.0**.
- **tilth**, one of:
  1. the `tilth` binary on PATH (`cargo install tilth` / `npm i -g tilth`) — 30s connect budget, instant startup, or
  2. `npx` on PATH — tilth is fetched on first use (120s connect budget; the first tool call may download it).

No MCP client, daemon, or server registration is required: the extension spawns `tilth --mcp` itself as a persistent stdio child process and talks JSON-RPC in-process via `@earendil-works/pi-mcp`.

## Tools

| Tool           | Replaces     | What it does                                                                                                                   |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `tilth_search` | grep/rg/Grep | Structural search: symbol definitions + usages with source inlined, callers, content, regex.                                   |
| `tilth_read`   | cat/Read     | Smart read: full content for small files, outline for large, `section`/`sections` for targeted slices, multi-file in one call. |
| `tilth_list`   | find/ls/tree | Glob patterns rendered as one directory tree with per-directory token rollups.                                                 |
| `tilth_deps`   | —            | Blast-radius check before breaking changes: imports + symbol-level dependents.                                                 |
| `tilth_grok`   | —            | One-call symbol deep-dive: definition, body, callees, callers, siblings, tests.                                                |
| `tilth_diff`   | git diff     | Structural diff: function-level change summaries, blast-radius warnings.                                                       |

Tool descriptions are verbatim transcriptions of the server's own (benchmark-tuned) descriptions, asserted byte-identical in tests against the frozen fixture `test/fixtures/tilth-server-schema.json`.
After upgrading tilth, refresh the fixture and descriptions using `client.listTools()` over the in-process transport (see `Development` below), then update the `DESCRIPTION` constants in `src/tools/*.ts` to match.

## `/tilth-savings`

User-invoked command; reports the tokens tilth estimates it saved this session versus naive grep/cat.
Calls the server's `tilth_savings` tool over the active persistent connection, so the report covers every read/search made this session — which per the server's own contract is reserved for explicit user requests, so it is a command, deliberately not a model-callable tool.

## Scoping

Every call injects `root: <session cwd>` when the caller did not supply one, and absolutizes relative `path`/`paths`/`scope` against the session cwd.
A caller-supplied absolute `root` passes through unchanged (a deliberate escape hatch for cross-repo queries).
Git references (`tilth_diff`'s `a`/`b`/`log`) are never path-resolved.
Because the server resolves an *omitted* `scope` to its own process cwd and ignores `root` for that purpose, the search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) additionally inject `scope: <resolved root>` when the caller supplied none.
Explicit `scope` is never overridden, and `tilth_read` / `tilth_diff` (whose `scope` is an output filter, not a root) receive no injection.

## Hashline compat (anchors on tilth_read output)

When **pi-hashline-edit** is installed and active, `tilth_read` output is rewritten line-by-line to hashline anchors (`NN#HASH:content`): every shown line is verified byte-equal against the normalized disk content, and only then is the read committed to the shared snapshot store via pi-hashline-edit's versioned compat contract (`pi-hashline-edit/compat`).
Anchors minted this way are bit-identical to what a native hashline read of the same bytes produces, so `edit` accepts anchors copied straight from tilth output.

On any mismatch (file changed between the server read and the disk verification) or unrecognized output shape (outline/signature/stripped views, `[empty]`/`[generated — skipped]` sentinels), that file's output passes through completely unannotated and nothing is committed.
The annotator never fabricates anchors or snapshots.
Budget-truncated full reads are the one deliberate exception: the verified **prefix** is annotated (and the snapshot committed) while the `... truncated (...)` marker passes through untouched — the same semantics a native truncated hashline read has, so anchors minted on the shown prefix still resolve in `edit`.

Repeat-read elisions (`[shown earlier]`) also pass through unannotated by design: elided regions cannot be verified against disk lines, so no anchors are fabricated and no snapshot is committed.

Topology: pi loads every extension in an isolated module instance (its loader creates a fresh jiti per extension with `moduleCache: false`), so **importing** `pi-hashline-edit/compat` from another extension yields a second copy with its own snapshot store. pi-hashline-edit therefore publishes its live compat module on the process global (`globalThis.__piHashlineEditCompat`) at extension load, and pi-tilth resolves that entry first, falling back to the dynamic import for same-module-tree runtimes.
Both paths are gated per call: `COMPAT_VERSION === 1`, `isHashlineEditActive()`, and config not disabled.

Disable with `~/.pi/agent/extensions/pi-tilth/config.json` or `<project>/.pi/extensions/pi-tilth/config.json` (project wins):

```json
{
	"connectTimeoutMs": 30000,
	"callTimeoutMs": 60000,
	"hashlineCompat": false
}
```

`connectTimeoutMs` is optional: when omitted it defaults to 120,000 ms in `npx` mode (cold-cache download) and 30,000 ms for a local binary.
`callTimeoutMs` (default 60,000 ms) cancels the pending JSON-RPC request in-process — the persistent server process is not killed, so the connection stays usable after a timeout.
Unknown fields are dropped; malformed files warn once and fall back to defaults.

Per-session opt-out: launch with `pi --tilth-no-hashline` to skip anchor annotation entirely — it overrides both config files.
Useful for read-only sessions (e.g. subagents with read permission only) where edit anchors add token overhead without benefit.

Per-call opt-out: `tilth_read` accepts `raw: true` to return plain text without anchors for that single call — identical to hashline-edit read's `raw` param.
This is the right lever when a session can't receive CLI flags (e.g. subagents spawned by pi-subagent-herdr, which builds the child's launch command itself): the model just sets `raw` on calls where it will not edit the file.
`raw` is client-side only — it is stripped before the call reaches the server and skips both annotation and the snapshot commit.

## Transport

A single persistent `tilth --mcp` stdio child process per Pi session, driven in-process through `@earendil-works/pi-mcp`'s `McpClient` and `StdioTransport`:

- **Availability** is probed once at `session_start`, in order: `tilth` binary on PATH → `npx` on PATH → unavailable (notify with remediation; every tool call then throws the same static error without spawning anything).
- **Lazy connect**: the child process spawns on the first tool call, not at session start, so sessions that never use tilth pay nothing.
  Concurrent first calls share one memoized connect — exactly one process is spawned.
- **Persistent**: the connection stays open across turns, which activates tilth's session memory — repeat-read dedup (`[shown earlier]` elisions) and the `/tilth-savings` counters.
- **Auto-healing**: if the child process dies unexpectedly, the next call discards the dead client and lazily constructs a fresh `StdioTransport` + `McpClient` (at most one reconnect per call).
  Note the fresh server starts with empty read history and savings counters — an unexpected `/tilth-savings` reset to zero means the server restarted in the background.
- **Teardown**: on `session_shutdown` (quit, reload, new, resume, fork) the client is closed, which SIGTERMs the child process group (2s grace, then SIGKILL).

Timeouts: the `initialize` handshake is bounded by `connectTimeoutMs` (see config above); each tool call is bounded by `callTimeoutMs`, enforced by the MCP client cancelling the pending request.
Tool invocations are sub-10 ms after connect — no process spawn per call.

## Troubleshooting

- **"tilth is not available" banner / every tool errors**: neither the `tilth` binary nor `npx` was found on PATH.
  Fix either (see Prerequisites) and start a new session.
- **First call times out in npx mode**: expected on a cold npx cache — the 120s connect budget usually covers the download, but a slow network can exceed it; retry, the cache is then warm.
- **`/tilth-savings` suddenly reports zero**: the tilth server process restarted (crash + auto-heal, or a session reload).
  Savings are counted per server process; a restart zeroes them.
- **Every call times out but the connection stays up**: the server process wedged (alive but not responding — auto-heal only covers process death, and timeouts cancel the request without killing the child).
  Reload the session (`/reload` or a new session) to tear down and respawn tilth.
- **tilth output not hashline-annotated**: check that (a) pi-hashline-edit is installed and loaded (it publishes the process-global compat entry at load), (b) `hashlineCompat` is not disabled in config, (c) the output shape is annotatable — outlines, signature views, stripped views, and sentinel-only outputs pass through by design. (Budget-truncated full reads *do* annotate their verified prefix.)
- **`[shown earlier]` in output**: tilth's session dedup eliding content already shown over the persistent connection; the annotator passes it through unannotated (no commit).
  If you need to edit the file, re-read with `full: true` or `section`.

## Development

```sh
pnpm install          # workspace install
pnpm test             # unit + loader + interop tests
pnpm test:integration # opt-in: real in-process MCP round-trips against tilth
pnpm run check        # biome + tsc
```

Tests load the real extension through `discoverAndLoadExtensions` (no loader mocking) and exercise the real `pi-hashline-edit/compat` via the workspace dependency.
The opt-in integration suite connects a real in-process MCP stdio client to `tilth --mcp`.

### Refreshing the server schema fixture

`test/fixtures/tilth-server-schema.json` freezes the live server's tool descriptions/schemas.
Refresh it with `client.listTools()` over the in-process transport:

```ts
import { writeFileSync } from "node:fs";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const client = new McpClient({ name: "pi-tilth", version: "0.1.0" });
await client.connect(new StdioTransport({ command: "tilth", args: ["--mcp"] }));
writeFileSync(
	"test/fixtures/tilth-server-schema.json",
	JSON.stringify({ tools: await client.listTools() }, null, 2),
);
await client.close();
```

then update the `DESCRIPTION` constants in `src/tools/*.ts` to match.

## License

MIT — see [LICENSE](./LICENSE). tilth itself is MIT © Jahala (see [THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt](./THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt)); the bundled skill is adapted from tilth's upstream SKILL.md.
