---
issue: 463
issue_title: "pi-subagents: add file-snapshot source to /subagent-sessions for evicted agents"
---

# File-snapshot source for evicted agents in `/subagent-sessions`

## Release Recommendation

**Release:** ship independently

Architecture roadmap Phase 19 Step 4b ([#463]) carries `Release: independent`.
This is a new capability the bespoke viewer never had — it gates nothing and is not a Step 5 prerequisite — so it ships on its own once landed.

## Problem Statement

The [#445] native-session-navigation slice sources transcripts live, from `manager.listAgents()` only.
The manager's cleanup sweep (`SubagentManager.cleanup()`, every 60 s) disposes a completed/stopped/errored record 10 minutes after it finishes — `disposeSession()` frees the heavy in-memory session (its message history included) and the record is deleted from the map.
The lightweight session JSONL persists on disk at `Subagent.outputFile`, but with no live record the agent is unreachable from `/subagent-sessions`.

This step makes a fully-evicted agent navigable: it adds the file-snapshot `TranscriptSource` branch the #445 seam was designed for, and broadens the picker's candidate set to include evicted agents.

## Goals

- Implement `fileSnapshotSource(outputFile, readFile)` in `src/ui/session-navigation.ts`: `parseSessionEntries(readFile(outputFile))` → drop the `SessionHeader` → `buildSessionContext(...).messages` → a static (no-subscribe, no-streaming) `TranscriptSource`.
- Broaden the `/subagent-sessions` candidate set to include evicted agents, deduped against live records.
- Render an evicted agent's transcript read-only from its persisted file when picked; the renderer (`buildTranscriptComponents`) and overlay (`TranscriptOverlay`) are untouched.
- Inject `readFile` as a parameter so the pure module performs no `fs` calls.

This change is **not** breaking: it is additive (a new source branch and a broadened candidate set); no existing behavior, output shape, or default changes for a tracked agent.

## Non-Goals

- No directory scan of the tasks directory and no surfacing of prior-process orphan session files (see Design Overview → Candidate-set decision).
- No change to the cleanup sweep's 10-minute eviction policy or to `disposeSession()`.
- No renderer or overlay changes — `session-navigator.ts`'s `buildTranscriptComponents` / `TranscriptOverlay` / `addMessageComponents` are unchanged (Step 4a, [#462], already brought them to parity).
- No `switchSession` / `loadEntriesFromFile` (rejected by the Step 1 spike, [#446]).
- No live re-read or file-watching of the snapshot — a file source is a static snapshot by design.

## Background

Relevant modules:

- `src/ui/session-navigation.ts` — the pure, unit-testable core: `NavigableSubagent` (narrow record view), `NavigationEntry`, `TranscriptSource`, `listNavigableAgents(agents, registry)`, `liveSource(record)`, `buildLabel(record, registry)`.
  It imports SDK *types* only (`ToolDefinition`) and the lifecycle type `SubagentStatus`.
- `src/ui/session-navigator.ts` — the SDK/TUI consumer half: `SessionNavigatorHandler` (picker + source selection) and `TranscriptOverlay` (read-only scrollable renderer).
  The handler already calls `liveSource(entry.record)`; the source is the only seam that varies.
- `src/lifecycle/subagent-manager.ts` — `listAgents()` (sorted live records), `cleanup()` (the 10-minute sweep), `clearCompleted()` (new-session wipe, called from `handlers/lifecycle.ts` on `session_start` / `session_before_switch`), `removeRecord()` (`disposeSession()` + `agents.delete`).
- `src/lifecycle/subagent.ts` — `Subagent` exposes `id`, `type`, `description` (readonly), and getters `status`, `startedAt`, `completedAt`, `toolUses`, `outputFile`.
- `src/index.ts` — registers `subagent-sessions`, calling `sessionNavigator.handle({ ui, agents: manager.listAgents(), registry, cwd })`.

SDK functions (`@earendil-works/pi-coding-agent`): `parseSessionEntries(content): FileEntry[]`, `buildSessionContext(entries: SessionEntry[]): { messages: AgentMessage[]; … }`, and the types `SessionEntry` / `SessionHeader`.
`FileEntry = SessionHeader | SessionEntry`; only the header has `type: "session"`, so `entries.filter((e): e is SessionEntry => e.type !== "session")` is a sound type guard.
`SessionMessage` (the navigator's message type) is `SessionContext["messages"][number]` = `AgentMessage`, so `buildSessionContext(...).messages` matches `TranscriptSource.getMessages()` with no cast.

Constraints from AGENTS.md / skills that apply:

- `code-design` SDK-boundary guideline: pure helpers should avoid SDK *runtime* imports.
  `fileSnapshotSource` calls the SDK runtime functions `parseSessionEntries` / `buildSessionContext` directly (see Design Overview → SDK-runtime decision); there is no `no-restricted-imports` lint rule, and the module already depends on SDK types.
- `testing`: components used by `session-navigator.ts` need `initTheme(undefined, false)` in `beforeAll` (already present in `session-navigator.test.ts`).
- `fallow dead-code`: a new export with no caller fails the gate.
  Producers (`fileSnapshotSource`, `listEvicted`) gain their caller in the integration step within the same push; the pushed tip is dead-code-clean (see Risks).

## Design Overview

### Candidate-set decision — manager-retained descriptors (not a directory scan)

The issue proposes enumerating persisted JSONL files in the tasks directory.
The persisted child session carries **no** subagent `type` or `description` — those live only on the in-memory `Subagent` record; the file holds only the conversation plus a header (`id`, `timestamp`, `cwd`, `parentSession`).
A directory scan therefore yields degraded labels (agent type → generic placeholder; curated `description` → a raw first-prompt snippet or filename) and must parse every file on every picker open.

Decision (confirmed with the operator): the manager retains a lightweight **descriptor** at eviction time instead.
When `cleanup()` disposes a record that has a persisted file, it first copies the record's label fields plus `outputFile` into a separate `evicted` map (no messages — the heavy state is still freed, so memory stays bounded by the number of subagents spawned, not their transcripts).
The picker's candidate set is `live ∪ evicted`, deduped by id, with identical rich labels for both.

Coverage: this surfaces agents evicted **in the current root session** — which are the cleanup sweep's only targets.
A fresh `SubagentManager` is created per session and `clearCompleted()` runs on `session_start`, so prior-process subagents are never reloaded into the manager; the only files a directory scan would *additionally* surface are old-session orphans, which are exactly the ones with degraded labels.
Picking an evicted agent still reads its file to render (the messages are gone from memory regardless) — so `fileSnapshotSource` is required either way; the descriptor only feeds the *label*.

### SDK-runtime decision — call `parseSessionEntries` / `buildSessionContext` directly

`fileSnapshotSource` imports and calls these SDK runtime functions directly rather than injecting them.
Rationale: they are deterministic parsers of Pi's own session format; the injected `readFile` already provides the unit-test seam (a fake `readFile` returning fixture JSONL fully exercises parse → drop-header → build → messages), so injecting the parsers adds wiring without testability gain.
There is no `no-restricted-imports` rule, and `session-navigation.ts` already imports SDK types.

### Data shapes

`EvictedSubagent` — the descriptor, owned by lifecycle (the manager constructs it), imported as a type by the UI (the UI already imports `SubagentStatus` from lifecycle):

```typescript
// src/lifecycle/subagent-manager.ts
export interface EvictedSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly outputFile: string;
}
```

`NavigationEntry` changes from `{ record, label }` to a discriminated union so the handler can pick the source by kind:

```typescript
// src/ui/session-navigation.ts
export type NavigationEntry =
  | { readonly kind: "live"; readonly label: string; readonly record: NavigableSubagent }
  | { readonly kind: "evicted"; readonly label: string; readonly outputFile: string };
```

`buildLabel` is narrowed to a per-call interface (ISP) that both a `NavigableSubagent` and an `EvictedSubagent` satisfy, and gains an `evicted` marker:

```typescript
interface LabelFields {
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
}

function buildLabel(fields: LabelFields, registry: AgentConfigLookup, evicted = false): string {
  const name = getDisplayName(fields.type, registry);
  const duration = formatDuration(fields.startedAt, fields.completedAt);
  const marker = evicted ? " · evicted (snapshot)" : "";
  return `${name} (${fields.description}) · ${fields.toolUses} tools · ${fields.status} · ${duration}${marker}`;
}
```

### `fileSnapshotSource`

```typescript
export function fileSnapshotSource(
  outputFile: string,
  readFile: (path: string) => string,
): TranscriptSource {
  const entries = parseSessionEntries(readFile(outputFile));
  const sessionEntries = entries.filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
  const { messages } = buildSessionContext(sessionEntries);
  return {
    getMessages: () => messages,
    subscribe: () => undefined, // static snapshot — no live updates
    streaming: () => undefined, // never streaming
    getToolDefinition: () => undefined, // no live tool registry off disk
  };
}
```

### `listNavigableAgents` (broadened) and the handler call site

```typescript
export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  evicted: readonly EvictedSubagent[],
  registry: AgentConfigLookup,
): NavigationEntry[] {
  const live = agents
    .filter((record) => record.isSessionReady())
    .map((record): NavigationEntry => ({ kind: "live", record, label: buildLabel(record, registry) }));
  const liveIds = new Set(agents.map((record) => record.id));
  const evictedEntries = evicted
    .filter((d) => !liveIds.has(d.id))
    .map((d): NavigationEntry => ({ kind: "evicted", outputFile: d.outputFile, label: buildLabel(d, registry, true) }));
  return [...live, ...evictedEntries];
}
```

Dedup is keyed by `id` (both shapes carry it) rather than `outputFile`: a record leaves `listAgents()` at the same instant its descriptor is captured, so the sets cannot overlap; the filter is defensive.
Order is live-then-evicted, which is already recency-ordered (evicted agents completed > 10 min ago).

Handler consumer sketch (Tell-Don't-Ask: the entry tells the handler its kind; the handler asks the right source constructor — no reach-through into the record's internals):

```typescript
const entry = entries.find((candidate) => candidate.label === choice);
if (!entry) return;
let source: TranscriptSource;
try {
  source = entry.kind === "live" ? liveSource(entry.record) : fileSnapshotSource(entry.outputFile, readFile);
} catch {
  ui.notify("Could not read the session transcript file.", "error");
  return;
}
// …unchanged: getMarkdownTheme(), ui.custom(new TranscriptOverlay({ source, … }))
```

### Manager retention sketch

```typescript
private readonly evicted = new Map<string, EvictedSubagent>();

private cleanup() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, record] of this.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if ((record.completedAt ?? 0) >= cutoff) continue;
    if (record.outputFile) this.evicted.set(id, toEvictedSubagent(record));
    this.removeRecord(id, record);
  }
}

listEvicted(): EvictedSubagent[] {
  return [...this.evicted.values()].sort((a, b) => b.startedAt - a.startedAt);
}
```

`clearCompleted()` and `dispose()` also `this.evicted.clear()` — descriptors belong to the session that evicted them, so a new session starts empty.
`toEvictedSubagent(record)` copies the eight fields; it is a private helper (or a free function in the module) and reads `record.outputFile` only after the `if (record.outputFile)` guard, so the `outputFile` field is always a defined `string`.

### Edge cases

- **`outputFile` undefined at eviction** (headless / never-persisted session) → no descriptor captured; nothing to navigate.
- **File deleted/unreadable after eviction** → `fileSnapshotSource`'s eager read throws; the handler's `try/catch` notifies and returns without opening the overlay.
- **Empty or header-only JSONL** → `buildSessionContext` returns `messages: []`; the overlay renders an empty transcript (no crash).
- **No navigable sessions at all** (no live, no evicted) → existing `ui.notify("No subagent sessions to view.", "info")` path, unchanged.

## Module-Level Changes

- `src/lifecycle/subagent-manager.ts` — add the `EvictedSubagent` interface (exported), the `evicted` map field, descriptor capture in `cleanup()`, `evicted.clear()` in `clearCompleted()` and `dispose()`, the `listEvicted()` method, and the `toEvictedSubagent` helper.
  Import `SubagentType` (already in `#src/types`) and `SubagentStatus` (`#src/lifecycle/subagent-state`) for the interface.
- `src/ui/session-navigation.ts` — add `fileSnapshotSource`; import `EvictedSubagent` (type), and the SDK runtime `parseSessionEntries` / `buildSessionContext` plus the `SessionEntry` type; change `NavigationEntry` to the discriminated union; broaden `listNavigableAgents` to `(agents, evicted, registry)`; narrow `buildLabel` to `LabelFields` + `evicted` flag.
- `src/ui/session-navigator.ts` — `SessionNavigatorParams` gains `evicted: readonly EvictedSubagent[]` and `readFile: (path: string) => string`; the handler selects the source by `entry.kind` inside a `try/catch`.
  No change to `TranscriptOverlay`, `buildTranscriptComponents`, `addMessageComponents`, or `addUserComponents`.
- `src/index.ts` — add `import { readFileSync } from "node:fs"`; the `subagent-sessions` handler passes `evicted: manager.listEvicted()` and `readFile: (path) => readFileSync(path, "utf8")`.
- `docs/architecture/architecture.md` — mark Step 4b ([#463]) **Landed** with a note recording the descriptor-vs-scan decision and that ADR-0004 Addendum 2's dual-source design is now realized; flip the `S4b` node label in the step-dependency Mermaid diagram to ✅.
- `docs/decisions/0004-reconsider-ui-direction.md` — optional one-line note under Addendum 2 that Step 4b chose manager-retained descriptors over a directory scan (the addendum's "evicted/untracked" wording said file snapshot for *rendering*, which still holds; only the *candidate-set* mechanism is being pinned down).

No SKILL update: the package SKILL's UI section references no session-navigation internals and the file/domain counts are unchanged (no new module — `fileSnapshotSource` joins the existing `session-navigation.ts`).
The architecture LOC/complexity tables are explicit end-of-phase snapshots, not per-file inventories, so a ~30-LOC addition does not update them.

## Test Impact Analysis

1. **New unit tests enabled by this change:**
   - `fileSnapshotSource` (pure, in `session-navigation.test.ts`): fixture JSONL via a fake `readFile` → assert `getMessages()` equals the parsed messages, the `SessionHeader` is dropped, and `subscribe()` / `streaming()` / `getToolDefinition()` return `undefined`.
   - `listNavigableAgents` with evicted descriptors: evicted entries appear with the `· evicted (snapshot)` marker; an evicted descriptor whose id matches a live record is deduped out.
   - `SubagentManager.listEvicted()` (in `subagent-manager.test.ts`): after advancing fake timers past the cutoff, a completed agent with an `outputFile` produces a descriptor; one without an `outputFile` does not; `clearCompleted()` empties the set.
   - `SessionNavigatorHandler` evicted path (in `session-navigator.test.ts`): picking an evicted label opens an overlay sourced from `readFile`; a throwing `readFile` notifies and skips the overlay.
2. **Tests that become redundant:** none — the live-source tests still exercise the tracked-agent branch.
3. **Tests that must stay as-is:** the existing `liveSource`, `listNavigableAgents` (live-only), `TranscriptOverlay`, and live-source handler tests — they pin the tracked-agent behavior this change must not regress.

## Invariants at risk

Step 4 (#445) and Step 4a (#462) established invariants on the navigation surface; this step must preserve them:

- **Handler is a reactive consumer with no inbound call into the core** (Invariant #423/#445).
  Pinned by the existing `session-navigator.test.ts` assertion `expect(record.getToolDefinition).not.toHaveBeenCalled()` in the live-source handler test.
  The evicted path reads only `entry.outputFile` (a string) + the injected `readFile`; it makes no inbound call into a record.
- **Read-only, non-interactive overlay** (#445/#446).
  The file source returns `subscribe: () => undefined` and `streaming: () => undefined`; the overlay's existing read-only behavior is unchanged.
  Pinned by the existing overlay tests.
- **Renderer parity via Pi per-entry components** (#462).
  The renderer is untouched; both sources still yield `SessionMessage[]` into the same `buildTranscriptComponents`.
  Pinned by the existing `TranscriptOverlay` render tests.

No new test is needed for these — existing tests already pin them; the integration step keeps them green.

## TDD Order

1. **`fileSnapshotSource` (pure, additive).**
   Surface: `test/ui/session-navigation.test.ts`.
   Red: a `describe("fileSnapshotSource")` with a fake `readFile` returning fixture JSONL (a `session` header line + a couple of `message` entries) — assert messages parsed, header dropped, and the three static-source methods return `undefined`.
   Green: implement `fileSnapshotSource` and the SDK runtime imports.
   Commit: `test(pi-subagents): cover file-snapshot transcript source` then `feat(pi-subagents): add file-snapshot transcript source` (or a single `feat` commit with test + impl).
2. **Manager evicted-descriptor retention (additive).**
   Surface: `test/lifecycle/subagent-manager.test.ts`.
   Red: with fake timers, advance past the 10-minute cutoff and assert `listEvicted()` returns a descriptor for a completed agent with an `outputFile`, none for one without, and an empty set after `clearCompleted()`.
   Green: add `EvictedSubagent`, the `evicted` map, capture in `cleanup()`, `clear()` in `clearCompleted()`/`dispose()`, `listEvicted()`, and `toEvictedSubagent`.
   Run `pnpm run check` after this commit (new exported interface).
   Commit: `feat(pi-subagents): retain evicted-agent descriptors in the manager`.
3. **Integrate: broaden the candidate set and dual-source the handler (breaking the `NavigationEntry` shape).**
   This step changes `NavigationEntry` and `listNavigableAgents`'s signature, so the handler, `index.ts` call site, and both UI test files break and are updated together.
   Surfaces: `src/ui/session-navigation.ts`, `src/ui/session-navigator.ts`, `src/index.ts`, `test/ui/session-navigation.test.ts`, `test/ui/session-navigator.test.ts`.
   Red: update `listNavigableAgents` tests to the union shape and add the evicted-entry (marker + dedup) cases; add the handler evicted-path tests (file source + throwing-`readFile` notify).
   Green: change `NavigationEntry` to the union, broaden `listNavigableAgents`, narrow `buildLabel`, add `evicted` + `readFile` to `SessionNavigatorParams`, switch the handler source by kind inside `try/catch`, and wire `manager.listEvicted()` + `readFileSync` in `index.ts`.
   Run `pnpm run check` (shared interface change with a single non-test call site).
   Commit: `feat(pi-subagents): source evicted-agent transcripts from disk in /subagent-sessions`.
4. **Docs.**
   Update `docs/architecture/architecture.md` Step 4b to Landed (descriptor decision + dual-source realized) and the `S4b` diagram node to ✅; add the optional Addendum 2 note in `docs/decisions/0004-reconsider-ui-direction.md`.
   Commit: `docs(pi-subagents): mark Phase 19 Step 4b landed (#463)`.

## Risks and Mitigations

- **Transient dead code between steps 1–2 and 3.**
  `fileSnapshotSource` and `listEvicted()` have no caller until step 3.
  CI / pre-completion `fallow dead-code` runs on the pushed tip, which is clean once step 3 lands; all steps ship in one push.
  Mitigation: do not run `/ship-issue` before step 3 is committed.
- **`buildSessionContext` / `parseSessionEntries` behavior on malformed JSONL.**
  Mitigation: the handler `try/catch` covers a throwing read/parse; a TDD fixture exercises a valid header-plus-messages file, and an empty-messages case confirms a graceful empty render.
- **Memory: the `evicted` map grows over a long session.**
  Each descriptor is eight scalar fields (no messages), bounded by subagents spawned; the heavy session objects are still disposed.
  `clearCompleted()` resets it per session.
- **Divergence from the issue's "enumerate persisted JSONL files" wording.**
  Documented and operator-confirmed (descriptors over scan, for rich labels and bounded IO); the architecture/ADR notes record the rationale so the file-scan option is not silently lost.

## Open Questions

None — the candidate-set strategy and the evicted-entry marker were resolved with the operator during planning.

[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#446]: https://github.com/gotgenes/pi-packages/issues/446
[#462]: https://github.com/gotgenes/pi-packages/issues/462
[#463]: https://github.com/gotgenes/pi-packages/issues/463
