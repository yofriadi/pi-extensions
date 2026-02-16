# Releasing Packages (npm Trusted Publisher / OIDC)

This repository publishes workspace packages independently via GitHub Actions using npm Trusted Publisher (OIDC), without `NPM_TOKEN`.

Workflow file:

- `.github/workflows/release-packages.yml`

## Packages

- `@yofriadi/pi-ast` (`packages/ast`)
- `@yofriadi/pi-fuzzy-match` (`packages/fuzzy-match`)
- `@yofriadi/pi-hashline-edit` (`packages/hashline-edit`)
- `@yofriadi/pi-lsp` (`packages/lsp`)
- `@yofriadi/pi-mcp` (`packages/mcp`)
- `@yofriadi/pi-web-search` (`packages/web-search`)

## One-time npm setup (per package)

In npm package settings, configure **Trusted Publisher**:

- Provider: GitHub Actions
- Repository: this repository
- Workflow file: `release-packages.yml`
- Environment (if requested): match your Actions setup

> For this repo, all listed packages are already published, so Trusted Publisher can be configured directly.

## Standard release flow

1. Bump package version in the target package directory.
2. Commit and push to `main`.
3. Run GitHub Actions workflow **Release Packages** with inputs:
   - `package`: one package or `all`
   - `run_checks`: `true` (recommended)
   - `dry_run`: `true` first, then `false`
   - `create_tags`: `true` (recommended)
4. Verify npm published version and tag creation.

## Pre-release checks

If `run_checks=true`, workflow runs:

- `bun run deps:check`
- `bun run check:ci`
- `bun run test`
- `bun run scorecard:check`
- `bun run audit`

## Tag format

On successful non-dry-run publish, the workflow creates:

- `<package-name>@<version>`

Examples:

- `@yofriadi/pi-hashline-edit@0.2.0`
- `@yofriadi/pi-lsp@1.16.11`

## Troubleshooting

### `npm ERR! 401/403` during publish

Trusted Publisher is not correctly configured for that package/repo/workflow file.

- Re-check npm package settings and workflow filename.
- Ensure the publish job has `permissions: id-token: write`.

### `npm ERR! 404 Not Found` for package on publish

Package name/version mismatch or package has not been created under expected scope.

- Verify `name` in `packages/*/package.json`.
- Verify scope ownership and package access.

### `You cannot publish over the previously published versions`

Version already exists.

- Bump version and re-run.

### Tag already exists

Workflow skips creating duplicate tags.

## Notes

- Root package is private; releases are per workspace package.
- Workflow uses `npm publish --provenance --access public` for OIDC + provenance.