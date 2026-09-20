# Tasks: add-perch-provider

## 1. Package skeleton

- [x] 1.1 `package.json` — name `@yofriadi/pi-provider-perchai` (match antigravity scope), version `0.1.0`, `pi.extensions: ["./src/index.ts"]`, peer deps `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` (`*`), dev deps copied from `packages/pi-provider-antigravity/package.json` (vitest, jiti, typescript, types), scripts copied from the sibling's actual block (`discover-models`, `test`, `test:live`, `test:watch`, `typecheck`, `verify-pack`, `prepublishOnly`), engines `>=22.19.0`.
- [x] 1.2 `tsconfig.json` — copy from antigravity (strip-only, no emit).
- [x] 1.3 `.gitignore` if antigravity has package-specific ignores.
- [x] 1.4 README.md — install, `/login` → Perch, Starter-plan notes, free-model table, **policy disclosure section** (see proposal "Impact"), troubleshooting (`usage_limit_reached`, `starter_model_blocked`, `turn_rate_limited`, 401 re-auth).

## 2. Discovery script (do before writing the catalog)

- [x] 2.1 `scripts/discover-models.ts` — locate the installed `perchai-cli` bundle (`require.resolve` fallback: `~/.local/share/pnpm/global/v11/*/node_modules/perchai-cli/dist/perch.mjs`), parse the registry array (`GDr`) for `{id, providerId, modelId, label, lanes, reasoningSupport/streaming, contextWindow, maxOutputTokens, userFacing, costTier}`.
- [x] 2.2 Cross-reference against the live Starter pool table scraped from `https://www.perchai.app/docs/concepts/models` (pool membership = docs truth; bundle = pin/context truth).
- [x] 2.3 Emit `src/models.generated.ts` + `src/cli-version.ts`; fail loudly when a docs model has no pin.
- [x] 2.4 Run it (`pnpm run discover-models`), commit generated files.

## 3. Auth

- [x] 3.1 `src/vendor/pkce.ts` — `randomVerifier()` (32 bytes, base64url), `challenge(verifier)` (SHA-256, base64url). No deps.
- [x] 3.2 `src/vendor/loopback.ts` — `startLoopbackCallback({path:"/callback"})` → `{port, waitForCode(signal, timeoutMs), close()}`; port 0, retry list fallback; serves a plain "Login complete — return to pi" page; captures `?code=`/`?error=`.
- [x] 3.3 `src/auth/perch-oauth.ts` — `fetchAuthConfig(appUrl)` with 15 min cache; `loginPerch(callbacks)` implementing design §Auth flow steps 1–5 incl. provider preference (google > github) and `onManualCodeInput` fallback; `exchangeCode()` / `refreshTokens()` (rotate refresh); `ensureTierSelected(accessToken)` (`/api/perchai/account` → `rpc/perch_ai_select_plan {p_plan_code:"pilot"}` when `tierSelectionRequired`; terminal error on `"banned"`).
- [x] 3.4 `src/auth/cli-session.ts` — `readCliSession()` → Keychain via `execFile("security", ["find-generic-password","-s","app.perchai.cli-auth","-a","default","-w"])` then `~/.perch/cli-auth-session.json` (respect `PERCH_CLI_AUTH_DIR`); map to credentials; validate `version===1`; reuse antigravity's private-file hardening checks (no symlink, 0600) where applicable.
- [x] 3.5 Wire `oauth: { name, login, refreshToken, getApiKey }` in `index.ts`; `getApiKey` → `JSON.stringify({access, appUrl})`.

## 4. Messages + model-call client

- [x] 4.1 `src/messages.ts` — pi Context → `{messages, tools, toolChoice}` per design; JSON-stringify assistant tool-call arguments; tool results → `role:"tool"`; unit-test round-trips for text/think/toolCall/toolResult parts.
- [x] 4.2 `src/errors.ts` — error-code table from design §Error mapping; `describePerchError(status, body)` helper; parse `{error, errorCode}` and plain-text bodies.
- [x] 4.3 `src/model-call.ts` — `mintTurnTicket(cred, signal)`; `postModelCall(cred, body, signal)` (headers incl. UA from `cli-version.ts`, ticket when available, `Accept: text/event-stream`); 5xx/network retry ×2 (1s, 4s); `onPayload`/`onResponse` hook invocation; non-enforced ticket failure tolerated.
- [x] 4.4 Attribution: cache `{userId, workspaceId}` from `/api/perchai/account` (10 min), send `attribution` when present, omit on failure.

## 5. Stream translation

- [x] 5.1 `src/perch-stream.ts` — SSE line parser (`data:` only, `[DONE]`/blank tolerated).
- [x] 5.2 Event state machine: `answer_delta` → text block; `reasoning_delta` → thinking block; `tool_call_delta` → toolcall start/delta keyed by `toolCalls[].id`; `tool_use_end` → sealed arguments replace stream text when not already emitted; `stream_restart` → reset accumulators; `model_call_failed` → "recovering" while events continue, terminal mapped error if the body ends without `done{ok:true}`; `done` → stopReason/usage (incl. `ok:false` → mapped error); `error` → mapped error.
- [x] 5.3 Assemble pi `AssistantMessage` (`responseModel: model.id`), emit `start/delta/end` + `done` (or `error`) events through `createAssistantMessageEventStream()`; honor `options.signal` (abort → error event with `stopReason:"aborted"`); map `done` → pi `StopReason` values (`toolUse` when tool calls sealed, else `stop`) and `Usage.cost` as an all-zero `ModelCostRates` object.
- [ ] 5.4 Unit tests with canned SSE fixtures: text-only, reasoning+text, single + multi tool-call, stream_restart mid-stream, `model_call_failed` then continuing events (recovering, not failure), `model_call_failed` then stream end without `done{ok:true}` (terminal failure — never an empty success), `done.ok:false` usage_limit, malformed JSON line tolerated.

## 6. Provider registration + catalog

- [x] 6.1 `src/models.ts` — `ModelDefinition[]` with **bare** ids (pi renders `perch/<id>`): two Roost auto tiers + pinned docs-pool models from `models.generated.ts`; all-zero `ModelCost` rates objects; `input:["text"]`; reasoning flags; `contextWindow`/`maxTokens` from generation; `manualModelOptionId` + `roostModelChoice` metadata kept as a side-table `perchModelMeta[bareId]` consumed by streamSimple (no `modifies`).
- [x] 6.2 `src/index.ts` — `pi.registerProvider("perch", { name:"Perch AI", baseUrl, api:"perch", models, oauth, streamSimple })`; map `options.reasoning` → effort per design table (incl. `roostReasoning:false` when absent).
- [x] 6.3 Registration order (the two Roost entries first) + thinking-level plumbing verified in loader test — global default-model selection is user state, out of scope.

## 7. Tests

- [ ] 7.1 `test/perch-oauth.test.ts` — mock `fetch` for config/account/token/rpc; ephemeral loopback server; PKCE round trip; refresh rotation (missing new refresh keeps old); manual-paste fallback parses both a full callback URL and a bare code.
- [ ] 7.2 `test/cli-session.test.ts` — temp `PERCH_CLI_AUTH_DIR` file; version/symlink/permission rejections.
- [ ] 7.3 `test/messages.test.ts`, `test/errors.test.ts`, `test/perch-stream.test.ts` (fixtures from 5.4), `test/model-call.test.ts` (ticket header present, UA, retries, onResponse).
- [ ] 7.4 `test/provider-registration.test.ts` — load through `discoverAndLoadExtensions` from `@earendil-works/pi-coding-agent` (pattern: `pi-provider-antigravity/test/accounts-with-antigravity.test.ts`); assert provider `perch` registers, models visible, `streamSimple` wired.
- [ ] 7.5 `scripts/validate-live.ts` (exposed as `pnpm run test:live`, env-gated `PERCH_LIVE=1`): reuse stored credentials, one streamed answer + one tool-call turn + ticket mint; probe `effort.level:"max"` acceptance and record the result in design §Open questions; prints account quota summary; run manually once before shipping.

## 8. Verify + polish

- [x] 8.1 `pnpm run check` at repo root — full output clean (errors, warnings, infos).
- [ ] 8.2 `pnpm test` from repo root (vitest picks new package).
- [x] 8.3 `openspec validate add-perch-provider --strict` (from this package) passes.
- [ ] 8.4 Live: `perch login` already done? use import path; else browser flow. Confirm `usage_limit_reached` and `starter_model_blocked` messages render legibly by forcing cases in validate-live (`--model` a Pro pin on a Starter account).
- [x] 8.5 Final README pass: quickstart, screenshots-free, policy note, how to refresh pins when Perch rotates the pool.
