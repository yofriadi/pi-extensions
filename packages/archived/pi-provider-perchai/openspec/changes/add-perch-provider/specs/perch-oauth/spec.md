# perch-oauth

## ADDED Requirements

### Requirement: Login obtains a Perch session via Supabase PKCE

The provider SHALL sign users in by fetching auth config from
`GET {appUrl}/api/perch-terminal/cli-auth/config`, opening the Supabase
authorize URL `{supabaseUrl}/auth/v1/authorize` (query: `provider`,
`redirect_to=http://127.0.0.1:<port>/callback`, `code_challenge`,
`code_challenge_method=s256`) in the browser, receiving `?code=` on a
loopback server, and exchanging it via
`POST {supabaseUrl}/auth/v1/token?grant_type=pkce`.

#### Scenario: browser login completes

- **WHEN** the user selects Perch in `/login` and finishes in the browser
- **THEN** `login()` returns credentials containing `access`, `refresh`,
  `expires` (ms epoch, ≥5 min skew-buffered), `email`, `userId`, `appUrl`

#### Scenario: manual code paste fallback

- **WHEN** the loopback server cannot receive (headless/SSH) and the user
  pastes either a full `…/callback?code=…` URL or a bare code
- **THEN** login continues with the pasted code and succeeds identically

#### Scenario: provider preference

- **WHEN** config lists `providers: ["google","github"]`
- **THEN** login uses `google` (matching the CLI's preference)

#### Scenario: config is cached

- **WHEN** login or refresh runs twice within 15 minutes
- **THEN** the config endpoint is hit at most once

### Requirement: Starter plan is selected when the account requires a tier

After token exchange the provider SHALL `GET {appUrl}/api/perchai/account`
and, when `session.tierSelectionRequired` is true, call Supabase
`POST {supabaseUrl}/rest/v1/rpc/perch_ai_select_plan` with
`{p_plan_code:"pilot"}`.

#### Scenario: fresh account becomes usable

- **WHEN** the account reports `tierSelectionRequired`
- **THEN** plan selection runs before login returns success

#### Scenario: banned account stops login

- **WHEN** plan selection returns `{error:"banned"}`
- **THEN** `login()` fails with a clear message and no credentials are stored

### Requirement: Refresh rotates the Supabase refresh token

`refreshToken()` SHALL `POST {supabaseUrl}/auth/v1/token?grant_type=refresh_token`
and persist the returned `refresh_token`, falling back to the previous one
when the response omits it.

#### Scenario: rotation persists

- **WHEN** refresh returns a new `refresh_token`
- **THEN** the stored credentials carry the new token and extended expiry

#### Scenario: session invalidated elsewhere

- **WHEN** refresh returns `invalid_grant` (e.g. the local `perch` CLI
  rotated the token first)
- **THEN** refresh fails with an error directing the user to `/login`
  (or the import command) again

### Requirement: An existing perch CLI session can be imported

`login()` SHALL first probe for a local CLI session — macOS Keychain
(service `app.perchai.cli-auth`, account `default`) then
`$PERCH_CLI_AUTH_DIR`/`~/.perch/cli-auth-session.json` — and when found,
offer the user a choice between importing it and a fresh browser login.
Imported credentials SHALL use `{accessToken→access, refreshToken→refresh,
expiresAt→expires, userId, email, appUrl}` from the session file
(`version:1`).

#### Scenario: import offered and used

- **WHEN** a valid CLI session exists and the user chooses import
- **THEN** no browser opens and credentials come from the CLI session

#### Scenario: rejected file

- **WHEN** the session file is a symlink, group/world-readable, or its
  `version` is not `1`
- **THEN** import is skipped with a warning and browser login proceeds

#### Scenario: no writes to the CLI store

- **WHEN** the provider refreshes an imported session
- **THEN** it never writes to the Keychain or `~/.perch` files

### Requirement: getApiKey serializes credentials for the stream path

`getApiKey()` SHALL return `JSON.stringify({access, appUrl})`; the
`streamSimple` handler SHALL parse it back and use the access token as the
`Authorization: Bearer` value.

#### Scenario: round trip

- **WHEN** a stored credential set is passed to streamSimple
- **THEN** the model-call request carries the correct bearer and base URL
