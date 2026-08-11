## 1. Status always-on (drop config file dependency)

- [x] 1.1 Replace `loadStatusConfig` / file fallback in `src/status.ts` with a constant always-enabled `StatusConfig` (keep existing line-limit constant)
- [x] 1.2 Delete dead status-config machinery: `parseStatusConfig`, `requireObject` / `requireBoolean` / `rejectUnsupportedKeys` / `invalidStatusConfig` (if only used by that parser), and package path constants `DEFAULT_STATUS_CONFIG_PATH` / `STATUS_CONFIG_EXAMPLE_PATH`
- [x] 1.3 Update `src/index.ts` call sites that branch on `statusConfig.enabled` so status aggregation/widget always run (simplify or drop the boolean if unused)
- [x] 1.4 Rewrite or remove unit tests in `test/test.ts` that require `config.json` / `config.json.example` for status loading, missing-file errors, and `status.enabled` parsing

## 2. Hard-code spawn defaults

- [x] 2.1 Remove `loadExtensionDefaults` package JSON I/O from `src/index.ts`; keep one in-code `ExtensionDefaults` constant with `blocking: false`, `layout: "attached"`, `surface: "pane"`, `direction: "right"` so resolve helpers retain their injectable default seam for tests
- [x] 2.2 Confirm `resolveBlocking` / `resolveLayout` / `resolveSurface` / `resolveDirection` still prefer per-call tool args over the hard-coded defaults
- [x] 2.3 Add or adjust unit coverage that omitted `blocking` is background and omitted layout trio resolves to attached/pane/right

## 3. Remove package model-config surface

- [x] 3.1 Delete unused `src/model-config.ts` (or equivalent) and all imports once confirmed unused by launch/resume
- [x] 3.2 Remove model-config unit tests that only exercised package `models.default` / `models.agents` parsing
- [x] 3.3 Grep the tree for residual `models.default`, `loadModelConfig`, `parseModelConfig`, `resolveModelDefault`, and package model-map references; clean docs/comments

## 4. Delete package config artifacts

- [x] 4.1 Delete `config.json.example` from the package root
- [x] 4.2 Remove `config.json.example` from `package.json` `files`
- [x] 4.3 Remove obsolete `config.json` from `.gitignore` if present solely for the package config surface
- [x] 4.4 Ensure no runtime path still references package-root `config.json` or the example file (except historical changelog notes if desired)

## 5. Docs and verification

- [x] 5.1 Update `README.md`: remove the copy-config section; document always-on status, hard-coded spawn defaults, agent-frontmatter model ownership, and explicit `blocking: true`
- [x] 5.2 Note the breaking change briefly in `CHANGELOG.md` if the project tracks unreleased changes there
- [x] 5.3 Run unit tests (`pnpm test` / package test script) and fix failures from removed config loaders
- [x] 5.4 Spot-check that a fresh install without any package JSON still registers tools and enables status
