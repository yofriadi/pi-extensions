# Development Rules

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit.
  Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules/<dep>` for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports).
  Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- This repo uses Node strip-only TypeScript syntax (no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit).
  Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands

- After code changes (not docs): `pnpm run check` (full output, no tail).
  Fix all errors, warnings, and infos before committing.
  Does not run tests.
- Run tests with `pnpm test` from the repo root.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done.
  Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Testing

- Test runner is per-package — check its `package.json`.
  Most use vitest; pi-accounts and pi-cc-ui use `node:test`; pi-condense uses `bun test`.
  `pnpm test` from the repo root runs all of them.
- The peer deps `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are installed as regular dev deps so tests can exercise the real loader path.
- Do not mock the extension loader.
  Loader-level integration tests must load the extension through `discoverAndLoadExtensions` from `@earendil-works/pi-coding-agent` (pattern: `packages/pi-provider-antigravity/test/accounts-with-antigravity.test.ts`) and assert the extension is discovered and registers its providers/commands.
  Mocking the `pi` API object for plain unit tests is fine.
- Cover the low-level edge cases the implementation has to handle (e.g. OAuth denial, manual paste fallback in pi-accounts / pi-provider-antigravity).

## Layout

- There is no build step and no `dist/`: Pi loads source files directly, and each package's `package.json` declares the entry in `pi.extensions`.
  Entry locations vary per package:
  - `./src/index.ts` — pi-event-sounds, pi-mlflow, pi-provider-antigravity, pi-subagent-herdr, pi-tilth
  - `./index.ts` (package root) — pi-condense, pi-hashline-edit, pi-session-recap
  - `./src/accounts.ts` — pi-accounts
  - `./extensions/index.ts` — pi-cc-ui
- Tests live in `packages/<name>/test/` (most packages), `packages/<name>/tests/` (pi-cc-ui), or co-located as `src/**/*.test.ts` (pi-condense).
- Vendored third-party helpers not worth pulling a dep for (e.g. PKCE, OAuth pages) live under `packages/<name>/src/vendor/` — currently only pi-provider-antigravity vendors them.
