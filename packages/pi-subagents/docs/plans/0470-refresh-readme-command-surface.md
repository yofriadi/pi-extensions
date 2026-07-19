---
issue: 470
issue_title: "pi-subagents: README still documents the removed /agents command and omits /subagents:settings and /subagents:sessions"
---

# Refresh pi-subagents README to the post-Phase-19 command surface

## Release Recommendation

**Release:** ship independently

This is a standalone documentation fix.
It is not a member of any architecture-roadmap step or `Release: batch` — the `dissolve-agents` batch (Steps 5–6, [#442]/[#441]) already shipped as `pi-subagents-v18.0.0`, and this issue corrects README staleness that batch left behind.
There is no code change and nothing to batch with, so it ships on its own.

## Problem Statement

The Phase 19 terminal cut ([#442], [#441]) removed the `/agents` command, the bespoke conversation viewer, and the agent creation wizard / config editor, replacing them with `/subagents:settings`, `/subagents:sessions`, and the always-on background widget.
`packages/pi-subagents/README.md` was never updated and still documents the deleted surface as if it were live.
This shipped to npm with `pi-subagents-v18.0.0`, so the published package's README actively misleads users toward commands and menu actions that no longer exist.

## Goals

- Replace every reference to the removed `/agents` interactive menu with the current focused commands `/subagents:settings` and `/subagents:sessions`.
- Remove the **Conversation viewer** feature bullet — the live-scrolling overlay was deleted; transcript viewing is now served by `/subagents:sessions`.
- Remove the **eject** customization story from the Default Agent Types section — the eject/disable/enable/edit/delete menu is gone; customization is now "override by creating `.pi/agents/<name>.md`" and disabling stays `enabled: false` frontmatter (per ADR-0004 Decision C).
- Rewrite the **Commands** section to document the two real commands instead of the deleted `/agents` menu tree.
- Correct the **Persistent Settings** section's `/agents` → Settings references to `/subagents:settings`.
- Correct the **Events** table's `subagents:settings_changed` description (currently "`/agents` → Settings mutation").
- Add a feature bullet (or amend an existing one) so the read-only session navigation surface (`/subagents:sessions`) is discoverable in the Features list, since the deleted Conversation viewer bullet was its only nearby mention.

## Non-Goals

- No source, test, or behavior changes — this is a pure documentation edit.
  `src/`, `test/`, the architecture doc, and the ADRs are already accurate (architecture.md lines 405/559 already describe the Phase 19 outcome) and are not touched.
- No rewrite of accurate sections (Quick Start, UI widget render examples, Default Agent Types table, Custom Agents, Tools, Graceful Max Turns, Concurrency, Worktree Isolation, migration notes, For Extension Authors).
- No new screenshots or media.
  The widget render examples in the **UI** section already describe the background-only widget accurately and stay as-is.
- No change to the `subagents.json` settings-file layering description (global `~/.pi/agent/subagents.json` + project `.pi/subagents.json`) — that mechanism is unchanged; only the command name that writes the project file changed.

## Background

Relevant current surface (verified against `src/index.ts`):

- `pi.registerCommand("subagents:settings", …)` → `SubagentsSettingsHandler.handle({ ui })` — interactive list to set max concurrency, default max turns, and grace turns at runtime (`src/ui/subagents-settings.ts`).
  This is the re-homed Settings job from the old `/agents` menu; it still persists to the same `subagents.json` files.
- `pi.registerCommand("subagents:sessions", …)` → `SessionNavigatorHandler.handle({ … agents, evicted, registry, cwd, readFile })` — read-only transcript navigation over `manager.listAgents()` and `manager.listEvicted()`, so any subagent (live or evicted) is navigable (`src/ui/session-navigation.ts`, `session-navigator.ts`).

ADR-0004 Decision C (`docs/decisions/0004-reconsider-ui-direction.md`) is the authority for the customization story the README must now tell:

- Create-new-agent wizard → removed.
  An operator generates a new agent `.md` by asking a Pi session directly or by writing the file in an editor.
- Agent-types list + config editor → removed.
  Viewing/editing definitions is done by opening the `.md` files in an editor/IDE.
- The eject convenience no longer exists; overriding a default agent is done by creating `.pi/agents/<name>.md` with the same name, and disabling stays `enabled: false` frontmatter.

AGENTS.md constraint that applies: this is a single-package README change, so it lives in `packages/pi-subagents/docs/plans/`.
The README documents commands, not module filenames, which is exactly why the Phase 19 module-name doc-staleness check missed it (the issue's own root-cause note, Refs [#442]/[#441]).

## Design Overview

Pure prose edit, no decision model or data shapes.
The README is restructured section-by-section to describe the live surface.
The one structural choice is how to present the two commands in the **Commands** section: keep the existing two-column command table (`| Command | Description |`) with two rows, then a short subsection per command describing what it opens, instead of the old single-command-plus-menu-tree layout.

### Commands section — target shape (illustrative)

```markdown
## Commands

| Command               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `/subagents:settings` | Configure subagent settings (concurrency, turn limits) |
| `/subagents:sessions` | View a subagent's session transcript (read-only)       |

### `/subagents:settings`

Interactive list to tune runtime settings — max concurrency, default max turns, and grace turns.
Changes persist across pi restarts (see Persistent Settings).

### `/subagents:sessions`

Pick any subagent — running or already evicted — and read its full session transcript in pi's native per-entry viewer.
Read-only: no steering, no session takeover (steering lives in the `steer_subagent` tool).
```

The command descriptions in the table are copied verbatim from the `registerCommand` calls in `src/index.ts` so the README matches what `/help` shows.

### Customization story — Default Agent Types section

Replace the eject sentence (line 119) with two retained mechanisms only:

```markdown
Default agents can be **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.
```

(The "ejected … to export them as `.md` files" clause is dropped entirely — there is no eject UI to produce the export.)

## Module-Level Changes

Single file: `packages/pi-subagents/README.md`.
Line numbers are against the current README (from the issue's "Affected lines"); each is a prose edit, not a code change.

1. **Line 21 — Features list, Conversation viewer bullet.**
   Remove the `**Conversation viewer**` bullet (it describes selecting an agent in `/agents` to open a live overlay).
   In its place, add a bullet for read-only session navigation, e.g. `**Session transcripts** — open any subagent's full session transcript (running or evicted) in a read-only viewer via /subagents:sessions`.
2. **Line 119 — Default Agent Types, eject sentence.**
   Reword to drop eject; keep override + disable (see Design Overview snippet).
3. **Lines ~226–303 — Commands + Persistent Settings sections.**
   - Rewrite the **Commands** section (table row `/agents` and the entire interactive-menu code block + bullet list, lines ~228–252) to document `/subagents:settings` and `/subagents:sessions` per the target shape above.
   - In **Persistent Settings**, replace each `/agents` → Settings reference (lines 277, 281, 283, 301) with `/subagents:settings`, and "the `/agents` menu never writes here" (line 281) with "the `/subagents:settings` command never writes here", and "without ever touching the menu" (line 300) with "without ever touching the command".
   - Line 303 failure-behavior sentence: change "the `/agents` toast" to "the `/subagents:settings` toast".
4. **Line 318 — Events table, `subagents:settings_changed` row.**
   Change the "When" cell from "`/agents` → Settings mutation was applied" to "`/subagents:settings` mutation was applied".

Doc-staleness cross-checks performed (per plan-issue checklist):

- Grepped the README for every removed term (`/agents`, `eject`/`Eject`, `conversation viewer`, `wizard`, `Create new agent`, `interactive menu`, `menu`) — all occurrences are enumerated in the steps above (lines 21, 119, 228, 230, 235, 241–248, 277, 281, 283, 300, 301, 303, 318).
- Confirmed no other `packages/pi-subagents/docs/` file or `.pi/skills/package-pi-subagents/SKILL.md` references `/agents` as a live command needing update (architecture.md already describes the Phase 19 removal as past tense; the SKILL.md describes `/subagents:settings`/`/subagents:sessions` already).
- The **UI** widget-render examples and the **Default Agent Types** table are accurate post-Phase-19 and are left unchanged — verify they are not contradicted by the edits.

## Test Impact Analysis

Not applicable — documentation-only change with no test surface.
There is no executable behavior to cover; correctness is verified by `pnpm run lint` (rumdl markdown rules) and visual review against `src/index.ts`'s registered commands.

## Invariants at risk

None.
This change touches no code surface a prior phase step refactored; the Phase 19 spine invariants ([#422]–[#425]) are pinned by existing source/observer/event-contract suites and are untouched by a README edit.

## Build Order

This is a `/build-plan` (docs-only) change, executed as a single reviewable commit — no red→green cycles.

1. Edit `packages/pi-subagents/README.md` per all four Module-Level Changes steps in one pass.
   Apply one-sentence-per-line formatting (markdown-conventions skill) to all rewritten prose.
   Suggested commit message: `docs(pi-subagents): refresh README for /subagents:settings and /subagents:sessions (#470)`.
2. Verify: run `pnpm --filter @gotgenes/pi-subagents run lint` (or `pnpm run lint` at root) to confirm rumdl passes, and re-grep the README for `/agents`, `eject`, `wizard`, `conversation viewer` to confirm zero stale references remain.
   Cross-check the two command descriptions against `src/index.ts` `registerCommand` strings.

## Risks and Mitigations

- **Risk: missing a stale reference.**
  Mitigation: the grep in Module-Level Changes enumerated every occurrence; the build step re-greps after editing to confirm none survive.
- **Risk: command description drift from the actual `/help` text.**
  Mitigation: copy the table descriptions verbatim from the `registerCommand` calls in `src/index.ts`.
- **Risk: markdown lint failure on the rewritten Commands table or code fences.**
  Mitigation: follow markdown-conventions (compact table style, fenced-block languages, sequential numbering) and run `pnpm run lint` before committing.

## Open Questions

None.
The issue is the operator's own, the surface is verified against source, and no follow-up work is named.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#425]: https://github.com/gotgenes/pi-packages/issues/425
