# Design: adopt-pi-google-thinking-types

## Decisions

### 1. Import the types, keep the resolver

Adopt `GoogleApiThinkingLevel` and `ResolvedGoogleThinkingLevel` as **type-only imports** from `@earendil-works/pi-ai`.
Do not adopt `resolveGoogleThinkingLevel()`: it is generic over `Model<"google-generative-ai" | "google-vertex">`, keyed on `model.thinkingLevelMap`, and returns lowercase pi levels — none of which fits the Antigravity wire-ID routing, where a single logical model fans out to per-effort server-side model IDs.
Our `getGeminiCliThinkingLevel(effort, modelId)` already mirrors pi's module-private `getThinkingLevel` (same minimal→LOW clamp for Gemini 3 Pro, same MINIMAL support for Flash), so the mapping logic stays; only its input/output types come from pi-ai.

### 2. Clamp `"max"` like upstream

pi-ai 0.84's `clampReasoning` (api/simple-options) is `effort === "xhigh" || effort === "max" ? "high" : effort`.
We mirror it exactly.
`ResolvedGoogleThinkingLevel` is precisely the post-clamp type, so `clampReasoning` returns `ResolvedGoogleThinkingLevel | undefined` and `getGeminiCliThinkingLevel` accepts `ResolvedGoogleThinkingLevel` — the switch stays exhaustive over `"minimal" | "low" | "medium" | "high"`.

### 3. Clamp once, at the streamSimple boundary

`streamSimpleGoogleGeminiCli` sets `antigravityEffort = clampReasoning(options?.reasoning) ?? "off"` (previously the raw `options?.reasoning ?? "off"`).
One clamp feeds both consumers: `getAntigravityRequestModelId` (wire-ID routing) and `getGeminiCliThinkingLevel` (tiered `thinkingLevel`).
Before this change an `"xhigh"`/`"max"` user hit the router's fallback chain `routing[effort] ?? routing.low ?? routing.minimal ?? off ?? defaultRequestId` and landed on the **low** wire model for the Gemini entries; after clamping they land on `high`. (`claude-opus-4-6` has a single-value routing map converging on `claude-opus-4-6-thinking`, so it was never misroutable.)

Note on `thinkingLevelMap`: our Antigravity models declare pi's standard map, whose semantics are "missing key = provider default".
With `"xhigh"`/`"max"` now in `ThinkingLevel`, their absence reads as implicitly supported.
Harmless today — nothing consumes the map for `google-gemini-cli` models, and the clamp keeps those efforts out of routing — but if the map ever drives resolution, unsupported levels must be mapped explicitly.

### 4. Keep the `as any` casts

`@google/genai`'s `ThinkingLevel` is a string enum; TypeScript string enums are nominal, so even a literal-equal string union is not assignable. pi's own adapter casts with the same comment.
We keep the casts and update the comment to reference `GoogleApiThinkingLevel`.

### 5. Per-package dependency floor

Only `packages/pi-provider-antigravity/package.json` changes.
The monorepo has no catalog/override for Pi versions; peers stay `"*"`. taze runs scoped to this package (`pnpm dlx taze major -w` from the package dir), not repo-wide, so sibling sync work (pi-accounts' 0.84 floor, pi-condense) is untouched.
