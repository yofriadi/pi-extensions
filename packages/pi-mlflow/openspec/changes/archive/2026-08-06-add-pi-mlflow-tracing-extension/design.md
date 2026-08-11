## Context

Pi extensions can hook a documented lifecycle of events (`agent_start`, `turn_start`/`turn_end`, `before_provider_request`, `after_provider_response`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`tool_execution_update`/`tool_execution_end`, `session_before_compact`/`session_compact`, `agent_end`/`agent_settled`, `session_shutdown`) via `pi.on(event, handler)`.
The maintainer's existing `pi-langfuse` extension already proves this pattern works for OpenTelemetry-based tracing: it maintains its own span stack across these events and exports to an OTel backend.
`pi-mlflow` reuses that same *hooking technique* but targets MLflow's official `mlflow-tracing` TypeScript SDK and MLflow's native trace/span data model (`SpanType` enum, `updateCurrentTrace()` metadata/tags, `mlflow.chat.tokenUsage` span attribute) instead of Langfuse's OTel span-naming conventions.

MLflow's TypeScript SDK requires a running MLflow Tracking Server reachable via `trackingUri` (no direct-to-file local write mode in the TS SDK) and a numeric `experimentId` obtained via `init()`.
The user runs and owns this server themselves; the extension only connects to it.

## Goals / Non-Goals

**Goals:**

- Trace every pi turn-cycle (one prompt → tool calls → response) as one MLflow trace, viewable in the MLflow UI, grouped by session.
- Capture rich structural metadata (tokens, cost, retries, git info, compaction stats, attempt/turn indices) on every trace by default, with no noticeable resource/latency impact on the pi session.
- Make full content capture (prompts, tool I/O, provider payloads) an explicit opt-in, off by default.
- Fail gracefully and quietly if the MLflow server isn't running — this is a personal observability add-on, not a required dependency.
- Provide a `/mlflow` command for at-a-glance status.

**Non-Goals:**

- No MCP server or tool-provider surface — the LLM never gets tools to query/mutate MLflow.
- No management of the `mlflow server` process (start/stop/health-check).
- No remote/Databricks-specific auth flows — `trackingUri` support is limited to what works trivially (local HTTP server, optionally basic-auth/bearer-token per the SDK's existing options).
- No write-ahead-log-style durability.
  MLflow's WAL durability feature is specific to their first-party Claude Code plugin (a separate daemon process) and is not exposed by the generic `mlflow-tracing` npm package.
  This extension relies on `mlflow-tracing`'s internal async/batched exporter plus explicit flush points; a tracking-server outage during a flush can lose that batch.
  Accepted as consistent with `pi-langfuse`'s equivalent exposure to this class of risk.
- No session-level parent trace / cross-turn aggregate view.
  Each turn-cycle is an independent trace; session-level browsing is achieved only via the `mlflow.trace.session` metadata tag and MLflow's trace search, not a dedicated timeline UI.
  This is an intentional trade-off to keep each trace matching MLflow's bounded request/response model rather than fighting it with a session-spanning trace.

## Decisions

### D1: Trace boundary = one turn-cycle, not one CLI session

Root span opens at `agent_start`, closes at `agent_settled`, and is flushed then.
Rationale: MLflow's trace UI and trace-level fields (status, request/response preview, token/cost totals) are designed around one bounded request/response; a session-spanning trace would leave that root span open for the entire CLI session, fighting the UI and delaying all flushing until the session ends.
Sessions are still browsable as a group via the `mlflow.trace.session` metadata tag set through `updateCurrentTrace()`.

- Alternative considered: one trace per whole session, with turns as child spans.
  Rejected — described above as fighting MLflow's data model, and it would defer all flushing (and therefore all durability) until `session_shutdown`, directly conflicting with D2's crash-safety goal.

### D2: Flush at `agent_settled` (primary) + `session_shutdown` (safety net)

`agent_settled` is pi's documented signal that "Pi will not continue running automatically" for that run (as opposed to `agent_end`, which can still be followed by auto-retry, auto-compaction-retry, or queued follow-ups).
The root span ends and `mlflow.flushTraces()` is **awaited** at `agent_settled` so a crash immediately after settlement cannot lose the completed cycle.
This caps data loss on a crash to just the in-flight turn, rather than the whole session's unflushed traces.
A second awaited flush plus an orphan-span sweep runs at `session_shutdown` (Ctrl+C/Ctrl+D/SIGHUP/SIGTERM): any span left open (root or child) is force-ended with a `warning`/incomplete status before the final flush, so an interrupted turn doesn't leave a dangling unflushed span.
Export failures remain accepted (no WAL).

- **Caveat, stated rather than assumed away**: whether an Esc-mid-turn user cancellation reliably still reaches `agent_settled` (as opposed to jumping straight toward shutdown) is not verified from pi's documentation or empirical testing.
  The `session_shutdown` orphan-sweep exists specifically as mitigation for this unverified case, not as an admission that it's a known failure mode — treat it as defensive insurance.
- Alternative considered: flush only at `session_shutdown`.
  Rejected per above (unbounded data-loss window) and per the lightweight goal (would require buffering an entire session's spans in memory rather than releasing them per turn).

### D3: Tool spans keyed by `toolCallId`, not a LIFO stack

Pi's documented parallel-tool-execution semantics: `tool_execution_start` fires in assistant source order during preflight, `tool_execution_update` events may interleave across tools, and `tool_execution_end` fires in tool *completion* order (not start order) once each tool finishes.
A simple push/pop stack would attribute a tool's end to the wrong span whenever two tools run concurrently and finish out of start order.
All three tool events carry `event.toolCallId`, so the extension maintains a `Map<toolCallId, Span>`: push on `tool_execution_start`, look up and close on `tool_execution_end`, delete from the map after closing.

- The turn-level span remains a single "current turn" reference (turns are not documented as overlapping each other).
  However, whether every child tool span for a turn is guaranteed to close (`tool_execution_end`) strictly before that turn's `turn_end` is an **assumption**, not a documented guarantee — pi's docs note `toolResult` message finalization can trail tool completion order.
  Mitigation: on `turn_end`, any tool spans still open in the map for that turn are force-closed (status: incomplete) and attributed as children of that turn before the turn span itself closes.

### D4: Compaction span placement by `reason`

`session_compact` fires with `reason` of `"manual"` (`/compact`), `"threshold"`, or `"overflow"`.
Only `"overflow"` is documented as tied to an in-flight turn (`willRetry: true`, "the aborted turn is retried after compaction").
Placement rule:

- `reason: "overflow"` → compaction span is a child of the turn it interrupted.
  **Implementation note**: pi actually fires `overflow` `session_compact` *after* that turn's `turn_end` has already run (see `_checkCompaction`, called from `_handlePostAgentRun` after `agent_end`), so the compaction span is parented to the already-*ended* turn span, not a still-open "current turn".
  When `willRetry: true`, the retried LLM call is a new `LLM` span under a *new* `pi.turn` span (mlflow-tracing spans cannot be reopened once ended), but that new turn span is itself parented under the compaction span — making it a descendant of the turn it overflowed rather than a sibling under the root — and the LLM span is tagged `pi.attempt.reason: "post_compaction"`.
- `reason: "manual"` or `"threshold"` while a trace is active (root span open, between turns) → compaction span is a child of the **root `AGENT` span**.
- Compaction firing with **no active trace** (idle, no root span open) → not traced at all, matching `pi-langfuse`'s existing "manual compaction outside an active agent trace is ignored" precedent.
- Compaction attributes: `tokensBefore`, `messagesToSummarize`/`firstKeptEntryId`, `reason`, `willRetry` — structural metadata only, never the summary text itself (consistent with the content/metadata separation in D6).

### D5: Span type mapping (MLflow-native, not ported from Langfuse)

| Pi event span                                                                 | MLflow `SpanType`             | Notes                                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start`...`agent_settled`                                               | `AGENT`                       | Root span per trace                                                                                                                                |
| `turn_start`...`turn_end`                                                     | `CHAIN`                       | One per turn                                                                                                                                       |
| `before_provider_request`/`after_provider_response`/`message_end` (assistant) | `LLM`                         | Attributes: `mlflow.chat.tokenUsage`, cost (see D7), provider, model, thinking level, final HTTP status code (see D7 addendum — not a retry count) |
| `tool_execution_start`...`tool_execution_end`                                 | `TOOL`                        | Keyed by `toolCallId` per D3                                                                                                                       |
| `session_compact`                                                             | `CHAIN` (tagged `compaction`) | Placement per D4                                                                                                                                   |

`pi-langfuse` is referenced only for the event-hooking technique (maintaining an in-memory span reference across discrete callback firings); its OTel span-naming scheme and generation/observation hierarchy are not ported — MLflow's own `SpanType` taxonomy and attribute conventions are used instead, per the proposal's stated intent to lean into MLflow's native model.

### D6: Metadata vs. content separation for the lightweight goal

Rich structural metadata (token usage, cost, git branch/commit, compaction stats, attempt/turn indices, a final HTTP status code — not response bodies) is always captured — it is small, numeric/structural data with negligible serialization or transport cost.
Full content (prompt text, tool arguments/outputs, provider request/response payloads) is captured only when `captureContent: true` in config (default `false`).
This mirrors `pi-langfuse`'s existing `captureContent` toggle and is the primary mechanism satisfying the "no noticeable resource bump" goal — the SDK's async/batched exporter avoids synchronous per-span HTTP calls, so the remaining cost is proportional to payload size, which the toggle bounds.

### D7: Cost and session/git metadata sourcing

- Cost and token usage are read directly from pi's own `message_end` event payload (`event.message.usage.cost.total` and associated usage fields), not reconstructed from `before_provider_request`/`after_provider_response` HTTP internals — pi already computes these for its own footer/session totals.
- Token usage is set via the MLflow-documented `mlflow.chat.tokenUsage` span attribute (`{ input_tokens, output_tokens, total_tokens }`).
- Cost is set via a span attribute; the canonical MLflow key for manually-set cost (candidate: `mlflow.llm.cost`) is **not verified** against MLflow's documentation as an accepted/rendered key at design time.
  Implementation must verify this against the installed `mlflow-tracing` version and fall back to a custom attribute (e.g. `pi.llm.cost`) if the canonical key is rejected or doesn't render — noted as an open question below, not a blocker, since MLflow accepts arbitrary span attributes regardless.
- Session grouping and git provenance are set via `updateCurrentTrace({ metadata: {...} })`, using MLflow's reserved metadata keys (`mlflow.trace.session`, `mlflow.trace.user` if applicable, `mlflow.source.git.commit`, `mlflow.source.git.branch`, `mlflow.source.git.repoURL`) — **not** `tags`, which is reserved for free-form user labels.
  This corrects an earlier draft that conflated the two; `updateCurrentTrace`'s `metadata` and `tags` options are distinct and not interchangeable for these reserved keys.
- **Addendum, discovered during implementation**: the original "HTTP retry/status counts" framing (D5/D6, and the `trace-metadata` spec's "retry and HTTP status metadata" requirement) assumed pi's `after_provider_response` event fires once per HTTP attempt, so a retried call would produce a sequence of statuses to record.
  It does not.
  Pi's provider layer (`retryProviderRequest` in `@earendil-works/pi-ai`) retries failed HTTP calls *internally*, catching failed attempts inside its own retry loop; `onResponse`/`after_provider_response` fires at most once per provider call, only for the attempt that ultimately succeeded.
  Pi's internal `auto_retry_start`/`auto_retry_end` events (which *do* carry attempt counts) are emitted only to pi's own UI event stream (`AgentSession._emit`), not to extensions (`_extensionRunner.emit`) — there is no extension-visible per-attempt retry signal.
  The implementation therefore records only the single final HTTP status code (`pi.llm.httpStatusCode`) observed for a completed provider call, and does not fabricate a retry count.
  This is a correction to the original design's assumption, not an implementation shortcut; revisit if a future pi version exposes per-attempt retry events to extensions.

### D8: Setup flow — experiment resolve-or-create

On extension load (once per pi process start): read `pi-mlflow.json` (`trackingUri`, default `http://localhost:5000`; `experimentName`; `captureContent`, default `false`).
Call MLflow REST `GET .../api/2.0/mlflow/experiments/get-by-name`; if not found, `POST .../experiments/create`.
Cache the resulting numeric `experimentId` in memory for the process lifetime (not re-resolved per trace or per turn).
Call `mlflow.init({ trackingUri, experimentId })`.
This removes the manual "copy experiment ID from the MLflow UI" step the TypeScript SDK would otherwise require, at the cost of one REST round-trip at startup.

### D9: Unreachable server → silent disable, not retry

If experiment resolution or `mlflow.init()` fails at startup (server unreachable, connection refused, etc.), the extension disables tracing for the remainder of that pi process: no retry loop, no interactive warning, one log line.
Rationale: this is a personal, local-only, best-effort observability add-on — retrying would add background work and complexity disproportionate to the goal, and a visible warning would be an unwanted interruption for a tool whose explicit design goal is to not be noticed.
The `/mlflow` command is the one sanctioned place this disabled state is surfaced explicitly (e.g. `status: disabled (tracking server unreachable at startup)`), so "silent" governs the trace path only, not the status surface — these are complementary, not contradictory.

### D10: Packaging and command surface

Ships as a standalone npm package (`pi-mlflow`), not a PR into the `narumiruna/pi-extensions` monorepo — full control over release cadence and structure, no dependency on that repo's conventions or review.
A `/mlflow` slash command (mirroring `pi-langfuse`'s `/langfuse`) shows: tracking URI, resolved experiment (name + id), capture-content mode, and current status (active, or disabled with reason).

### D11: Tracking URI must not embed credentials

`trackingUri` is validated as an absolute `http`/`https` URL and **rejected** if it contains userinfo (`user:pass@...`).
Authentication is environment-variable only (`MLFLOW_TRACKING_USERNAME`/`MLFLOW_TRACKING_PASSWORD` or `MLFLOW_TRACKING_TOKEN`), matching the MLflow TypeScript SDK.
Rationale: request/timeout errors from the SDK and REST helpers can include the full URL; embedding credentials would leak them into logs and `/mlflow`'s disabled reason despite redaction claims.
Rejecting at config load is stronger than best-effort sanitization of every error path.

### D12: Root span status follows final cycle outcome

The root `AGENT` span ends with the final turn-cycle outcome, not always `OK`.
A terminal `error`/`aborted` turn or any force-closed incomplete child marks the cycle `ERROR`.
A later successful recovery turn within the same cycle (retry / post-compaction continue) restores `OK`, so overflow recovery reports the eventual result rather than the intermediate failure.

## Risks / Trade-offs

- [No session-level aggregate/timeline view] → Mitigated by the `mlflow.trace.session` metadata tag enabling filtered search in the MLflow UI; accepted as an intentional trade-off (D1) rather than something to solve now.
- [Tracking-server outage during flush loses that batch — no WAL-style durability] → Accepted as a stated limitation, consistent with `pi-langfuse`'s equivalent exposure; not solved by this design.
- [Turn-span containment of child tool spans is an assumption, not a documented guarantee] → Mitigated by force-closing any still-open tool spans at `turn_end` (D3).
- [Esc/Ctrl+C mid-turn reaching `agent_settled` is unverified] → Mitigated by the `session_shutdown` orphan-sweep (D2); worst case is a force-closed, correctly-attributed-but-incomplete span, not data loss beyond the in-flight turn.
- [Exact MLflow attribute key for manually-set cost is unverified] → Non-blocking; MLflow accepts arbitrary span attributes, so the only failure mode is the value not rendering in a built-in cost widget.
  Verify during implementation; fall back to a custom key if needed (D7).
- [`mlflow-tracing` install size/dependency weight unverified] → The lightweight goal targets runtime footprint (addressed by D6's content/metadata separation and the SDK's async exporter), not one-time install size; worth a quick check during implementation but not a design blocker.

## Migration Plan

Not applicable — this is a new, standalone extension with no existing users or prior version to migrate from.

## Open Questions

- Exact MLflow span attribute key for manually-set LLM cost (candidate `mlflow.llm.cost`) — verify against the installed `mlflow-tracing` version during implementation (D7).
- `mlflow-tracing`'s npm package dependency tree/install size — quick check during implementation, informational only.
- Exact `pi-mlflow.json` file permission policy (e.g. whether to restrict to `0600` like `pi-langfuse.json`) — lower stakes here since the config holds no secrets (no API keys, just a local URL and experiment name), but worth a one-line decision during implementation.
