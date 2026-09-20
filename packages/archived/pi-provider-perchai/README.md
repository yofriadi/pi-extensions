# pi-provider-perchai

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that adds
**Perch AI** (`app.perchai.app`) as a free OAuth provider. It registers the
`perch` provider with the Starter-pool models plus two Roost auto tiers,
logs in through the same PKCE browser flow the Perch CLI uses, and streams
through Perch's own chat lane.

## Install

```sh
pi install @yofriadi/pi-provider-perchai
```

Then in pi:

```
/login
```

Select **Perch AI**. If a local `perch login` session exists (macOS Keychain
or `~/.perch/cli-auth-session.json`), you'll be offered to import it instead
of opening a browser. Fresh accounts get the free Starter plan selected
automatically during login.

## Free models

Registered under the `perch` provider, all zero-cost:

| pi model (`perch/<id>`) | Backing model | Notes |
| --- | --- | --- |
| `perch/standard` | Roost auto (server picks) | default |
| `perch/standard-max` | Roost auto, higher tier | |
| `perch/qwen-3.6` … | pinned Starter-pool models | from the live docs pool |

The pinned set is **generated**, not hand-maintained — see
[Refreshing the model pins](#refreshing-the-model-pins). Only models in the
current Starter pool are registered; models Perch rotates out disappear on
regeneration (the docs pool table is the source of truth).

Thinking levels map to Perch effort levels (`minimal`→`low`, …, `max`→`max`);
with reasoning off the provider sends `effort.level:"off"`.

## How it works

- **Auth**: Perch's CLI auth — Supabase PKCE with a `127.0.0.1` callback
  (port 0, manual paste fallback for SSH/headless) — plus optional import
  of an existing `perch` CLI session. Refresh tokens rotate on refresh.
- **Requests**: byte-for-byte the CLI's model-call body
  (`POST /api/perch-terminal/model-call`) with the CLI's
  `perchai-cli/<version>` user agent, a per-request turn ticket, and SSE
  streaming translated into pi's event protocol.
- **No runtime dependencies**: raw `fetch` + vendored PKCE/loopback helpers.

## Policy disclosure — read before using

Perch's pricing FAQ states that its internal endpoints are not a public API
and direct calls may be blocked or rate limited. This extension reproduces
the first-party CLI's request shape and user agent — the same traffic a
`perch` session produces — but it is not an official client:

- Keep request rates low; this is a free Starter lane (20,000 PT/period).
- Heavy or automated usage belongs on a Pro plan, not this extension.
- Perch may rotate the pool, rename pins, or raise CLI-version floors at
  any time; the account-suspension risk is yours to accept. The login flow
  says so before you connect.

## Refreshing the model pins

Perch rotates the Starter pool between CLI releases. When models stop
matching:

```sh
pnpm add -g perchai-cli   # upgrade the CLI first — the bundle is pin truth
pnpm run discover-models  # in this package
```

The script cross-references the installed CLI bundle with
`https://www.perchai.app/docs/concepts/models` (docs = pool truth) and
rewrites `src/models.generated.ts` + `src/cli-version.ts`. It fails loudly
when a docs model has no matching pin instead of emitting a dead pin.

## Troubleshooting

- **`usage_limit_reached`** — monthly Starter quota exhausted; the server
  message includes the reset time. Wait or upgrade to Pro.
- **`starter_model_blocked`** — a pinned model left the free pool. Switch
  to `perch/standard` or re-run `pnpm run discover-models`.
- **`turn_rate_limited`** — server-owned turn pacing; no auto-retry.
- **`client_update_required`** — Perch raised its CLI version floor. Run
  `pnpm add -g perchai-cli` then `pnpm run discover-models` to refresh the
  spoofed user agent.
- **401 / `invalid_grant`** — session expired or rotated (e.g. the CLI
  refreshed first). Log in again with `/login`; re-importing the CLI
  session also works.

## Development

```sh
pnpm run typecheck     # tsc --noEmit
pnpm test              # vitest
pnpm run test:live     # live smoke (requires PERCH_LIVE=1 and a login)
pnpm run verify-pack   # tarball sanity for pi install
```
