# Releasing Packages (Git Tags + GitHub Releases)

This repository distributes workspace packages through git (not npm).

Workflow file:

- `.github/workflows/release-packages.yml`

## Packages

- `@yofriadi/pi-ast` (`packages/ast`)
- `@yofriadi/pi-commit` (`packages/commit`)
- `@yofriadi/pi-fuzzy-match` (`packages/fuzzy-match`)
- `@yofriadi/pi-hashline-edit` (`packages/hashline-edit`)
- `@yofriadi/pi-lsp` (`packages/lsp`)
- `@yofriadi/pi-mcp` (`packages/mcp`)
- `@yofriadi/pi-review` (`packages/review`)
- `@yofriadi/pi-web-search` (`packages/web-search`)

## Distribution outputs

For each released package version, the workflow can create:

1. **Git tag** (install pin):
   - `<pkg>-v<version>`
   - examples: `lsp-v1.16.11`, `mcp-v0.1.1`
2. **GitHub release** on that tag with assets:
   - `<pkg>-<version>.tar.gz`
   - `<pkg>-<version>.sha256`
3. **Release title** for human readability:
   - `<npm-name>@<version>`

## Standard release flow

1. Bump package version in `packages/<pkg>/package.json`.
2. Commit and push to `main`.
3. Run GitHub Actions workflow **Release Packages (Git)** with inputs:
   - `package`: one package or `all`
   - `run_checks`: `true` (recommended)
   - `dry_run`: `true` first, then `false`
   - `create_tags`: `true` (recommended)
   - `create_releases`: `true` (recommended)
4. Verify pushed git tag and GitHub release assets.

## Pre-release checks

If `run_checks=true`, workflow runs:

- `bun run deps:check`
- `bun run check:ci`
- `bun run test`
- `bun run scorecard:check`
- `bun run audit`

## Install from git URLs

Install this package repository from git and pin to a release tag:

```bash
pi install git:github.com/yofriadi/pi-extensions@lsp-v1.16.11
# or
pi install https://github.com/yofriadi/pi-extensions@lsp-v1.16.11
```

Then enable the extensions you want via package filters in settings (global or project), for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@lsp-v1.16.11",
      "extensions": ["packages/lsp/src/index.ts"]
    }
  ]
}
```

## Troubleshooting

### Tag already exists

If the target tag exists, tag creation is skipped.

- Bump package version and rerun.

### Release exists but assets are stale

Workflow uploads with `--clobber`.

- Re-run release job to replace assets.

### GitHub release creation fails

- Ensure workflow has `permissions: contents: write`.
- Ensure `GITHUB_TOKEN` is available (default in GitHub-hosted runs).

## Notes

- Root package is private; releases are per workspace package.
- GitHub release tarballs are generated from tracked files under `packages/<pkg>`.
