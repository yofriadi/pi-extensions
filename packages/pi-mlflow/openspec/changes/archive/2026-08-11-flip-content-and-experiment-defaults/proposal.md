## Why

Three defaults inherited from a conservative, SaaS-style stance now work against the extension's personal, local-only premise:

- `captureContent: false` hides the extension's main readability feature — MLflow Chat Sessions conversation bubbles — behind an opt-in flag.
  For a local, user-managed tracking server, the data owner and destination are the same person, so the privacy-motivated default-off buys little.
- `experimentName: "pi"` lumps every project's traces into one bucket; per-project naming is the natural model (this repo's own config overrides it to the directory name).
- `trackingUri: http://localhost:5000` can never connect on stock macOS — ControlCenter (AirPlay Receiver) occupies port 5000 and answers HTTP 403 — so a no-config startup silently disables tracing.
  The repo's server helper already defaults to `5055`.

## What Changes

- **BREAKING (default behavior)**: `experimentName` now defaults to the basename of the project working directory instead of `"pi"`.
  If the basename is empty (filesystem root), it falls back to `"pi"`.
  An explicit `experimentName` in `pi-mlflow.json` still wins.
- **BREAKING (privacy-relevant default)**: `captureContent` now defaults to `true`.
  Full prompt text, tool call arguments/outputs, provider request/response bodies, and Sessions conversation text are captured out of the box; structure-only tracing becomes the opt-out (`"captureContent": false`).
- **BREAKING (default behavior)**: `trackingUri` now defaults to `http://localhost:5055` instead of `http://localhost:5000` — macOS ControlCenter occupies port 5000 (HTTP 403), and the repo's server helper uses `5055`.
  An explicit `trackingUri` in `pi-mlflow.json` still wins.
- README and `pi-mlflow.example.json` updated to document the new defaults, including an explicit warning for anyone pointing `trackingUri` at a shared/team tracking server (content capture is now on by default).
- Prerequisite housekeeping: archive the two completed changes (`add-pi-mlflow-tracing-extension`, `add-mlflow-session-chat-bubbles`) so their delta specs land in `openspec/specs/` and this change's deltas apply against them.

No changes to the config file format, validation rules, env-var auth contract, or any gating call sites — only the three default values and their resolution change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `trace-metadata`: the "content capture is opt-in and disabled by default" requirement flips to opt-out / enabled by default; default-behavior scenarios are rewritten accordingly.
- `mlflow-export`: the local connection-configuration requirement gains the directory-name experiment default (with root-dir fallback) and a `http://localhost:5055` default tracking URI as specified behavior.
- `mlflow-session-chat-summary`: the operator-documentation requirement is rewritten to describe content capture as default-enabled (it currently mandates documenting "the default `false`", which would contradict the flipped `trace-metadata` default).

## Impact

- **Code**: `src/config.ts` — `DEFAULT_CAPTURE_CONTENT` flips to `true`; the static `DEFAULT_EXPERIMENT_NAME` is replaced by cwd-basename resolution (with empty-basename fallback to `"pi"`); `DEFAULT_TRACKING_URI` changes to `http://localhost:5055`.
  No other functional code changes (comment-only updates in `src/metadata.ts`/`src/index.ts`, task 2.4); all `gateContent` call sites are default-agnostic.
- **Tests**: `test/config.test.ts` — default-expectation assertions updated; new cases for dirname default, root-dir fallback, and explicit override precedence.
- **Docs**: `README.md` (defaults section, `captureContent` guidance rewritten from opt-in to opt-out, shared-server warning), `pi-mlflow.example.json` (documented defaults).
- **Specs**: delta specs for `trace-metadata`, `mlflow-export`, and `mlflow-session-chat-summary` (applied on top of the archived base specs).
- **No impact**: MLflow SDK/REST integration, auth env vars, OTel setup, `/mlflow` status command code, span lifecycle.
  Accepted cosmetic mismatch: disabled-state placeholder configs hardcode `captureContent: false` (`src/setup.ts`, `src/index.ts`), so `/mlflow` shows "capture content: disabled" when tracing is off — literally true (nothing is captured) even though the effective default is now enabled; no code change.
