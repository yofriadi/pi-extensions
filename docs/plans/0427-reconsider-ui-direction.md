---
issue: 427
issue_title: "pi-subagents: reconsider the UI direction from first principles (ADR)"
---

# Reconsider the UI direction from first principles (ADR)

## Release Recommendation

**Release:** ship independently

Phase 18 carries no `Release:` batch annotation in the architecture roadmap, so this issue ships on its own.
It is a decision-only ADR plus an architecture-doc update — docs-only, no runtime change — and it completes the Phase 18 roadmap, gateway-ing the (separately planned) Phase 19 implementation.

## Problem Statement

Phase 18's spine (Steps 1–7) disentangled the activity tier from the core, leaving the inherited UI a pure reactive consumer of the broadcast-plus-query surface.
The UI is now _substitutable_.
This final step (Step 8, [#427]) decides the UI's _direction and distribution_, not whether substitution is possible — and records the decision in an ADR that gateways Phase 19.

The decision is **per component** (widget, conversation viewer, `/agents` menu) and per the architecture's own first principles: keep, shrink, extract to a separate package, or remove — judged on our terms, not preserved by default.
Two standing concerns are the evidence:

- **Foreground widget redundancy** — in foreground the tool's inline `onUpdate` stream already shows progress, so the above-editor widget duplicates it; the widget earns its keep only for background agents.
- **Truncated transcript** — the bespoke conversation viewer renders a custom, capped transcript, yet each child is already persisted as a standard Pi session JSONL (`outputFile`); the limit is the bespoke overlay, not data access.

## Goals

- Write `docs/decisions/0004-reconsider-ui-direction.md` recording a per-component decision for the widget, the conversation viewer, and the `/agents` menu.
- Record the **distribution** decision: the surviving UI stays in-core as a reactive consumer (substitutable, not extracted to a separate package now).
- Record the open feasibility questions for the native-session-navigation direction as Phase 19 spike gates (not pretend-resolved).
- Update `docs/architecture/architecture.md`: mark Phase 18 Step 8 complete, mark Phase 18 complete, and add a forward pointer to ADR-0004 / Phase 19.
- This is a **decision-only** ADR — no `src/` or `test/` changes; the implementation lands in the separately-planned Phase 19.

## Non-Goals

- No UI code changes (no widget edit, no viewer removal, no menu decomposition, no new `/subagents:settings` command).
  Those are Phase 19 implementation, planned and shipped separately.
- No new `@gotgenes/pi-subagents-ui` package — extraction is explicitly _not_ chosen now.
- No resolution of the `switchSession` mechanics (root-continuity, view-only-vs-interactive) — the ADR records these as Phase 19 spike entry criteria.
- No full Phase 19 roadmap — the arch-doc update adds only a forward pointer; Phase 19's steps are planned in their own pass.
- No SKILL.md edits — `package-pi-subagents` SKILL describes the UI domain's module count, which changes only when Phase 19 code lands.

## Background

Relevant modules and how they relate:

- `src/ui/agent-widget.ts` (~290 LOC) — `AgentWidget implements SubagentManagerObserver`; self-drives an 80 ms render loop from lifecycle events (Step 4, [#423]), renders running/completed agents above the editor.
- `src/ui/conversation-viewer.ts` (~241 LOC) — bespoke `ConversationViewer` overlay; subscribes to `record.subscribeToUpdates`, renders a live, width-capped transcript of one agent's `messages`, plus a streaming indicator.
- `src/ui/agent-menu.ts` (~331 LOC) + `agent-config-editor.ts`, `agent-creation-wizard.ts`, `agent-file-ops.ts` — the `/agents` command.
  Four entries: **Running agents** (→ `ConversationViewer`), **Agent types** (→ `AgentConfigEditor` view/edit/enable/disable), **Create new agent** (→ `AgentCreationWizard`), **Settings** (max concurrency / default max turns / grace turns, written to layered settings).
- `src/tools/foreground-runner.ts` — foreground runs stream progress via the tool's inline `onUpdate` callback; the result is rendered by `result-renderer.ts` (caps display at 50 lines).
- The core persists each child as a standalone Pi session JSONL at `Subagent.outputFile`; `Subagent.messages` exposes full history.

Pi SDK surface relevant to the candidate redesign (verified against `@earendil-works/pi-coding-agent@0.79.1`):

- `ExtensionActions.switchSession(sessionPath, { withSession })` — switches the **active** session to a different session file; fires `session_before_switch` / `session_shutdown` and invalidates the current session context (`setBeforeSessionInvalidate` exists for host-owned UI teardown).
  Returns `{ cancelled }`.
  The switched-to session is fully interactive — `ReplacedSessionContext` exposes `sendUserMessage`.
- `session-manager` exports `loadEntriesFromFile(filePath)` / `parseSessionEntries(content)` — read a session file's entries without switching (the read-only alternative).

Constraint from AGENTS.md / the package SKILL: pi-subagents is a minimal core, open for extension and closed for modification; the UI is an _observational consumer_ (unlimited, the core never waits on it), distinct from the rationed generative `WorkspaceProvider` seam.
The ADR records a consumer-design decision; it must not introduce any new inbound dependency from the core onto the UI.

## Design Overview

The ADR records four decisions, each motivated by the first principles in the architecture doc's "first-principles refinement."

### Decision A — Foreground widget: shrink to background agents only

The above-editor widget duplicates the foreground tool's inline `onUpdate` stream.
Decision: the widget survives **only** as the background-agent status surface (concern (b): background agents have no tool-call display, so _something_ must indicate their state).
Foreground runs suppress the widget; the inline stream is authoritative there.

Multiple subagents can run in parallel, so the background surface must represent N concurrent agents at once — the widget's existing per-agent tree already does this; the change is _when_ it shows (background-only), not _what_ it shows.

### Decision B — Conversation viewer: replace the bespoke overlay with native session navigation

Concern (c) — "let the operator switch into a subagent's session, scroll/read it, switch between subagents, and exit back to root" — is a richer interaction than a live overlay.
The core already persists each child as a standalone Pi session JSONL, so this maps onto Pi's own session machinery rather than a bespoke renderer.

Decision (direction): **remove `ConversationViewer`**; the operator navigates into a child's persisted session via Pi's native viewer and back to root.
The bespoke, width-capped transcript is replaced by the same viewer Pi uses for any session — the recursive-Pi insight applied to the already-persisted session file.

Candidate call-site shape (Phase 19, illustrative — verifies the interaction pattern, not final):

```typescript
// "View running agents" → pick a child → switch into its persisted session
const child = manager.getRecord(id);
if (child?.outputFile) {
  await ctx.switchSession(child.outputFile);
  // operator reads/scrolls in Pi's native viewer; a later switch returns to root
}
```

This is Tell-Don't-Ask (hand Pi the session path; Pi owns the viewer) and keeps the core free of transcript-rendering code.

Open mechanics (recorded in the ADR, resolved by a Phase 19 spike — see Open Questions): `switchSession` is a full active-session takeover (not a view-only overlay), it invalidates the current session context, and the switched-to session is interactive.
The spike decides whether the operator UX is (i) true `switchSession` round-trips, or (ii) a read-only transcript built from `loadEntriesFromFile` that renders Pi-standard entries without leaving root.
The ADR records the _direction_ (native session machinery over a bespoke renderer) and gates the mechanism on the spike.

### Decision C — `/agents` menu: dissolve the monolithic command into focused surfaces

The single `/agents` command bundles four unrelated jobs.
Decision (direction): split them; do not keep all in one command.
The operator does not value managing agent definitions through the menu at all — creating or editing agents is firmly better done with other tools (directly in Pi, or a real text editor / IDE), so both of those surfaces are **removed outright**, not merely deprioritized.

- **Create new agent (wizard)** → **remove.**
  An operator generates a new agent `.md` by asking a Pi agent directly (more capable than a fixed wizard) or by writing the file in an editor — the wizard earns no keep.
- **Agent types (list + config editor)** → **remove.**
  Viewing and editing agent definitions is better served by opening the `.md` files directly in an editor/IDE; the in-menu config editor earns no keep.
- **Running agents (visibility)** → **keep the responsibility, re-home it.**
  _Something_ must own running-agent visibility; it moves onto the background widget (Decision A) plus the native session navigation (Decision B), not a bespoke in-menu overlay.
- **Settings (concurrency / max turns / grace turns)** → **extract to a focused command** (e.g. `/subagents:settings`).
  Some value, but it does not belong bundled with agent management.

### Decision D — Distribution: keep the surviving UI in-core (substitutable, not extracted)

The spine already made the UI substitutable — a replacement UI is a downstream concern that targets the public broadcast-plus-query surface.
Decision: the surviving UI (background widget + a settings command + session-navigation glue) **stays in-core** as a reactive consumer.
Extraction to `@gotgenes/pi-subagents-ui` is _not_ chosen now; it remains an available future option precisely because the core is byte-for-byte identical with or without a given UI consumer (the composition invariant).

This answers the issue's headline question — the UI's _distribution_ — with "keep in core, substitutable," recorded explicitly rather than left implicit.

## Module-Level Changes

This is a decision-only ADR; the only files touched are docs.

- **New:** `packages/pi-subagents/docs/decisions/0004-reconsider-ui-direction.md`.
  Frontmatter (`status: accepted`, `date: <ISO date>`), then `# 0004 — ...`, `## Status`, `## Context`, `## Decision` (Decisions A–D), `## Consequences`, `## Phase 19 entry criteria` (the spike gates + per-component implementation handles).
- **Changed:** `packages/pi-subagents/docs/architecture/architecture.md`:
  - Phase 18 Step 8 (`### Steps`, item 8) — mark complete with a `Landed:` bullet referencing ADR-0004 and the recorded decisions.
  - Step dependency diagram node `S8` — append a ✅ marker (matching S1–S7) so the diagram is consistent.
  - The phase summary table row `| 18 | Reconsider UI (first principles) | In progress |` → `Complete`, and add the per-phase pointer to the ADR.
  - Add a forward-pointer line gateway-ing Phase 19 (implementation of the recorded decisions, planned separately).
  - Add a `[#427]` reference usage is already present; no new link-ref definition needed.
    Add an ADR-0004 reference link if the doc cites it by path.

No `src/`, `test/`, or SKILL.md changes — every removed-symbol / reworded-mechanism check is therefore vacuous for this issue (no symbols removed, no runtime mechanism reworded).
The architecture doc's UI-domain module count and health metrics are _not_ edited here — they change when Phase 19 code lands.

## Test Impact Analysis

None — this is a docs-only ADR.

1. No new unit tests are enabled (no extraction, no behavior change).
2. No existing tests become redundant (no code removed).
3. No tests must stay-as-is for a layer being extracted (nothing is extracted in this issue).

The Phase 19 implementation that acts on these decisions will carry its own Test Impact Analysis when it is planned.

## Invariants at risk

None regressed by this issue — it changes no code, so every Phase 18 spine outcome stays green by construction.

The ADR _records_ that Phase 19 must preserve these spine invariants when it implements the decisions:

- Step 3 ([#422]) outcome "runtime holds zero UI state" — Phase 19 must not re-introduce UI state on the core when wiring the background-only widget or session navigation.
- Step 4/5 ([#423], [#424]) outcome "the widget is a reactive consumer; no inbound calls from core spawn tools / the LLM tool depends only on manager/runtime/settings/registry" — the background-only restriction and the `/agents` decomposition must keep the dependency direction inward.
- Step 6 ([#425]) outcome "declared channels equal emitted channels; no vacant hook" — any new navigation surface must consume existing broadcast/query channels, not add a vacant one.

These are pinned today by the existing observer/widget/event-contract suites; Phase 19 inherits them.

## Build Order

Docs-only — no red→green test cycles.
Numbered build steps, each a single reviewable commit.

1. **Write ADR-0004.**
   Author `docs/decisions/0004-reconsider-ui-direction.md` with Status / Context / Decision (A–D) / Consequences / Phase 19 entry criteria, capturing the `switchSession` findings and open mechanics.
   Verify: `pnpm run lint` passes (rumdl markdown rules); the ADR states a decision for every component named in [#427].
   Commit: `docs: add ADR-0004 reconsidering the UI direction (#427)`.
2. **Update the architecture doc.**
   Mark Phase 18 Step 8 complete (Landed bullet → ADR-0004), append ✅ to the `S8` diagram node, flip the phase table row to Complete, and add the Phase 19 forward pointer.
   Verify: `pnpm run lint` passes; the `[#427]` reference still resolves; no orphaned link-ref definitions (MD053); Phase 18 reads as complete end-to-end.
   Commit: `docs: mark Phase 18 complete and gateway Phase 19 (#427)`.

(Both steps may be folded into one commit if preferred; kept separate here because they touch different documents with different review concerns.)

## Risks and Mitigations

- **Risk:** the ADR over-commits to `switchSession` before its mechanics are understood, locking Phase 19 into an infeasible UX.
  **Mitigation:** the ADR records the _direction_ (native session machinery over a bespoke renderer) and explicitly gates the _mechanism_ on a Phase 19 spike, listing the read-only `loadEntriesFromFile` fallback as a first-class alternative.
- **Risk:** removing the conversation viewer and the running-agents menu entry leaves a visibility gap before Phase 19 ships.
  **Mitigation:** this issue removes _nothing_ — it only records decisions; the viewer/menu stay live until Phase 19 replaces them, so there is no interim regression.
- **Risk:** the arch-doc edits silently drop an enclosing structure (the Steps list, the diagram fence, the phase table).
  **Mitigation:** anchor edits on unique adjacent lines, re-read each edited region after editing, and run `pnpm run lint` to confirm the Mermaid fence and tables still parse.
- **Risk:** a future reader treats the recorded "keep in core" distribution decision as permanent.
  **Mitigation:** the ADR frames extraction as a still-available option enabled by the composition invariant, with the conditions under which it would be revisited.

## Open Questions

These are recorded in the ADR as Phase 19 spike entry criteria, not resolved here:

- **Root-continuity during a session switch.**
  `switchSession` invalidates the current session context — does the root's in-flight turn survive a switch-out-and-return, and what is the correct "return to root" gesture?
  Spike before committing Phase 19 to true `switchSession` round-trips.
- **View-only vs interactive.**
  A switched-to child session is interactive (`sendUserMessage`).
  Is steering a child from its own session desirable, or should the viewer be strictly read-only (favoring the `loadEntriesFromFile` transcript path)?
- **Parallel-agent navigation.**
  With N background agents running, what is the operator's gesture to pick which child to view and to cycle between them — driven from the background widget, a dedicated command, or both?
- **Settings command namespace.**
  Confirm the final command name/namespace for the extracted settings surface (`/subagents:settings` vs another form) against how sibling packages register namespaced commands.

The agent create/edit surfaces are _not_ open questions: the operator firmly removes both (managing agent definitions belongs in an editor/IDE or a Pi agent, not the menu).

[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#427]: https://github.com/gotgenes/pi-packages/issues/427
