# Proposal: adopt-pi-google-thinking-types

## Why

pi-ai 0.84.3 renamed the inherited `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` (`Exclude<ThinkingLevel, "xhigh" | "max">`) for normalized adapter levels.
The extension does not import the renamed type, so nothing breaks — but it carries its own local duplicates copied from an older pi-ai:

- `src/cloud-code-assist.ts` defines a local `GoogleThinkingLevel` that is now byte-identical to pi-ai's exported `GoogleApiThinkingLevel`.
- `src/vendor/simple-options.ts` has a vendored `clampReasoning` that only clamps `"xhigh"`. pi-ai 0.80.6 added a new `ThinkingLevel` value `"max"`, and upstream's `clampReasoning` now clamps `"xhigh" | "max"` → `"high"`.
  Our copy has drifted.

That drift is a live bug the moment devDeps move to 0.84.x: `ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh">` would still contain `"max"`, `getGeminiCliThinkingLevel`'s switch has no `"max"` case, and `getAntigravityRequestModelId`'s fallback chain (`routing[effort] ?? routing.low ?? routing.minimal ?? off ?? defaultRequestId`) would route an `"xhigh"`/`"max"` user to the **low** wire model for the Gemini entries instead of the high one. (`claude-opus-4-6` is unaffected: every routing value and `defaultRequestId` are the same `claude-opus-4-6-thinking` ID, so all fallbacks converge on it.)

## What Changes

1. **Bump Pi devDeps** `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` from 0.79.1 to 0.84.3, and update the package's remaining dependencies to latest (including majors) via `pnpm dlx taze major -w`.
2. **Delete the local `GoogleThinkingLevel` type** in `src/cloud-code-assist.ts` and import `GoogleApiThinkingLevel` from `@earendil-works/pi-ai` instead.
3. **Replace `ClampedThinkingLevel`** (`Exclude<ThinkingLevel, "xhigh">`) with pi-ai's `ResolvedGoogleThinkingLevel`, and update `clampReasoning` to clamp both `"xhigh"` and `"max"` to `"high"`, mirroring upstream.
4. **Clamp `antigravityEffort` before request-model routing** so `"xhigh"`/`"max"` resolve to the `high` wire model rather than falling back to `low`.
5. **Keep the `as any` casts** at the `thinkingConfig.thinkingLevel` assignment sites — `@google/genai`'s `ThinkingLevel` is a nominal string enum, so plain string literals are not assignable regardless.
   Only the stale comments referencing the old local type name change.

## Non-goals

- **Not adopting pi's `resolveGoogleThinkingLevel()` function.**
  It requires `Model<"google-generative-ai" | "google-vertex">` (our models are `Model<"google-gemini-cli">`), consults `model.thinkingLevelMap` (a different concept from our Antigravity wire-ID routing), returns a lowercase pi level rather than the wire enum, and throws on unmapped levels.
  The extension's `getGeminiCliThinkingLevel` (which mirrors pi's module-private `getThinkingLevel`) and `getAntigravityRequestModelId` remain.
- **Not bumping sibling packages' Pi devDeps.**
  The monorepo pins Pi per package (peers stay `*`); pi-accounts' own floor is managed by its sync change.

## Capabilities

### New Capabilities

- `thinking-level-resolution`: how pi `ThinkingLevel` values are normalized for Google APIs and routed to Antigravity wire models, sourced from pi-ai types.

### Modified Capabilities

None.

## Impact

- **Code**: `src/cloud-code-assist.ts`, `src/vendor/simple-options.ts`, `test/stream-routing.test.ts` in `packages/pi-provider-antigravity`.
- **Deps**: `packages/pi-provider-antigravity/package.json` only.
  Peers remain `*`, so consumers are unconstrained; the 0.84.3 floor applies only to this package's own typecheck/tests.
- **Behavior change**: `reasoning: "xhigh"` (existing) and `"max"` (new since pi-ai 0.80.6) now route to the `high` Antigravity wire model and emit `thinkingLevel: "HIGH"` instead of misrouting to the low wire model.
- **Risk**: low — the enum values are unchanged, the resolver semantics are copied from upstream, and the loader-level tests exercise the real path.
