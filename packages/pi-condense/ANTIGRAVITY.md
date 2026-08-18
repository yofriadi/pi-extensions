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
bun run typecheck
```

`bun run typecheck` resolves the package-owned TypeScript compiler through the local `tsconfig.json` in project mode, so it does not inherit a parent workspace configuration.

After reloading the extension, the configured Gemini model should produce summaries directly. If this warning persists, the message now includes the primary's caught error after the colon, e.g.:
```text
pi-condense: summarizer model Gemini 3.6 Flash (Antigravity) failing, using session model DeepSeek V4 Flash Free until it recovers: Cloud Code Assist API error (429): Resource has been exhausted
```
Read the suffix to tell a real outage from a config issue:
- `Cloud Code Assist API error (429): ...` / `Server requested Ns retry delay ...` — account/model quota on the Antigravity side.
- `stalled (no output for Ns)` — the stream produced no event within `summarizerIdleTimeoutMs`; a slow-to-first-token endpoint trips it.
- `Network error: ...` — connectivity to the Antigravity endpoints.
- `No API provider registered for api: google-gemini-cli` — the old `pi-ai/compat` regression is back (this code must dispatch via `ctx.modelRegistry`).

## Authenticated live smoke

Run the credential-gated helper from this repository after authenticating the Antigravity provider in your normal pi agent directory. It creates a separate agent and session directory, copies only `auth.json`, and loads the provider, a no-input deterministic smoke-payload tool, and pi-condense extensions explicitly. It runs with `--no-approve`, no built-in tools, no context files, skills, or prompts; the model cannot read, write, or execute host commands.

```bash
bash scripts/smoke-antigravity.sh \
  --model google-antigravity/gemini-3.7-flash \
  --provider-extension /absolute/path/to/pi-provider-antigravity/src/index.ts \
  --keep
```

It intentionally does **not** claim success automatically. Inspect its printed JSONL session artifact for `context-prune-flush-metrics` and `context-prune-summary`, verify that the configured Antigravity model summarized directly, or record the exact fallback/error suffix above. A failure always retains the session directory but removes the copied credential first. Only an operator who has inspected that authenticated run may close the live-smoke task.
