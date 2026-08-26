# Tasks: adopt-pi-google-thinking-types

## 1. Dependencies

- [x] 1.1 In `packages/pi-provider-antigravity`, bump devDeps `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from `0.79.1` to `0.84.3`
- [x] 1.2 Run `pnpm dlx taze major -w` from the package dir to update the remaining deps (`@google/genai`, `jiti`, `vitest`) to latest, including majors; leave peers as `*` — **note:** taze 19/20/21 silently no-ops on node 26.7.0 in this environment (metadata fetches fine, comparison broken; reproduced with `lodash@1.0.0` in a scratch dir).
      Versions were resolved via `npm view` and written manually: `@google/genai` 1.52.0 → 2.18.0, `vitest` 3.2.4 → 4.1.11; `jiti` 2.7.0 already latest
- [x] 1.3 `pnpm install` from the repo root

## 2. Type adoption (`src/cloud-code-assist.ts`)

- [x] 2.1 Delete the local `export type GoogleThinkingLevel` and its doc comment; import `type GoogleApiThinkingLevel` and `type ResolvedGoogleThinkingLevel` from `@earendil-works/pi-ai`
- [x] 2.2 Retype `GoogleGeminiCliOptions.thinking.level` to `GoogleApiThinkingLevel`
- [x] 2.3 Delete `type ClampedThinkingLevel`; retype `getGeminiCliThinkingLevel(effort, ...)`'s `effort` param to `ResolvedGoogleThinkingLevel` and its return type to `GoogleApiThinkingLevel`
- [x] 2.4 Update the two `as any` cast comments to reference `GoogleApiThinkingLevel`

## 3. Clamp (`src/vendor/simple-options.ts`, `src/cloud-code-assist.ts`)

- [x] 3.1 Update `clampReasoning` to clamp `"xhigh"` and `"max"` to `"high"`, returning `ResolvedGoogleThinkingLevel | undefined` (mirrors pi-ai 0.84 `api/simple-options`)
- [x] 3.2 In `streamSimpleGoogleGeminiCli`, set `antigravityEffort = clampReasoning(options?.reasoning) ?? "off"` so routing uses the clamped effort; retype `GoogleGeminiCliOptions["antigravityEffort"]` to `ResolvedGoogleThinkingLevel | "off"`

## 4. Tests

- [x] 4.1 Extend `test/stream-routing.test.ts`: assert `"xhigh"` and `"max"` route to the high wire model with `thinkingLevel: "HIGH"` for a tiered Gemini model (e.g. `gemini-3.7-flash` → `gemini-3.7-flash-tiered`)
- [x] 4.1a Review follow-up: also assert wire IDs for models whose routing distinguishes efforts (`gemini-3.6-flash` → `gemini-3.6-flash-high`, `gemini-3.1-pro` → `gemini-pro-agent`) — 3.7-flash maps every effort to the same `-tiered` ID, so its `payload.model` assertion alone could not catch a clamp regression
- [x] 4.2 Run the package suite (`pnpm --filter @yofriadi/pi-provider-antigravity test`) and iterate until green; fix any breakage from the pi-ai/pi-coding-agent 0.79→0.84 jump (loader API, genai types)
- [x] 4.3 0.79→0.84 fallout fixed: `test/auth.test.ts` migrated `AuthStorage.create` + `ModelRegistry.create` → `ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false })` + `new ModelRegistry(...)`; `refreshToken` test call passes the now-required `AbortSignal`; `cloud-code-assist.ts` gained a `stopReason === "pending"` guard so `done` typechecks (type-narrowing only — the extension initializes `stopReason` to `"stop"`, so unlike upstream's guard it is unreachable at runtime and an SSE stream with no finish reason still reports `"stop"`; pre-existing edge, kept minimal); vendored `mapStopReason` handles genai 2.x's new `FinishReason.TOO_MANY_TOOL_CALLS`
- [x] 4.4 Pre-existing failures (NOT this change; staged-WIP test files expecting unlanded source fixes): 5 in `test/stream-budget.test.ts` (maxTokens cap fix, terminal-400/Retry-After retry classification, SAFETY error message — none of that code exists in HEAD or this change), 1 in `test/accounts-with-antigravity.test.ts` (duplicate `/accounts` command — dedupe lives in the mid-flight pi-accounts WIP).
      Verified all code paths they exercise are untouched by this change (`git diff HEAD` audit)
- [x] 4.5 Review 2 follow-up: (a) `getDisabledThinkingConfig`'s two `as any` cast sites now carry the required mirror comment (spec req 4); (b) narrowed `getAntigravityRequestModelId`'s `effort` param and `AntigravityCliSelection.reasoning` to `ResolvedGoogleThinkingLevel` so raw `ThinkingLevel` (incl. `"xhigh"`/`"max"`) is unrepresentable at the routing boundary (spec req 2 "before any use"); (c) proposal/design corrected: `claude-opus-4-6` was never misroutable (single-value routing map converges on `claude-opus-4-6-thinking`)

## 5. Gates

- [x] 5.1 `pnpm run check` from the repo root — antigravity biome + tsc clean; the chain still fails on **pre-existing** pi-session-recap WIP (biome format/`noExplicitAny` + `recap-outcome.test.ts` imports of unimplemented exports), untouched by this change
- [x] 5.2 `pnpm test` from the repo root — antigravity: 79 passed / 6 pre-existing failures (see 4.4); pi-mlflow 94 passed; pi-condense passing; pi-session-recap fails pre-existing (39 WIP failures)
- [x] 5.3 `openspec validate adopt-pi-google-thinking-types --strict` (run from `packages/pi-provider-antigravity`)
