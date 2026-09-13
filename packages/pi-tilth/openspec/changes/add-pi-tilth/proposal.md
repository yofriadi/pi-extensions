# Add pi-tilth

## Why

pi has no built-in MCP support — its own README (verified at latest, 0.85.1) states: " **No MCP.**
… or build an extension that adds MCP support."
Meanwhile [tilth](https://github.com/jahala/tilth) ships its best mode as an MCP stdio server (`tilth --mcp`): session dedup (`[shown earlier]` on repeat expansions), `expand=2` by default, benchmarked −38% to −44% cost-per-correct-answer across Claude models versus built-in tools.
Using tilth from pi today means either the stateless CLI (loses dedup and MCP-mode behaviors) or nothing.

The user already standardizes on [mcporter](https://github.com/steipete/mcporter) as the MCP bridge on this machine (four servers configured, keep-alive daemon).
Per-call `mcporter call` is exactly the same shape as pi-colgrep's per-call `colgrep` exec — a proven extension pattern in this ecosystem (typed tool schemas, `promptGuidelines`, truncation to a tmp file, availability probe at `session_start`, config files).

Two integration gaps must be designed for, not discovered in code:

1. **cwd/root mismatch**: a keep-alive tilth server outlives any pi session and may be rooted in another project; tilth's server also refuses bare relative paths.
   Every call needs explicit, absolute scoping.
2. **Anchor incompatibility**: pi-hashline-edit overrides pi's read/edit tools with `LINE#HASH` anchors validated against in-memory read snapshots. tilth's own `--edit` hashlines use a different format and server-side state — the two systems cannot interoperate.
   Without a compat layer, a model that reads via tilth cannot paste anchors into pi-hashline-edit's edit, forcing a wasteful re-read — the exact token burn both tools exist to eliminate.

## What Changes

- **New package `packages/pi-tilth`** (`@yofriadi/pi-tilth`) following this repo's conventions (`pi.extensions` → `./src/index.ts`, biome + `tsc --noEmit`, vitest, skills via `pi.skills`).
- **Six pi tools mirroring tilth's MCP surface 1:1** — `tilth_search`, `tilth_read`, `tilth_list`, `tilth_deps`, `tilth_grok`, `tilth_diff` — with tool descriptions transcribed verbatim from the server schema (those descriptions are benchmark-tuned; paraphrasing them forfeits measured accuracy).
- **Transport = `mcporter call` per tool invocation**, through an injected `Exec` seam (identical to pi-colgrep's architecture).
  Server resolution order: configured `tilth` mcporter server → ad-hoc `--stdio tilth --mcp` → ad-hoc `--stdio npx -y tilth --mcp` → unavailable warning with exact remediation commands.
- **Always-explicit scoping**: `root` defaults to the pi session's `ctx.cwd`; relative `path`/`scope` arguments are absolutized against `ctx.cwd` before the call.
- **`/tilth-savings` command** (not a tool) wrapping the server's `tilth_savings` — tilth's own description restricts it to explicit user requests, which is what a command is.
- **Optional hashline compatibility**: when pi-hashline-edit is installed *and active*, content that tilth tools display (`tilth_read` full/section regions) is re-annotated client-side with pi-hashline-edit-compatible `LINE#HASH` anchors, and full-file snapshots are registered into pi-hashline-edit's read-snapshot store, so its overridden `edit` accepts anchors copied from tilth output.
  Loaded via guarded dynamic `import()` — each extension works without the other.
- **pi-hashline-edit gains a small public contract**: a new `src/compat.ts` module and an `exports` map entry (`"./compat"`) exposing normalization, anchor minting, snapshot registration, an activity flag set by its extension entry, and a compat-version constant.
  Its own behavior is otherwise unchanged (redesign of internals is permitted where it simplifies this contract).
- **No tilth edit mode**: `tilth_write` and `--edit` stays off; pi-hashline-edit remains the sole write/edit path.

## Capabilities

### New Capabilities

- `mcporter-transport`: server resolution (config / ad-hoc fallback / unavailable), per-call invocation via the Exec seam, JSON result extraction and error mapping, root/cwd scoping, availability probing.
- `tilth-tools`: the six tools' schemas, verbatim descriptions, prompt snippets/guidelines, call/result rendering, output truncation, and the shipped skill.
- `tilth-savings-command`: the `/tilth-savings` command and its output/error handling.
- `hashline-compat`: optional anchor interoperability with pi-hashline-edit — activation conditions, annotation correctness, snapshot registration, config toggle, and the cross-package compat contract pi-hashline-edit must expose.

### Modified Capabilities (cross-package contract)

- `hashline-compat` — the pi-hashline-edit half of the same capability delta listed above: pi-hashline-edit's public surface gains the versioned `./compat` export contract (see `specs/hashline-compat/spec.md`, which specifies both halves in one file). pi-hashline-edit has no openspec root of its own (it is a vendored backup maintained in this monorepo), so its contract modification is specified here alongside the consumer; if that package later adopts an openspec root, the contract requirement should be mirrored there.
  Its user-facing behavior requirements are unchanged.

## Impact

- **New code**: entire `packages/pi-tilth` tree (`src/index.ts`, `src/lib/*`, `src/tools/*`, `skills/tilth/SKILL.md`, config/tsconfig/package metadata, tests).
- **Sibling package**: `packages/pi-hashline-edit` — new `src/compat.ts`, `package.json` `exports` entry, README/CONTEXT.md notes, compat tests.
  No behavioral change for existing pi-hashline-edit-only users.
  The annotation premise (tilth's shown content is byte-equal to normalized disk lines) is gated by a fixture/recognizer spike **before** this sibling work is executed; a no-go descopes compat to passthrough and pi-hashline-edit ships nothing.
- **Repo wiring**: pi-tilth gets a package-local `check` script (biome + tsc); root `check` gains a `pnpm --filter @yofriadi/pi-tilth run check` delegation, consistent with the existing pi-condense pattern in the root `check` script.
- **Runtime dependencies**: none for pi-tilth core (exec-only transport); peer deps on `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` follow pi-colgrep. `pi-hashline-edit` is declared as an **optional peer dependency** (not auto-installed) plus a `workspace:*` devDependency — the declaration documents the relationship, guarantees monorepo resolvability for development and the interop test, and npm will not nest a second copy at consumer install (optional peers are not auto-installed).
- **Attribution**: tilth is MIT-licensed (Copyright (c) 2026 Jahala); verbatim tool descriptions and the adapted skill require the notice to ship — a `THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt` file is included in the published package (pi-colgrep precedent).
- **Host requirements (documented, not enforced at install)**: `mcporter` on PATH; a `tilth` binary (cargo/npx) or reachable `npx`; for session dedup, an mcporter `tilth` entry with `lifecycle: "keep-alive"` and a healthy mcporter daemon (the user's daemon currently needs the `daemon migrate` permission fix — noted in README, not handled by the extension).
  README also notes that `tilth install pi` writes `~/.pi/agent/mcp.json`, which is inert for pi ≤0.85.1 (no built-in MCP) — users who ran it should not expect it to work.
- **Performance envelope** (estimates until task 10.5 measures them): one node spawn per tool call (~100–300 ms) on top of tilth's ~18–27 ms operations; ad-hoc fallback additionally cold-starts `tilth --mcp` per call (no dedup), and ad-hoc npx mode may exceed the 60 s timeout on its very first call (download; retry succeeds).
  Accepted: correctness and zero-config before latency; emit-ts long-lived client is a documented non-goal alternative if profiling later demands it.
  The README presents these as estimates unless task 10.5's measurement has run.
- **Risks**: mcporter output format drift (mitigated by narrow parsing + passthrough-on-unknown); tilth output format assumptions in the compat annotator (mitigated by strict recognizers, skip-on-mismatch, and a recorded fixture test); transient disk-vs-shown content skew (annotator must verify equality before minting anchors, else pass through untouched).
