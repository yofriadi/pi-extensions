## Context

`pi-mlflow.json` has three fields with conservative defaults: `trackingUri` (`http://localhost:5000`), `experimentName` (`"pi"`), and `captureContent` (`false`).
All three were chosen in the original tracing-extension design (D-defaults) under a SaaS-observability mindset inherited from `pi-langfuse`: minimize payload, never transmit content without explicit opt-in, and assume the stock MLflow port.

Two observations motivate revisiting them:

1. The chat-bubbles change made `captureContent: true` the gateway to the extension's main readability feature, yet left the default off — its own proposal called the result "unusable by default."
   In practice the user's config flips it on in every project.
2. The user's per-project `experimentName` overrides (e.g. `"pi-mlflow"` in this repo) show the shared `"pi"` bucket is not the natural grouping; the project directory name already is.
3. The `http://localhost:5000` default can never connect out of the box on macOS: ControlCenter (AirPlay Receiver) already binds port 5000 and answers HTTP 403, so a no-config startup silently disables tracing.
   The repo's own server helper (`scripts/run-mlflow-server.sh`) defaults to port `5055` for exactly this reason.

Constraint carried forward: configuration stays project-local (`./pi-mlflow.json` only); a global `~/.pi` config layer was explored and explicitly deferred.

## Goals / Non-Goals

**Goals:**

- Out of the box (no config file), a running local MLflow server yields per-project experiments with full Sessions chat bubbles.
- `captureContent` becomes opt-out; structure-only tracing remains one explicit flag away.
- Validation semantics otherwise unchanged: unknown keys rejected, empty-string values still error (absent ≠ empty), credentials-in-URI still rejected.

**Non-Goals:**

- Global/user-level config (`~/.pi/agent/settings.json` or `~/.pi/agent/pi-mlflow.json`) — deferred; this change keeps the single project-local file model.
- A sentinel/templating syntax (e.g. `"experimentName": "$dirname"`) — the default flip makes it unnecessary.
- Migration or renaming of existing MLflow experiments/traces created under old defaults.
- Changes to any gating call site (`gateContent`), span lifecycle, or the `/mlflow` status command (already reports capture state).

## Decisions

### D1: `experimentName` default = `basename(resolved cwd)`, fallback `"pi"`

`loadConfig(cwd)` already receives the working directory; the default is computed as `basename(resolve(cwd))`, and when that yields an empty string (filesystem root), it falls back to the previous static default `"pi"`.
An explicit `experimentName` in the config file always wins.
Explicit empty string remains a validation error (it signals a hand-editing mistake, distinct from absence).

Alternatives considered:

- **Keep `"pi"` + document per-project override**: rejected — every project silently shares one bucket; the user's own configs show the override is always wanted.
- **Sentinel value (`"$dirname"`)**: rejected — magic strings in config are worse than a sensible dynamic default; explicit names remain available.
- **`process.cwd()` at call time instead of threading the resolved default through validation**: the existing `validateConfig(raw, path)` signature gains the resolved default (or cwd) as a parameter, keeping validation pure and testable.

### D2: `captureContent` default = `true`

One-line constant flip (`DEFAULT_CAPTURE_CONTENT`) plus doc/test updates.
All `gateContent` call sites are default-agnostic and untouched.

Rationale: the tracking server is user-managed and local (the README's stated premise); the data owner and destination are the same person, so the exfiltration argument for default-off is weak, while the feature-visibility argument for default-on is strong (Sessions bubbles work immediately).

Alternatives considered:

- **Keep `false`, improve docs/discoverability**: rejected — docs don't fix a feature that's invisible until enabled; the bubbles proposal itself identified the gating as the product gap.
- **Interactive first-run prompt**: rejected — violates the extension's silent, non-interactive stance (D9 lineage).

### D3: Docs carry the shared-server warning explicitly

Because default-on content capture changes the blast radius for anyone pointing `trackingUri` at a shared/team MLflow server, the README gains an explicit warning line, and `pi-mlflow.example.json` documents `captureContent` as defaulting to `true`. `/mlflow` already surfaces the effective capture state at runtime; no code change needed there.

### D4: `trackingUri` default = `http://localhost:5055`

One-line constant change (`DEFAULT_TRACKING_URI`).
The stock MLflow port `5000` is unusable as a no-config default on macOS, where ControlCenter (AirPlay Receiver) binds it and returns HTTP 403 — so on a fresh install the extension silently disabled itself.
`5055` matches the repo's server helper (`scripts/run-mlflow-server.sh`, `PORT` default `5055`), so out of the box the extension connects to a server started the documented way, with no TLS or CA setup.
An explicit `trackingUri` still overrides; the value is still validated as an absolute http(s) URL.

Alternatives considered:

- **Keep `5000` (stock MLflow port)**: rejected — on the primary platform it can never work without the user first disabling AirPlay Receiver or overriding the URI, defeating the no-config goal.
- **Auto-probe a port range**: rejected — magic discovery is surprising and could attach to the wrong server; an explicit, documented default plus an override is simpler and predictable.

## Risks / Trade-offs

- [Shared/team tracking server now receives full prompt/tool/LLM bodies by default] → README warning; opt-out is a single config flag; `/mlflow` displays capture state.
- [Experiment proliferation: any directory pi runs in can create a new experiment (`scratch/`, `tmp/`, fixtures)] → accepted; resolve-or-create is cheap, and per-project grouping is the desired behavior.
  Documented in README.
- [Renaming a project directory splits trace history across two experiments] → accepted; old traces remain under the old experiment name.
  Users who rename and want continuity can set `experimentName` explicitly.
- [Running pi in the home directory creates an experiment named after the user] → accepted as reasonable behavior; explicit override available.
- [Breaking-change surprise for existing users relying on `"pi"` default or structure-only traces] → called out as BREAKING in the proposal; README migration note (`"experimentName": "pi"` / `"captureContent": false` restore old behavior).
- [Same-basename collisions: `~/work/app` and `~/client/app` share one experiment] → accepted; grouping by directory name is the intended heuristic, and explicit `experimentName` disambiguates when it matters.
- [Derived directory name is passed to server-side experiment creation unvalidated] → safe by construction: an invalid-per-server name fails resolve-or-create and folds into the existing silent-disable path (`src/setup.ts`), same as any misconfiguration.
- [Disabled-state placeholder configs hardcode `captureContent: false`, so `/mlflow` can show "disabled" while the effective default is enabled] → accepted as cosmetic: tracing is off in those states, so nothing is captured and the display is literally true.
- [Non-macOS users running a stock MLflow server on port `5000` with no config now resolve `5055`] → accepted; they pin `"trackingUri": "http://localhost:5000"` explicitly.
  Called out as BREAKING in the proposal.

## Migration Plan

No code migration.
On upgrade:

- Users who want the old grouping pin `"experimentName": "pi"`.
- Users who want structure-only traces pin `"captureContent": false`.
- This repo's own `pi-mlflow.json` can drop the now-redundant `experimentName` key; its `captureContent: true` key is kept explicit as self-documentation in the extension's own repo (deliberate, not an oversight).

Rollback: revert the change; no persisted state is affected (config resolution is per-process, in-memory only).

## Open Questions

(none — global config layering is deliberately out of scope, tracked as a possible future change)
