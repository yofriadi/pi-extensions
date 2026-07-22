# pi-provider-antigravity

Pi extension that registers the Google OAuth provider for Antigravity:

## Install

```bash
# Install from npm
pi install npm:@yofriadi/pi-provider-antigravity

# Or load a local clone for a single session
pi -e /path/to/pi-extensions/packages/pi-provider-antigravity
```

| Provider id | Display name | Endpoint | Callback port |
|---|---|---|---|
| `google-antigravity` | `Antigravity (Gemini 3, Claude, GPT-OSS)` | `https://daily-cloudcode-pa.googleapis.com` | 51121 |

## Models

### Current Antigravity CLI parity

The six logical Pi models below cover the eleven choices currently shown by `agy models`:

- `gemini-3.6-flash`: Low, Medium, High
- `gemini-3.5-flash`: Low, Medium, High
- `gemini-3.1-pro`: Low, High
- `claude-sonnet-4-6`: Thinking
- `claude-opus-4-6`: Thinking
- `gpt-oss-120b`: Medium

The static catalog is limited to the six model families and eleven thinking choices exposed by `agy models`.

After a successful login or token refresh, the extension fetches the account's public backend IDs and Pi's OAuth model hook filters unavailable static entries. If discovery is temporarily unavailable, it deliberately retains the static catalog rather than hiding models based on a failed probe.

### Catalog discovery and live validation

After authenticating with Pi, capture a sanitized account catalog without printing OAuth credentials, quota state, project IDs, or account data:

```bash
pnpm --silent --dir packages/pi-provider-antigravity discover-models > /tmp/antigravity-models.json
```

Run the opt-in, quota-consuming text happy-path validation for all eleven current CLI choices:

```bash
ANTIGRAVITY_LIVE=1 pnpm --dir packages/pi-provider-antigravity test:live
```

The live validator verifies that every expected wire ID is present as a non-internal discovery entry, captures the outgoing model ID through Pi's supported `onPayload` callback, and requires a completed primary-endpoint HTTP 200 response. It runs one request attempt by default to avoid accidentally exercising fallback paths; set `ANTIGRAVITY_LIVE_ATTEMPTS=2` or `3` only for expected transient retries.

## Login flow

The extension runs a standard PKCE OAuth dance against `https://accounts.google.com/o/oauth2/v2/auth`:

1. Generate a verifier + SHA-256 challenge.
2. Start a local callback HTTP server on the provider's port.
3. Open the auth URL with `access_type=offline` and `prompt=consent` so we get a refresh token.
4. Wait for the callback (or for a manual paste of the redirect URL).
5. Exchange the code for tokens at `https://oauth2.googleapis.com/token`.
6. Resolve the user's Cloud Code Assist project ID.
7. Persist credentials to Pi's auth storage.

`/login` will prompt for authorization. Complete the consent screen in the browser, return to the terminal. If the callback fails or you cancel, you can paste the redirect URL into the terminal prompt and the extension will pick it up from there.

## Credentials shape

The provider encodes the OAuth credentials as:

```json
{ "token": "<access_token>", "projectId": "<google_cloud_project_id>" }
```

The runtime decodes this and passes the access token to the Cloud Code Assist API as `Authorization: Bearer <token>`.

## Source
This is a source-only package. Pi loads `./src/index.ts` directly via jiti — there is no build step.
