## 1. Project Setup

- [x] 1.1 Scaffold standalone npm package `pi-mlflow` (package.json, tsconfig, build script) following the extension package shape shown in pi's own `examples/extensions/*` packages (e.g. `with-deps`, `gondolin`)
- [x] 1.2 Add `mlflow-tracing` as a runtime dependency; check its dependency tree/install size (informational, per design's open questions) — installs ~426 packages / ~325MB in `node_modules` (mostly transitive `@opentelemetry/*` exporters pulled in by `@opentelemetry/sdk-node`); noted here as informational per the design, not a blocker
- [x] 1.3 Add `@earendil-works/pi-coding-agent` (or its extension type exports) as a dev dependency for extension typings
- [x] 1.4 Set up a basic test runner and lint config consistent with the target extension ecosystem

## 2. Configuration And Connection (mlflow-export)

- [x] 2.1 Define `pi-mlflow.json` schema: `trackingUri` (default `http://localhost:5000`), `experimentName`, `captureContent` (default `false`)
- [x] 2.2 Implement config file loading with validation and sensible defaults — also rejects `trackingUri` userinfo (env-var auth only) so credentials cannot leak via request/timeout errors
- [x] 2.3 Implement experiment resolve-or-create against MLflow REST (`experiments/get-by-name`, `experiments/create`), caching the resolved `experimentId` in memory for the process lifetime — cache is keyed on `globalThis`, not a module-level `let`, so it survives extension re-evaluation from `/reload`/session replacement within the same OS process (see `test/setup.test.ts`'s reload-simulation test)
- [x] 2.4 Implement `mlflow.init({ trackingUri, experimentId })` call using the resolved values
- [x] 2.5 Implement silent-disable behavior: on any failure during 2.3/2.4, disable tracing for the process, log once, no retry, no interactive warning — also covers `mlflow.init()`'s internal SDK-initialization failure, which the SDK itself only logs rather than throws (see `initMlflowOrThrow` in `src/setup.ts`)
- [x] 2.6 Decide and implement config file permission policy (design's open question) — decided: no permission enforcement, since `pi-mlflow.json` holds no secrets and is never written by the extension (see `src/config.ts`).
      Also gated `pi-mlflow.json` loading behind `ctx.isProjectTrusted()` (matching pi's own project-local resource trust boundary) so an untrusted project cannot point tracing at an attacker-controlled `trackingUri` or force `captureContent: true` (see `test/index.test.ts`).

## 3. Span Lifecycle Core (session-tracing)

- [x] 3.1 Implement root span open/close bound to `agent_start`/`agent_settled`, with `mlflow.flushTraces()` **awaited** at `agent_settled` — pi fires `agent_start` once per low-level attempt (auto-retry and overflow-compaction recovery both call `agent.continue()`, which fires another `agent_start` before `agent_settled`); the root span is opened only on the *first* `agent_start` of a trace and left alone on subsequent ones within the same trace, so retries/recoveries stay in one trace instead of starting a disconnected second root; root status follows the final cycle outcome (`ERROR` on terminal error/aborted/force-close, `OK` after successful recovery) (see `test/lifecycle.test.ts`)
- [x] 3.2 Implement turn span open/close bound to `turn_start`/`turn_end`, nested under the root span (`SpanType.CHAIN`)
- [x] 3.3 Implement LLM span creation, reading token usage and cost from `event.message.usage`, setting `mlflow.chat.tokenUsage` and the cost attribute (verify exact key per design D7; fall back to a custom key if needed) — verified `mlflow.llm.cost` against MLflow's "Manually Setting Token and Cost Information" docs; used as-is since it's MLflow-native and accepted as an arbitrary attribute regardless.
      The span opens at `before_provider_request` (using the outgoing payload as `inputs`) and closes at `message_end` (using the assistant response as `outputs`), so its duration covers the actual call instead of being zero-duration and duplicating the same content as both fields; falls back to opening-and-closing at `message_end` if `before_provider_request` never fired.
- [x] 3.4 Implement tool span tracking via `Map<toolCallId, Span>`: create on `tool_execution_start`, close and remove on `tool_execution_end`
- [x] 3.5 Implement force-close of any tool spans still open in the map when their turn's `turn_end` fires
- [x] 3.6 Implement compaction span placement per `session_compact` `reason`: child of current turn (`overflow`), child of root (`manual`/`threshold` between turns), or not traced (no active root span) — pi always fires `overflow` compaction *after* the overflowing turn's `turn_end` has already run (per `_checkCompaction` in pi's `agent-session.js`), so the compaction span is parented to the most recently *ended* turn span (`lastEndedTurnSpan`), not the (already-cleared) `turnSpan` reference.
      When `willRetry: true`, the retried LLM call's new turn span is itself parented under the compaction span (not the root), so the retry remains a descendant of the turn it overflowed rather than a sibling of it — mlflow-tracing spans cannot be reopened to literally continue the ended turn.
      The retried LLM span is tagged `pi.attempt.reason: "post_compaction"` (see `test/lifecycle.test.ts`'s overflow-recovery test, which drives pi's real event order end to end and asserts the full parent chain).
- [x] 3.7 Implement orphan-span sweep at `session_shutdown`: force-close any still-open spans with an incomplete status, then trigger a final flush

## 4. Trace And Span Metadata (trace-metadata)

- [x] 4.1 Implement `updateCurrentTrace({ metadata: {...} })` calls setting `mlflow.trace.session` (pi session id) and git provenance (`mlflow.source.git.commit`, `mlflow.source.git.branch`, repo URL) as metadata, not tags — provenance is resolved off the critical path at first `agent_start` and **awaited before root end/export** so ordinary slow repos (>100 ms) still keep branch/commit; each git command has its own timeout; remote URLs with embedded credentials are stripped before being recorded (see `test/git.test.ts` / `test/lifecycle.test.ts`)
- [x] 4.2 Implement structural metadata capture always-on: attempt/turn indices, compaction stats (tokensBefore, messagesToSummarize), HTTP status metadata (status code only, never response bodies) — turn index, attempt index, and compaction stats (tokensBefore, firstKeptEntryId — pi's `CompactionEntry` does not expose a separate `messagesToSummarize` field) are implemented; **corrected during implementation**: pi's extension API does not expose per-attempt HTTP retry information (see D7 addendum in design.md) — `after_provider_response` fires at most once per provider call, only for the eventually-successful attempt, so only a single final `pi.llm.httpStatusCode` is captured, not a retry count/history; thinking level is attached as `pi.llm.thinkingLevel` from `ctx.thinkingLevel`.
- [x] 4.3 Implement `captureContent` gating: when `false` (default), omit prompt text, tool argument/output bodies, and provider payload bodies from all spans; when `true`, include them
- [x] 4.4 Write tests verifying no content fields are populated when `captureContent` is `false`, across LLM and tool spans

## 5. Status Command (mlflow-status-command)

- [x] 5.1 Implement `/mlflow` command registration via `pi.registerCommand`
- [x] 5.2 Implement status output: tracking URI, resolved experiment name/id, capture-content mode, and current tracing status (active / disabled + reason)
- [x] 5.3 Ensure disabled-state reporting is accurate (does not show stale "last flush" info as if tracing were active) per design D9
- [x] 5.4 Ensure command output never includes captured trace content

## 6. Verification

- [x] 6.1 Manual end-to-end test: run a local `mlflow server` with sqlite backend, install the extension, run a pi session with sequential tool calls, confirm one trace per turn-cycle appears correctly in the MLflow UI with expected span tree — automated against real server in `test/real-server.integration.test.ts` (span tree + session metadata via REST/artifacts; UI not exercised)
- [x] 6.2 Manual test: parallel tool calls (e.g. multiple file reads) finishing out of start order, confirm each tool span closes with its own correct result — see `test/real-server.integration.test.ts`
- [x] 6.3 Manual test: trigger overflow compaction (or simulate via a short context window) mid-turn, confirm compaction span nests under the correct turn and the retried LLM call appears as expected — event-order simulation against real server export in `test/real-server.integration.test.ts`
- [x] 6.4 Manual test: trigger manual `/compact` between turns, confirm compaction span nests under the root span — see `test/real-server.integration.test.ts`
- [x] 6.5 Manual test: stop the MLflow server before starting pi, confirm tracing silently disables with one log line and `/mlflow` reports the disabled reason, with no interactive interruption — covered by unreachable-server setup + `buildStatusLines` in `test/real-server.integration.test.ts` (and unit `test/setup.test.ts`)
- [x] 6.6 Manual test: interrupt a pi session mid-turn (Ctrl+C), confirm the orphan-sweep force-closes open spans and a final flush occurs — `session_shutdown` orphan sweep + real flush/export verified in `test/real-server.integration.test.ts`
- [x] 6.7 Verify `captureContent: false` (default) produces no prompt/tool/payload content in exported traces; verify `captureContent: true` does — real exported artifacts checked in `test/real-server.integration.test.ts`
- [x] 6.8 Verify resolved `experimentId` is not re-fetched from MLflow REST more than once per pi process (e.g. via request logging/mocking in a test) — see `test/setup.test.ts`
