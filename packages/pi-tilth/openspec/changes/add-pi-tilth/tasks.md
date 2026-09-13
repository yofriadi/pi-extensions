## 1. Package scaffold (`packages/pi-tilth`)

- [x] 1.1 Create `package.json` (`@yofriadi/pi-tilth`): `pi.extensions: ["./src/index.ts"]`, `pi.skills: ["./skills"]`; peer deps `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` (ranges matching pi-colgrep) **plus optional peer** `pi-hashline-edit` with `peerDependenciesMeta: { "pi-hashline-edit": { "optional": true } }` (documents the relationship; npm does not auto-install optional peers — blocker-1 correction); runtime dep `typebox` (bare specifier, pi-colgrep precedent — the loader maps it); dev deps typescript/vitest/@types/node **plus `pi-hashline-edit: "workspace:*"`** (monorepo dev/test resolution — blocker-1 correction); `engines.node >= 22.19.0`; `exports` map (`"."` + `"./package.json"`, herdr convention); repo-standard scripts (`check` = biome + tsc package-local, `typecheck`, `test`, `test:integration` wired to `vitest.integration.config.ts`); `files` including `THIRD_PARTY_LICENSES`; `publishConfig.access: "public"`
- [x] 1.2 Add `tsconfig.json` extending `../../tsconfig.base.json`; `vitest.config.ts`; `vitest.integration.config.ts` (opt-in, excluded from default `pnpm test`)
- [x] 1.3 Add placeholder `src/index.ts` exporting the extension factory; wire root `package.json` `check` to delegate: `pnpm --filter @yofriadi/pi-tilth run check` (pi-condense delegation pattern, not a raw `tsc -p` — nitpick-4 correction)
- [x] 1.4 Stub `README.md`, `CHANGELOG.md`, `LICENSE` (fill content in section 10); add `THIRD_PARTY_LICENSES/tilth-LICENSE.MIT.txt` with tilth's verbatim MIT text (Copyright (c) 2026 Jahala — fetched from upstream during implementation; required by verbatim description/skill transcription, pi-colgrep precedent)

## 2. Transport core (`src/lib/`)

- [x] 2.1 `src/lib/exec.ts`: `Exec` type matching `pi.exec` (verbatim pi-colgrep pattern)
- [x] 2.2 `src/lib/config.ts`: `loadConfig` with global `<agentDir>/extensions/pi-tilth/config.json` + project `<cwd>/.pi/extensions/pi-tilth/config.json`, project wins, unknown fields dropped, malformed file warns once; keys `serverName` (default `"tilth"`), `callTimeoutMs` (default `60_000`), `hashlineCompat` (default `true`)
- [x] 2.3 `src/lib/availability.ts`: availability state machine probing in order — configured mcporter server (named `serverName`), `tilth` binary, `npx` fallback — storing the resolved mode; `undefined` before first refresh (pi-colgrep pattern)
- [x] 2.4 `src/lib/mcporter.ts`: pinned argv per mode (spec acceptance contract) — config mode `["call", "<server>.<tool>", "--output", "json", "--args", json]`; ad-hoc mode `["call", "--stdio", cmd, ...stdioArgs, "--name", serverName, "--tool", toolName, "--output", "json", "--args", json, "--yes"]` (`--tool` verified live; descriptor repeated per call; `--yes` skips first-run confirmation); always `cwd: ctx.cwd`; timeout enforced at the **Exec seam** via `pi.exec`'s `timeout` option from `callTimeoutMs` (verified API), not via mcporter `--timeout`
- [x] 2.5 `src/lib/result.ts`: parse the mcporter JSON envelope (join `content[].text` for text blocks; `isError` → tool error with server message; malformed JSON / non-zero exit → error carrying stderr verbatim; never fabricate content)
- [x] 2.6 Verify against `mcporter config add --help`: document exact stdio+keep-alive config-add command and schema keys (`command`/`args`/`lifecycle`/`idleTimeoutMs`) used in README + unavailable-warning text

## 3. Tools (`src/tools/`)

- [x] 3.1 Capture the live server schema (`mcporter list … --schema --json` against ad-hoc `npx tilth --mcp`) and save it as a test fixture; transcribe all six param schemas into typebox and **all tool descriptions verbatim** (design D4); the verbatim assertion in tests compares against this **frozen fixture**, and the README documents the refresh procedure (re-dump + diff) for tilth upgrades — nitpick-1 correction
- [x] 3.2 `src/tools/search.ts` — `tilth_search` (`query`, `kind`, `scope`, `glob`, `expand`, `context`, `budget`, `root`)
- [x] 3.3 `src/tools/read.ts` — `tilth_read` (`path`, `paths`, `section`, `sections`, `mode`, `full`, `budget`, `root`)
- [x] 3.4 `src/tools/list.ts` — `tilth_list` (`patterns`, `scope`, `depth`, `budget`, `root`)
- [x] 3.5 `src/tools/deps.ts` — `tilth_deps` (`path`, `scope`, `budget`, `root`)
- [x] 3.6 `src/tools/grok.ts` — `tilth_grok` (`target`, `scope`, `full`, `root`)
- [x] 3.7 `src/tools/diff.ts` — `tilth_diff` (`a`, `b`, `scope`, `log`, `patch`, `search`, `source`, `blast`, `expand`, `budget`, `root`)
- [x] 3.8 `src/lib/scope.ts`: inject `root: <abs ctx.cwd>` when absent; absolutize relative `path`/`paths`/`scope` against `ctx.cwd`; never forward git refs through path resolution (design D3); shared by all six tools
- [x] 3.9 Per-tool `promptSnippet` + `promptGuidelines` (steer structural use-cases to tilth; no claims of replacing built-ins)
- [x] 3.10 Per-tool `renderCall`/`renderResult` via pi-tui `Text` (call: verb + target; result collapsed: summary counts + truncation marker; expanded: full text)
- [x] 3.11 Truncation: `truncateHead` with `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`; on truncation write full output to `$TMPDIR/tilth-<ts>.txt` and append pointer (pi-colgrep pattern)

## 4. Command

- [x] 4.1 `src/commands/savings.ts`: register `/tilth-savings`; invokes `tilth_savings` via transport; displays output as a message; unavailable/error paths notify with the same remediation text as tools (tool-style failures throw; command failures notify — nitpick-2 mechanism)

## 5. Entry wiring (`src/index.ts`)

- [x] 5.1 `session_start`: load config, refresh availability, notify on unavailable (with exact fix commands incl. keep-alive config snippet), warn once when in ad-hoc npx mode that the first call may be slow
- [x] 5.2 Register the six tools and `/tilth-savings`; tools consult availability state per call and **throw** the static explanatory error when unavailable (pi's tool-error contract: only a thrown `execute()` marks the result as error — nitpick-2 mechanism)

## 6. Skill (`skills/tilth/SKILL.md`)

- [x] 6.1 Adapt tilth's own `skills/SKILL.md` to the tool-based surface (tool names, root/scope semantics, section-before-edit flow, when NOT to use tilth); register via `pi.skills`; add repo-root skills listing entry if the README indexes skills

## 7. Hashline annotation premise spike (gate for sections 8–9)

- [x] 7.1 Capture real tilth output fixtures from the live server via ad-hoc mcporter: `tilth_read` full-file (small file), `tilth_read` with `section` on a large file, `tilth_read` outline (large file, mode=auto), plus a multi-`paths` call; store under `test/fixtures/`
- [x] 7.2 Spike the recognizer + byte-equality check against the fixtures (shown line content === normalized disk line at that line number; observed gutter shape is `NN` — two spaces, no `│`; elisions are a single tail marker `... truncated (N tokens omitted, budget: M)`)
- [x] 7.3 **Go decision**: byte-equality holds in all fixture classes — full view raw content, section view `NN` gutters (tabs/trailing spaces/CRLF-preserved-`\r` in full, `\r` stripped by section gutters), multi-`paths` per-file regions, sentinels confined to headers (`[empty]`, `[generated — skipped]`), truncation is a tail marker only, no server warnings injected into content regions.
      No no-go trigger fired; the design's assumed `NN │` gutter shape was corrected to the observed `NN` before writing the recognizer.

## 8. Hashline compat — pi-hashline-edit side

- [x] 8.1 Add `src/compat.ts` to `packages/pi-hashline-edit` (verify-then-commit contract, design D7): `COMPAT_VERSION = 1`; `isHashlineEditActive()`; `readNormalizedForAnnotate(path)` (canonicalize via `resolveMutationTargetPath`, read+stripBom+normalizeToLF, return `{ normalized, lines }`, **no** store write; `null` on any failure); `commitExternalRead(path, normalized)` (register exactly the verified bytes: `rememberReadSnapshot` + `clearAppliedPayload` on the canonical path); `mintAnchor(fileLines, line1)` (full-file-context `computeLineHash`)
- [x] 8.2 Flip the activity flag from `index.ts` at extension load
- [x] 8.3 Add `exports` map entry `"./compat": "./src/compat.ts"` to pi-hashline-edit `package.json` (keep `"."` behavior unchanged)
- [x] 8.4 pi-hashline-edit tests: compat module shape, `readNormalizedForAnnotate` performs no store write, `commitExternalRead` produces store state identical to a native `read.ts` read of the same bytes, inert when never activated
- [x] 8.5 pi-hashline-edit docs: README + CONTEXT.md section describing the compat contract and its version; CHANGELOG entry

## 9. Hashline compat — pi-tilth side (`src/lib/hashline-bridge.ts`)

- [x] 9.1 Compat resolution at `session_start`: registry-first — `globalThis.__piHashlineEditCompat` (published by the loaded pi-hashline-edit extension at factory time) — then guarded dynamic `import("pi-hashline-edit/compat")` in `try/catch` as fallback for registry-absent runtimes (explicitly sanctioned exception to the repo no-dynamic-imports rule; cache the settled module-or-null); specifier pinned to the unscoped name `pi-hashline-edit` (verified in its package.json).
      Registry-first is required: pi's loader isolates every extension in its own jiti (`moduleCache: false`), so the import alone yields a second module instance whose store and activity flag the `edit` tool cannot see
- [x] 9.2 Per-call activation check: module resolved AND `COMPAT_VERSION` match AND `isHashlineEditActive()` AND config `hashlineCompat !== false`; plus two post-round-3 opt-outs — `--tilth-no-hashline` session flag (overrides both config files) and `tilth_read`'s client-side `raw` param (stripped before the server call; skips annotation and the snapshot commit)
- [x] 9.3 `src/lib/annotate.ts`: strict recognizer for tilth_read content lines (full-file + section regions; outline/header/scaffold lines untouched); per file `readNormalizedForAnnotate`, verify **every** recognized shown line equals the normalized disk line, rewrite to hashline-edit format via `mintAnchor`, and only then `commitExternalRead`; **any** mismatch/unrecognized shape → passthrough untouched and no commit (design D7, verify-then-commit)
- [x] 9.4 Recognizer tests on the section-7 fixtures; drift fixtures (content changed between server read and disk read → passthrough, no commit)

## 10. Docs + verification

- [x] 10.1 README: install, prerequisites (mcporter; tilth binary or npx; keep-alive config snippet + note that the user's daemon needs `mcporter daemon migrate …` for dedup; note that `tilth install pi` writes `~/.pi/agent/mcp.json` which is inert for pi ≤0.85.1), tool table, `/tilth-savings`, config keys, hashline compat behavior + how to disable, compat topology requirement (single installed copy of pi-hashline-edit in the same module tree), troubleshooting (unavailable modes; ad-hoc npx first call may exceed the 60s timeout — retry; no dedup without daemon)
- [x] 10.2 CHANGELOG Unreleased entry
- [x] 10.3 `pnpm run check` clean from repo root (full output); fix all biome/tsc findings
- [x] 10.4 `pnpm test` (unit + loader + real interop via the workspace devDep); `pnpm test` inside `packages/pi-hashline-edit` stays green
- [x] 10.5 Opt-in integration run (`pnpm test:integration`): real `mcporter call` against `npx tilth --mcp` round-trips for all six tools; record actual ad-hoc per-call latency (incl. npx first-call download behavior: clean timeout + clean retry?) and document measured numbers in the README; if the integration run cannot execute in the target environment, the README MUST present latency figures as estimates, not measurements (W2 acceptance criterion)
- [x] 10.6 `openspec validate add-pi-tilth` clean

## Implementation notes (session log)

- **Design correction (round 4 review, registry bridge):** D7's original "same module tree ⇒ same instance" premise was verified false — pi's extension loader creates a fresh jiti per extension with `moduleCache: false`, so a dynamic import alone yields a second module copy whose snapshot store and activity flag the `edit` tool cannot see (store fragmentation was ruled out by probe: modules within one extension's static import graph do share identity).
  The shipped mechanism is the process-global registry `globalThis.__piHashlineEditCompat` published by pi-hashline-edit's entry point, with the dynamic import kept as fallback.
  Load order is safe: all extension factories run before any `session_start` handler fires.
  Spec/design/tasks amended to match (round 4).
- **Test premise fix (round 4 review):** the ws.txt fake disk in `test/lib/annotate.test.ts` fabricated a trailing `""` line where the captured `(4 lines)` output corresponds to a 3-line file (real compat drops split's trailing empty); the assertion minted an anchor on the phantom blank — impossible under real compat semantics.
  Fixed to a 3-line disk asserting 3 anchors + phantom passthrough; the phantom-cap path remains covered by read-multi-crlf.
- **Repo hygiene (round 4 review):** stray session-export artifacts (`pi-session-*.html`, `*-blobs/`) inside the package dir were untracked-but-not-ignored — a `git add packages/pi-tilth` would have committed a 676K session export.
  Deleted and gitignored.
- **Root check + pi-session-recap (explicit user decision, round 4):** the root `check` script's pi-session-recap typecheck leg was removed at the user's explicit request ("skip pi-session-recap") because its only failure comes from another in-flight change's untracked WIP (`packages/pi-session-recap/test/recap-outcome.test.ts`, imports exports that do not exist — verified pre-existing).
  This is a deliberate, documented decision, not a side effect: root check does not typecheck pi-session-recap until that change lands; restore the leg (`tsc --noEmit -p packages/pi-session-recap/tsconfig.json`) when recap's WIP merges.
- **Skill six-tool coverage (round 5 review):** `skills/tilth/SKILL.md` referenced only `tilth_search`/`tilth_read`/`tilth_list` while its description said "three tilth tools" — failing the tilth-tools spec scenario ("references the six pi tools by name") and giving sessions no guidance for deps/grok/diff workflows.
  Fixed: description says six tools (search, read, list, deps, grok, diff) and the selection table carries rows for `tilth_deps` (blast radius), `tilth_grok` (symbol deep-dive), and `tilth_diff` (structural diff, adapted from upstream's Deps/Diff sections).
- **10.3:** `pnpm run check` is green for every package in this change's scope (pi-tilth, pi-hashline-edit) plus the root biome/tsc surfaces this change touched.
  Remaining root `check` errors are **pre-existing, out-of-scope**: three TDD-stub imports in the *untracked* `packages/pi-session-recap/test/recap-outcome.test.ts` (belongs to another in-flight change; verified failing on a pristine stash).
  Mechanical lint fixes were applied where they were safe (recap-integration.test.ts casts, organizeImports/format).
- **10.4:** green: pi-tilth 54/54 (unit + loader + real-compat interop), pi-hashline-edit 539/539 (incl. 13 new compat tests + a test-isolation fix for the register test that previously read the developer's real `~/.pi/agent/hashline.json`), pi-subagent-herdr 437, pi-mlflow 94, pi-session-recap tracked suite 5.
  Pre-existing failures (all verified identical on pristine HEAD via stash): pi-condense 19 (untracked WIP `proactive-tiers.integration.test.ts`), pi-session-recap 39 (untracked WIP files), pi-accounts 8→(pristine 19), pi-cc-ui 2.
- **Cross-package support changes made for this change:** `packages/pi-hashline-edit`: new `src/compat.ts` + `exports` map entry `./compat` + knip entry + flag flip in `index.ts` + a `noUncheckedIndexedAccess` guard in `fs-write.ts` (required by the repo's stricter shared tsconfig when tsc pulls the source in via the exports map).
  Root `biome.json`: excluded the two packages that self-lint with biome ≥2.5 (`pi-cc-ui`, `pi-hashline-edit` — matching the existing `pi-condense` precedent), and converted their `preset` keys to the 2.3-compatible `recommended` form.
- **10.5 measured ad-hoc latency** (macOS, tilth 0.10.1 via npx, 2026-09-08): warm npx cache ≈0.8–2.7 s/call (median ≈1.2 s), cold-cache download ≈33 s (clean within the 60 s budget; retry after timeout succeeds).
  Recorded in README.

## Adversarial review — response log (2026-09-09)

Review verdict was *Request changes*.
All Critical/Required findings were verified against pi's real `exec` source (0.84.3) and live `mcporter call` probes, then fixed:

- **C1 (killed = success hole):** `Exec`/`McporterCallResult` now carry `killed`; `parseEnvelope` throws `TransportError` before envelope parsing when killed; availability `probe()` rejects killed probes.
  Regression tests cover the code-0-plus-valid-JSON killed case.
- **R1 (CRLF full view never verifies):** live re-probe confirmed the server's full view **preserves** `\r` (the shipped fixture had been `\r`-stripped at capture — it certified a false premise).
  Verifier strips one trailing `\r` from shown lines in both views; anchors embed the `\r`-stripped form.
  Fixture re-captured byte-exact; test premise corrected.
- **R2 (no-trailing-newline last line escapes verification):** confirmed live (`no trailing\nsecond` ends with content, no trailing blank).
  Trailing blank is now subtracted only when present.
  Live-captured fixture + test: the final line now verifies and receives an anchor.
- **R3 (commitExternalRead async drift):** real module is `async`; ambient `.d.ts` and bridge interfaces now declare `Promise<void>`; the annotator awaits it, and a commit failure degrades the file to passthrough (anchors dropped) instead of a floating promise.
- **R4 (root check never visits pi-tilth):** root `package.json` `check` now delegates `pnpm --filter @yofriadi/pi-tilth run check`.
- **O1 (flagship D9 edit-path scenario):** interop test now drives `computeEditPreview` from hashline-edit's real edit pipeline with an anchor copied from annotated tilth output — it validates and produces a diff.
- **O2/O3/N1–N4:** dead `prepareParams` removed; `/tilth-savings` output truncated via the shared pipeline; `sections` gained `maxItems: 20` (server enforces "limited to 20 per call" — verified live); `.babysit/` git-ignored and the typo'd `workflow.pi-tilith.json` removed; truncated-read test name fixed and now asserts the commit; `tilth_search`'s `context` param absolutized like `path`/`scope`.

Not addressed (accepted, with rationale): anchor padding divergence (cosmetic; `parseAnchorRef` tolerates both), fake-header injection & paths-with-spaces headers (both degrade safely to passthrough — probed).

## Adversarial review round 2 — response log (2026-09-09)

Verdict was *Request changes* (no Critical/Escalate; 2 Required, 5 Optional, 5 Nit).
All remediations applied:

- **Required 1 (inline type import):** `toolkit.ts` now uses a top-level `import type { Exec }`; the dynamic `import()` in the hashline bridge stays the single sanctioned exception (design D10).
- **Required 2 (zero truncation coverage):** new `test/lib/truncate.test.ts` — passthrough, head+spill+pointer (spill file contains the full text; head is a proper prefix), distinct spill paths for back-to-back calls, savings-command notify truncation / verbatim passthrough / transport-failure warning.
- **Optional 3 (README contradiction):** both passages now state truncated full reads annotate the verified prefix and commit (the deliberate, tested behavior).
- **Optional 4 (describe-scope bare expect):** wrapped as `it`; killed-process test folded into the describe.
- **Optional 5 (dead machinery):** `gutterWidth`, `width`, write-only `startLine`/`endLine` removed from `FileRegion`.
- **Optional 6 (tmpfile collision):** spill name now `tilth-<pid>-<ms>-<seq>.txt` (same-millisecond parallel calls can't overwrite each other), regression-tested.
- **Optional 7 (coverage gaps):** multi-file drift independence test (spec Scenario "Multi-file read"); `context` absolutization tests (relative + absolute).
- **Nit 8-12:** stale availability doc comment fixed; "leniently" comment reworded to exact-match; speculative `> Related:` swallow loop deleted (unrecognized shapes degrade safely; section-view footer handling retained); design D9 skip-branch text aligned with reality; `${" ".repeat(0)}` cruft dropped; 12 unused spike fixtures removed and a fresh live-captured whitespace-edge multi-path fixture (`read-multi-whitespace.txt`) wired in.

**Live-probe discovery while wiring N12** (beyond the review): tilth's "N lines" header counts `fileText.split("\n")` *including* the phantom trailing empty element, and full views render that phantom as a real blank line — so blank-count trimming could never disambiguate phantom/separator blanks from genuine blank content lines.
The full-view region is now capped at the compat line count during verification (excess shown lines must be blank), with a `truncatedTail` flag exempting marker-bounded regions (the server shows fewer lines than disk when budget-truncating).
Verified against live captures: `ws.txt` (trailing-spaces/tabs), `nt.txt` (no trailing newline), `ewb.txt` (file ending with a blank line), `p1.txt`, `blanks_mid.txt` (interior blanks).

## Adversarial review round 3 — response log (2026-09-10)

Verdict: **Approve** (no Critical/Required/Escalate; 2 Optional, 4 Nit).
The reviewer independently re-verified every round-1 and round-2 remediation — including against pi 0.84.3's real `exec.js` (`resolve({..., code: code ?? 0, killed})`), the real `pi-hashline-edit/compat` module via realpath, byte-level fixture inspection, programmatic description diffing against the frozen schema, and hand-re-derivation of the phantom-trailing-blank capping arithmetic against every shipped fixture.
Optional/Nit polish applied:

- **Optional 1 (savings never exercised live):** live-probed `tilth_savings` with the root-only scoped object — the server accepts extras (normal result, no unknown-property rejection).
  Added a `tilth_savings` round-trip to the integration suite (now 7 tools, 9 tests) so the seventh surface is exercised against the live server.
- **Optional 2 (repository URL):** corrected `ycm/pi-extensions.git` → `yofriadi/pi-extensions.git`, matching the @yofriadi siblings and the convention of the other packages.
- **Nit 3 (dead `void` silencers):** removed both, plus the now-unused imports (`Type`, `ExtensionAPI`).
- **Nit 4 (double applyScoping):** `runTilthCall` now returns `{ text, scopedParams }`; the annotator path reuses the scoped params for `readTargetPaths` instead of re-scoping.
- **Nit 5 (unavailable-transport notify untested):** added the savings-command test — warns via notify with the static message, never reaches the exec seam (spec Scenario "Unavailable transport").
- **Nit 6 (v1 compat scope not pinned):** loader test now locks the scope — `annotate: true` appears only in `read.ts`, absent from the other five tools' sources.
- **FYI items** accepted as-is with rationale (Related-footer full views degrade safely to passthrough; duplicated paths entries annotate only the last block — degenerate input, safe degradation; verbatim-description vs advisory-guidelines tension is the spec's D4 mandate).

## Implementation note (2026-09-13) — keep-alive scope fix

Diagnosed from session log `2026-09-12T11-24-04-426Z_…` (pi-cc-ui): bare `tilth_list`/`tilth_search` returned `~/.mcporter`.
Root cause: tilth resolves an omitted `scope` to the server's own process cwd and ignores `root` for that purpose (upstream pin: `resolve_scope_no_arg_ignores_root`); the mcporter keep-alive daemon spawns `tilth --mcp` with cwd `~/.mcporter`. pi-tilth's `root`-only scoping (D3) was therefore insufficient in config mode.

Fix: `applyScoping` gains `ScopeOptions.defaultScope`; the search-root tools (`tilth_search`, `tilth_list`, `tilth_grok`, `tilth_deps`) set `defaultScope: true`, injecting `scope: <resolved root>` (caller `root`, else session cwd) only when the caller omitted `scope`.
`tilth_read` (no scope param) and `tilth_diff` (scope is an output filter — verified live that injecting it breaks file matching) receive no injection.
Regression tests added in `test/lib/transport.test.ts` and `test/tools.test.ts`; verified end-to-end against the live daemon.
D3 amended above.
