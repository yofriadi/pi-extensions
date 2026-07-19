---
issue: 446
issue_title: "pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria"
---

# Spike: resolve ADR-0004 session-navigation entry criteria

## Release Recommendation

**Release:** ship independently

Phase 19 Step 1 ([#446]) carries `Release: independent` in the architecture roadmap, and the roadmap's "Release batches" subsection lists it among the independently releasable steps (the only batch is "dissolve-agents" = Steps 5, 6).
The deliverable is an ADR addendum that unblocks Step 4 ([#445]); it ships on its own with no batch coupling.

## Problem Statement

ADR-0004 (Phase 18) decided the UI *direction* — replace the bespoke `ConversationViewer` overlay with Pi's own session machinery applied to each child's already-persisted session JSONL — but deliberately left the *mechanism* open behind four "Phase 19 entry criteria."
Each criterion changes the shape of the Step 4 session-navigation code, so all four must be answered before that work can begin.
This is a spike: produce a minimal, throwaway investigation that answers each criterion against the real SDK surface, then record the answers as an addendum to `docs/decisions/0004-reconsider-ui-direction.md`.
No production source files change; the spike closes when the ADR addendum is merged.

## Goals

- Answer all four ADR-0004 entry criteria with evidence from the bundled `@earendil-works/pi-coding-agent` SDK surface and a real child session JSONL:
  1. Root-continuity during a session switch (and the correct "return to root" gesture).
  2. View-only vs interactive (switch-takeover vs `loadEntriesFromFile` read-only transcript).
  3. Parallel-agent navigation gesture (widget, command, or both).
  4. Settings command name (`/subagents-settings` vs `/agents-settings` vs a `:`-namespaced form).
- Record the answers as a dated addendum to ADR-0004 so Step 4 ([#445]) can commit to a mechanism.
- Validate the read-only transcript path empirically: a throwaway vitest harness exercises `loadEntriesFromFile` against a real child session file and confirms entries render without a session switch.

## Non-Goals

- No production source changes — `session-navigator.ts`, the widget background-only filter, the settings command, and the `/agents` dissolution are all later Phase 19 steps ([#445], [#444], [#447], [#442], [#441]).
- Do not implement the chosen mechanism; the spike only chooses it.
- Do not commit the vitest spike harness — it is throwaway evidence, discarded after observation (operator decision: ADR addendum only).
- Do not modify `0004-reconsider-ui-direction.md`'s existing Status/Decision/Consequences body beyond appending the addendum.

## Background

Relevant SDK surface, verified against the bundled `@earendil-works/pi-coding-agent` types in `packages/pi-subagents/node_modules/.../dist`:

- `ExtensionCommandContext.switchSession(sessionPath, { withSession })` — a **full active-session takeover** (`core/extensions/types.d.ts:276`).
  It returns `{ cancelled }` and hands the replacement session to an optional `withSession(ctx: ReplacedSessionContext)` callback.
- `ReplacedSessionContext extends ExtensionCommandContext` (`types.d.ts:289`) — exposes `sendUserMessage` and `sendMessage`, so a switched-to child session is **interactive**, not read-only.
- `session_before_switch` (cancellable; `reason: "new" | "resume"`) and `session_shutdown` (`reason: "quit" | "reload" | "new" | "resume" | "fork"`, with `targetSessionFile`) events (`types.d.ts:414`, `:440`) fire around a switch — the current runtime is torn down when the active session is replaced.
- `setBeforeSessionInvalidate` lives on the **host** runtime (`core/agent-session-runtime.*`, `modes/interactive/interactive-mode.*`), not on the extension command context — it is a host-owned UI-teardown seam, not something this extension calls.
- `loadEntriesFromFile(filePath): FileEntry[]` and `parseSessionEntries(content): FileEntry[]` (`core/session-manager.d.ts:151`, `:141`, both re-exported from the package root `index.d.ts`) — read a session file's entries **without** switching.
- `Subagent.outputFile: string | undefined` (`src/lifecycle/subagent.ts:120`, delegating to `subagentSession?.outputFile`) — already exposes each child's persisted session JSONL path; no new SDK dependency is needed.
- Sibling command registration uses **flat, hyphenated** names with no `:` namespace: `registerCommand("agents", …)` (this package), `registerCommand("colgrep-reindex", …)`, `registerCommand("permission-system", …)`.

AGENTS.md constraint: pi-subagents is a minimal core; the surviving UI is an in-core reactive consumer (ADR-0004 Decision D).
The spike chooses the navigation mechanism but adds no policy and no new core dependency.

## Design Overview

The spike is an investigation, not a feature.
Each criterion is answered from the SDK surface above; the one path with genuine runtime uncertainty (read-only transcript rendering) is confirmed with a throwaway vitest harness against a real child session JSONL.

### Criterion 1 — Root-continuity during a session switch

`switchSession` replaces the active session: it fires `session_before_switch` (cancellable) then tears the current runtime down via `session_shutdown` (the `targetSessionFile` field marks a replacement-driven shutdown).
The root's in-flight turn does **not** survive a takeover — the runtime that owns that turn is invalidated.
The "return to root" gesture under a true round-trip would be a second `switchSession(rootSessionFile)`, re-incurring the same teardown/replay cost on the way back.

Expected finding: a true `switchSession` round-trip is hostile to a root that may have a turn in flight (background agents run precisely while the operator keeps working at root).
This pushes the recommendation toward the read-only `loadEntriesFromFile` path, which never touches the active session and so has no return gesture to get wrong.

### Criterion 2 — View-only vs interactive

`ReplacedSessionContext` exposes `sendUserMessage`/`sendMessage`, so switching makes the child interactive — the operator could steer a child from inside its own session.
ADR-0004 frames operator visibility (concern 3) as "switch in, scroll/read, switch between, exit back to root" — a **navigation** interaction, not a live steering overlay.
Steering already has a home (`steer_subagent` tool / the widget), so conflating read-navigation with in-session steering adds a second, redundant steering surface.

Expected finding: the viewer should be **read-only**, favoring `loadEntriesFromFile` to render the child's persisted entries without leaving the root session.
This also resolves Criterion 1 by construction (no switch, no root-continuity problem).

### Criterion 3 — Parallel-agent navigation

With N background agents running, the operator needs a gesture to pick which child to view.
The background widget (ADR-0004 Decision A, [#444]) already represents N parallel agents as a per-agent tree, making it the natural **selection** surface.
A flat command (Criterion 4 naming) gives a non-widget entry point that lists running background agents and lets the operator pick one keyed on `record.outputFile`.

Expected finding: provide a **command** as the primary, testable selection surface (lists background agents → operator picks → render that child's transcript read-only), with a widget gesture as an optional later enhancement.
The command is unit-testable and does not depend on the widget landing first; "both" is the eventual target, command-first is the spike's recommended Step 4 starting point.

### Criterion 4 — Settings command name

Sibling packages register flat, hyphenated command names with no `:` namespace (`agents`, `colgrep-reindex`, `permission-system`).
A `/subagents:settings` form would be inconsistent with every existing command in the repo.

Expected finding: confirm **`/subagents-settings`** (flat, hyphenated) — already the name used in the architecture roadmap's Step 2 ([#447]).
Reject the ADR's tentative `/subagents:settings` and the `/agents-settings` alternative (the latter implies it manages agent definitions, which Decision C removes).

### Throwaway vitest harness (discarded, not committed)

A single throwaway spec confirms the read-only path end to end:

```typescript
// throwaway — discarded after observation, never committed
import { loadEntriesFromFile } from "@earendil-works/pi-coding-agent";

// against a REAL child session JSONL produced by a background subagent run
const entries = loadEntriesFromFile(childOutputFile);
// assert: returns FileEntry[] with the expected message/turn entries,
// renderable as a transcript, with no switchSession / no active-session mutation.
```

The harness sources `childOutputFile` from a real run (or an existing session fixture under the Pi session dir), not a synthetic stub, so the observation reflects the actual on-disk JSONL shape the Step 4 viewer will consume.
It asserts the entries are well-formed and that the read path requires no session switch — confirming `loadEntriesFromFile(Subagent.outputFile)` is a viable read-only transcript source.

## Module-Level Changes

- `packages/pi-subagents/docs/decisions/0004-reconsider-ui-direction.md` — **append** an addendum section (e.g. `## Addendum (2026-06-..): Phase 19 entry-criteria answers`) recording the four answers with their SDK evidence and the resulting Step 4 mechanism decision (read-only `loadEntriesFromFile` transcript, command-first selection, `/subagents-settings` name).
  Do not rewrite the existing "Phase 19 entry criteria" section — leave it as the question of record and let the addendum answer it.
- `packages/pi-subagents/docs/architecture/architecture.md` — optional doc-sync only: the Step 1 entry already states its `Outcome`; if marking the spike resolved here is desired, update only that step's status line.
  Keep out of scope unless the operator wants it folded in at ship time.

No `src/` or committed `test/` files change.
The vitest spike harness is throwaway and is **not** added to the committed tree (operator decision: ADR addendum only).

## Test Impact Analysis

Not applicable in the usual sense — this spike commits no production code and no retained tests.
The throwaway vitest harness exists only to observe `loadEntriesFromFile` behavior against a real child session JSONL and is discarded; it enables no new committed test surface and makes no existing test redundant.
Step 4 ([#445]) will introduce the committed tests for the chosen mechanism.

## Invariants at risk

None.
The spike changes no runtime code, so the Phase 18 spine invariants ADR-0004 lists (runtime holds zero UI state [#422]; widget is a reactive consumer with no inbound core calls [#423]; the `subagent` tool depends only on manager/runtime/settings/registry [#424]; declared event channels equal emitted channels [#425]) are untouched and stay pinned by their existing suites.
The addendum must not recommend a Step 4 mechanism that would later violate them — the read-only `loadEntriesFromFile` path is chosen partly because it keeps transcript rendering out of core and adds no inbound call to the core from the UI.

## Build Order

This is a docs/spike deliverable (next stage: `/build-plan`), so the order is investigate → confirm → write → discard, not red→green→commit.

1. **Investigate the SDK surface and confirm the read path.**
   Re-verify the `switchSession`/`ReplacedSessionContext`/event semantics and `loadEntriesFromFile` signatures in the bundled SDK types, then run the throwaway vitest harness against a real child session JSONL to confirm read-only transcript rendering is viable.
   No commit (throwaway harness is discarded).
2. **Write the ADR-0004 addendum.**
   Append the dated addendum answering all four criteria with their SDK evidence and the resulting Step 4 mechanism decision.
   Verify: addendum present, four criteria each answered with a recommendation, markdown lints clean (`pnpm --filter @gotgenes/pi-subagents run lint` or repo `pnpm run lint`).
   Commit: `docs: resolve ADR-0004 session-navigation entry criteria (#446)`.
3. **Optional doc-sync.**
   If folding in the architecture status update, amend only Step 1's status line in `architecture.md` in the same or a follow-up `docs:` commit; otherwise leave it for ship time.

## Risks and Mitigations

- **Risk: root-continuity cannot be fully proven without a live multi-session run, and the chosen method is an automated harness only.**
  Mitigation: the answer is derivable from the documented event semantics (a switch tears down the active runtime via `session_shutdown`), which is exactly why the recommendation avoids `switchSession` for navigation; the harness confirms the read-only alternative works, sidestepping the unproven path.
- **Risk: the addendum recommends a mechanism that Step 4 cannot honor (e.g. a TUI rendering limitation in `loadEntriesFromFile`).**
  Mitigation: the throwaway harness exercises the real entries shape before the recommendation is written; Step 4 retains the freedom to revisit if a rendering gap surfaces, since the ADR records direction, not an irreversible commitment.
- **Risk: scope creep into implementing the chosen surface.**
  Mitigation: Non-Goals explicitly defer all production changes to [#445]/[#444]/[#447]/[#442]/[#441]; the only committed file is the ADR addendum.

## Open Questions

- Whether to also land the `architecture.md` Step 1 status update in this issue or defer it — decide at ship time (Build Order step 3).
- The widget gesture for parallel-agent navigation (Criterion 3 "both") is left to Step 4 — the spike recommends command-first and notes the widget gesture as an optional follow-up.

[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#444]: https://github.com/gotgenes/pi-packages/issues/444
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#446]: https://github.com/gotgenes/pi-packages/issues/446
[#447]: https://github.com/gotgenes/pi-packages/issues/447
