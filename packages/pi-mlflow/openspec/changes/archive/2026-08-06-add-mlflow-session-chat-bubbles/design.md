## Context

pi-mlflow already exports one MLflow trace per pi turn-cycle (root `AGENT` span from `agent_start`…`agent_settled`, children for turns/LLM/tools).
Session grouping via `mlflow.trace.session` works.
The Traces drawer looks correct.

MLflow Chat Sessions is empty because the **server UI under test (MLflow 3.14.0)** renders **only the root span** as a chat turn.
Evidence from that server’s shipped web bundle (`main.2ce8870a.js` on `https://mlflow.localhost`) and upstream `SingleChatTurnMessages` sources:

1. Prefer `root.chatMessages` / `mlflow.chat.messages`
2. Else `extractSimpleChatMessages(root.inputs, root.outputs)` — including **string/string** pairs
3. Else raw key/value panels from root I/O
4. Else blank

That contract is **not pinned as a package dependency** in this repo (`mlflow-tracing` is `0.1.3`; the Tracking Server UI is whatever the operator runs).
Implementation MUST treat 3.14.0 manual bubble confirmation as a gate, not an assumption that unit tests alone prove.

Today the root is opened bare and never receives inputs/outputs, even when `captureContent: true` puts full payloads on child LLM/tool spans.
Child content cannot fix Sessions on 3.14 (no child BFS in that UI build).

Original design D1 cited MLflow’s bounded request/response model as the reason for per-cycle traces, but never tasked root request/response population.
D6 gates “prompt text” behind `captureContent`.
This change fills that gap without reopening the completed tracing-extension change.

## Goals / Non-Goals

**Goals:**

- When `captureContent: true`, populate each cycle’s root span with chat-shaped turn summary so MLflow Chat Sessions shows user + assistant **bubbles** on the verified server UI.
- Call `setInputs` / `setOutputs` with **JavaScript strings** (Door 2 intent) so chat extractors that see deserialized string I/O can succeed.
- Derive request from `before_agent_start.prompt` (post skill/template expansion).
- Derive response from the last non-empty assistant text in the cycle (text content parts only), else error/abort text via structural field access + stopReason fallback.
- Publish summary on `agent_settled` and on `session_shutdown` if the root is still open, at a pinned point in the existing close sequence.
- Keep summary gated by existing `captureContent` (default false → root stays bare; Sessions empty by policy).
- Document that Chat Sessions conversation view requires `captureContent: true`.

**Non-Goals:**

- Changing the one-trace-per-turn-cycle boundary (D1).
- Making Sessions work with `captureContent: false` (no always-on preview carve-out in v1).
- Showing mid-run steers/follow-ups as separate Sessions turns or multi-bubble transcripts (3.14 still shows last user + last assistant only; steers remain in the Traces tree).
- Preferring pre-expansion raw slash-command text via `input` (optional later).
- Fixing token-total rollup overcount / git metadata gaps (separate concerns).
- Depending on newer MLflow UI child-span BFS for chat extraction as the primary path.
- Adding a second config flag to split “session summary” from full child capture.
- Importing `@earendil-works/pi-ai` for `contentText` (use a local text-part extractor).

## Decisions

### D1: Root string/string API values, JSON-serialized on the wire

**Call site:** when capture is on, `root.setInputs(userPromptString)` and `root.setOutputs(assistantTextString)` with plain JS `string` values (not `{ prompt: … }` objects).

**SDK storage (verified in `mlflow-tracing@0.1.3`):** `SpanAttributesRegistry.set` runs every attribute through `safeJsonStringify` before OTel storage.
A logical string `hello` is stored as the JSON text `"hello"` (including quotes).
`LiveSpan` getters `JSON.parse` that text back, so in-process `.inputs` / `.outputs` are JS strings again.
Existing lifecycle tests assert on **deserialized** span `.inputs` via `trace.toMlflowTrace()` / span accessors — new tests MUST do the same, not assert on raw OTel attribute bytes.

**Export / UI:** Tracking Server artifacts and Chat Sessions ultimately consume whatever the exporter and UI rehydrate.
Implementers MUST verify with a real export (repo already has `test/real-server.integration.test.ts` patterns and/or manual 3.14.0 Sessions) that root inputs/outputs appear as **strings** (or otherwise render bubbles), not as opaque quoted JSON blobs that break `extractSimpleChatMessages`.

**Previews:** `toMlflowTrace` may build `request_preview` / `response_preview` via `getPreviewString` on **raw** attribute values (already JSON text, max length 1000).
Previews might therefore include JSON quoting artifacts; acceptable for v1 list chrome.
Do not set previews when capture is off.
Do not rely on previews alone for Sessions turn body.

**`mlflow.chat.messages` belt:**

- Implement string `setInputs` / `setOutputs` first.
- Run **Task 5.1** (manual Chat Sessions on MLflow **3.14.0** or the operator’s recorded server version) as the bubble gate.
- If string I/O does **not** produce user/assistant bubbles, **promote** setting root attribute `mlflow.chat.messages` to `[{ role: "user", content }, { role: "assistant", content }]` from optional to **required** before calling the change done.
- If strings already bubble, the belt remains optional polish (may still add for defense in depth).

**Alternatives considered:** Root object panels only (weaker UX); only `updateCurrentTrace` previews (list chrome improves, turn body stays empty); put chat only on LLM children (3.14 never reads them).

### D2: Request = `before_agent_start.prompt`

Register `before_agent_start` and stash `event.prompt` into cycle state when `captureContent` is true.

- **Why:** Always fires on the idle prompt path that starts a turn-cycle; text is post skill/template expansion (what the agent actually ran as the user message). `BeforeAgentStartEventResult` cannot rewrite `prompt`, so the stash is stable.
- **Not used in v1:** `input` event (pre-expansion) — only emitted if some extension registers `input`; would need an observe-only handler.
  Skill walls may be long (~5k+ chars); accepted under capture-on.

**Alternatives considered:** Raw `input.text` for shorter bubbles (better human label, extra hook); first user `message_end` (same expanded text as before_agent_start on the main path).

### D3: Response = last non-empty assistant text, then error via structural access

On assistant `message_end`, if capture is on:

- Extract text from `message.content` (join `type === "text"` parts only; skip thinking/toolCall) via a **local** helper.
- If non-empty after trim, set `lastAssistantText` (overwrite; last prose wins).
- If `stopReason` is `error` or `aborted`, set `lastAssistantError` as follows:
  1. Read `errorMessage` only via **structural narrowing** on the message object (e.g. `"errorMessage" in message && typeof (message as { errorMessage?: unknown }).errorMessage === "string"`), mirroring how `lifecycle.ts` already types `after_provider_response` structurally without relying on a fully installed `pi-agent-core` graph for every field.
  2. If that string is present and non-empty after trim, use it.
  3. **Otherwise the fallback to `stopReason` is normative** (`"error"` / `"aborted"`), not optional — do not require `errorMessage` to exist on the typed `AgentMessage` surface in this package.

At publish: `outputs = lastAssistantText ?? lastAssistantError ?? ""`.

- **Why:** Coding agents often end on toolUse or empty error LLM; the last prose the user saw may be earlier in the cycle.
  Rolling `message_end` covers retries within one root (re-entrant `agent_start` must not clear pending prompt/text).
- **Typing:** `pi-coding-agent` is a devDependency; runtime message shapes come from the host pi process.
  Do not add `@earendil-works/pi-ai` as a runtime dependency solely for `contentText` or `errorMessage` types.
- **Abort gap:** If the cycle aborts such that no further `message_end` fires, `forceCloseDanglingLlmSpan` may run first and `lastAssistantText` may only reflect earlier completed assistants — accepted; still publish whatever was recorded.

**Alternatives considered:** Only final `message_end` (often empty); only `agent_end.messages` scan (agent_end can fire multiple times before settled; optional safety net later).

### D4: Publish placement, single clear owner, one capture gate

**`publishRootTurnSummary(state)`** (write-only helper):

- If `!state.config.captureContent` or `!state.rootSpan`, return.
- `rootSpan.setInputs(pendingUserPrompt ?? "")`
- `rootSpan.setOutputs(lastAssistantText ?? lastAssistantError ?? "")`
- **Does not clear** pending fields (avoids double-clear / split ownership).

**Clear ownership (single owner):** pending chat-summary fields are cleared **only** in the existing settle/shutdown **cycle reset blocks** that already clear `gitCommit`, `lastHttpStatus`, etc., **after** the root has been ended (or force-closed) and summary publish has run.
Same pattern as other per-cycle fields.
Do **not** clear inside `publishRootTurnSummary`.
Do **not** clear on re-entrant `agent_start`.

**`onAgentSettled` order (pinned to current `lifecycle.ts`):**

1. Await `pendingGitProvenance` (existing)
2. `forceCloseToolSpans` / `forceCloseDanglingLlmSpan` / incomplete turn close (existing) — may set `finalCycleStatus` ERROR
3. **`publishRootTurnSummary(state)`** — after child force-closes, **before** ending root
4. `endSpan(rootSpan, { status: finalCycleStatus })` (existing)
5. Cycle reset block: clear git fields, attempt fields, **`pendingUserPrompt` / `lastAssistantText` / `lastAssistantError`**, reset `finalCycleStatus`
6. `flushTracesBestEffort` (existing)

**`onSessionShutdown` order:** same idea — force-close children as today → **`publishRootTurnSummary`** if root still open → force-close/end root → clear pending chat fields in the shutdown reset path → flush.

- **Why:** Settled is the true end of automatic continuation; shutdown is the abort path that already force-closes roots without I/O today.
  Publishing after child force-close keeps status logic intact and still mutates root attributes while the root LiveSpan is open (required: ending root pops+exports the trace in the SDK).
- **Gate:** Same `captureContent` as child bodies (D6).
  Root summary is a content channel, not structural metadata.
- **Test note:** `InMemoryTraceManager` drops the trace when the root ends; existing tests snapshot **before** `agent_settled`.
  New tests should spy `setInputs`/`setOutputs` on the live root and/or read deserialized inputs/outputs **after publish would have run but** the practical pattern is: spy before firing settled, or split a test-only observation — do not expect `snapshotTraceSpans` after settled without changing that helper’s contract.

**Alternatives considered:** Always-on short previews (privacy carve-out; rejected for v1); separate `captureSessionSummary` flag (more config surface); clear inside publish (rejected — split ownership).

### D5: Steer / follow-up stay inside one Sessions turn

Initial `before_agent_start` prompt is the user bubble for the whole idle→idle cycle.
Mid-run steers/followUps do not open a new trace (D1) and do not update the root user string in v1.
Full mid-run user messages remain visible under the Traces tree.

- **Why:** 3.14 turn card still displays only last user + last assistant even with multi-message chat arrays; true multi-bubble transcript in one card is not available on the UI under test.
  Concatenating steers is optional later polish.

### D6: State fields

Extend tracing state with cycle-scoped:

- `pendingUserPrompt?: string`
- `lastAssistantText?: string`
- `lastAssistantError?: string`

Set prompt on `before_agent_start` (capture on).
Update assistant fields on assistant `message_end` (capture on).
Do **not** clear on re-entrant `agent_start`.
Clear only in settle/shutdown cycle reset after root end (D4).

### D7: UI verification baseline

| Item                 | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| Server UI under test | **MLflow 3.14.0** (observed on operator `mlflow.localhost` during exploration)         |
| Primary contract     | Root-only Sessions turn rendering; string/string → `extractSimpleChatMessages` bubbles |
| Automated proof      | Deserialized root `.inputs` / `.outputs` strings (or absence of keys) in unit tests    |
| Product proof        | Task 5.1 manual Chat Sessions bubbles on that (or documented) server version           |
| Fallback             | Require `mlflow.chat.messages` if 5.1 fails with strings only                          |

If the operator’s server differs, record version + outcome in the PR / task notes; do not claim “Sessions fixed” from unit tests alone.

## Risks / Trade-offs

- **[Sessions empty when captureContent false]** → Document as intentional (D6).
  Not a regression vs today; only capture-on paths gain bubbles.
- **[Expanded skill text as “user” bubble]** → Accurate to model input; may look like a wall of instructions.
  Accept for v1; raw `input` later if needed.
- **[Steer/follow-up not in bubble]** → Aggregation limitation of one-trace-per-cycle + 3.14 display.
  Mitigate via docs + Traces tree.
- **[Empty assistant on tool-only success]** → outputs `""`; Inputs still fill.
  Optional synthetic line deferred.
- **[JSON attribute serialization vs UI parsers]** → Mitigated by D1 verification + 5.1 gate + chat.messages promotion path.
- **[UI version drift]** → Mitigated by D7 recording 3.14.0 baseline; newer UIs may BFS children but root summary remains correct.
- **[Abort without final message_end]** → Summary may lack last partial stream; still publish stashed prompt + earlier text/error.
- **[Large root strings when capture on]** → Dominated by existing child payload cost; previews auto-truncate ~1000 chars of serialized form.
- **[Shutdown race]** → Publish while root open, before force-close end; same safely-wrapped handlers as existing lifecycle.

## Migration Plan

- No config schema change; existing `captureContent` controls new behavior.
- Users who already set `captureContent: true` get Sessions bubbles after upgrade **once Task 5.1 passes** (and belt added if required).
- Default installs unchanged (structure-only traces, hollow Sessions).
- README, `pi-mlflow.example.json`, and `/mlflow` status/help: note Sessions requires content capture.
- Rollback: revert lifecycle/state changes; traces remain valid without root I/O.

## Open Questions

- Whether tool-only success should use a fixed synthetic assistant string instead of `""` (still deferred; empty string is specified).
- Whether a later change should expose raw `input` text as an attribute or preferred bubble when much shorter than expanded prompt.
- Whether preview quoting from raw JSON attributes is worth a follow-up `updateCurrentTrace({ requestPreview, responsePreview })` with unquoted slices (out of scope unless 5.1 shows list chrome is misleading).
