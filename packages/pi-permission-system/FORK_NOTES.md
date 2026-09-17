# Fork notes

Local fork of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system), imported as a git subtree at upstream version 32.1.0.

Refresh with `pnpm run update:pi-permission-system` from the repo root.

Keep local fixes in commits separate from subtree imports so they survive a refresh.

## Local changes

- `package.json`: renamed to `@yofriadi/pi-permission-system` with a `forkOf` provenance block.
  `repository`, `homepage`, and `bugs` still point upstream, since they describe where the code comes from and this fork is not published.
- `package.json`: the `exports.types` condition pointing at the gitignored `./dist/public.d.ts` is removed, because nothing in this repo runs `build:types`.
  Restore it if the package is ever published from here.
- `package.json`: dev dependencies pinned to this repo's versions instead of upstream's `catalog:` specifiers, which cannot resolve here because this workspace defines no catalog.
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` keep upstream's own `0.79.1` pins, which are what its suite is written against.
- `tsconfig.json`: does **not** extend `../../tsconfig.base.json`.
  It reproduces upstream's own base options instead.
  This repo's base adds `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, which upstream source is not written against.
- `biome.json` and `prek.toml` (repo root): this package is excluded, as the other vendored packages are.
  Upstream formats with 2 spaces; this repo formats with tabs.

## The custom-prompt divergence

Upstream fixed [#919](https://github.com/gotgenes/pi-packages/issues/919) in 32.0.6 by scoping the removal pass to regions Pi or the package authored, while still appending the session's own tool-surface block to every prompt.

This fork keeps the imported code as-is but *skips* `renderToolSurface` when Pi built the prompt from a custom one (`src/handlers/before-agent-start.ts`).

An operator-supplied prompt is left alone: nothing removed, nothing appended.

The tool-surface pass never touches it, so byte-identity holds for that concern unconditionally.

Skill filtering can still rewrite the prompt's skills catalogue when policy withholds a skill, so the handler returns no override only when no skill is withheld.

Every `pi-subagent-herdr` child is such a prompt: its `--system-prompt` is its own agent definition, which states its own tools, so upstream's reason for always appending does not apply here.

Upstream's subagent children carry no tool prose of their own; ours do.

`toolRegistry.setActive` and the permission gates remain the sole authority either way.

## Invariants not enforced in this fork

Upstream's ESLint config carries three rules scoped specifically to this package.

Biome cannot express any of them, and this repo has no ESLint, so the `lint` script here drops `eslint .`.

The `lint:md` script is kept but left out of `lint`: it was written against an upstream `.rumdl.toml` pinning rumdl `0.2.24`, while this repo runs `^0.2.40`, and the imported `docs/` tree plus `CHANGELOG.md` would flood findings.

Re-run upstream's own `lint` against a clean upstream clone before offering any patch:

- a same-directory import convention for `src/**` and `test/**` (upstream #837);
- a ban on interior `process.platform` reads outside `src/index.ts` (upstream #510);
- an import restriction keeping `policy/permission-manager.ts` off `AccessPath` (upstream ADR-0002).

## Deliberate exception: constructor parameter properties

This repo's conventions forbid TypeScript constructor parameter properties, because Node's strip-only mode cannot compile them.

Upstream uses them in roughly 89 places, including `AgentPrepHandler` itself.

They are kept as-is.

Pi loads extension sources through jiti, which compiles them; vitest compiles them; `tsc --noEmit` is indifferent.

Rewriting 89 constructors would also destroy the byte relationship an upstream patch depends on.

The exception has one boundary worth knowing: the package's own `gen:schema` script runs `node --experimental-strip-types`, which is native stripping and *would* reject a parameter property.

It only imports `src/config/config-schema.ts`, whose import chain reaches none today, so the script works — but an import that pulls one in would break it.

Code this fork authors still follows the repo rule.

## Known upstream interactions

Pi's custom-prompt branch appends `<available_skills>` only when `read` or `bash` is in the session's active tool set (upstream `system-prompt.js` resolves `skillFileReadTool` from those two names).

If policy withholds both, later turns' prompts carry no skills catalogue at all, so this package's skill filtering has nothing to resolve and the session's skill entries go empty.

That is Pi and this package's shared upstream behavior, unchanged by the custom-prompt skip, and worth knowing before blaming the divergence.
