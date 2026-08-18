# Pi-Condense and Antigravity Model Resolution

## Configuration

```json
{
  "summarizerModel": "google-antigravity/gemini-3.6-flash",
  "summarizerThinking": "high"
}
```

## Symptom

```text
pi-condense: summarizer model Gemini 3.6 Flash (Antigravity) failing, using session model DeepSeek V4 Flash Free until it recovers
```

This warning means the configured summarizer returned a transient failure and the session model successfully produced the summary. The fallback is working, but it hides the primary failure after the retry succeeds.

For Antigravity, this is a known integration regression if `src/summarizer.ts` imports `stream` from `@earendil-works/pi-ai/compat` or sends `reasoningEffort`. An upstream merge restored that old path and made the warning recur.

## Cause

Custom provider handlers are registered on Pi's host `ModelRegistry`. The `pi-ai/compat` registry is module-global, so it cannot reliably resolve Antigravity's `google-gemini-cli` API from an extension. It can fail with:

```text
No API provider registered for api: google-gemini-cli
```

Also, Antigravity implements the provider-neutral `streamSimple()` contract, whose thinking option is `reasoning`, not the low-level API-specific `reasoningEffort`.

## Required implementation

`src/summarizer.ts` must:

- Resolve auth and the provider through `ctx.modelRegistry`.
- Call `ctx.modelRegistry.getProvider(model.provider)?.streamSimple(...)`.
- Pass `apiKey`, `headers`, `env`, and the combined abort signal.
- Pass `{ reasoning: level }` only for a reasoning-capable model and a configured level other than `default` or `off`.
- Never import or call `stream` from `@earendil-works/pi-ai/compat`.

The host provider is the same composed provider Pi uses for extension-registered custom APIs, including `google-antigravity`.

## Regression coverage

`src/summarizer-wiring.test.ts` verifies host-provider dispatch with resolved auth and `reasoning: "high"`, and asserts that `reasoningEffort` is absent. It does not mock `pi-ai/compat`, so restoring the compatibility path breaks the test.

## Verification

```bash
bun test src/summarizer.test.ts src/summarizer-wiring.test.ts
bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts
```

After reloading the extension, the configured Gemini model should produce summaries directly. If this warning persists, the message now includes the primary's caught error after the colon, e.g.:
```text
pi-condense: summarizer model Gemini 3.6 Flash (Antigravity) failing, using session model DeepSeek V4 Flash Free until it recovers: Cloud Code Assist API error (429): Resource has been exhausted
```
Read the suffix to tell a real outage from a config issue:
- `Cloud Code Assist API error (429): ...` / `Server requested Ns retry delay ...` — account/model quota on the Antigravity side.
- `stalled (no output for Ns)` — the stream produced no event within `summarizerIdleTimeoutMs`; a slow-to-first-token endpoint trips it.
- `Network error: ...` — connectivity to the Antigravity endpoints.
- `No API provider registered for api: google-gemini-cli` — the old `pi-ai/compat` regression is back (this code must dispatch via `ctx.modelRegistry`).
