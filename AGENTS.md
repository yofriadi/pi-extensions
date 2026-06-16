# Development Rules

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules/<dep>` for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- This repo uses Node strip-only TypeScript syntax (no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit). Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands

- After code changes (not docs): `pnpm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Run tests with `pnpm test` from the repo root.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Testing

- Tests live next to the package: `packages/<name>/test/`.
- The peer deps `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are installed as regular dev/peer deps so tests can exercise the real loader path.
- Tests should cover the loader-level integration (extension is discovered and registers both providers) and any low-level edge cases the implementation has to handle (OAuth denial, manual paste fallback, etc.).
- Do not mock the loader or the package itself; load the package's `src/index.ts` through `loadExtensions` from `@earendil-works/pi-coding-agent`.

## Layout

- `packages/<name>/src/` — the extension source. Pi loads `<name>/src/index.ts` directly.
- `packages/<name>/test/` — vitest tests.
- `packages/<name>/vendor/` — vendored third-party helpers (PKCE, OAuth pages, etc.) that are not worth pulling a dep for.
- `packages/<name>/package.json` — `pi.extensions` points to `./src/index.ts`. There is no `dist/` and no `build` script.
