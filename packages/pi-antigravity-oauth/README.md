# pi-antigravity-oauth

Pi extension that registers the Google OAuth provider for Antigravity:

## Install

```bash
# Install from npm
pi install npm:@yofriadi/pi-antigravity-oauth

# Or load a local clone for a single session
pi -e /path/to/pi-extensions/packages/pi-antigravity-oauth
```

| Provider id | Display name | Endpoint | Callback port |
|---|---|---|---|
| `google-antigravity` | `Antigravity (Gemini 3, Claude, GPT-OSS)` | `https://daily-cloudcode-pa.sandbox.googleapis.com` | 51121 |

## Models

### `google-antigravity`

- `claude-opus-4-5`
- `claude-opus-4-6`
- `claude-sonnet-4-5`
- `claude-sonnet-4-6`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-2.5-pro`
- `gemini-3-flash`
- `gemini-3-pro`
- `gemini-3.1-flash-image`
- `gemini-3.1-flash-lite`
- `gemini-3.1-pro`
- `gemini-3.5-flash`
- `gpt-oss-120b`
- `tab_flash_lite_preview`
- `tab_jump_flash_lite_preview`

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
