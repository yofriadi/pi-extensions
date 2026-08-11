## 1. Prerequisites

- [x] 1.1 Archive completed changes (`add-pi-mlflow-tracing-extension`, `add-mlflow-session-chat-bubbles`) so base specs exist in `openspec/specs/`

## 2. Config defaults

- [x] 2.1 In `src/config.ts`, flip `DEFAULT_CAPTURE_CONTENT` to `true`
- [x] 2.2 In `src/config.ts`, replace static `DEFAULT_EXPERIMENT_NAME` with cwd-derived resolution: `basename(resolve(cwd))`, falling back to `"pi"` when the basename is empty; thread the resolved default through `validateConfig` (explicit `experimentName` still wins; explicit empty string remains a validation error)
- [x] 2.3 Verify no other source file references the removed/renamed constants; `gateContent` call sites must remain untouched
- [x] 2.4 Update stale code comments to match opt-out defaults: `src/metadata.ts` file header ("opt-in via `captureContent`") and the trust comment in `src/index.ts` (exfil vector no longer requires flipping `captureContent` — a malicious `trackingUri` alone suffices once content capture defaults to on)

## 3. Tests

- [x] 3.1 Update `test/config.test.ts` default expectations: `captureContent: true`, experiment name = fixture cwd basename
- [x] 3.2 Add case: cwd at filesystem root (or empty basename) falls back to experiment name `"pi"`
- [x] 3.3 Add case: explicit `experimentName` overrides the directory default; explicit `captureContent: false` is honored
- [x] 3.4 Add case: explicit empty-string `experimentName` still fails validation (absent ≠ empty)
- [x] 3.5 Run full unit test suite (`vitest`) and confirm no other tests assumed the old defaults

## 4. Docs

- [x] 4.1 Update `README.md`: new defaults, `captureContent` guidance rewritten from opt-in to opt-out, shared/team-server warning, migration note (`"experimentName": "pi"` / `"captureContent": false` restore old behavior) — including the inline JSON snippet (README lines ~24-30, which today shows `"experimentName": "pi"` / `"captureContent": false` and cannot express a dynamic dirname default as a literal) and the "defaults above" sentence (~line 32): state the dirname default + root fallback in prose; the opt-in sentences at ~lines 55-56 are the ones being rewritten to opt-out
- [x] 4.2 Update `pi-mlflow.example.json`: set `captureContent: true` and remove the `experimentName` key — the file is strict JSON and config validation rejects unknown keys, so the dynamic dirname default + root fallback are documented in README only, not via inline note keys
- [x] 4.3 Drop the now-redundant `experimentName` key from this repo's own `pi-mlflow.json`; keep `captureContent: true` explicit as self-documentation (per design migration plan)

## 5. Verify

- [x] 5.1 `openspec validate flip-content-and-experiment-defaults` passes
- [x] 5.2 Manual smoke: no-config startup verified end-to-end — with no `pi-mlflow.json`, defaults resolve to `http://localhost:5055` / `captureContent: true` / cwd-basename experiment, and the live server resolves the experiment (the default URI was moved off the ControlCenter-occupied `5000` to `5055` precisely so this works out of the box)

Verification note: the no-config leg resolved `trackingUri: http://localhost:5055`, `captureContent: true`, and `experimentName` from the temporary project basename, and `resolveOrCreateExperiment` succeeded against the live server (experiment id returned); the live export leg emitted a trace whose User and Assistant bubbles were visible in MLflow Chat Sessions.
