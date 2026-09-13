# Add pi-tilth

## Context

Verified ground truth this design rests on (all checked 2026-09-08, not assumed):

- **pi has no MCP.**
  `@earendil-works/pi-coding-agent@0.85.1` (latest) README: " **No MCP.**
  Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."
  Extension-loadable tools are the sanctioned path.
- **tilth** is a Rust binary (`cargo install tilth` / `npx tilth` / prebuilt releases); `tilth --mcp` serves stdio MCP.
  Verified live tool surface (via ad-hoc mcporter call): `tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`, `tilth_savings`; `--edit` additionally enables `tilth_write` and switches read output to tilth's own hashline format.
  MCP-mode-only behaviors: session dedup ("[shown earlier]" on repeat expansions — state lives in the server process), `expand` default 2.
- **mcporter 0.13.10** (Homebrew) on this machine.
  `mcporter call <server>.<tool> --output json --args '<json>'` returns `{"content":[{"type":"text","text":…}], "isError": bool}` — verified end-to-end with `tilth_list`/`tilth_search`.
  Config lives at `~/.mcporter/mcporter.json` (`mcpServers`, `lifecycle: "keep-alive" | "ephemeral"`, per-server `cwd`); daemon keep-alive is what preserves a long-lived tilth server process across calls.
  Ad-hoc stdio (`--stdio <cmd> --stdio-arg … --name …`) requires no config and was verified working.
  **Note:** `mcporter call` ad-hoc global flags exclude `--root` interplay we rely on — root scoping is done via tool params instead (D3), which works identically in both server modes.
- **pi-colgrep is the architectural guide** (vendored copy read in full): `Exec` seam type injected everywhere; `createAvailabilityState()` probed once at `session_start`; `loadConfig` merging `<agentDir>/extensions/<id>/config.json` with `<cwd>/.pi/extensions/<id>/config.json`, project winning, garbage fields dropped; `pi.registerTool` with typebox params, `promptSnippet`/`promptGuidelines`; `truncateHead` with `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` and full output spilled to `$TMPDIR`; `renderCall`/`renderResult` via pi-tui `Text`.
- **pi-hashline-edit** (user-maintained backup in this monorepo; upstream deleted) overrides pi's `read`/`edit`(+optional `grep`).
  Anchors: `computeHashFromContext(prev,curr,next)` = xxh32 over NUL-joined, `stripBom`d, `normalizeToLF`d, `\r`-stripped, `trimEnd`ed lines, low N nibbles mapped through alphabet `ZPMQVRWSNKTXJBYH`, N from `hashline.json` (`getHashLength()`, default 2).
  Validation reads from `rememberReadSnapshot(canonicalPath, fullNormalizedContent)` — a module-level multi-version LRU.
  Its read mints anchors with `formatHashlineRegion(allLines, start, end)` over **full-file context**. tilth's `--edit` hashlines (`42:a3f|`, hex alphabet, server-side) are **incompatible by construction** — interop must reuse hashline-edit's own code, not reimplement it.
- **Cross-extension module state requires a registry**: pi's extension loader creates a fresh jiti instance per extension with `moduleCache: false` (verified in `@earendil-works/pi-coding-agent@0.84.3`), so two extensions can never share a module instance directly — pi-tilth importing `pi-hashline-edit/compat` gets a second copy whose store/flag the loaded extension cannot see.
  The compat module is therefore published as a process-global registry entry (`globalThis.__piHashlineEditCompat`) by pi-hashline-edit's entry point; the dynamic import stays only as a fallback for registry-absent runtimes.
- **pi-hashline-edit detection caveat**: the package being resolvable does not imply its extension is active (it may be installed but not enabled).
  The compat module must therefore expose an activity flag flipped by its own entry point, and pi-tilth must consult it per call (cheap boolean), not just at `session_start` — extension load order is not guaranteed.

## Goals / Non-Goals

**Goals:**

- tilth's MCP tool surface available as six first-class pi tools plus a `/tilth-savings` command, with zero Go/Rust/SDK dependencies — the `mcporter` binary is the only runtime requirement.
- Works out of the box with no mcporter config (ad-hoc stdio fallback), and gets strictly better (session dedup) when the user adds a keep-alive `tilth` entry.
- Relative paths from the model always resolve against pi's session cwd; the server never receives a bare relative path or scope.
- Hashline interop that is *bit-identical* to hashline-edit's own read: anchors minted from identical bytes with identical code, snapshots registered through the same store.
  Both extensions fully functional alone.
- Failure honesty: transport errors, unavailable binaries, and unknown output shapes degrade to clear tool errors — never silent truncation or fabricated anchors.

**Non-Goals:**

- tilth `--edit` / `tilth_write` (pi-hashline-edit owns writes).
- Annotating `tilth_search`/`tilth_grok` expansion blocks with anchors in v1 — only `tilth_read` content regions.
  Models do a targeted `tilth_read --section` before editing, which is tilth's own recommended edit flow.
- `mcporter emit-ts` typed clients or a long-lived MCP client owned by the extension.
- Writing to the user's mcporter config (the extension only *suggests* exact commands).
- Disabling or shadowing pi's built-in tools; guidance is advisory text only.
- MCP resources/prompts passthrough; mcporter `record`/`replay` integration.
- Auto-installing `tilth` or `mcporter`.

## Decisions

### D1: Transport is one `mcporter call` per tool invocation, behind an injected `Exec` seam

Chosen over `mcporter emit-ts` + owning a long-lived MCP child process.
Rationale: identical proven shape to pi-colgrep (testability via fake `Exec`, no MCP SDK dependency, no process-lifecycle state machine in the extension); mcporter owns stdio spawning, timeouts, and (with keep-alive) session reuse.
Cost: one node spawn per call (estimated ~100–300 ms until measured in task 10.5).
Accepted: tilth's operations are ~20 ms, and correctness/testability beat saving ~200 ms here.
The `emit-ts` alternative remains documented in the proposal as the follow-up if profiling shows the spawn dominates.

### D2: Server resolution order — config first, ad-hoc fallback, then unavailable

At `session_start`, probe in order:

1. `mcporter list tilth --json`-style query succeeds → **config mode**: calls use `mcporter call tilth.<tool> --args …`.
2. Else `tilth --version` exec succeeds → **ad-hoc binary mode**: `--stdio tilth --stdio-arg --mcp --name tilth`.
3. Else `npx --version` succeeds → **ad-hoc npx mode**: `--stdio npx --stdio-arg -y --stdio-arg tilth --stdio-arg --mcp --name tilth` (first call may download tilth; the probe warns about this once).
4. Else → **unavailable**: notify with exact remediation (`cargo install tilth` or `brew install mcporter` / `mcporter config add …` hint), all six tools return a static error message, mirroring pi-colgrep's availability pattern.

Remediation always mentions the keep-alive config path because that is the mode with session dedup:

```jsonc
// ~/.mcporter/mcporter.json
{ "mcpServers": { "tilth": { "command": "tilth", "args": ["--mcp"], "lifecycle": "keep-alive", "idleTimeoutMs": 300000 } } }
```

(Schema keys `args`/`lifecycle` to be verified against `mcporter config add --help` during implementation — task 2.6.) Ad-hoc modes never persist anything and never touch user config.
Ad-hoc argv always includes `--yes` (verified present in mcporter 0.13.10) so a first-run trust confirmation can never block or stall a headless call; mcporter's ad-hoc descriptors are not persisted, so the full `--stdio … --name …` descriptor is repeated on every call.

### D3: Root/scoping is always explicit and absolute, derived from `ctx.cwd`

Every tool call injects `root: <absolute ctx.cwd>` when the caller didn't supply `root`, and absolutizes any relative `path`/`paths`/`scope` against `ctx.cwd` before invocation.
Reasons: (a) tilth refuses bare relative paths; (b) a keep-alive server can outlive the pi session that spawned it and be rooted in another project; (c) ad-hoc spawns inherit mcporter's cwd, which is not guaranteed to be pi's.
This makes config mode and ad-hoc mode behaviorally identical.
`tilth_diff`'s `scope`/`root` follow the same rule; its git refs (`a`/`b`/`log`) are not paths and pass through untouched.

**Correction (2026-09-13, from a mis-scoped session):** `root` alone is not sufficient.
The server resolves an *omitted* `scope` to its own process cwd — pinned upstream by `resolve_scope_no_arg_ignores_root` — and for a keep-alive mcporter daemon that cwd is `~/.mcporter`, not the pi session.
The search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) therefore also inject `scope: <resolved root>` when the caller omits `scope` (explicit scope is never overridden).
`tilth_read` has no scope parameter, and `tilth_diff`'s `scope` is an output filter — injecting it would break file matching — so both receive no injection.
Ad-hoc mode only worked by accident: the server spawn cwd happened to equal the session cwd.

### D4: Six tools, 1:1 with the server schema; descriptions transcribed verbatim

Tools: `tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff`.
Parameter schemas are copied from the live server (`mcporter list … --schema` dump captured during implementation — task 3.1 — including defaults like `expand=2`, `mode="auto"`, `kind="symbol"`), with typebox types matching the server's JSON Schema.
**Tool descriptions are transcribed verbatim.**
tilth's benchmarked gains partially come from those descriptions' wording; paraphrasing them silently discards measured behavior.
Where a description references a different host (e.g. "the host Read tool"), it stays accurate for pi, which has those tools.

Each tool declares a `promptSnippet` and `promptGuidelines` steering structural use-cases toward tilth (search-before-read, `--section` before edit) **without** claiming to replace built-ins — the user runs other overlapping tools (colgrep, grep.app/via mcporter) and precedence among them is a user-level prompt decision, not something this extension asserts.

### D5: Output handling is narrow parsing + passthrough

- Pinned argv per mode (acceptance contract in the `mcporter-transport` spec):
  - **Config mode**: `["call", "<server>.<tool>", "--output", "json", "--args", JSON.stringify(params)]`
  - **Ad-hoc mode**: `["call", "--stdio", cmd, …stdioArgs, "--name", serverName, "--tool", toolName, "--output", "json", "--args", JSON.stringify(params), "--yes"]` — descriptor repeated per call; `--tool` (verified working live) selects the tool because ad-hoc servers have no `server.tool` selector.
- Timeout is enforced at the **Exec seam** via `pi.exec`'s `timeout` option (verified API) using config `callTimeoutMs`; mcporter's own `--timeout` is not relied on.
  In ad-hoc npx mode the first call may download tilth and exceed the timeout — documented; the call fails as a normal timeout error and a retry succeeds.
- Parse the mcporter JSON envelope; join `content[i].text` for `type === "text"` blocks. `isError: true` → tool error result carrying tilth's own message (already verified the shape with a real `tilth_list` error).
- Truncate with `truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })`; on truncation, write the full output to `$TMPDIR/tilth-<ts>.txt` and append the pointer — the pi-colgrep pattern.
- Unparseable envelope or non-zero exit: surface mcporter's stderr verbatim as the tool error.
  Never fabricate content.
- Tool failures are reported by **throwing** from `execute()` (pi's contract: a returned value is never an error); every "returns a static error" phrase in the specs means throw-after-constructing-the-message.
  D9's loader-level tests assert thrown failures.
- Custom `renderCall`/`renderResult` per tool (pi-tui `Text`), summarizing verb + target; result render shows line/byte counts and truncation state, not full content, unless expanded.

### D6: `tilth_savings` is a command, not a tool

The server's own description ("Call ONLY when the user explicitly asks") forbids habitual model use; a pi command `/tilth-savings` matches that semantics exactly (user-invoked).
Handler performs the same transport call and displays output via `ctx.ui.notify` or a printed message; errors render as notifications.
No parameters.

### D7: Hashline compat is a registry-first bridge with a versioned cross-package contract

**Package relationship (blocks silent resolution failure):** pi-hashline-edit's package name is pinned as `pi-hashline-edit` (verified in its package.json, v0.8.3, unscoped); the specifier is exactly `pi-hashline-edit/compat`. pi-tilth declares it as an **optional peer dependency** (`peerDependencies` + `peerDependenciesMeta.optional: true` — npm does not auto-install optional peers, so consumers without pi-hashline-edit get no extra install and no risk of a nested second copy) plus a **`workspace:*` devDependency** so the monorepo dev/test tree can resolve it (pnpm grants no undeclared sibling visibility; without the devDep the import can never resolve in development and D9's interop test would silently skip forever).

**Correction to the original premise (verified against pi 0.84.3's loader source and empirically):** pi's extension loader creates a fresh jiti instance per loaded extension with `moduleCache: false`, so the dynamic import does **not** resolve to the same module instance the loaded extension uses — even within one jiti, repeated imports re-evaluate.
Same-instance sharing holds only *within* one extension's static import graph (verified by probe: modules A imported by both `index.ts` and `c.ts` share identity).
The original "same module tree, one copy ⇒ shared instance" premise is therefore false for cross-extension imports.
The shipped mechanism is a **process-global registry**: pi-hashline-edit's entry point publishes its live compat module (whose closures point at the real snapshot store the `edit` tool reads) on `globalThis.__piHashlineEditCompat` at extension load; pi-tilth's bridge resolves the registry first and falls back to the guarded dynamic import only for same-module-tree runtimes (tests, single-module hosts).
Both paths are shape- and `COMPAT_VERSION`-gated, so drift fails safe: compat-off, passthrough, no store writes.
Because all extension factories run before any `session_start` handler fires, the registry is guaranteed populated (or provably absent) by the time pi-tilth's session_start resolves compat.
A duplicate-instance/wrong-tree situation degrades to compat-off — never corruption.

**pi-hashline-edit side (user owns the package; redesign permitted):** new `src/compat.ts` exporting a versioned, **verify-then-commit** surface, and `"./compat": "./src/compat.ts"` added to `package.json` `exports`:

```ts
export const COMPAT_VERSION = 1;
export function isHashlineEditActive(): boolean;   // flipped true by index.ts on extension load
// Read + canonicalize (resolveMutationTargetPath) + stripBom/normalizeToLF.
// NO snapshot-store write: callers must verify before committing.
export function readNormalizedForAnnotate(path: string): Promise<{ normalized: string; lines: string[] } | null>;
// Register exactly the bytes that were verified (same store semantics as read.ts:
// rememberReadSnapshot + clearAppliedPayload on the canonical path).
export function commitExternalRead(path: string, normalized: string): void;
export function mintAnchor(fileLines: string[], line1: number): string; // computeLineHash, full-file context
```

Verify-then-commit is load-bearing: registering a snapshot *before* any shown line is verified would pollute the store with content the model may never have seen (outline-only or `[shown earlier]` dedup'd output), weakening hashline-edit's read-before-edit gating and contradicting the compat spec's own no-fabrication rule.
Only after recognition + per-line equality succeed does pi-tilth commit.
Encapsulating canonicalization/normalization inside the compat module keeps pi-tilth from drifting on read.ts's semantics.

**pi-tilth side:** at `session_start`, resolve the compat module registry-first — `globalThis.__piHashlineEditCompat` (published by the loaded pi-hashline-edit extension, so its closures see the real store) — then fall back to a guarded dynamic `import("pi-hashline-edit/compat")` in a `try/catch` for registry-absent runtimes (import failure = compat off, never an error — per user decision, dynamic import is explicitly allowed here, overriding the repo's general no-inline-imports rule, because the two extensions must each work standalone).
Compat is active for a call only when: resolution succeeded AND `COMPAT_VERSION` matches AND `isHashlineEditActive()` is true AND config `hashlineCompat !== false` AND the session was not launched with `--tilth-no-hashline` AND the call did not pass `raw: true` (client-side param, stripped before the server call).
The activity flag is re-read per call (load-order independence); the flag and `raw` provide the per-session and per-call opt-outs documented in the hashline-compat spec.

**Annotation pass (tilth_read only):** after a successful `tilth_read`, for each concrete file named by `path`/`paths`: `readNormalizedForAnnotate(absPath)`; on non-null, parse tilth's output for content lines (full-file and section regions) of that file; for each shown line N, verify `shownContent === lines[N-1]` and only then rewrite the line to hashline-edit's `formatHashlineRegion` line format using `mintAnchor(lines, N)`.
If **every** recognized content line of the file verifies, `commitExternalRead(absPath, normalized)` registers the snapshot.
**Any mismatch, unrecognized line, or multi-file ambiguity → that file's output passes through untouched and nothing is committed for it.**
Outline lines (`[n-m] signature`), headers, and scaffolding are never annotated and trigger no registration.
This yields anchors bit-identical to what hashline-edit's own `read` would have minted for the same bytes, because the same functions mint them from the same full-file context; and a committed snapshot is indistinguishable from a native hashline-edit read, so stale-anchor recovery behaves the same.

**Premise gate (before the sibling API ships):** tilth's read output uses `NN │ <content>` gutters with `...` elisions; the byte-equality assumption above must be proven against real tilth output *before* the pi-hashline-edit-side work is executed.
A spike task (captures fixtures for read-full, read-section, and outline from the live server, then exercises the recognizer + equality check) gates the sibling work with an explicit go/no-go — if tilth transforms content, compat v1 is descoped to passthrough and the sibling package ships nothing.

**Why not annotate search expansions:** expansion gutter format and multi-file interleave make strict recognition harder, and tilth's documented edit flow already routes through `read --section`.
Spec'd as a named follow-up, not silent scope creep.

### D8: Config file mirrors pi-colgrep's pattern

`loadConfig` from global `<agentDir>/extensions/pi-tilth/config.json` + project `<cwd>/.pi/extensions/pi-tilth/config.json`, project winning, unknown/garbage fields dropped silently, malformed file warns once and falls back.
Three keys only:

| key              | default   | meaning                                |
| ---------------- | --------- | -------------------------------------- |
| `serverName`     | `"tilth"` | mcporter server entry to prefer        |
| `callTimeoutMs`  | `60_000`  | per-call mcporter timeout              |
| `hashlineCompat` | `true`    | master switch for D7 (when deps allow) |

### D9: Testing mirrors repo rules — loader-level plus low-level edge cases

- **Unit**: args/scoping builder (D3), config merge, envelope parsing incl. `isError` and malformed JSON, availability state transitions, annotation pass (recognizer, equality guard, multi-file, outline passthrough) — all with fake `Exec`/fixtures.
- **Loader-level** (per repo AGENTS.md: real `loadExtensions`, no mocking the loader or the package): extension discovered from `src/index.ts`; six tools + one command registered; tools error cleanly when availability is false.
- **Interop**: load pi-tilth **and** pi-hashline-edit together through `loadExtensions`; tilth_read output anchor minted in compat mode validates through hashline-edit's edit path against a temp fixture file.
  The `workspace:*` devDependency guarantees resolvability in the monorepo, so this test **runs for real** in development.
  It hard-requires the peer (a relative source import of hashline-edit's edit pipeline); published consumers do not ship `test/`, so there is no skip branch to maintain.
- **Opt-in integration** (`vitest.integration.config.ts`, like pi-mlflow): real `mcporter` + real `npx tilth` round-trip; never in default `pnpm test`.
- A recorded fixture of real tilth output (read full, read section, outline) anchors the compat recognizer against format drift.

### D10: Packaging follows this monorepo

`packages/pi-tilth` with `@yofriadi/pi-tilth`; `pi.extensions: ["./src/index.ts"]`, `pi.skills: ["./skills"]`; peer deps `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` (match pi-colgrep's ranges); dev deps for typescript/vitest/biome; root `package.json` `check` script gains `tsc --noEmit -p packages/pi-tilth/tsconfig.json`.
No `build`/`dist`; strip-only TypeScript per repo rules (no parameter properties, enums, or emit-requiring syntax — dynamic `import()` per D7 is the sanctioned single exception).

## Sequence / Rollout

Single change, but tasks ordered so the extension is usable after task section 5 and compat lands after its premise gate (a fixture/recognizer spike precedes the pi-hashline-edit-side work, with a go/no-go): core transport → tools → command → skill → **spike: annotation premise** → compat bridge → tests/docs. pi-hashline-edit's compat module is additive; older pi-hashline-edit lacks the `./compat` export → the guarded import throws → compat off.
This failure mode is by design.
