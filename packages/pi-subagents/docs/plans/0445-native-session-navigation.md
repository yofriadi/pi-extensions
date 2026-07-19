---
issue: 445
issue_title: "pi-subagents: implement native session navigation for any subagent (live or completed)"
---

# Native session navigation for subagents (live transcript, text renderer)

## Release Recommendation

**Release:** ship independently

Phase 19 Step 4 ([#445]) carries `Release: independent` (spike-gated) in the architecture roadmap.
The only batch defined in Phase 19 is "dissolve-agents" (Steps 5–6, [#442]/[#441]); Step 4 is an additive replacement surface that stands up alongside the bespoke viewer and is not part of that batch.
It ships on its own.

## Problem Statement

The operator can view a subagent's conversation only through the bespoke `ConversationViewer` overlay, reachable inside the monolithic `/agents` menu.
That overlay re-implements session-transcript rendering — message formatting, a streaming indicator, scroll chrome — even though Pi already persists each child as a standalone session JSONL and ships its own session-rendering machinery.
ADR-0004 Decision B replaces the bespoke overlay with **native session navigation**: a flat command that lists the session's subagents, lets the operator pick one, and renders that child's transcript read-only through Pi's own components.

ADR-0004 Addendum 2 (the Step 1 spike, [#446]) refines the sourcing: a file read is a *snapshot* (good for a completed agent, frozen for a running one), so the transcript is **dual-sourced by liveness** — live from the in-memory record for a tracked agent, a file snapshot for an evicted one — rendered through one renderer.

This issue is deliberately **sliced** (see Decomposition below).
It stands up the complete navigation UX — list → pick → read-only, live transcript — behind a renderer-agnostic source seam, using Pi's `serializeConversation` as the first renderer.
Upgrading that renderer to Pi's per-entry TUI components, and broadening the candidate set to evicted agents, are named follow-ups.

## Goals

- Add a flat `/subagent-sessions` command that lists navigable subagents (`manager.listAgents()`, gated on `isSessionReady()`), lets the operator pick one, and renders its transcript **read-only** (non-interactive) in a scrollable overlay.
- Source the transcript **live** from the in-memory record: history from a new typed `agentMessages` accessor, live re-render via `record.subscribeToUpdates()`, and a running-agent streaming indicator from `record.activeTools` / `record.responseText`.
- Render through Pi's own `serializeConversation` (no bespoke message-formatting code) behind a `TranscriptSource` seam, so a follow-up swaps in Pi's per-entry TUI components without touching selection or sourcing.
- Add a typed `agentMessages` accessor on `SubagentSession` and `Subagent` returning `readonly SessionMessage[]` (the boundary currently widens `messages` to `readonly unknown[]`).
- Stand the new surface up **alongside** the existing `viewAgentConversation` / `ConversationViewer` path — it is removed only by Phase 19 Step 5 ([#442]).

Non-breaking: this is pure addition.
No existing export, command, default, or behavior changes.

## Non-Goals

- Do **not** implement the **file-snapshot** source branch (`parseSessionEntries` → `buildSessionContext`) in this issue.
  With the `listAgents()`-only candidate set, no listed record is ever session-disposed (see Background), so the file branch has **no reachable caller** here — implementing it now would be dead code that fails the `fallow dead-code` gate.
  It ships with the follow-up that broadens the candidate set to evicted agents.
- Do **not** use Pi's per-entry TUI components (`AssistantMessageComponent` / `ToolExecutionComponent` / …) as the renderer in this issue — that is the named renderer follow-up.
- Do **not** add in-session steering or any interactive gesture — steering stays in `steer_subagent` and the widget; the viewer is strictly read-only.
- Do **not** use `switchSession` or `loadEntriesFromFile` (per the ADR-0004 addendum).
- Do **not** touch `agent-menu.ts`, `conversation-viewer.ts`, or `message-formatters.ts` — they stay live until Step 5 ([#442]).
- Do **not** wire a widget selection gesture — the command is the primary surface; a widget gesture ([#444]) is an optional later enhancement.

## Background

Relevant existing modules:

- `src/lifecycle/subagent-session.ts` — `SubagentSession` wraps one SDK `AgentSession`.
  Its `get messages(): readonly unknown[]` returns `this._session.messages as readonly unknown[]` — deliberately widened at the core boundary.
  It already exposes `subscribe(fn)`, `outputFile`, `getContextPercent()`.
- `src/lifecycle/subagent.ts` — `Subagent` delegates `get messages(): readonly unknown[]`, `subscribeToUpdates(fn)`, `get outputFile()`, `isSessionReady()`, `get activeTools()`, `get responseText()`, `get status()` to its `subagentSession` / `state`.
  These are the exact accessors the bespoke `ConversationViewer` reads — the new navigator reads the same surface.
- `src/lifecycle/subagent-manager.ts` — `listAgents()` returns tracked `Subagent[]` (newest first).
  `cleanup()` (every 60 s) and `clearCompleted()` call `removeRecord(id, record)`, which calls `record.disposeSession()` **then** `agents.delete(id)` atomically.
  `disposeSession()` disposes the wrapped session but does **not** null `subagentSession`; however, because dispose-and-delete are atomic, **no record that remains in `listAgents()` is ever session-disposed**.
  Consequence: with the `listAgents()`-only candidate set, every listed, session-ready record has a live (non-disposed) session — so the live source is always valid and the file-snapshot branch is unreachable (drives the Non-Goal above).
- `src/ui/conversation-viewer.ts` — the bespoke overlay being replaced (deleted in Step 5).
  Reads `record.messages`, subscribes via `record.subscribeToUpdates()`, renders a streaming indicator from `record.activeTools` / `record.responseText`, and owns its own scroll chrome (up/down/pageUp/pageDown/home/end/esc).
  The new navigator must **not** import from it or from `message-formatters.ts` (both doomed in Step 5).
- `src/ui/agent-menu.ts` — `viewAgentConversation(ui, record)` gates on `record.isSessionReady()` and opens the overlay via `ui.custom<undefined>((tui, theme, _kb, done) => new ConversationViewer({...}), { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } })`.
  This is the wiring shape the navigator mirrors.
- `src/ui/subagents-settings.ts` ([#447]) — the precedent for an additive, flat, narrow-interface command extracted from the menu.
- `src/ui/display.ts` — `getDisplayName(type, registry)`, `formatDuration(startedAt, completedAt)`, `getPromptModeLabel(type, registry)` for option labels.
- `src/types.ts` — shared type barrel; already imports SDK types (`AgentSessionEvent`, `ThinkingLevel`).
- `src/index.ts` — constructs `manager`, `registry`, and `settings`, and registers commands (`agents`, `subagents-settings`).
  Sibling commands use flat hyphenated names with no `:` namespace.

Pi SDK facts verified for this plan:

- `parseSessionEntries`, `buildSessionContext`, `serializeConversation`, `SessionContext`, `FileEntry`, `SessionEntry`, and the per-entry components are all re-exported from the public `@earendil-works/pi-coding-agent` barrel; `loadEntriesFromFile` is **not** (confirmed in `dist/index.d.ts`).
- `SessionContext.messages` is typed `AgentMessage[]` (`AgentMessage` from `@earendil-works/pi-agent-core`, which is **not** a direct dependency).
  Derive the type from the barrel-exported `SessionContext` rather than adding a dependency: `type SessionMessage = SessionContext["messages"][number]`.
- `serializeConversation(messages: Message[]): string` takes a **mutable** `Message[]` (from `@earendil-works/pi-ai`).
  The accessor returns `readonly SessionMessage[]`, so the renderer must spread (`serializeConversation([...messages])`); the spread also resolves the readonly→mutable mismatch.
  `AgentMessage` assignability to `Message` is verified in TDD step 2 (Pi itself feeds `buildSessionContext` output to serialization, so it is expected to hold); if it does not, narrow via a typed adapter at the renderer boundary.

AGENTS.md / package constraints:

- pi-subagents is a minimal core; surviving UI is an **in-core reactive consumer** with no inbound calls into the core.
  The new `agentMessages` accessor is a read-only getter — it adds no inbound call and preserves the Phase 18 spine invariants ([#422]–[#425]).
- Keep Pi SDK *coupling* out of pure helpers: the pure module uses only Pi's pure utility functions (`serializeConversation`) and an **injected** file/registry, so it stays unit-testable; the overlay component and command handler are SDK/TUI consumers (allowed to import SDK/TUI directly).
- Use narrow interface types (not the concrete `Subagent` class) at the seam — concrete class types leak private fields into test mocks.

## Design Overview

Two new modules split pure logic from SDK/TUI wiring, plus a typed accessor on the record.

### Typed `agentMessages` accessor (boundary narrowing)

`src/types.ts` gains a derived alias (no new dependency):

```typescript
import type { SessionContext } from "@earendil-works/pi-coding-agent";

/** One message in a child session's history, typed from Pi's SessionContext. */
export type SessionMessage = SessionContext["messages"][number];
```

`SubagentSession` and `Subagent` each gain a typed read accessor alongside the existing widened `messages`:

```typescript
// SubagentSession
get agentMessages(): readonly SessionMessage[] {
  return this._session.messages;
}

// Subagent
get agentMessages(): readonly SessionMessage[] {
  return this.subagentSession?.agentMessages ?? [];
}
```

`_session.messages` is already `AgentMessage[]` (= `SessionMessage[]`), so this is a typed view of the same data — no cast through `unknown`.
The widened `messages` getter stays (other readers depend on it); `agentMessages` is the typed accessor the navigator uses.

### `session-navigation.ts` — pure selection, source, and text rendering

A pure module (SDK pure-utility imports only; no TUI, no `ExtensionAPI`).
It declares narrow interfaces for the record fields it reads (ISP — not the concrete `Subagent`).

```typescript
/** The record fields the navigator reads to label and source a transcript. */
export interface NavigableSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly agentMessages: readonly SessionMessage[];
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined;
}

/** A navigable entry: the record plus its display label. */
export interface NavigationEntry {
  readonly record: NavigableSubagent;
  readonly label: string;
}

/** Liveness-agnostic transcript source consumed by the renderer. */
export interface TranscriptSource {
  /** Current message history. */
  getMessages(): readonly SessionMessage[];
  /** Subscribe to live updates; returns an unsubscribe, or undefined for a static snapshot. */
  subscribe(onChange: () => void): (() => void) | undefined;
  /** Running-agent streaming state, or undefined when not streaming. */
  streaming(): { activeTools: ReadonlyMap<string, string>; responseText: string } | undefined;
}
```

Functions:

- `listNavigableAgents(agents, registry): NavigationEntry[]` — keep records with `isSessionReady()`, map each to a label (`getDisplayName` · description · status · `formatDuration`).
- `liveSource(record: NavigableSubagent): TranscriptSource` — `getMessages` → `record.agentMessages`; `subscribe` → `record.subscribeToUpdates`; `streaming` → `{ activeTools, responseText }` when `record.status === "running"`, else `undefined`.
- `renderTranscriptLines(source, opts): string[]` — `serializeConversation([...source.getMessages()])` split on `\n`, then append a minimal streaming indicator (active tool names + a truncated `responseText` preview) when `source.streaming()` is defined; return `[]`-safe content for an empty history (`"(no messages yet)"`).

`renderTranscriptLines` carries **no bespoke message formatting** — the transcript text is Pi's `serializeConversation` output; only the small streaming indicator is local (a few lines), and it does not import the doomed `message-formatters.ts`.

### `session-navigator.ts` — overlay component + command handler

SDK/TUI consumer.

- `TranscriptOverlay` — a read-only scrollable `Component`: on construct, subscribe via `source.subscribe(() => tui.requestRender())`; each `render(width)` calls `renderTranscriptLines(source)` and paints a scrolling viewport with header/footer chrome and key handling (up/down, pageUp/pageDown, home/end, esc/q to close); `dispose()` unsubscribes.
  Scroll math mirrors the bespoke viewer's behavior but the content comes from `renderTranscriptLines` (the bespoke viewer is deleted in Step 5; this is fresh code with its own tests, not a clone of doomed code).
- `SessionNavigatorHandler` — `handle({ ui, agents, registry })`:

```typescript
async handle({ ui, agents, registry }: SessionNavigatorParams): Promise<void> {
  const entries = listNavigableAgents(agents, registry);
  if (entries.length === 0) { ui.notify("No subagent sessions to view.", "info"); return; }
  const choice = await ui.select("Subagent sessions", entries.map(e => e.label));
  const entry = entries.find(e => e.label === choice);
  if (!entry) return;
  const source = liveSource(entry.record);
  await ui.custom<undefined>(
    (tui, theme, _kb, done) => new TranscriptOverlay({ tui, theme, source, done, wrapText: wrapTextWithAnsi }),
    { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } },
  );
}
```

`SessionNavigatorParams` / `SessionNavigatorUI` are narrow interfaces declaring only `select`, `notify`, and `custom` — the methods the handler uses.

### Registration call site (`index.ts`)

```typescript
const sessionNavigator = new SessionNavigatorHandler();
pi.registerCommand("subagent-sessions", {
  description: "View a subagent's session transcript (read-only)",
  handler: async (_args, ctx) => {
    await sessionNavigator.handle({ ui: ctx.ui, agents: manager.listAgents(), registry });
  },
});
```

`manager.listAgents()` is called in the handler registration (the navigator never holds a manager reference — it receives the snapshot), keeping the navigator a pure reactive consumer with no inbound core call.

### Consumer call-site sketch (Tell-Don't-Ask / LoD check)

`liveSource` does not reach through the record to a stranger: it reads the record's own getters (`agentMessages`, `status`, `activeTools`, `responseText`) and delegates subscription to `record.subscribeToUpdates`.
The renderer talks only to `TranscriptSource`, never to the record — so the component renderer follow-up swaps the source's internals (file vs live) and the renderer (text vs components) independently.
No output arguments: nothing writes back into the record or the source.

### Decomposition and follow-ups (Kent Beck: make the change easy, then make the easy change)

This issue is the first releasable vertical slice.
The `TranscriptSource` seam is the "change made easy" — it decouples *how messages are sourced* from *how they are rendered*, so each follow-up is a localized swap:

1. **Renderer upgrade (named follow-up):** replace `renderTranscriptLines`/`TranscriptOverlay`'s `serializeConversation` text path with Pi's per-entry TUI components (`AssistantMessageComponent` / `ToolExecutionComponent` / …) behind the same `TranscriptSource`.
   Selection and sourcing are untouched.
2. **Evicted-agent source (named follow-up):** broaden the candidate set beyond `listAgents()` and add the **file-snapshot** `TranscriptSource` (`parseSessionEntries(readFileSync(outputFile))` → drop `SessionHeader` → `buildSessionContext(...).messages`) for agents no longer tracked.
   This is where the dual-source design lands its second branch; the renderer is untouched.

Recommendation: file these two as Phase 19 follow-up issues at ship time, and update the architecture roadmap's Step 4 description (which currently scopes dual-source + components as one step) to reflect the slice.

### Design-review findings

| Smell               | Location                         | Evidence                                                                                     | Result                                                                             |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Wide interface      | `NavigableSubagent` (11 members) | `listNavigableAgents` reads 7 label fields; `liveSource` reads `agentMessages`/streaming/sub | Acceptable — two consumers split the surface; both are real reads, no unused field |
| LoD violation       | `session-navigation.ts`          | `liveSource` reads record getters + delegates `subscribeToUpdates`; no `record.x.y.z` chains | None                                                                               |
| Output argument     | `session-navigation.ts`          | source/renderer return values; never write back into the record                              | None                                                                               |
| Concrete-class leak | seam interfaces                  | navigator depends on `NavigableSubagent`/`TranscriptSource`, not the concrete `Subagent`     | None — narrow interfaces                                                           |

The new collaborators each own behavior (`liveSource` returns a stateful subscription view; `TranscriptOverlay` owns scroll state and the subscription lifecycle; `renderTranscriptLines` returns rendered lines) — not procedure-splitting.

### Edge cases

- Empty candidate set → `ui.notify("No subagent sessions to view.", "info")`, return.
- Operator cancels `select` (`undefined`) or the label is stale → return, no overlay.
- Empty message history (`agentMessages.length === 0`) → render `"(no messages yet)"`.
- Running agent → streaming indicator appended; a `subscribeToUpdates` event triggers re-render with the latest `agentMessages` + streaming state.
- Completed tracked agent → `streaming()` returns `undefined` (status not `running`); transcript is the final `agentMessages`, no indicator; `subscribe` still attaches harmlessly.
- `subscribeToUpdates` returns `undefined` (no live session) → cannot happen for a `listAgents()`-gated, session-ready record, but the overlay tolerates `undefined` (no subscription, static render).
- Very narrow terminal width → overlay returns `[]` below a minimum width, matching the bespoke viewer.

## Module-Level Changes

- **New** `src/ui/session-navigation.ts` — `NavigableSubagent`, `NavigationEntry`, `TranscriptSource` interfaces; `listNavigableAgents`, `liveSource`, `renderTranscriptLines` functions.
- **New** `src/ui/session-navigator.ts` — `TranscriptOverlay` component, `SessionNavigatorHandler` class, `SessionNavigatorParams` / `SessionNavigatorUI` narrow interfaces.
- **Changed** `src/types.ts` — add `export type SessionMessage = SessionContext["messages"][number]` and the `SessionContext` type import.
- **Changed** `src/lifecycle/subagent-session.ts` — add `get agentMessages(): readonly SessionMessage[]`.
- **Changed** `src/lifecycle/subagent.ts` — add `get agentMessages(): readonly SessionMessage[]`.
- **Changed** `src/index.ts` — import `SessionNavigatorHandler`, construct it, register the `subagent-sessions` command (sole call site of the new export).
- **New** `test/ui/session-navigation.test.ts` — unit tests for `listNavigableAgents`, `liveSource`, `renderTranscriptLines`.
- **New** `test/ui/session-navigator.test.ts` — unit tests for `TranscriptOverlay` render/scroll/key handling and `SessionNavigatorHandler` select→custom wiring.
- **Changed** `test/lifecycle/subagent-session.test.ts`, `test/lifecycle/subagent.test.ts` — add `agentMessages` accessor tests.

No removed or renamed exports — grep for removed symbols is not applicable (pure addition).

Doc / skill grep results:

- `docs/architecture/architecture.md` Step 4 currently describes the **full** dual-source + components scope and names `src/ui/session-navigator.ts` and the typed accessor.
  This issue narrows that scope (live-source + text renderer).
  Update the Step 4 description to reflect the slice and the two named follow-ups — defer the status-line flip and the rescoping edit to ship time (matches the [#447] precedent), or fold a short rescoping note in this issue if preferred.
- `.pi/skills/package-pi-subagents/SKILL.md` lists the UI domain by count (`ui/` = 10 modules); this adds two files (→ 12).
  The table is a coarse summary not maintained per-file — leave for a later Phase 19 doc-sync unless the operator asks otherwise.
- No `src/`/`test/` references to a removed symbol (nothing is removed); the bespoke `ConversationViewer` and `message-formatters.ts` are untouched and keep their tests.

## Test Impact Analysis

1. **New tests enabled.**
   `listNavigableAgents`, `liveSource`, and `renderTranscriptLines` are pure and unit-testable against narrow `NavigableSubagent` / `TranscriptSource` stubs — no full `Subagent`, `TUI`, or `AgentSession` construction.
   This is strictly more focused than `conversation-viewer.test.ts`, which builds a full record + TUI to exercise transcript rendering.
   The `agentMessages` accessor gets direct unit tests on both `SubagentSession` and `Subagent`.
2. **Existing tests that become redundant.**
   None in this issue.
   `conversation-viewer.test.ts` and `message-formatters.test.ts` still exercise the live, still-shipping bespoke overlay; they are removed only when Step 5 ([#442]) deletes those modules.
3. **Existing tests that must stay as-is.**
   All bespoke-viewer and menu tests stay unchanged — this issue does not touch `agent-menu.ts`, `conversation-viewer.ts`, or `message-formatters.ts`.

## Invariants at risk

This issue adds two modules, one accessor, and one command registration; it does not touch the Phase 18 spine that prior steps refactored.
The relevant `Outcome:` invariants and their pins:

- **[#422] — runtime holds zero UI state.**
  The navigator holds its own overlay/scroll state; nothing is pushed onto the runtime.
  Pinned by `runtime.test.ts` / the service spine tests; unchanged.
- **[#423] — widget/UI is a reactive consumer with no inbound calls from core spawn tools.**
  The navigator reads via the injected `manager.listAgents()` snapshot and record getters only; the new `agentMessages` accessor is a read-only getter.
  No inbound call into the core.
  A focused navigator test asserts the handler reads only through its injected `agents` + record getters.
- **[#424] — the `subagent` tool depends only on manager/runtime/settings/registry.**
  No tool change.
- **[#425] — declared event channels equal emitted channels, no vacant hook.**
  The navigator subscribes to existing record updates; it declares/emits no new channel.
  Pinned by the events-contract suite (`test/service`, `test/observation`); unchanged.

A later phase step (the renderer / evicted-source follow-ups) must not regress these with a green suite — the navigator-reads-only test pins #423 for the seam.

## TDD Order

1. **Red→Green: typed `agentMessages` accessor.**
   Test surface: `test/lifecycle/subagent-session.test.ts`, `test/lifecycle/subagent.test.ts`.
   Tests: `SubagentSession.agentMessages` returns the wrapped session's typed messages; `Subagent.agentMessages` delegates to the session and returns `[]` when no session.
   Implementation: add `SessionMessage` to `src/types.ts` (with the `SessionContext` import); add the two getters.
   Run `pnpm run check` (verifies `SessionContext["messages"][number]` resolves and `_session.messages` is assignable).
   Commit: `feat: add typed agentMessages accessor on subagent record (#445)`.
2. **Red→Green: pure selection, live source, and text rendering.**
   Test surface: `test/ui/session-navigation.test.ts`.
   Tests:
   - `listNavigableAgents` keeps only `isSessionReady()` records and builds the expected labels (name · description · status · duration); empty input → `[]`.
   - `liveSource.getMessages` returns the record's `agentMessages`; `subscribe` delegates to `subscribeToUpdates`; `streaming()` returns state only when `status === "running"`, else `undefined`.
   - `renderTranscriptLines` returns `serializeConversation` output split into lines; appends the streaming indicator when streaming; returns the empty-history placeholder for `[]`.
   Implementation: create `src/ui/session-navigation.ts` with the three interfaces and three functions.
   Verify `AgentMessage`→`Message` assignability for `serializeConversation([...messages])` here; if it fails, add a typed adapter at the boundary.
   Commit: `feat: add subagent session selection and live transcript source (#445)`.
3. **Red→Green: read-only overlay component + `/subagent-sessions` command.**
   Test surface: `test/ui/session-navigator.test.ts`.
   Tests:
   - `TranscriptOverlay.render(width)` paints the current `renderTranscriptLines` content with chrome; scroll keys move the viewport; `esc`/`q` calls `done`; `dispose()` unsubscribes; a `subscribe` callback triggers `tui.requestRender`.
   - `SessionNavigatorHandler.handle`: empty entries → `notify` + no `custom`; cancel at `select` → no `custom`; a valid pick → `custom` opened with a `liveSource` for the chosen record (assert via a `makeMenuUI`-style stub).
   Implementation: create `src/ui/session-navigator.ts`; register the command in `src/index.ts` (sole call site).
   Run `pnpm run check` immediately (the registration is the only consumer of the new handler export — both must compile together).
   Run `pnpm fallow dead-code` before pushing (confirms no unreachable file-source branch slipped in).
   Commit: `feat: add /subagent-sessions read-only navigation command (#445)`.

Steps 2 and 3 may be folded if preferred, but keeping the pure logic (with its stub-only tests) separate from the TUI/SDK wiring keeps each commit self-contained.

## Risks and Mitigations

- **Risk: `AgentMessage` is not assignable to `serializeConversation`'s `Message[]`.**
  Mitigation: verify in TDD step 2 (`pnpm run check`); Pi feeds `buildSessionContext` output to serialization, so it is expected to hold.
  If not, add a typed adapter (`toMessages(messages): Message[]`) at the renderer boundary — the seam isolates the fix to `renderTranscriptLines`.
- **Risk: implementing the file-snapshot branch creates dead code (no caller under `listAgents()`-only) and fails `fallow dead-code`.**
  Mitigation: this issue ships the **live source only** behind the seam; the file source is a named follow-up.
  `pnpm fallow dead-code` runs before push.
- **Risk: importing the doomed `message-formatters.ts` / `conversation-viewer.ts` couples the navigator to code Step 5 deletes.**
  Mitigation: the navigator imports neither; the streaming indicator is a small local helper and the transcript text is Pi's `serializeConversation`.
- **Risk: the new overlay duplicates the bespoke viewer's scroll chrome (apparent duplication).**
  Mitigation: the bespoke viewer is deleted in Step 5, so there is no lasting duplication; the new overlay is fresh code with its own tests and a different content source (`renderTranscriptLines` vs bespoke `formatMessage`).
- **Risk: command-name choice.**
  Mitigation: `subagent-sessions` follows the flat-hyphenated sibling convention (`agents`, `subagents-settings`); confirm at ship time (see Open Questions).
- **Risk: the architecture roadmap's Step 4 description diverges from the sliced scope.**
  Mitigation: update the Step 4 description and file the two follow-ups at ship time.

## Open Questions

- **Command name** — `subagent-sessions` is proposed (flat, hyphenated, sibling-consistent).
  Alternatives: `subagent-transcript`, `view-subagent`, `subagents-view`.
  Confirm at ship time; the command is not yet shipped, so it is cheaply renamable.
- **Whether to rescope the architecture roadmap's Step 4 entry in this issue or defer** to a Phase 19 doc-sync — decide at ship time (matches the [#447] precedent).
- **Whether to file the two named follow-ups (renderer upgrade, evicted-agent source) now or after this slice lands** — recommended at ship time so the roadmap stays accurate.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#444]: https://github.com/gotgenes/pi-packages/issues/444
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#446]: https://github.com/gotgenes/pi-packages/issues/446
[#447]: https://github.com/gotgenes/pi-packages/issues/447
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
