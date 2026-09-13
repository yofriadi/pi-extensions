# @yofriadi/pi-tilth

Tilth code-intelligence tools for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent), bridged through [mcporter](https://github.com/steipete/mcporter).

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
- **mcporter** on PATH (`brew install steipete/tap/mcporter`).
- **tilth**, one of:
  1. a configured mcporter server entry (recommended — enables tilth's session dedup via mcporter's keep-alive daemon), or
  2. the `tilth` binary on PATH (`cargo install tilth` / `npm i -g tilth`), or
  3. `npx` on PATH — tilth is fetched ad hoc per call.

### Recommended: keep-alive server (session dedup)

Add to `~/.mcporter/mcporter.json`:

```json
{
	"mcpServers": {
		"tilth": {
			"command": "tilth",
			"args": ["--mcp"],
			"lifecycle": "keep-alive",
			"idleTimeoutMs": 300000
		}
	}
}
```

The equivalent `mcporter config add tilth --stdio tilth --arg --mcp` creates the stdio entry but has no flags for `lifecycle`/`idleTimeoutMs` — edit the JSON to add them.

Session dedup additionally requires a healthy mcporter daemon (`mcporter daemon status`; if the daemon is stale, `mcporter daemon migrate …` as mcporter itself suggests).
Without the daemon, keep-alive entries still work but each call pays connection setup, and tilth's repeat-read dedup (`[shown earlier]` elisions) cannot form.

> Note: `tilth install pi` writes `~/.pi/agent/mcp.json`, which pi ≤ 0.85.1 does not read.
> It is inert for this integration — configure mcporter instead.

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
After upgrading tilth, refresh the fixture and descriptions:

```sh
mcporter list --stdio npx --stdio-arg -y --stdio-arg tilth --stdio-arg --mcp \
  --name tilth --schema --all-parameters --json --yes \
  > test/fixtures/tilth-server-schema.json
```

then update the `DESCRIPTION` constants in `src/tools/*.ts` to match.

## `/tilth-savings`

User-invoked command; reports the tokens tilth estimates it saved this session versus naive grep/cat.
Calls the server's `tilth_savings` tool, which per its own contract is reserved for explicit user requests — so it is a command, deliberately not a model-callable tool.

## Scoping

Every call injects `root: <session cwd>` when the caller did not supply one, and absolutizes relative `path`/`paths`/`scope` against the session cwd.
A caller-supplied absolute `root` passes through unchanged (a deliberate escape hatch for cross-repo queries).
Git references (`tilth_diff`'s `a`/`b`/`log`) are never path-resolved.
Because the server resolves an *omitted* `scope` to its own process cwd — and for a keep-alive mcporter daemon that is the daemon directory, not the session — the search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) additionally inject `scope: <resolved root>` when the caller supplied none.
Explicit `scope` is never overridden, and `tilth_read` / `tilth_diff` (whose `scope` is an output filter, not a root) receive no injection.
Identical behavior in configured and ad-hoc modes, so a keep-alive server rooted elsewhere cannot receive mis-scoped queries.

## Hashline compat (anchors on tilth_read output)

When **pi-hashline-edit** is installed and active, `tilth_read` output is rewritten line-by-line to hashline anchors (`NN#HASH:content`): every shown line is verified byte-equal against the normalized disk content, and only then is the read committed to the shared snapshot store via pi-hashline-edit's versioned compat contract (`pi-hashline-edit/compat`).
Anchors minted this way are bit-identical to what a native hashline read of the same bytes produces, so `edit` accepts anchors copied straight from tilth output.

On any mismatch (file changed between the server read and the disk verification) or unrecognized output shape (outline/signature/stripped views, `[empty]`/`[generated — skipped]` sentinels), that file's output passes through completely unannotated and nothing is committed.
The annotator never fabricates anchors or snapshots.
Budget-truncated full reads are the one deliberate exception: the verified **prefix** is annotated (and the snapshot committed) while the `... truncated (...)` marker passes through untouched — the same semantics a native truncated hashline read has, so anchors minted on the shown prefix still resolve in `edit`.

Topology: pi loads every extension in an isolated module instance (its loader creates a fresh jiti per extension with `moduleCache: false`), so **importing** `pi-hashline-edit/compat` from another extension yields a second copy with its own snapshot store. pi-hashline-edit therefore publishes its live compat module on the process global (`globalThis.__piHashlineEditCompat`) at extension load, and pi-tilth resolves that entry first, falling back to the dynamic import for same-module-tree runtimes.
Both paths are gated per call: `COMPAT_VERSION === 1`, `isHashlineEditActive()`, and config not disabled.

Disable with `~/.pi/agent/extensions/pi-tilth/config.json` or `<project>/.pi/extensions/pi-tilth/config.json` (project wins):

```json
{
	"serverName": "tilth",
	"callTimeoutMs": 60000,
	"hashlineCompat": false
}
```

Unknown fields are dropped; malformed files warn once and fall back to defaults.

Per-session opt-out: launch with `pi --tilth-no-hashline` to skip anchor annotation entirely — it overrides both config files.
Useful for read-only sessions (e.g. subagents with read permission only) where edit anchors add token overhead without benefit.

Per-call opt-out: `tilth_read` accepts `raw: true` to return plain text without anchors for that single call — identical to hashline-edit read's `raw` param.
This is the right lever when a session can't receive CLI flags (e.g. subagents spawned by pi-subagent-herdr, which builds the child's launch command itself): the model just sets `raw` on calls where it will not edit the file.
`raw` is client-side only — it is stripped before the call reaches the server and skips both annotation and the snapshot commit.

## Transport resolution

Probed once at `session_start`, in order:

1. **Configured mcporter server** — `mcporter list <serverName> --status --json --quiet` (default server name `tilth`, configurable).
2. **`tilth` binary** on PATH — ad-hoc `mcporter call --stdio tilth --stdio-arg --mcp …`.
3. **npx fallback** — ad-hoc `mcporter call --stdio npx --stdio-arg -y --stdio-arg tilth --stdio-arg --mcp …`.
4. **Unavailable** — notify with remediation text; every tool call throws the same static error.

Timeouts are enforced at the exec seam (pi.exec's `timeout`, default 60s per call — `callTimeoutMs`). mcporter is invoked exactly once per tool call; no daemons are spawned by pi-tilth itself.
A killed process (timeout or user abort) is always a thrown tool error even if stdout contains a complete JSON envelope — pi's exec resolves `code ?? 0` for signal-deaths, so pi-tilth consults the `killed` flag first.

### Measured ad-hoc latency (macOS, 2026-09-08, tilth 0.10.1 via npx)

- Warm npx cache: **~0.8–2.7 s** per call (median ≈ 1.2 s) — the dominant cost is node startup, not tilth.
- Cold npx cache (real download): **~33 s** observed, within the default 60 s budget but network-dependent.
  If the first call times out, retry immediately — the npx cache is now warm and the retry completes normally.

These are single-machine measurements, treat them as estimates for your environment.
Configured-server mode skips node startup entirely and is the fastest option.

## Troubleshooting

- **"tilth is not available" banner / every tool errors**: no configured server, no `tilth` binary, and npx probe failed.
  Fix any of the three (see Prerequisites) and start a new session.
- **First call times out in npx mode**: expected on a cold npx cache; retry.
  Consider installing the binary or configuring the keep-alive server.
- **No dedup / repeated full outputs on re-reads**: mcporter daemon not healthy (needed for session dedup); check `mcporter daemon status`.
- **tilth output not hashline-annotated**: check that (a) pi-hashline-edit is installed and loaded (it publishes the process-global compat entry at load), (b) `hashlineCompat` is not disabled in config, (c) the output shape is annotatable — outlines, signature views, stripped views, and sentinel-only outputs pass through by design. (Budget-truncated full reads *do* annotate their verified prefix.)
- **`[shown earlier]` in output**: tilth's keep-alive dedup eliding a repeat read; the annotator treats it as unrecognizable and passes the file through unannotated (no commit).

## Development

```sh
pnpm install          # workspace install
pnpm test             # unit + loader + interop tests
pnpm test:integration # opt-in: real mcporter/tilth round-trips (network)
pnpm run check        # biome + tsc
```

Tests load the real extension through `discoverAndLoadExtensions` (no loader mocking) and exercise the real `pi-hashline-edit/compat` via the workspace dependency.
The opt-in integration suite shells out to `mcporter` against `npx tilth --mcp`.

## License

MIT — see [LICENSE](./LICENSE). tilth itself is MIT © Jahala (see [THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt](./THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt)); the bundled skill is adapted from tilth's upstream SKILL.md.
