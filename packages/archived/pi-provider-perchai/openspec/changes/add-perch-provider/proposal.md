# Proposal: add-perch-provider

## Why

Perch AI ([perchai.app](https://perchai.app)) ships a free **Starter** plan
(no card, 20,000 PT ≈ $20 of hosted usage per billing period) that runs a
rotating pool of open models — currently Qwen 3.6, Kimi K2.5, GLM 5,
Qwen3 Coder, Nemotron Super, and Gemma 4 (E2B / 31B) — through its
Web/Desktop/CLI surfaces. Today pi users cannot reach that pool at all:
Perch exposes no public API key, only OAuth sessions owned by its own
clients (`perchai-cli` on npm).

The wire protocol and auth flow are fully known:

- The locally installed `perchai-cli@2.4.100` bundle documents every
  endpoint, header, and SSE event.
- [opendum](https://github.com/sachnun/opendum) implements the same flow
  in Go/TS (`apps/proxy/internal/providers/perch*.go`,
  `apps/dashboard/server/lib/providers/perch/client.ts`), corroborating
  the bundle.

So the only missing piece is a pi provider package that mirrors the CLI's
own request shape, letting a user authenticate with their Perch account
(Google/GitHub OAuth via Supabase PKCE, or by importing an existing
`perch login` session) and stream Starter-pool models inside pi.

## What Changes

1. **New package `pi-provider-perchai`** (this directory), registered as
   pi provider `perch` via `pi.registerProvider()`, with a custom
   `streamSimple` handler (`api: "perch"`) that speaks the Perch
   model-call SSE protocol.
2. **OAuth login** against `https://app.perchai.app`:
   `GET /api/perch-terminal/cli-auth/config` → Supabase project → PKCE
   browser flow (`google` preferred, `github` fallback) with a local
   `http://127.0.0.1:<port>/callback` server and a manual-paste fallback,
   then Starter-plan selection when the account reports
   `tierSelectionRequired`. Token refresh rotates via Supabase
   `grant_type=refresh_token`.
3. **CLI session import**: if `perch login` has already been run locally
   (macOS Keychain service `app.perchai.cli-auth`, or
   `~/.perch/cli-auth-session.json` elsewhere), `login()` offers to import
   that session instead of opening a browser.
4. **Model-call client**: per-turn ticket from
   `POST /api/perch-terminal/turn-ticket` (`{surface:"cli",
   profile:"standard"}`), then `POST /api/perch-terminal/model-call` with
   the CLI's exact body shape (`lane:"chat"`, `clientSurface:"cli"`,
   `roostModelChoice`, `effort`, optional `manualModelOptionId`) and
   headers (`Authorization: Bearer`, `User-Agent: perchai-cli/<version>`,
   `x-perch-turn-ticket`, `Accept: text/event-stream`).
5. **Model catalog**: two Roost auto entries (`perch/standard`,
   `perch/standard-max`) plus pinned Starter-pool models
   (`kimi-2.5`, `glm-5`, `qwen-3.6`, `qwen3-coder`, `nemotron-super`,
   `gemma-4-e2b`, `gemma-4-31b`), all free (`cost: 0`), plus a
   `scripts/discover-models.ts` that re-derives pins/context windows from
   the installed `perchai-cli` bundle, and a `scripts/validate-live.ts`
   smoke runner.
6. **Tests**: unit tests for auth, message conversion, SSE translation,
   and error mapping; a loader-level integration test through
   `discoverAndLoadExtensions`; live validation gated behind an env flag.

## Non-goals

- **Pro-tier models** (`pro` / `pro_max` roost choices, premium pins).
  The catalog registers what a free Starter account can run; the code
  paths accept the tier value so a Pro user can widen it later.
- **BYOK/BYO lanes** (`byoProviderId`, `providerCredentialOverrides`) and
  local-model (`byolm`) support. Pi already handles user keys natively.
- **Perch agent surfaces**: threads, tools, MCP, delegates, flock,
  `perch run`. This provider is a plain chat-completions bridge; pi owns
  the agent loop and tools.
- **Image input**. The chat lane is text-only for these models; pi models
  are registered with `input: ["text"]`.
- **Usage/quota dashboard.** `/api/perchai/account` is used only for
  login-time plan selection and diagnostics.

## Capabilities

### New Capabilities

- `perch-oauth`: PKCE login, plan selection, refresh-token rotation, and
  local-CLI session import for the Perch Starter plan.
- `perch-model-call`: turn-ticket acquisition, model-call request
  construction, SSE translation to pi `AssistantMessageEvent`s, and
  Perch-specific error mapping.
- `perch-model-catalog`: the registered Starter models, pin table,
  context windows, and thinking-level mapping.

### Modified Capabilities

None.

## Impact

- **Code**: new files under `packages/pi-provider-perchai` (`src/`,
  `test/`, `scripts/`); no changes to other packages.
- **Deps**: runtime none (raw `fetch`, vendored PKCE/callback helpers);
  dev `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `vitest`, `jiti`.
- **Risk**: Perch's pricing FAQ states its internal endpoints are not a
  public API and direct calls "may be blocked or rate limited". This
  provider sends byte-for-byte the CLI's own request shape with the
  CLI's `perchai-cli/*` user agent — the same traffic a first-party CLI
  session produces — and the README will say so plainly, recommend
  keeping request rates low, and note that heavy usage belongs on Pro.
  The account-suspension risk is the user's to accept, disclosed in the
  login flow instructions.
- **Drift**: Perch rotates its Starter pool and renames pins between CLI
  versions (v2.4.98 ↔ v2.4.100 already differ). Mitigated by
  `scripts/discover-models.ts` and by treating the docs page
  (`perchai.app/docs/concepts/models`) as the pool's source of truth.
