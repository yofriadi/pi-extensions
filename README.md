# pi-provider-antigravity

A [Pi](https://github.com/earendil-works/pi-mono) extension that restores the Google Cloud Code Assist (Gemini CLI) and Antigravity (Gemini 3, Claude, GPT-OSS) OAuth providers.

## Install

```bash
# From npm
pi install npm:@yofriadi/pi-provider-antigravity

# Local clone
pi -e packages/pi-provider-antigravity

# Or point Pi at this directory
pi -e /path/to/pi-extensions/packages/pi-provider-antigravity
```

Once loaded, `/login` will surface two new targets:

- `Google Cloud Code Assist (Gemini CLI)` — standard Gemini models via the prod Cloud Code Assist endpoint.
- `Antigravity (Gemini 3, Claude, GPT-OSS)` — extended model set (Gemini 3, Claude 4.x, GPT-OSS) via the Antigravity sandbox.

## What it does

This package is a self-contained Pi extension that re-implements the two Google OAuth flows that shipped with Pi prior to v0.71.0:

- **PKCE OAuth dance** against Google's standard authorization endpoint.
- **Local callback server** on port 8085 (Gemini CLI) or 51121 (Antigravity).
- **Project discovery** that provisions a Cloud Code Assist project for the user (Gemini CLI) or falls back to a default project (Antigravity).
- **Token refresh** persisted to Pi's auth storage.
- **Model registration** for the full set of Gemini, Claude, and GPT-OSS models exposed by each endpoint.

See `packages/pi-provider-antigravity/README.md` for model IDs and provider details.

## Development

```bash
pnpm install                         # install workspace deps (incl. peer deps)
pnpm test                            # run all tests
pnpm run check                       # biome + tsc
pnpm run check:fix                   # biome --write
```

Tests are colocated in `packages/pi-provider-antigravity/test/` and exercise both the lower-level OAuth helpers and the full extension-load path through the real Pi loader.

## Layout

```
.
├── packages/
│   └── pi-provider-antigravity/
│       ├── src/                 # extension source (TypeScript, no build)
│       │   ├── index.ts
│       │   ├── cloud-code-assist.ts
│       │   ├── google-gemini-cli-oauth.ts
│       │   ├── google-antigravity-oauth.ts
│       │   ├── google-oauth-utils.ts
│       │   ├── models.ts
│       │   └── vendor/
│       ├── test/                # vitest test suite
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
├── biome.json
├── package.json                 # workspace root
├── tsconfig.json
├── tsconfig.base.json
├── vitest.config.ts
└── README.md
```

This is a source-only repo. Pi loads `./src/index.ts` directly via jiti; there is no build step. The `@yofriadi/pi-provider-antigravity` package is published to npm as `@yofriadi/pi-provider-antigravity`; the root workspace is not.
