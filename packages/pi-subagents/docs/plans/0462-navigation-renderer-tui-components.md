---
issue: 462
issue_title: "pi-subagents: upgrade /subagent-sessions renderer to Pi per-entry TUI components"
---

# Upgrade `/subagent-sessions` renderer to Pi per-entry TUI components

## Release Recommendation

**Release:** ship independently

Phase 19 Step 4a ([#462]) carries `Release: independent` in the architecture roadmap.
It swaps the renderer behind the existing `TranscriptSource` seam; it is not a member of Phase 19's only batch ("dissolve-agents", Steps 5–6, [#442]/[#441]).
Step 4a gates Step 5 ([#442]) for rendering parity, but a gate is a sequencing dependency, not a release batch — this step ships on its own once it lands.

## Problem Statement

The #445 slice ([#445]) stood up native session navigation — list → pick → read-only scrollable transcript — behind a renderer-agnostic `TranscriptSource` seam, using Pi's `serializeConversation` plain text as the first renderer.
That text dump is lower fidelity than the bespoke `ConversationViewer` it is slated to replace, which renders richer per-message formatting (tool call/result blocks, bash execution, markdown).
ADR-0004 Decision B's full intent is native-fidelity rendering through Pi's **own** interactive components ([ADR-0004] Addendum, Finding 1): `AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`, `BashExecutionComponent`, `CompactionSummaryMessageComponent`, `BranchSummaryMessageComponent`, and the skill-block components.
This follow-up swaps the renderer behind the same seam — selection and sourcing are untouched — so the native navigator reaches rendering parity with the bespoke viewer, which unblocks Step 5's deletion of that viewer without a fidelity regression.

## Goals

- Replace the `serializeConversation` text path with a per-entry Pi TUI component tree, mirroring Pi's own `renderSessionContext` message→component mapping.
- Drive the component tree by **rebuild-on-change**: on each `TranscriptSource` change, clear and reconstruct the cached component `Container` from the current message snapshot (Pi's own `rebuildChatFromMessages` path); each paint reuses the cached tree, so markdown highlighting does not re-run per frame.
- Render tool calls at full fidelity by passing each tool's real `ToolDefinition`, sourced through a new dependency-safe `getToolDefinition` read accessor on the record (mirroring the existing `agentMessages` accessor) and surfaced on the `TranscriptSource` seam.
- Keep the existing lightweight `◍ describeActivity` streaming-indicator line for a running agent's live activity (the high-frequency streaming text it absorbs is why rebuild-on-change stays cheap).
- Confirm rendering parity with the bespoke `ConversationViewer` so Step 5 ([#442]) can delete it with no fidelity regression.

Non-breaking: this is an internal renderer swap behind the seam.
No public export, command name, default, or observable behavior changes.
The internal `renderTranscriptLines` export is removed, but its only consumers are within this package (the overlay and its tests).

## Non-Goals

- Do **not** implement the **file-snapshot** source branch (`parseSessionEntries` → `buildSessionContext`) or broaden the candidate set to evicted agents — that is Step 4b ([#463]), independent and unblocked by this step.
- Do **not** add in-session steering or any interactive gesture — the overlay stays strictly read-only; steering remains in `steer_subagent` and the widget.
- Do **not** touch `agent-menu.ts`, `conversation-viewer.ts`, or `message-formatters.ts` — they stay live until the terminal cut (Step 5, [#442]).
- Do **not** change `listNavigableAgents` selection or the `liveSource` sourcing semantics — only the renderer changes, plus the additive `getToolDefinition` accessor.
- Do **not** render `custom`-role messages through `CustomMessageComponent` — it requires the session's `extensionRunner.getMessageRenderer`, which the navigator does not hold (see Open Questions); custom messages are skipped, matching the bespoke viewer, which never rendered them either.

## Background

Relevant existing modules:

- `src/ui/session-navigation.ts` (pure) — owns selection and sourcing: `listNavigableAgents`, `liveSource`, and the interfaces `NavigableSubagent`, `NavigationEntry`, `StreamingState`, `TranscriptSource`.
  It currently also owns `renderTranscriptLines(source): string[]` (the `serializeConversation` text path) and its `toMessages` adapter — these are text rendering via a pure SDK utility.
- `src/ui/session-navigator.ts` (SDK/TUI consumer) — owns `TranscriptOverlay` (a read-only scrollable `Component`) and `SessionNavigatorHandler`.
  `TranscriptOverlay.buildContentLines` currently calls `renderTranscriptLines(this.source)`, then wraps each line with the injected `wrapText`.
- `src/lifecycle/subagent-session.ts` — `SubagentSession` wraps `_session: AgentSession`.
  It already exposes `get agentMessages(): readonly SessionMessage[]` returning `this._session.messages`.
  The SDK `AgentSession` exposes `getToolDefinition(name: string): ToolDefinition | undefined` (a definition-first registry retained per session).
- `src/lifecycle/subagent.ts` — `Subagent` delegates `get agentMessages()` to `this.subagentSession?.agentMessages ?? []`; this is the exact pattern the new `getToolDefinition` accessor follows.
- `src/ui/display.ts` — `describeActivity(activeTools, responseText)`, `getDisplayName`, `formatDuration`.
- `src/index.ts` — registers the `subagent-sessions` command; the handler already receives `ctx` (which carries `ctx.cwd: string` and `ctx.ui`).

Pi SDK facts verified for this plan (against the bundled `@earendil-works/pi-coding-agent`):

- The per-entry components are all re-exported from the public root barrel: `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `CompactionSummaryMessageComponent`, `BranchSummaryMessageComponent`, `SkillInvocationMessageComponent`, `CustomMessageComponent`.
  `parseSkillBlock`, `getMarkdownTheme`, and the `ToolDefinition` type are also public.
- Component constructors are heterogeneous and stateful (`Container` subclasses):
  - `AssistantMessageComponent(message?, hideThinkingBlock?, markdownTheme?, hiddenThinkingLabel?)`.
  - `UserMessageComponent(text: string, markdownTheme?)`.
  - `ToolExecutionComponent(toolName, toolCallId, args, options, toolDefinition, ui: TUI, cwd: string)`, with `updateResult(result)` called separately to attach the tool result.
  - `BashExecutionComponent(command, ui: TUI, excludeFromContext?)`, with `appendOutput` / `setComplete`.
  - `CompactionSummaryMessageComponent(message, markdownTheme?)` / `BranchSummaryMessageComponent(message, markdownTheme?)`.
- Pi's own message→component mapping is `interactive-mode.ts`'s `renderSessionContext(sessionContext)` (and the `addMessageToChat` helper it calls); `rebuildChatFromMessages()` is `chatContainer.clear()` + `renderSessionContext(buildSessionContext())`.
  This plan mirrors that mapping; the `toolResult` → pending-tool match (`renderedPendingTools.get(toolCallId).updateResult(message)`) is reproduced.
- `Container` (from `@earendil-works/pi-tui`) exposes `addChild`, `clear`, and `render(width): string[]`, which stacks children vertically — so a `Container` of per-entry components renders to the `string[]` the existing scroll overlay already consumes.
- No higher-level "message list" / "transcript" renderer is exported from the SDK — the mapping must be mirrored, not imported.

AGENTS.md / package constraints:

- pi-subagents is a minimal core; the navigator is an in-core reactive consumer with **no inbound call** into the core.
  The new `getToolDefinition` accessor is a read-only getter (like `agentMessages`) — it adds no inbound call and preserves the Phase 18 spine invariants ([#422]–[#425]).
  This is the dependency-safe answer to "wire real tool definitions": arrows still point inward (navigator → record getter → wrapped `AgentSession.getToolDefinition`); `SubagentManager` tracks nothing extra and no dependency is inverted.
- Keep Pi SDK *coupling* out of pure helpers: per-entry components require a `TUI`, `cwd`, and `markdownTheme`, so the component-building renderer lives in the SDK/TUI module `session-navigator.ts`, not in the pure `session-navigation.ts`.
  The `serializeConversation` text renderer leaves the pure module entirely.
- Use narrow interface types (not the concrete `Subagent`) at the seam — unchanged from the slice.

## Design Overview

The `TranscriptSource` seam is the change point.
Its sourcing surface (`getMessages` / `subscribe` / `streaming`) is unchanged except for one additive method (`getToolDefinition`); the **renderer** moves from the pure module into the SDK/TUI module and changes shape from text to a component tree.

### Dependency-safe tool definitions

The SDK `AgentSession` already retains a definition-first tool registry and exposes `getToolDefinition(name)`.
A new read accessor surfaces it through the record, mirroring `agentMessages`:

```typescript
// SubagentSession
getToolDefinition(name: string): ToolDefinition | undefined {
  return this._session.getToolDefinition(name);
}

// Subagent
getToolDefinition(name: string): ToolDefinition | undefined {
  return this.subagentSession?.getToolDefinition(name);
}
```

This is a pure outward read — no inbound call, no `SubagentManager` bookkeeping, no dependency inversion.

### Seam: `TranscriptSource` gains `getToolDefinition`

`TranscriptSource` (and the `NavigableSubagent` record interface it sources from) gain the lookup; `liveSource` delegates to the record:

```typescript
export interface TranscriptSource {
  getMessages(): readonly SessionMessage[];
  subscribe(onChange: () => void): (() => void) | undefined;
  streaming(): StreamingState | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined; // new
}
```

A future file-snapshot source (Step 4b) returns `undefined` here → generic fallback tool rendering, with no renderer change.
Placing the lookup on the seam (not on the renderer's separate params) keeps the seam the single change point across both follow-ups.

### Renderer: per-entry component tree (`session-navigator.ts`)

A new function builds a `Container` of per-entry components from a message snapshot, mirroring `renderSessionContext`:

```typescript
function buildTranscriptComponents(
  messages: readonly SessionMessage[],
  opts: { tui: TUI; cwd: string; markdownTheme: MarkdownTheme; getToolDefinition: (name: string) => ToolDefinition | undefined },
): Container {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  for (const message of messages) {
    switch (message.role) {
      case "assistant": { /* AssistantMessageComponent + per-toolCall ToolExecutionComponent (track pending by id) */ }
      case "toolResult": { /* pendingTools.get(toolCallId)?.updateResult(message) */ }
      case "user": { /* parseSkillBlock → SkillInvocation(+UserMessage) | UserMessageComponent */ }
      case "bashExecution": { /* BashExecutionComponent + appendOutput + setComplete */ }
      case "compactionSummary": { /* CompactionSummaryMessageComponent */ }
      case "branchSummary": { /* BranchSummaryMessageComponent */ }
      // custom: skipped (no message renderer available — see Open Questions)
    }
  }
  return container;
}
```

`ToolExecutionComponent` is constructed with `opts.getToolDefinition(content.name)` for its definition, `opts.tui`, and `opts.cwd`, and `{ showImages: false }` (the read-only viewer does not render images).
Spacers between entries follow Pi's own spacing in `addMessageToChat`.

### Overlay: rebuild-on-change with a cached `Container`

`TranscriptOverlay` caches the component tree and rebuilds it only when the source changes — never per frame:

```typescript
// constructor: build once, then subscribe
this.content = this.rebuild();
this.unsubscribe = source.subscribe(() => {
  if (this.closed) return;
  this.content = this.rebuild();      // rebuild on change only
  this.tui.requestRender();
});

private rebuild(): Container {
  return buildTranscriptComponents(this.source.getMessages(), {
    tui: this.tui, cwd: this.cwd, markdownTheme: this.markdownTheme,
    getToolDefinition: (name) => this.source.getToolDefinition(name),
  });
}

private buildContentLines(innerW: number): string[] {
  const lines = this.content.render(innerW);           // components own their own wrapping
  const streaming = this.source.streaming();
  if (streaming) lines.push("", `◍ ${describeActivity(streaming.activeTools, streaming.responseText)}`);
  return lines.map((l) => truncateToWidth(l, innerW)); // defensive truncate; no re-wrap
}
```

The per-frame `render(width)` chrome (header/footer/scroll math) is unchanged; only the content source changes from `renderTranscriptLines(source)` to the cached `Container`.
Because the components already wrap to width, the overlay no longer re-wraps each line — the injected `wrapText` collaborator is removed from `TranscriptOverlayOptions` and the handler call site.

### Handler / registration

`SessionNavigatorParams` gains `cwd: string`; `index.ts` passes `ctx.cwd`:

```typescript
await sessionNavigator.handle({ ui: ctx.ui, agents: manager.listAgents(), registry, cwd: ctx.cwd });
```

The handler obtains `markdownTheme` via `getMarkdownTheme()` (current theme; Pi has initialized it at startup) and threads `cwd` + `markdownTheme` into the `TranscriptOverlay` it mounts through `ui.custom`.
`manager.listAgents()` is still called in the registration, never inside the navigator — the navigator stays a reactive consumer with no inbound core call.

### Consumer call-site sketch (Tell-Don't-Ask / LoD check)

The renderer talks only to `TranscriptSource`: it reads `source.getMessages()` and `source.getToolDefinition(name)`, never reaching through the record to a stranger.
`liveSource.getToolDefinition` delegates to `record.getToolDefinition` (the record's own getter), which delegates to the wrapped `AgentSession` internally — a one-hop delegation, not a `record.session.x.y` chain.
No output arguments: the renderer constructs and returns a `Container`; nothing writes back into the record or the source.

### Design-review findings

| Smell                          | Location                       | Evidence                                                                                             | Result                                                            |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Dependency width               | `TranscriptSource` (4 methods) | renderer reads `getMessages`/`streaming`/`getToolDefinition`; overlay reads `subscribe`              | Acceptable — cohesive sourcing seam; every method is a real read  |
| LoD violation                  | `liveSource.getToolDefinition` | one-hop delegation `record.getToolDefinition` → `AgentSession.getToolDefinition`                     | None — delegation through the record's own getter, no chain       |
| Output argument                | `buildTranscriptComponents`    | returns a `Container`; `updateResult` mutates the tool component it owns, not a received bag         | None                                                              |
| Concrete-class leak            | seam interfaces                | renderer depends on `TranscriptSource`, not the concrete `Subagent`                                  | None — narrow interface                                           |
| Pi SDK coupling in pure module | `session-navigation.ts`        | component rendering moves out to `session-navigator.ts`; pure module keeps selection + sourcing only | Improved — pure module sheds the `serializeConversation` renderer |

The new collaborator (`buildTranscriptComponents`) gives behavior to data — it maps message data to stateful components and returns a renderable tree — not procedure-splitting.

### Edge cases

- Empty history (`getMessages()` is `[]`) → empty `Container`; the overlay renders an empty viewport (no crash); the existing "no sessions" notify path is unchanged at the selection layer.
- Running agent → component tree for finalized messages plus the appended `◍ describeActivity` indicator; a `subscribeToUpdates` event rebuilds the tree and re-renders.
- A partially-streamed assistant message present in `getMessages()` → rendered by `AssistantMessageComponent`; the indicator also shows activity (parity with the bespoke viewer, which showed both).
- `toolResult` with no matching pending tool (out-of-order / truncated history) → no-op (matches Pi's `renderedPendingTools.get` miss).
- `getToolDefinition` returns `undefined` (definition not registered, or a future file source) → `ToolExecutionComponent` generic fallback rendering.
- Very narrow terminal width → `render` returns `[]` below the minimum width (unchanged chrome guard).

## Module-Level Changes

- **Changed** `src/types.ts` — re-export or reference the SDK `ToolDefinition` type for the seam interfaces (import from `@earendil-works/pi-coding-agent`); confirm a consumer imports it from the barrel if added there (no speculative re-export).
- **Changed** `src/lifecycle/subagent-session.ts` — add `getToolDefinition(name): ToolDefinition | undefined` delegating to `this._session.getToolDefinition(name)`.
- **Changed** `src/lifecycle/subagent.ts` — add `getToolDefinition(name): ToolDefinition | undefined` delegating to `this.subagentSession?.getToolDefinition(name)`.
- **Changed** `src/ui/session-navigation.ts` — add `getToolDefinition` to `NavigableSubagent` and `TranscriptSource`; `liveSource` delegates it.
  **Remove** `renderTranscriptLines`, its `toMessages` adapter, and the `serializeConversation` + `describeActivity` imports (rendering moves to `session-navigator.ts`).
- **Changed** `src/ui/session-navigator.ts` — add `buildTranscriptComponents`; rewrite `TranscriptOverlay` to cache + rebuild the `Container` (drop `wrapText` from `TranscriptOverlayOptions`); add `describeActivity`, `getMarkdownTheme`, `Container`, and the per-entry component imports; add `cwd` (+ `markdownTheme` wiring) to `SessionNavigatorParams`/the overlay.
- **Changed** `src/index.ts` — pass `cwd: ctx.cwd` into `sessionNavigator.handle(...)`.
- **Changed** `test/lifecycle/subagent-session.test.ts`, `test/lifecycle/subagent.test.ts` — add `getToolDefinition` accessor tests.
- **Changed** `test/ui/session-navigation.test.ts` — remove the `renderTranscriptLines` describe block; add `liveSource.getToolDefinition` delegation; add `getToolDefinition` to the `makeNavigable` factory.
- **Changed** `test/ui/session-navigator.test.ts` — assert component-rendered content (text still appears via markdown), add a tool-call render test (stub `getToolDefinition`), add `getToolDefinition` to `fakeSource`/`makeNavigable`, pass `cwd` in handler tests, drop `wrapText`.

Removed-symbol grep: `renderTranscriptLines` is the sole removed export.
Its consumers are `src/ui/session-navigator.ts` (rewritten this issue) and `test/ui/session-navigation.test.ts` (block removed); confirmed no other `src/`/`test/` references and no `.pi/skills/package-pi-subagents/SKILL.md` mention.

Doc / skill updates:

- `docs/architecture/architecture.md` — flip Step 4a's status to landed (mirroring the Step 4 "Landed" note style) and update the Phase 19 Mermaid node label `S4a` from pending to done; record that the native navigator now renders at parity, unblocking Step 5.
  Defer the status-line/Mermaid flip to ship time if preferred (matches the [#447] precedent), but the rescoping note belongs in this issue's doc step.
- `.pi/skills/package-pi-subagents/SKILL.md` — the UI domain count is a coarse summary (no file added or removed here); leave unless the operator asks otherwise.

## Test Impact Analysis

1. **New tests enabled.**
   The `getToolDefinition` accessor gets direct unit tests on `SubagentSession` and `Subagent` (mirroring `agentMessages`).
   The component renderer is exercised through `TranscriptOverlay` against a `fakeSource` — asserting that message text renders (via the components) and that a tool call renders with its definition.
2. **Existing tests that become redundant.**
   The `renderTranscriptLines` describe block in `session-navigation.test.ts` is removed — the function it tests is gone (rendering moved and changed shape).
   No other tests become redundant.
3. **Existing tests that must stay as-is.**
   `listNavigableAgents` and `liveSource` selection/sourcing tests stay (selection and sourcing semantics are unchanged; `liveSource` only gains the `getToolDefinition` delegation).
   All bespoke-viewer and menu tests (`conversation-viewer.test.ts`, `message-formatters.test.ts`, `agent-menu.test.ts`) stay untouched — Step 5 deletes those.

## Invariants at risk

This issue swaps a renderer behind the seam, adds one read accessor, and threads `cwd`; it does not touch the Phase 18 spine.
The relevant `Outcome:` invariants and their pins:

- **[#422] — runtime holds zero UI state.**
  The overlay holds its own cached `Container` + scroll state; nothing is pushed onto the runtime.
  Pinned by the runtime/service-spine tests; unchanged.
- **[#423] — UI is a reactive consumer with no inbound calls from core spawn tools.**
  The navigator reads via the injected `manager.listAgents()` snapshot and record getters only; the new `getToolDefinition` accessor is a read-only getter.
  Pinned by the navigator-reads-only test from the slice (extend it to assert the handler reads `getToolDefinition` only through the source).
- **[#424] — the `subagent` tool depends only on manager/runtime/settings/registry.**
  No tool change.
- **[#425] — declared event channels equal emitted channels, no vacant hook.**
  The navigator subscribes to existing record updates; it declares/emits no new channel.
  Pinned by the events-contract suite; unchanged.

A later phase step (Step 4b file source, Step 5 deletion) must not regress these with a green suite — the navigator-reads-only test pins #423 for the seam.

## TDD Order

1. **Red→Green: `getToolDefinition` read accessor on the record.**
   Test surface: `test/lifecycle/subagent-session.test.ts`, `test/lifecycle/subagent.test.ts`.
   Tests: `SubagentSession.getToolDefinition` delegates to the wrapped session; `Subagent.getToolDefinition` delegates to the session and returns `undefined` when no session.
   Implementation: reference the SDK `ToolDefinition` type (via `src/types.ts` or a direct import); add the two getters.
   Run `pnpm run check` (verifies `AgentSession.getToolDefinition` resolves).
   Commit: `feat: add getToolDefinition accessor on subagent record (#462)`.
2. **Red→Green: surface `getToolDefinition` on the seam (additive).**
   Test surface: `test/ui/session-navigation.test.ts`.
   Tests: `liveSource.getToolDefinition` delegates to `record.getToolDefinition`; add `getToolDefinition` to the `makeNavigable` factory.
   Implementation: add `getToolDefinition` to `NavigableSubagent` and `TranscriptSource`; `liveSource` delegates.
   This step is pure addition — `renderTranscriptLines` still exists and compiles.
   Commit: `feat: expose getToolDefinition on the transcript source seam (#462)`.
3. **Red→Green: component-tree renderer + overlay rewrite + `cwd` wiring.**
   Test surface: `test/ui/session-navigator.test.ts` (+ remove the `renderTranscriptLines` block from `test/ui/session-navigation.test.ts`).
   Tests:
   - `TranscriptOverlay.render` paints component-rendered content for user/assistant messages (text appears); a tool call renders via `ToolExecutionComponent` using a stubbed `getToolDefinition`; the `◍` streaming indicator still appends while running; rebuild-on-change re-renders after a `subscribe` callback; `esc`/`q` calls `done`; `dispose` unsubscribes.
   - `SessionNavigatorHandler.handle`: empty entries → `notify`, no `custom`; cancel → no `custom`; valid pick → `custom` opened with an overlay sourced from the picked record and the passed `cwd`.
   Implementation (one commit — removing `renderTranscriptLines` breaks the overlay and its tests at the type level, so the rewrite, the export removal, the test updates, and the `index.ts` call-site update land together):
   - Add `buildTranscriptComponents` and rewrite `TranscriptOverlay` (cached `Container`, rebuild-on-change, drop `wrapText`) in `session-navigator.ts`.
   - Remove `renderTranscriptLines`/`toMessages`/`serializeConversation`/`describeActivity` from `session-navigation.ts`.
   - Add `cwd` to `SessionNavigatorParams`; update `index.ts` to pass `ctx.cwd`.
   - Remove the `renderTranscriptLines` describe block from `session-navigation.test.ts`.
   Run `pnpm run check` immediately (shared-interface + single-call-site change) and `pnpm fallow dead-code` before pushing (confirms no orphaned helper after the renderer move).
   Commit: `feat: render /subagent-sessions transcript with Pi per-entry components (#462)`.
4. **Docs: record rendering parity and flip Step 4a.**
   Test surface: none (docs).
   Update `docs/architecture/architecture.md` Step 4a status to landed and the `S4a` Mermaid node; note the native navigator now renders at parity, unblocking Step 5.
   Commit: `docs: mark native-navigation renderer upgrade landed (#462)`.

## Risks and Mitigations

- **Risk: Pi's per-entry components depend on interactive-mode globals (e.g. `initTheme`) not initialized in this context.**
  Mitigation: the navigator runs inside a live Pi session where theme is already initialized; `getMarkdownTheme()` returns the active theme.
  The overlay-render tests construct components against a mock `TUI` and assert text appears — a smoke test that the components render outside interactive mode.
  If a component throws without a global, narrow the role set or supply the missing default at the boundary.
- **Risk: rebuilding the component tree re-runs markdown highlighting and is expensive under live streaming.**
  Mitigation: rebuild happens on **source change only** (cached `Container`), not per frame, and the high-frequency streaming text is absorbed by the `◍` indicator (so the tree changes at message granularity).
  Incremental `updateContent`/`updateResult` reconciliation remains a clean follow-up behind the same seam if profiling ever shows cost (track-and-watch).
- **Risk: `ToolExecutionComponent` needs `cwd`/`tui`/options not previously threaded.**
  Mitigation: `cwd` comes from `ctx.cwd` (verified present on the command context), `tui` from the `ui.custom` factory, options default to `{ showImages: false }`.
- **Risk: removing `renderTranscriptLines` and its tests leaves orphaned imports.**
  Mitigation: Step 3 removes the `serializeConversation`/`describeActivity` imports from `session-navigation.ts` in the same commit; `pnpm fallow dead-code` and a re-read of the file confirm no orphans (Biome `noUnusedImports` is warning-level).
- **Risk: parity is asserted only by "text appears", missing richer formatting differences.**
  Mitigation: the goal is *native-fidelity via Pi's own components* — using the same components Pi uses **is** the parity definition; the tests assert the component path is taken (tool call renders via `ToolExecutionComponent`, bash via `BashExecutionComponent`), not byte-equality with the bespoke output.

## Open Questions

- **`custom`-role messages** — `CustomMessageComponent` requires the session's `extensionRunner.getMessageRenderer(customType)`, which the navigator does not hold.
  This issue skips custom messages (the bespoke viewer never rendered them either, so this is not a parity regression).
  If custom-message fidelity is later wanted, a follow-up would surface a message-renderer lookup on the seam — not filed now (speculative).
- **Step 4a doc flip timing** — flip the architecture status line and Mermaid node in this issue's doc step, or defer to a Phase 19 doc-sync ([#447] precedent); the plan does it in-issue (TDD step 4) by default.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#447]: https://github.com/gotgenes/pi-packages/issues/447
[#462]: https://github.com/gotgenes/pi-packages/issues/462
[#463]: https://github.com/gotgenes/pi-packages/issues/463
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425

[ADR-0004]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0004-reconsider-ui-direction.md
