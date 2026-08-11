## 1. State and text helpers

- [x] 1.1 Extend `TracingState` with `pendingUserPrompt`, `lastAssistantText`, and `lastAssistantError` (optional strings).
      Clear them only in settle/shutdown cycle reset blocks after the root ends (same ownership as `gitCommit` / `lastHttpStatus`) — never on re-entrant `agent_start`, never inside the publish helper
- [x] 1.2 Add a local `extractAssistantText(content)` helper that joins `type === "text"` parts (and plain strings), skipping thinking/toolCall — no new pi-ai dependency
- [x] 1.3 Add `publishRootTurnSummary(state)` that, when `captureContent` and `rootSpan` are set, calls `setInputs(pendingUserPrompt ?? "")` and `setOutputs(lastAssistantText ?? lastAssistantError ?? "")` and does **not** clear pending fields

## 2. Lifecycle hooks

- [x] 2.1 Register `before_agent_start`: if enabled and `captureContent`, stash `event.prompt` into `pendingUserPrompt` (do not open/end root here)
- [x] 2.2 In assistant `message_end` handling (alongside existing LLM span close): if `captureContent`, update `lastAssistantText` from `extractAssistantText`; on `error`/`aborted`, set `lastAssistantError` from structurally narrowed `errorMessage` if a non-empty string, else normative `stopReason`
- [x] 2.3 Ensure re-entrant `agent_start` (root already open) does not clear pending chat-summary fields
- [x] 2.4 In `onAgentSettled`, call `publishRootTurnSummary` **after** `forceCloseToolSpans` / `forceCloseDanglingLlmSpan` / incomplete turn close and **immediately before** `endSpan(rootSpan)`; then clear pending chat fields in the existing post-root-end reset block; then flush
- [x] 2.5 In `onSessionShutdown`, after child force-closes and while root is still open, call `publishRootTurnSummary` when capture allows; then force-close/end root; clear pending chat fields in the shutdown reset path

## 3. Docs

- [x] 3.1 Document in README that MLflow Chat Sessions bubbles / turn Inputs–Outputs require `captureContent: true` (default remains false; empty Sessions body is expected)
- [x] 3.2 Document the same requirement in `pi-mlflow.example.json` (comments or documented key notes — file exists in repo root)
- [x] 3.3 Update `/mlflow` status output and/or command help in `src/status-command.ts` so content capture is described as controlling Sessions conversation text as well as child bodies

## 4. Tests

- [x] 4.1 Unit test: `extractAssistantText` covers text parts, skips toolCall/thinking, handles string content
- [x] 4.2 With `captureContent: true`, fire `before_agent_start` + assistant `message_end` + path that invokes publish; assert deserialized root inputs/outputs are the expected **strings** (spy `setInputs`/`setOutputs` and/or read span accessors before root end — `snapshotTraceSpans` must run before settled ends the root, per existing helper contract)
- [x] 4.3 With `captureContent: false`, assert exported/deserialized root has **no** summary `inputs`/`outputs` (undefined/absent keys), matching existing capture-off child-span assertions
- [x] 4.4 Later empty/tool-only assistant does not wipe earlier `lastAssistantText`; error path without text uses structural `errorMessage` or else `stopReason`
- [x] 4.5 Re-entrant `agent_start` keeps stashed prompt; shutdown path publishes when root still open and capture on; pending fields cleared after cycle end so the next cycle does not leak prior prompt/text

## 5. Manual verification (product gate)

- [x] 5.1 On MLflow **3.14.0** (or record the actual server version), with `captureContent: true`, run a short pi prompt and **assert** Chat Sessions shows user/assistant **bubbles** for the new trace (not only non-empty raw panels).
      Record server version + pass/fail in the PR or task notes
- [x] 5.2 If 5.1 fails with string I/O only, implement root `mlflow.chat.messages` belt (required promotion per design D1/D7 and spec) and re-run 5.1 until bubbles appear or document a blocking UI limitation
- [x] 5.3 Confirm Traces drawer span tree still looks correct and capture-off behavior is unchanged
- [x] 5.4 Optionally inspect one exported artifact / real-server fetch to confirm root inputs/outputs rehydrate as strings (or chat.messages present) consistent with unit assertions

### Verification notes (5.x)

| Item                            | Result                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server UI                       | **MLflow 3.14.0** (`https://mlflow.localhost/version`)                                                                                                                                                                                                                                  |
| 5.1 Chat Sessions bubbles       | **PASS** — session `session-chat-bubble-verify` on experiment `pi-chat-bubbles-*` shows **User** `hello from bubble verify` and **Assistant** `hi there bubble` as chat bubbles (not raw panels only). Trace id `tr-0a2301a0819fde6c74739bf65f172118`.                                  |
| 5.2 `mlflow.chat.messages` belt | **Not required** — string root I/O already produced bubbles on 3.14.0.                                                                                                                                                                                                                  |
| 5.3 Traces / capture-off        | Unit suite green (89 tests); capture-off asserts root `inputs`/`outputs` absent; existing span-tree tests unchanged.                                                                                                                                                                    |
| 5.4 Artifact rehydrate          | Exported `traces.json` root attributes `mlflow.spanInputs` / `mlflow.spanOutputs` are plain strings (`hello from bubble verify` / `hi there bubble`), not opaque quoted blobs. List chrome `request_preview`/`response_preview` still show JSON-quoted form (acceptable per design D1). |
