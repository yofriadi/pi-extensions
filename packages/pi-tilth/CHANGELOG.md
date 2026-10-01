# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (native MCP migration)

- Transport: `mcporter` is removed entirely. The six tools and `/tilth-savings` now talk to `tilth --mcp` over one persistent in-process stdio connection managed by `@earendil-works/pi-mcp` (`McpClient` + `StdioTransport`) instead of spawning a `mcporter call` child process per tool call. Tool-call latency drops from ~1.2 s (process spawn) to sub-10 ms in-process JSON-RPC, and the long-lived connection activates tilth's session memory: repeat-read dedup (`[shown earlier]` elisions) and real `/tilth-savings` counters (previously permanently 0 because every CLI invocation was an isolated client).
- Lifecycle: the stdio child spawns lazily on the first tool call (concurrent first calls share one memoized connect), survives across turns, auto-heals by reconstructing a fresh client + transport at most once per call if the server dies (a restart zeroes the session's savings counters), and is closed idempotently on `session_shutdown` (quit, reload, new, resume, fork). Note a fresh server process starts with empty read history.
- Timeouts: `connectTimeoutMs` (new optional config key; default 120 s in `npx` mode for cold-cache downloads, 30 s for a local binary) bounds the MCP `initialize` handshake. `callTimeoutMs` (default 60 s) is now enforced by the MCP client cancelling the pending request in-process — the server process is no longer killed on timeout and the connection stays usable.
- Availability probing no longer inspects mcporter: `tilth` binary on PATH → `npx` → unavailable (static remediation message unchanged in shape). The `serverName` config key is gone.
- `[shown earlier]` elisions pass through unannotated by design: elided regions cannot be verified against disk lines, so no hashline anchors are fabricated and no snapshot is committed.
- Dependencies: `@earendil-works/pi-mcp` added as a runtime `dependencies: "^0.99.1"` entry (it is not a host-provided package, so a `peerDependencies` declaration would break standalone `pi install`); the `@earendil-works/pi-coding-agent` peer floor is now `>=0.99.1`. `mcporter` removed from keywords/description.


### Changed

- Packaging: `typebox` moved out of `dependencies` into `peerDependencies` as `"*"`, with an exact `devDependencies` pin (`1.3.27`) matching the copy the pi 0.99.2 host bundles. pi's resource loader warns when a host-provided package is declared under `dependencies`. Runtime behaviour is unchanged: the loader intercepts the bare `typebox` specifier — jiti alias in built mode, virtual module in compiled and TS-source modes — and serves pi's own copy ahead of node resolution, so no duplicate instance was ever observable. `pi install` never resolves peers, so a managed tree no longer carries a second copy either.
- Test host bumped to `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `0.99.2` as devDependencies (the `>=0.75.0` peers are unchanged), so `discoverAndLoadExtensions` exercises the loader production runs instead of 0.84.3. That also closes a version split: the 0.84.3 alias served `typebox` 1.3.7 to loader-path tests while direct source imports resolved the pinned 1.3.27, and `tsc` loaded both declaration trees in one program. Both paths now see 1.3.27. New `test/host-deps.test.ts` locks the invariants: `typebox` stays a `"*"` peer and never a runtime dependency, and the devDependency pin must equal the `typebox` the resolved host bundles.
- Repo guard `scripts/check-host-provided-deps.mjs`, wired into the root `pnpm run check`, fails when any `packages/*/package.json` declares a host-provided package (`typebox`, `@sinclair/typebox`, `@earendil-works/pi-*`, `@mariozechner/pi-*`) under `dependencies` or `optionalDependencies`; the rule is recorded in the root `AGENTS.md`.

### Fixed (post-review)

- Mis-scoped keep-alive calls: the server resolves an *omitted* `scope` to its own process cwd (a keep-alive mcporter daemon spawns it in `~/.mcporter`) and ignores `root` for that purpose, so bare `tilth_search`/`tilth_list`/`tilth_grok`/`tilth_deps` calls silently searched the daemon directory. The extension now injects `scope: <resolved root>` on those tools when the caller supplies none; explicit `scope` is never overridden and `tilth_read`/`tilth_diff` (whose `scope` is an output filter) receive no injection.

- Transport honesty: a killed process (call timeout or abort) is always a thrown tool error even when stdout holds a complete JSON envelope — pi's exec resolves `code ?? 0` for signal-deaths, so `Exec`/`McporterCallResult` now carry `killed` and `parseEnvelope` checks it before envelope parsing. Availability probes treat killed probes as failures too.
- Full-view CRLF verification: the server's full view preserves `\r` (verified live); the verifier strips one trailing `\r` per shown line (both views) and embeds the `\r`-stripped form in anchors, matching native hashline reads. The shipped CRLF fixture had been `\r`-stripped at capture and was re-captured byte-exact.
- No-trailing-newline full reads: the trailing blank line is only subtracted when actually present, so the final content line now verifies and receives an anchor (fixture captured live; previously it escaped both verification and annotation while the snapshot still committed).
- Compat async contract: `commitExternalRead` is declared `Promise<void>` everywhere (ambient `.d.ts`, bridge interfaces) and awaited by the annotator; a commit failure degrades the file to passthrough instead of leaving a floating promise and uncommitted anchors.
- `/tilth-savings` output goes through the same truncation pipeline as tool output.
- Dead `prepareParams` toolkit option removed; `sections` gains `maxItems: 20` mirroring the live server cap ("sections limited to 20 per call"); `tilth_search`'s `context` path param is absolutized like `path`/`scope`.

### Added

- Initial release: six tilth tools (`tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`) bridged through mcporter, with verbatim server descriptions and typebox schemas mirrored from the live server schema (frozen fixture asserted in tests).
- Transport resolution probed once per session: configured mcporter server → `tilth` binary → `npx -y tilth --mcp` → unavailable, with the static remediation message shared across tools, the availability notify, and `/tilth-savings`.
- Root/scope argument preparation: `root` injected from the session cwd, relative `path`/`paths`/`scope` absolutized, git refs (`a`/`b`/`log`) untouched — identical in configured and ad-hoc modes.
- Hashline compat: `tilth_read` output is verified line-by-line against normalized disk content and rewritten to pi-hashline-edit anchors via the versioned `pi-hashline-edit/compat` contract (verify-then-commit; commits are bit-identical to native reads). Any mismatch, unrecognized shape, or ambiguity passes through unannotated with no store write. Per-call activation gated by `COMPAT_VERSION`, the pi-hashline-edit activity flag, and the `hashlineCompat` config key.
- Registry-first hashline compat resolution: pi's extension loader isolates every extension in its own jiti instance (`moduleCache: false`), so dynamically importing `pi-hashline-edit/compat` yields a second module copy whose snapshot store and activity flag are invisible to the `edit` tool. The bridge now resolves the live compat module from `globalThis.__piHashlineEditCompat` (published by pi-hashline-edit's `index.ts` at extension load) first, keeping the dynamic import as fallback for same-module-tree runtimes and tests. Both paths are shape- and `COMPAT_VERSION`-gated, so drift fails safe. Proven end-to-end by a new loader-level interop test (`test/interop-loader.test.ts`) that loads both packages through `discoverAndLoadExtensions` and by a live-session `tilth_read` anchor mint.
- Per-session hashline opt-out flag `--tilth-no-hashline`: skips anchor annotation of `tilth_read` output for the session, overriding the `hashlineCompat` config key (config-off and flag-off behave identically). Intended for read-only sessions — e.g. subagents with read permission only — where edit anchors add token overhead without benefit.
- Per-call hashline opt-out param `raw` on `tilth_read`: returns plain text without anchors for that single call, mirroring pi-hashline-edit read's `raw`. `raw` is client-side only — stripped before the server call, skips annotation and the snapshot commit. Reaches sessions that cannot receive CLI flags, e.g. subagents spawned by pi-subagent-herdr (which builds the child's launch command itself).
- `/tilth-savings` command surfacing the server's explicit-request-only savings report.
- Config layer: global (`<agentDir>/extensions/pi-tilth/config.json`) + project (`<cwd>/.pi/extensions/pi-tilth/config.json`) merge, project wins, unknown fields dropped, malformed files warn once. Keys: `serverName`, `callTimeoutMs`, `hashlineCompat`.
- Output truncation with tmp-file spill using pi's shared `truncateHead` and host defaults.
- `skills/tilth` skill adapted from tilth's upstream SKILL.md (MIT © 2026 Jahala, attribution in THIRD_PARTY_LICENSES).
- Opt-in integration suite (`pnpm test:integration`) round-tripping the real `mcporter` transport against `npx tilth --mcp`.
