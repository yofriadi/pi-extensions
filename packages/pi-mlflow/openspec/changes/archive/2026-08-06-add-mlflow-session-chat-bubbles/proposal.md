# Add MLflow Chat Sessions bubbles for pi-mlflow tracing

## Why

The MLflow Chat Sessions UI (single chat view) is currently completely blank for our traces.
It shows a sidebar of turns but no Inputs/Outputs or chat bubbles because the root span for each trace has no `inputs`/`outputs` attributes or `mlflow.chat.messages`.

This is a product gap: the extension already exports full turn-cycle traces with one root `AGENT` span per cycle (as designed in D1), but the UI that should make those traces readable as conversations is unusable by default.
When `captureContent: true`, we want to populate the root span with a minimal chat-shaped summary so Sessions immediately shows a real user + assistant bubble pair.

This change adds the missing root turn summary without changing the existing trace boundary or adding new traces.

## What Changes

- Add `captureContent`-gated root `inputs`/`outputs` (JS strings via span setters; SDK JSON-serializes attributes) to the `AGENT` root span for each turn-cycle; promote `mlflow.chat.messages` if Chat Sessions on the baseline UI still lacks bubbles.
- Use the initial user prompt (from `before_agent_start.prompt`) as the request and the last non-empty assistant text as the response.
- When `captureContent: false`, keep root bare as before (Sessions stays empty, which is documented).
- Update `onAgentSettled` and `session_shutdown` to publish the summary after child force-closes and before ending the root span; clear pending summary state only in cycle reset.
- Document in README, `pi-mlflow.example.json`, and `/mlflow` status/help that Sessions conversation text requires `captureContent: true`.

**No breaking changes** — existing behavior unchanged.
Only adds value when `captureContent: true`.

## Capabilities

### New Capabilities

- `mlflow-session-chat-summary`: Adds chat-shaped root turn summary to Sessions UI (one trace per turn-cycle still respected).

## Impact

- Affects `src/lifecycle.ts` / `src/state.ts` (pending summary fields, `before_agent_start`, publish on settle/shutdown).
- Affects tracing state and event handlers.
- Affects MLflow UI rendering on operator servers (baseline verified: Chat Sessions on MLflow **3.14.0**); product gate is manual bubble confirmation, not unit tests alone.
- No change to Traces drawer or span tree structure.
- Requires `captureContent: true` for new behavior (default remains off).
