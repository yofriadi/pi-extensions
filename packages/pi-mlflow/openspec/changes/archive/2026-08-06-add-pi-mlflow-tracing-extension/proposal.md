## Why

Pi sessions currently produce no durable, queryable record of what happened during a coding session: which turns ran, which tools were called, how much each LLM call cost, and where time and tokens went.
The maintainer previously solved this with a `pi-langfuse` extension, but Langfuse's self-hosted stack (ClickHouse + PostgreSQL + Redis + S3 + web server) is too resource-heavy for a personal, local-only observability tool.
MLflow offers the same OpenTelemetry-based tracing model with a dramatically lighter self-hosted footprint (single server process + SQLite + local file storage), and ships an official TypeScript tracing SDK.
This change builds a `pi-mlflow` extension that traces pi sessions to a local, user-managed MLflow Tracking Server.

## What Changes

- New standalone npm package `pi-mlflow`: a pi extension that hooks pi's lifecycle events and exports each prompt/turn-cycle as an MLflow trace via the official `mlflow-tracing` TypeScript SDK.
- One MLflow trace per pi turn-cycle (`agent_start` → `agent_settled`), not per whole CLI session — chosen to match MLflow's bounded request/response trace model.
  Traces are grouped/filterable across a session via an `mlflow.trace.session` metadata tag.
- Span tree per trace uses MLflow's native `SpanType` taxonomy (`AGENT` root, `CHAIN` per turn, `LLM` per provider call, `TOOL` per tool execution), with tool spans keyed by `toolCallId` to correctly handle parallel tool execution.
- Rich structural metadata always captured (token usage, cost, retry/HTTP status history, git branch/commit, compaction stats, attempt/turn indices).
  Full content capture (prompts, tool arguments/outputs, provider payloads) is gated behind a `captureContent` config flag, default `false`.
- Flush strategy: primary flush at `agent_settled` (caps data loss to the in-flight turn on a crash), with a secondary flush and orphan-span sweep at `session_shutdown` as a safety net.
- Setup is zero-touch beyond a config file: the extension resolves-or-creates the target MLflow experiment by name via MLflow's REST API on load, avoiding the manual "copy experiment ID from the UI" step the TypeScript SDK would otherwise require.
- If the configured MLflow Tracking Server is unreachable, the extension silently disables tracing for that session and logs once — no retry loop, no interactive warning.
  The `/mlflow` status command is the one place this disabled state is surfaced explicitly.
- New `/mlflow` slash command showing tracking URI, resolved experiment, capture-content mode, and current tracing status (active / disabled and why).
- Explicit non-goals: no MCP server or tool-provider surface (no experiment/model-registry access exposed to the LLM), no remote/Databricks-specific auth flows, no management of the `mlflow server` process lifecycle, no write-ahead-log-style durability (MLflow's WAL durability feature is scoped to their own first-party Claude Code plugin and is not available to third-party `mlflow-tracing` consumers — accepted as a known limitation, consistent with `pi-langfuse`'s equivalent exposure).

## Capabilities

### New Capabilities

- `session-tracing`: Hooking pi's lifecycle events (agent/turn/tool/message/compaction/shutdown) and translating them into an MLflow trace/span tree with correct parallel-tool handling, compaction placement, and orphan-span cleanup.
- `mlflow-export`: Configuring and connecting to a local MLflow Tracking Server (config file, experiment resolve-or-create, `mlflow-tracing` SDK initialization, flush strategy, silent-disable-on-unreachable behavior).
- `trace-metadata`: The rich structural metadata captured on every trace/span (token usage, cost, git info, retry/HTTP history, compaction stats, attempt/turn indices) and the `captureContent` toggle governing full content capture.
- `mlflow-status-command`: The `/mlflow` slash command surfacing current tracing configuration and status.

### Modified Capabilities

(none — no existing specs in this repository)

## Impact

- New standalone package (not a modification to any existing codebase); no breaking changes since nothing exists yet.
- New runtime dependency: `mlflow-tracing` (npm).
- Requires the user to run their own `mlflow server` process (e.g. `mlflow server --backend-store-uri sqlite:///mlruns.db`); the extension does not install, start, or supervise it.
- New local config file (e.g. `pi-mlflow.json`) holding `trackingUri`, `experimentName`, and `captureContent`.
- No impact on pi's core behavior beyond the lifecycle event handlers the extension registers; no changes to pi itself.
