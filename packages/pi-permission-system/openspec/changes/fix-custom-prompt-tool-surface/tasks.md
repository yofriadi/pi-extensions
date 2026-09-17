## 1. Subtree import

- [x] 1.1 Confirm the worktree is clean for `packages/pi-permission-system`, then move the `openspec/` tree written for this change aside to a temp directory: `git subtree add` refuses a prefix that already exists on disk (`cmd_add` dies on `[ -e "$dir" ]`), so the prefix must be empty.
- [x] 1.2 Import with the split-branch recipe from `GIT_SUBTREE.md`, since the upstream package lives under `packages/pi-permission-system` inside a monorepo and the repository root must not be subtree-added: clone `https://github.com/gotgenes/pi-packages.git` to a temp dir, run `git subtree split --prefix=packages/pi-permission-system --branch=pi-permission-system-root main` inside it, then from the monorepo root run `git subtree add --prefix=packages/pi-permission-system "$tmp/repo" pi-permission-system-root --squash`.
- [x] 1.3 Restore the `openspec/` tree into the imported package and confirm `git status` shows it as the only untracked addition under the prefix.
- [x] 1.4 Add `scripts/update-pi-permission-system-subtree.sh` modelled on `scripts/update-session-recap-subtree.sh`: clean-worktree guard, temp clone, `subtree split` on the upstream prefix, `git subtree pull --squash` with a fixed message, and a closing review hint naming the upstream ref.
- [x] 1.5 Register `"update:pi-permission-system": "bash scripts/update-pi-permission-system-subtree.sh"` in the root `package.json`, alongside the four existing update scripts.

## 2. Make the package install, compile, and lint in this repo

Each task here fixes a constraint verified against this repository; skipping any one leaves the package broken rather than merely unpolished.

- [x] 2.1 Replace the `"catalog:"` dev-dependency specifiers in the package manifest with concrete versions, since this repository's `pnpm-workspace.yaml` defines no catalog and `pnpm install` fails on an unresolvable `catalog:`.
      The `catalog:` form exists in the upstream *git tree* that 1.2 imports (seven specifiers: `@biomejs/biome`, `@types/node`, `rollup`, `rollup-plugin-dts`, `rumdl`, `typescript`, `vitest`); the published tarball resolves them to concrete versions, so inspect the git tree rather than a packed copy when doing this.
      Prefer the versions the root already pins (`typescript 5.9.3`, `vitest 3.2.4`, `@types/node 22.19.19`, `@biomejs/biome 2.3.5`) so the workspace resolves one copy.
      Upstream's catalog asks for `typescript ^6.0.3` and `vitest ^4.1.11`, both majors ahead of this repo's pins, so treat this as a real compatibility question rather than a version nit: type-check and run the suite on the pinned versions in 2.9, and if either fails, install the package-local version it needs instead of weakening the code.
- [x] 2.2 Give the package a local `tsconfig.json` that does not inherit `../../tsconfig.base.json`, reproducing upstream's own base options (ES2024 target, `strict`, `skipLibCheck`, `esModuleInterop`, `allowSyntheticDefaultImports`, `resolveJsonModule`, bundler resolution) plus the `#src/*` and `#test/*` paths.
      This repository's base adds `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and an ES2022 lib that upstream source is not written against — `tool-surface-prompt.ts:241` indexes `lines[index]` unguarded — so inheriting it would demand hundreds of unrelated edits and destroy the byte relationship the upstream patch needs.
- [x] 2.3 Add `"!packages/pi-permission-system"` to `files.includes` in the root `biome.json`, matching the existing exclusions for the other vendored packages.
      Without it `biome check .` reformats the whole subtree from space/2 to tab/4/120.
- [x] 2.4 Adjust the package's `lint` script to drop `eslint .`, which this repository does not provide, keeping `biome check .` and the markdown lint.
      Record in the package README or a fork note that upstream's three package-scoped ESLint rules (same-directory import convention, no interior `process.platform`, permission-manager import restriction) are not enforced in this fork and must be re-checked upstream before any patch is offered.
- [x] 2.5 Point the package's `lint:md` at this repository's rumdl configuration, or drop it from the fork's scripts: it was written against an upstream `.rumdl.toml` pinning rumdl `0.2.24`, while this repo runs `^0.2.40`, and the imported `docs/` tree plus a large `CHANGELOG.md` would otherwise flood findings.
- [x] 2.6 Append `tsc --noEmit -p packages/pi-permission-system/tsconfig.json` to the root `check` script chain, after 2.2 makes it pass.
- [x] 2.6a Record a deliberate exception to this repository's strip-only TypeScript rule for this package: upstream uses constructor parameter properties in roughly 89 places, including `AgentPrepHandler` itself (`handlers/before-agent-start.ts:70-76`).
      Bare `node --experimental-strip-types` rejects them with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, but Pi loads extension sources through jiti, which compiles them — verified by loading a parameter-property class through the jiti version Pi depends on, and `loader.js` routes every branch through jiti with native stripping left off.
      Vitest compiles them too, and `tsc --noEmit` is indifferent, so tests and type-checking are unaffected.
      The exception is not unconditional: the package's own `gen:schema` script runs `node --experimental-strip-types scripts/generate-permissions-schema.ts`, a native-strip invocation.
      It only imports `config/config-schema.ts`, whose import chain reaches no parameter property today, so it works — but any future import that does will break it.
      State that boundary in the fork note rather than claiming the source "runs as-is" everywhere.
      Note this so the rule is not silently violated, and so nobody "fixes" 89 constructors and destroys the upstream patch relationship.
      Any code this fork *authors* still follows the repo rule.
- [x] 2.6b Decide the `exports.types` story before publishing anything: the manifest points `types` at `./dist/public.d.ts`, which is gitignored and produced by `build:types` (`rollup -c rollup.dts.config.mjs`).
      Either run that build, drop the `types` condition for the fork, or mark the package private.
      Type-checking alone does not produce `dist`, so the exports map dangles until this is settled.
- [x] 2.7 Run `pnpm install` from the repo root and confirm the package resolves, including `tree-sitter-bash`, `web-tree-sitter`, and `zod`.
      Upstream's workspace grants `tree-sitter-bash` a build allowance that this repo does not, so confirm the two `.wasm` files the bash parser resolves at runtime are present in the installed packages.
- [x] 2.8 Confirm the package's peer dependencies resolve for tests: upstream pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as dev dependencies, and no package in this repository currently installs `pi-tui`.
- [x] 2.9 Establish the upstream baseline before touching any source: run the package's own suite (`vitest run` from the package directory, so its `vitest.config.ts` and `#test/*` alias apply) and record the pass count.
      A later failure is then attributable to this change rather than to the import.
- [x] 2.10 Verify `BeforeAgentStartEvent.systemPromptOptions.customPrompt` exists in the installed `@earendil-works/pi-coding-agent` typings.
      The whole fix rests on that field, and because the handler's payload type is local, a local widening would compile even if the field were absent — leaving a guard that never fires.

## 3. Failing test first

- [x] 3.1 In `test/handlers/before-agent-start.test.ts`, add the reproduction from issue #919: build an event whose prompt states its surface as `## Available Tools` and `## Guidelines` and whose options carry a non-empty `customPrompt`, then assert the returned prompt contains no generated `Available tools:` block.
      The existing `makeEvent` helper already takes `Partial<BuildSystemPromptOptions>`, so no fixture change is needed.
      This fails before the fix.
- [x] 3.2 Add a byte-identity assertion for the same event, using a fixture that withholds no skill: the returned prompt equals the input prompt exactly, covering whitespace, blank-line runs, and line endings.
      The fixture matters — `resolveSkillPromptEntries` still runs on the passed-through prompt and rewrites the skills catalogue when policy withholds a skill, so byte-identity holds only when none is withheld.
- [x] 3.3 Add a case where the custom prompt uses Pi's literal `Available tools:` / `Guidelines:` headers and asserting it is still left untouched, so header style never decides ownership.
- [x] 3.4 Add the negative case: with no `customPrompt`, relocation still happens — Pi's sections are removed from the preamble and this session's are rendered at the end, exactly as before.
- [x] 3.5 Add an empty-string case asserting `customPrompt: ""` does not count as operator-authored and relocation still runs.
- [x] 3.6 Add the enforcement-independence cases: with `customPrompt` set and a tool fully denied, `setActive` receives the same allowed set it would without a custom prompt, and a denied skill is still filtered from the prompt and recorded inactive.
      These guard against the guard being placed too early in `handle`.
- [x] 3.7 Run the package suite and confirm the new tests fail for the stated reason — an appended generated block — rather than by construction error.

## 4. Implementation

- [x] 4.1 In `src/handlers/before-agent-start.ts`, widen `BeforeAgentStartPayload.systemPromptOptions` with `customPrompt?: string`, and update the interface comment: `toolSnippets` explains rendering, and `customPrompt` explains when rendering is skipped.
- [x] 4.2 Guard the `renderToolSurface` call on a non-empty `customPrompt`, passing `event.systemPrompt` through unchanged when one is present.
      Keep the guard on that call alone, after `setActive` and the changed-surface log and before `resolveSkillPromptEntries`, so no other per-turn work is skipped.
- [x] 4.3 Add a comment at the guard recording why the prompt is left alone — the operator defined it, the surface is prose, and the gates enforce — with a pointer to the proposal's rejected alternatives so a future reader does not reintroduce in-place rewriting.
- [x] 4.4 Confirm no `any` was introduced and the change uses no syntax outside Node strip-only TypeScript.
- [x] 4.5 Leave `src/exposure/tool-surface-prompt.ts` untouched and confirm `git diff --stat` shows one source file changed.

## 5. Verification

- [x] 5.1 Run the package suite and confirm every new test passes and the count matches the 2.9 baseline plus the added cases, with the existing prefix-stability cases for #890 green.
- [x] 5.2 Run `pnpm run check` from the repo root with full output; confirm the package type-checks and that biome reports no findings attributable to this change.
- [x] 5.3 Run `pnpm test` from the repo root to confirm no sibling package regressed, `pi-subagent-herdr`'s permission integration tests in particular.
- [ ] 5.4 Live-check the parent case: launch a session with a custom `SYSTEM.md` and confirm the prompt carries one tool-surface section and no generated block after `Current working directory:`.
- [ ] 5.5 Live-check that enforcement is unchanged: with a tool denied by policy under a custom prompt, confirm the tool is inactive and a call to it is refused.
- [ ] 5.6 Live-check a subagent child: confirm its prompt is its own agent definition and carries no generated tool block.
- [ ] 5.7 Diff the rendered parent prompt against the pre-fix prompt and confirm the only difference is the removal of the appended block.

## 6. Upstream contribution

Disposition after the 2026-09-16 rebase onto the upstream tip (32.1.0).

Upstream closed #919 with its own fix, which scopes removal to Pi- or package-authored regions but still appends the session's tool-surface block under a custom prompt.

This fork imported that tip and keeps the skip as a deliberate divergence, recorded in `FORK_NOTES.md`.

So 6.1 resolves to the fork note, because release-please owns `CHANGELOG.md`, and 6.3–6.5 are obsolete as written.

There is no pull request to prepare, because upstream's landed test comment explicitly rejects the skip for their subagent design, where children carry no tool prose of their own.

6.6 remains worth filing independently of any pull request.

- [x] 6.1 Add a `CHANGELOG.md` entry for the fork describing the user-facing fix: no duplicate tool surface when a custom system prompt is in use, and the operator's prompt left untouched.
      Confirm upstream's release tooling does not own that file before hand-editing it.
- [x] 6.2 Keep the fix in its own commit, separate from the subtree import, using Conventional Commits as upstream requires: `fix(pi-permission-system): leave a custom system prompt's tool surface alone`.
- [ ] 6.3 Produce the upstream contribution as a hand-applied patch of the changed handler and its tests against a clean upstream clone, not via `git subtree split`: a split branch would carry the fork rename, the `forkOf` block, the dropped ESLint invocation, the fork changelog entry, and the whole `openspec/` tree.
- [ ] 6.4 Re-run upstream's own `lint` (including ESLint) against that clean clone before opening the pull request, since 2.4 leaves those three rules unenforced in this fork.
- [ ] 6.5 Open the pull request against issue #919, noting that the fix is the one the issue suggested, that the duplicate arises because `buildSystemPrompt` emits no tool surface on the `customPrompt` branch, and that Markdown is written one sentence per line per upstream's convention.
- [ ] 6.6 File the underlying Pi issue — `buildSystemPrompt` omits the tool surface on the `customPrompt` branch, and `BeforeAgentStartEvent` exposes no structured tool-surface region — and cite it from the pull request.
- [ ] 6.7 Run `openspec validate fix-custom-prompt-tool-surface --strict` and `rumdl check` over the change directory, then archive the change.
