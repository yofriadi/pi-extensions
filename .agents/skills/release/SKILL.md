---
name: release
description: Use when asked to release, publish, bump the version, or cut a tag for yofriadi/pi-condense.
---

# Release

`@yofriadi/pi-condense` publishes to **npm** (public, scoped); the `pi-package` keyword
lists it on `https://pi.dev/packages/@yofriadi/pi-condense`. Users install with
`pi install npm:@yofriadi/pi-condense`.

The release is **tag-driven and CI-executed**: a plain `vX.Y.Z` tag created from
`local/main` first passes a no-OIDC provenance validation job, then enters the protected
`npm-publish` environment to run frozen dependency installation, typecheck, tests, and
`npm publish --provenance --access public` through **OIDC trusted publishing**. The local
flow only assigns the version and atomically pushes branch + tag; **never run `npm publish` by hand.**

Releases are cut only from `local/main`, the fork's default branch; never release the upstream-tracking `main` branch.

All mechanics live in `.agents/skills/release/scripts/release.sh`. Its configuration
records this fork's scoped npm identity and `local/main` publication branch.

## Boundaries

- Reads: git log/tags, `package.json`, `CHANGELOG.md`, pi `settings.json` files.
- Writes: `CHANGELOG.md` heading, `package.json` version, one `Release X.Y.Z`
  commit, the `vX.Y.Z` tag; `settings.json` pins only via `sync-presets --apply`.
- Never: `npm publish`, consumer project files, `~/.pi/**/settings.json`
  without `--apply` being authorized.

## Bump policy

`v<major>.<minor>.<patch>`; `package.json` `version` mirrors the tag without `v`.

| Level | When |
|---|---|
| `patch` | fixes, prose, internal changes that don't alter behavior |
| `minor` | new command, config key, tool surface, or backward-compatible feature |
| `major` | breaking change: config-schema break, removed command, changed customType wire format |

## Process

**Level named in the request** ("release patch") - that is the approval. Run
step 2 directly; no proposal, no re-confirmation. An explicit version ("cut
6.1.0"): set `package.json` to it, commit, run `current`.

**Level not named** - step 1 once, then step 2 with the level the user picks.

### 1. Propose

```bash
bash .agents/skills/release/scripts/release.sh propose
```

Present commits since the nearest reachable SemVer release tag (`vX.Y.Z`), the
heuristic level, and the resulting `X.Y.Z` with a one-line rationale tied to those commits.
Baseline tags such as `subtree-v2.11.2+local` are intentionally ignored. Wait for the pick.

### 2. Release

Release notes must already sit under `## [Unreleased]` in `CHANGELOG.md`,
committed. If missing, write them from the commits since the last tag
(Keep-a-Changelog: `### Added` / `### Changed` / `### Fixed` / `### Removed`,
`(#N)` on ticket-linked bullets), commit, then run:

```bash
bash .agents/skills/release/scripts/release.sh patch      # or minor / major
bash .agents/skills/release/scripts/release.sh --dry-run patch
bash .agents/skills/release/scripts/release.sh current    # package.json already set; still promotes Unreleased
```

The script requires `local/main`, a clean tree, a plain `X.Y.Z` package version, and
absence of the target tag both locally and on `origin`; it promotes `## [Unreleased]` to
`## [X.Y.Z] - <date>`, sets `package.json`, commits `Release X.Y.Z`, runs
`bun run typecheck && bun test src/`, creates the annotated tag, atomically pushes
`local/main` + the tag, then runs `verify`. `current` tags the already committed plain
version. Any failed check exits with the reason - report it, don't work around it.

### 3. Verify

Runs automatically after the push. Standalone:

```bash
bash .agents/skills/release/scripts/release.sh verify           # package.json version
bash .agents/skills/release/scripts/release.sh verify 2.10.4
```

Watches the release workflow to a terminal state, polls
`npm view @yofriadi/pi-condense@X.Y.Z version` until live, then checks the pi.dev catalog.
Success means `npm view` printed the version. pi.dev lags npm by minutes to
hours - report crawl lag, do not loop on it.

### 4. Follow-ups named in the same instruction

Run after step 3 prints the version, no further confirmation:

- close a ticket: `gh issue close <n> --comment "<text>"` - "relevant ticket"
  is the `(#N)` ref in the promoted CHANGELOG section; the comment is that
  section plus the npm version line. Stop only if several refs are present and
  none is named.
- `sync-presets --apply` when the instruction asks for it; otherwise report-only:

```bash
bash .agents/skills/release/scripts/release.sh sync-presets            # report
bash .agents/skills/release/scripts/release.sh sync-presets --apply    # rewrite same-form npm pins
```

Scans `settings.json` under `~/.pi` and this repo's parent tree. Same-form scoped
pins (`npm:@yofriadi/pi-condense@<old>`) are bumped by `--apply`; versioned unscoped
pins (`npm:pi-condense@<old>` and `npm:pi-context-prune@<old>`) migrate to the scoped
package under `--apply`. Git pins are reported for manual migration.

## Safety checks (enforced by the script)

- clean working tree, on `local/main`
- plain `X.Y.Z` version in `package.json`
- `## [Unreleased]` present and non-empty, or top heading already `X.Y.Z`
- target `vX.Y.Z` tag absent locally and on `origin`
- `bun run typecheck && bun test src/` passes

## Red Flags - STOP

- about to run `npm publish` locally
- picked a level the user neither named nor approved
- reported success without `npm view @yofriadi/pi-condense@X.Y.Z` printing the version
- retrying the pi.dev fetch "until it appears"
- `sync-presets --apply` without the instruction asking for it
- editing a `~/.pi/**/settings.json` without its own explicit approval
- `package.json` version and the tag are not the identical `X.Y.Z` string
- working around a failed safety check instead of reporting it

## First-time npm setup (one-off)

Register `@yofriadi/pi-condense` as a trusted publisher on npmjs.com: Settings -> Trusted
Publishing -> GitHub Actions publisher for repo `yofriadi/pi-condense`, workflow
`release.yml`. Until then the publish step fails with 403.
