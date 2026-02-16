# Dependency Policy

## External pi dependencies

This repository depends on external pi packages maintained outside this workspace.

Current constrained versions:

- `@mariozechner/pi-ai`: `^0.52.10`
- `@mariozechner/pi-coding-agent`: `^0.52.10`

Package-level peer ranges are also constrained to avoid accidental floating with `*`.

## Why constraints are required

Using `*` can silently introduce behavior and type changes that bypass review and break extension compatibility.

Constrained ranges provide:

- reproducible installs,
- explicit upgrade intent,
- easier bisecting when regressions appear.

## Update workflow

1. Update version ranges intentionally in `package.json` / package peer dependencies.
2. Run:
   - `bun install`
   - `bun run deps:check`
   - `bun run check`
   - `bun run test`
   - `bun run audit`
3. Document upgrade impact in PR notes.

## Security audit

Run `bun run audit` regularly (CI and before releases). Any advisory affecting runtime paths must be triaged before merging.

`bun run deps:check` is also enforced in CI to prevent wildcard/floating ranges for external `@mariozechner/pi-*` dependencies.
