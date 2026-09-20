# Design: add-perch-provider

## Verification status

Every endpoint and payload below is verified against:

1. `perchai-cli@2.4.100` (installed at
   `~/.local/share/pnpm/global/v11/*/node_modules/perchai-cli/dist/perch.mjs`):
   session storage (`L3e`/`gvn`), login (`qF(...supabaseUrl, supabaseAnonKey,
   {auth:{flowType:"pkce"}})`, local server path `SXt="/callback"`), model
   proxy (`fbt`/`w1e`, `qQr`, `WMn`), UA builder (`iN`, prefix
   `nbt="perchai-cli/"` with `PERCH_CLI_VERSION`), turn-ticket cache
   (`IP`/`pie`, header `x-perch-turn-ticket`), error-code set
   (`a$r` = `provider_not_configured | api_error | timeout | parse_error |
   usage_limit_reached | starter_model_blocked | perch_surface_required |
   turn_rate_limited | client_update_required | promo_overflow_decision`).
2. opendum (`sachnun/opendum@main`):
   `apps/proxy/internal/providers/perch.go` + `perch_stream.go` (request
   shape, SSE translation), `apps/proxy/internal/proxy/quota_perch.go`
   (account/quota), `apps/dashboard/server/lib/providers/perch/client.ts`
   (browser PKCE login, plan selection).
3. Live check: `GET https://app.perchai.app/api/perch-terminal/cli-auth/config`
   returns
   `{ok, appUrl, supabaseUrl:"https://zlfuvsfjtgsdtqcaykia.supabase.co",
   supabaseAnonKey:"sb_publishable_…", providers:["google","github"],
   redirectHost:"127.0.0.1"}`.
4. Docs: `perchai.app/pricing` (Starter free, 20,000 PT/period, 1000 PT = $1)
   and `perchai.app/docs/concepts/models` (Starter pool table + per-model
   rates; pool rotates — scrape target for discovery script).

## Architecture

```
pi ──registerProvider("perch")──▶ src/index.ts
   ├─ oauth.login ───────▶ src/auth/perch-oauth.ts      (PKCE browser flow)
   │                        src/auth/cli-session.ts     (import `perch login`)
   │                        src/vendor/pkce.ts          (vendored: verifier,
   │                                                   challenge)
   │                        src/vendor/loopback.ts      (127.0.0.1 /callback)
   ├─ oauth.refreshToken ▶ src/auth/perch-oauth.ts      (supabase refresh)
   ├─ oauth.getApiKey ───▶ JSON.stringify({access, appUrl})
   └─ streamSimple ──────▶ src/model-call.ts            (ticket + POST + fetch)
                            src/perch-stream.ts         (SSE → pi events)
                            src/messages.ts             (pi Context → messages)
                            src/models.ts               (catalog + pins + effort)
```

No runtime dependencies. Supabase is spoken to with plain `fetch` (the
publishable anon key is public by design; it is fetched at runtime from the
config endpoint, not hardcoded). PKCE + the loopback callback server are
vendored under `src/vendor/` per repo convention (pattern:
`packages/pi-provider-antigravity/src/vendor/`).

## Auth flow (login)

1. `fetchAuthConfig()` — `GET {appUrl}/api/perch-terminal/cli-auth/config`
   (15-minute in-memory cache). Yields `supabaseUrl`, `supabaseAnonKey`,
   `providers`.
2. CLI-session probe first: if a `perch login` session exists, offer
   `onSelect({message:"…", options:[{id:"import"},{id:"browser"}]})`.
   See "CLI session import".
3. Browser path:
   - PKCE: 32 random bytes → base64url verifier; challenge =
     base64url(SHA-256(verifier)).
   - Loopback server on `127.0.0.1`, ephemeral port, path `/callback`
     (Supabase allowlists localhost redirects; opendum hard-codes 47321, the
     real CLI binds port 0 — we bind port 0 and fall back to a small static
     list on collision).
   - Provider choice: first of `google`, `github` present in config
     (mirrors the CLI's preference).
   - `onAuth({url})` with
     `{supabaseUrl}/auth/v1/authorize?provider=<p>&redirect_to=http://127.0.0.1:<port>/callback&code_challenge=<c>&code_challenge_method=s256`.
   - Await `GET /callback?code=…` (timeout 5 min). Manual fallback:
     `onManualCodeInput` resolves a pasted `…/callback?code=…` URL (or bare
     code) when the loopback cannot receive (SSH, remote).
   - Exchange: `POST {supabaseUrl}/auth/v1/token?grant_type=pkce`,
     headers `{apikey, Authorization: Bearer <anon>, Content-Type: json}`,
     body `{auth_code, code_verifier}` → `{access_token, refresh_token,
     expires_in, expires_at, user:{id,email}}`.
4. Plan readiness: `GET {appUrl}/api/perchai/account` (Bearer). If
   `session.tierSelectionRequired`, call
   `POST {supabaseUrl}/rest/v1/rpc/perch_ai_select_plan` with
   `{p_plan_code:"pilot"}` (Starter) — required once on fresh accounts.
   Banner on failure: `perch_ai_select_plan` returns `{error:"banned"}` for
   banned accounts → surface as terminal login error.
5. Return `OAuthCredentials`:
   `{access, refresh, expires (ms epoch), email, userId, appUrl}`.
   `expires = expires_at*1000` when present else `now + expires_in*1000`,
   minus 5-minute skew buffer.

### Refresh

`POST {supabaseUrl}/auth/v1/token?grant_type=refresh_token` with
`{refresh_token}`. Supabase rotates: always persist the returned
`refresh_token` (fall back to the previous one when absent). pi runs
refresh inside the credential store lock (`Models.getAuth`), so no extra
mutex is needed in-process. Concurrent CLI usage is the rotation risk the
CLI itself handles with `cli-auth-refresh.lock`; our store copy may be
invalidated if the *CLI* refreshes first — recover by re-importing or
re-login on `invalid_grant` (map to "re-authenticate" error).

### getApiKey

`JSON.stringify({access, appUrl})` — the stream handler parses it back,
mirroring antigravity's `{token, projectId}` pattern.

## CLI session import

Order (first hit wins):

1. macOS Keychain: `security find-generic-password -s app.perchai.cli-auth
   -a default -w` (service/account names from the CLI bundle: `O3e`, `F3e`).
2. `~/.perch/cli-auth-session.json` (respect `PERCH_CLI_AUTH_DIR`).

File shape (verified): `{version:1, appUrl, accessToken, refreshToken,
expiresAt, userId, email, updatedAt}`. Read through the same private-file
hardening as antigravity's `stored-credentials.ts` (no symlinks, mode
0600). Imported credentials go through the normal refresh path
afterwards; we do **not** write back to the CLI's files.

## Model call

`POST {appUrl}/api/perch-terminal/model-call`

Headers:
- `Content-Type: application/json`
- `Accept: text/event-stream` (always — we always stream)
- `Authorization: Bearer <accessToken>`
- `User-Agent: perchai-cli/<installedCliVersion>` — the server gates on UA
  ("client_update_required"). Resolve version at runtime: `perch --version`
  equivalent is the `perchai-cli` package version; cached; fallback to the
  version the package was built against, recorded in `src/cli-version.ts`
  and refreshed by `scripts/discover-models.ts`.
- `x-perch-turn-ticket: <ticket>` — minted per request (see below). Ticket
  failure while `enforced` ⇒ fail with the server message; ticket absence
  tolerated when the server does not enforce (CLI behavior mirrors this).

Body (field-for-field from opendum's `MakeRequest` and the CLI's `fbt`):

```jsonc
{
  "request": {
    "lane": "chat",
    "messages": [/* OpenAI-ish; see messages.ts */],
    "tools": [/* {type:"function",function:{name,description,parameters}} */],
    "toolChoice": "auto",            // only when tools present
    "temperature": 0.7,              // pass-through when set
    "maxOutputTokens": 8192          // when set
  },
  "runId": "cli-turn-<ms>-<rand8>",
  "lane": "chat",
  "strictManual": false,
  "preferredModelId": null,
  "avoidModelIds": [],
  "attribution": null,               // or {userId, workspaceId, runId, lane:"chat", source:"cli", billingMultiplier:null} from /api/perchai/account, cached 10 min
  "clientSurface": "cli",
  "manualModelOptionId": "wandb-qwen3-6-35b-a3b",  // pinned models only
  "roostModelChoice": "standard",    // or "standard_max" (wire uses underscores)
  "roostReasoning": true,
  "effort": {"level": "high", "orchestration": false}
}
```

### Turn ticket

`POST {appUrl}/api/perch-terminal/turn-ticket`, bearer + UA headers, body
`{surface:"cli", profile:"standard"}` → `{ok, ticket, ticketId, runId,
expiresAt, enforced}`. Use the returned `runId` for the model call.
429 with `{enforced:true, errorCode:"turn_rate_limited"}` ⇒ surface the
server message verbatim (it is human-readable per Perch docs).

Tickets are minted per model call and **reused across that call's 5xx
retries**: the CLI builds the header set (incl. `await pie()`) once per
POST and retries the same request (`{onRetry:…}` in the bundle), so we
match that; single-use semantics are otherwise unverified.

### Thinking-level mapping

pi `ThinkingLevel` → Perch `effort.level` (`off|low|medium|high|xhigh|max`
— CLI help also lists `ultra`, we never emit it):

| pi level        | Perch                                              |
| --------------- | -------------------------------------------------- |
| (none / off)    | `roostReasoning:false`, `effort.level:"off"`      |
| `minimal`       | `effort.level:"low"` (Perch has no minimal)        |
| `low`           | `"low"`                                            |
| `medium`        | `"medium"`                                         |
| `high`          | `"high"` (CLI default)                             |
| `xhigh`         | `"xhigh"`                                          |
| `max`           | `"max"`                                            |

Models that don't reason set `reasoning:false` in the pi catalog; pi then
never passes a level for them.

## pi Context → Perch messages (`messages.ts`)

- `context.systemPrompt` → one leading `{role:"system", content}`
  message (pi carries the system prompt as a field, not messages).
- `user` → `{role:"user", content}`; content parts flattened to text
  (image parts are unreachable: models register `input:["text"]`).
- `assistant` → `{role:"assistant", content, tool_calls?}` — thinking
  (`ThinkingContent`) parts are dropped (Perch has no channel for prior
  reasoning) — with
  `tool_calls:[{id,type:"function",function:{name,arguments:<json string>}}]`.
- `toolResult` → `{role:"tool", tool_call_id, content}` (stringify JSON
  content).
- Tools array from pi → OpenAI function form; `parameters` defaults to
  `{"type":"object","properties":{}}`.

## SSE → pi events (`perch-stream.ts`)

Perch stream (lines starting `data:`; JSON `type` field):

| Perch event | pi `AssistantMessageEvent` |
| --- | --- |
| `reasoning_delta {text}` | `thinking_*` sequence |
| `answer_delta {text}` | `text_*` sequence |
| `tool_call_delta {toolCalls:[{id,name,rawArgumentsText}]}` | `toolcall_start` (first sight of id), `toolcall_delta {delta}` |
| `tool_use_end {toolCalls:[{id,name,arguments}]}` | `toolcall_end`; sealed `arguments` replaces streamed text (skip if already emitted — opendum's `emittedArgs` rule) |
| `stream_restart` | reset local text/tool accumulators; no pi events (stream is retried upstream) |
| `continuation_seam` | ignore |
| `model_call_failed {error, errorCategory}` | mark the stream "recovering" — transient while events keep coming (bundle: the auto-router retries in-stream, UI shows "recovering route"); **terminal** if the body ends without `done{ok:true}` → fail the turn with the mapped error (bundle's network path emits `model_call_failed` then stops with no `done`) — never emit an empty success |
| `done {ok:true, text, provider, model, usage, durationMs}` | fill usage, `stopReason: toolCalls ? "toolUse" : "stop"` (pi `StopReason`: `pending\|stop\|length\|toolUse\|error\|aborted\|deferred` — **not** OpenAI's `tool_use`) |
| `done {ok:false, error, errorCode}` / `error {message}` | throw mapped error |

Usage: `{inputTokens, outputTokens, cacheReadInputTokens,
cacheWriteInputTokens}` → pi `Usage` `{input, output, cacheRead,
cacheWrite, totalTokens, cost:{input:0, output:0, cacheRead:0,
cacheWrite:0}}` — `Usage.cost` is a `ModelCostRates` object, not a number.

Contract requirements from pi: call `options.onPayload(requestBody, model)`
before send and honor a returned replacement (but never let a replacement
strip auth headers — headers are not part of the payload); call
`options.onResponse({status, headers}, model)` right after headers arrive.
Honor `options.signal` end-to-end (ticket fetch included).

## Error mapping

| Condition pi sees | Meaning / message |
| --- | --- |
| 401 / `invalid_grant` on any call | credentials expired → error text tells the user to `/login` again |
| 403 body containing "Upgrade to Pro" (`starter_model_blocked`) | pinned model left the Starter pool → suggest `perch/standard` or re-run discovery |
| 429 / `usage_limit_reached` | monthly 20k PT (or rolling window) exhausted; include server text |
| `turn_rate_limited` | server-owned turn rate; include server text, no auto-retry |
| `perch_surface_required` | request rejected as non-Perch surface; a bug in our mimicry — log full body in debug |
| 5xx / network | retry up to 2 times with exponential backoff (1s, 4s), then terminal |
| `promo_overflow_decision` | resend once with `promoOverflowAccepted:true` (CLI behavior) — v1: surface as error instead, note in code |

## Model catalog (`models.ts`)

Registered under provider `perch`, `api: "perch"`, `baseUrl:
"https://app.perchai.app"`, all-zero `ModelCost` rate objects
(`input/output/cacheRead/cacheWrite = 0`), `input: ["text"]`. Registered
`Model.id`s are **bare** (`standard`, `kimi-2.5`, …) — pi renders them
`perch/<id>`, and the `perchModelMeta` side-table is keyed by the same
bare id (mirrors antigravity, which registers `gemini-3.8-flash` under
provider `google-antigravity`; registering `perch/standard` would render
`perch/perch/standard`):

| id (bare) | pin (`manualModelOptionId`) | roost | reasoning |
| --- | --- | --- | --- |
| `standard` | — | `standard` | true |
| `standard-max` | — | `standard_max` | true |
| `kimi-2.5` | `bedrock-mantle-moonshotai-kimi-k2-5` | `standard` | false |
| `glm-5` | `bedrock-mantle-zai-glm-5` | `standard` | true |
| `qwen-3.6` | `wandb-qwen3-6-35b-a3b` | `standard` | true |
| `qwen3-coder` | `bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct` | `standard` | true |
| `nemotron-super` | `bedrock-mantle-nvidia-nemotron-super-3-120b` | `standard` | true |
| `gemma-4-e2b` | `bedrock-mantle-google-gemma-4-e2b` | `standard` | true |
| `gemma-4-31b` | `bedrock-mantle-google-gemma-4-31b` | `standard` | true |

Pins and context windows are **not** hand-maintained: opendum's table was
from v2.4.98 and is already stale against v2.4.101 (bedrock-mantle
pins are gone). `scripts/discover-models.ts` extracts the registry array
(`GDr`) from the locally installed `perchai-cli` bundle (or falls back to
scraping the docs pool table + `npm view perchai-cli`, but **the docs pool
table is not trusted for `maxOutputTokens`** (probes show it diverges from
the bundle's own `maxTokens`). Emits
`src/models.generated.ts` with pins/contextWindow/maxOutputTokens/
reasoning flags, and `src/cli-version.ts`. Default when no pin is known:
register only the two Roost auto models (they always work).

`contextWindow`/`maxTokens` defaults when the bundle is silent: 131072 /
8192 (observed pool range 128k–1M; conservative beats wrong).

## Package layout

```
packages/pi-provider-perchai/
├── package.json            # pi.extensions: ["./src/index.ts"], peers *, vitest
├── README.md               # setup, free-plan notes, policy disclosure
├── src/
│   ├── index.ts            # registerProvider("perch", …)
│   ├── models.ts           # catalog w/ types; imports models.generated
│   ├── models.generated.ts # generated: pins, versions
│   ├── cli-version.ts      # generated: PERCH_CLI_UA
│   ├── auth/perch-oauth.ts # login + refresh + plan selection
│   ├── auth/cli-session.ts # keychain / cli-auth-session.json import
│   ├── vendor/pkce.ts      # verifier/challenge (crypto.getRandomValues)
│   ├── vendor/loopback.ts  # 127.0.0.1 callback server (/callback)
│   ├── model-call.ts       # ticket + POST + retry
│   ├── perch-stream.ts     # SSE → AssistantMessageEvents
│   ├── messages.ts         # Context → Perch messages/tools
│   └── errors.ts           # errorCode table
├── scripts/discover-models.ts
├── scripts/validate-live.ts
└── test/*.test.ts          # vitest, incl. loader-level test
```

Node strip-only TS per repo rules; no `any`; top-level imports only.

## Decisions

1. **Register as custom API `api:"perch"` + `streamSimple`**, not as an
   OpenAI-compatible proxy: Perch's SSE dialect needs translation that no
   built-in api does, and running a localhost proxy per pi process adds an
   unnecessary hop (opendum runs the proxy as a separate long-lived service;
   pi extensions cannot).
2. **Browser login AND CLI import**, not one or the other: import is the
   smoothest path on this machine (`perch` is installed), but a fresh user
   (or headless box) needs the browser flow. Both end at the same
   credential shape.
3. **Always request SSE and synthesize non-streaming** is irrelevant — pi
   always streams. The non-streaming JSON branch in the CLI is ignored.
4. **Skip `attribution` when the account fetch fails** rather than failing
   the turn (server tolerates null; matches CLI's "attribution stays nil
   when unknown").
5. **UA spoofing is deliberate and documented** — the server keys
   Starter-lane behavior to it. We take on the maintenance burden of
   tracking the CLI version via `discover-models.ts`.
6. **No writes to Perch state beyond login**: we never call
   `cli-turn` (telemetry), `cli-context`, or thread endpoints. Read-only
   usage keeps the surface minimal.

## Open questions

- Whether `client_update_required` triggers on a hard minimum CLI version
  — if so, `discover-models.ts` must learn to read it (search for the
  error code in the bundle at implementation time and mimic the version
  floor).
- Does the Starter lane tolerate `effort.level:"max"`? Unknown until
  `scripts/validate-live.ts` probes it; until the answer is recorded here,
  the spec mandates plain-400 surfacing with **no** auto-clamp (opendum
  clamps `high|xhigh|max → "high"`, so it gives no evidence either way).
