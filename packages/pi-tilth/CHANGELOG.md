# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
