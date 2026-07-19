---
issue: 447
issue_title: "pi-subagents: extract subagent settings to a focused /subagents-settings command"
---

# Extract subagent settings to a focused `/subagents-settings` command

## Release Recommendation

**Release:** ship independently

Phase 19 Step 2 ([#447]) carries `Release: independent` in the architecture roadmap, and the only batch defined there is "dissolve-agents" (Steps 5–6, [#442]/[#441]).
This step is purely additive — it stands up the new command without touching `agent-menu.ts` — so it ships on its own with no batch coupling.

## Problem Statement

The `/agents` command bundles four unrelated jobs (running-agent visibility, agent-type browsing, the creation wizard, and operational settings).
ADR-0004 Decision C splits them.
Settings has standalone value but does not belong buried inside an agent-management menu — a focused, top-level command is discoverable on its own without navigating a multi-purpose menu.

This step is deliberately **additive**: it stands up the new command without touching `agent-menu.ts`.
The old in-menu Settings option keeps working until Phase 19 Step 5 ([#442]) deletes `agent-menu.ts` wholesale.
Keeping the work additive avoids surgery on the doomed module and lets this step run in parallel with the rest of the Phase 19 replacement track.

## Goals

- Add `src/ui/subagents-settings.ts` — a `SubagentsSettingsHandler` lifted verbatim from `AgentsMenuHandler.showSettings`, carrying its own narrow manager interface (the three `apply*` methods and three readonly accessors only) and a narrow UI interface (only `select`, `input`, `notify`).
- Register the `/subagents-settings` command in `src/index.ts`, passing the existing `settings` (`SettingsManager`) directly.
- Add `test/ui/subagents-settings.test.ts` covering the extracted handler's behavior.

Non-breaking: this is pure addition.
No existing export, command, or behavior changes.

## Non-Goals

- Do **not** remove `showSettings` or `AgentMenuSettings` from `agent-menu.ts` — that file is deleted whole in Phase 19 Step 5 ([#442]).
- Do **not** modify the `/agents` command, its handler, or any wiring in `index.ts` beyond adding the new registration block.
- Do **not** add a settings re-show loop or any new settings behavior — the lift preserves the single-selection-then-return semantics of `showSettings` (see Design Overview).
- Defer the background widget ([#444]), native session navigation ([#445]), and the `/agents` dissolution ([#442]/[#441]) to their own Phase 19 steps.

## Background

Relevant existing modules:

- `src/ui/agent-menu.ts` — `AgentsMenuHandler.showSettings(ui)` is the source of the lift.
  It depends solely on `this.settings` (typed `AgentMenuSettings`) and the `ui` parameter (`MenuUI`).
  It calls `ui.select` once, then `ui.input` + one `settings.apply*` + `ui.notify` for the chosen field.
  It does not loop: it shows the settings list once, applies one change (or none), and returns.
  The re-show in the live menu comes from `showAgentsMenu` re-invoking *itself* after `showSettings` returns — not from `showSettings` looping.
- `AgentMenuSettings` (in `agent-menu.ts`) — the narrow settings shape `showSettings` reads: `readonly maxConcurrent`, `readonly defaultMaxTurns: number | undefined`, `readonly graceTurns`, plus `applyMaxConcurrent`/`applyDefaultMaxTurns`/`applyGraceTurns`, each returning `{ message: string; level: "info" | "warning" }`.
- `MenuUI` (in `agent-menu.ts`) — the wide menu UI interface; `showSettings` uses only `select`, `input`, and `notify` from it.
- `src/settings.ts` — `SettingsManager` is the concrete settings object constructed in `index.ts`.
  It already exposes all six members of `AgentMenuSettings` (the three getters and three `apply*` methods), so it structurally satisfies the new narrow manager interface and can be passed directly.
- `src/index.ts` — constructs `settings = new SettingsManager(...)`, then `new AgentsMenuHandler(manager, registry, settings, ...)` and `registerCommand("agents", ...)`.
  Sibling commands register flat, hyphenated names (`agents`, `colgrep-reindex`, `permission-system`) — no `:` namespace.
- `docs/decisions/0004-reconsider-ui-direction.md` — the addendum (2026-06-20) confirms the command name **`/subagents-settings`** (Criterion 4) and rejects `/subagents:settings` and `/agents-settings`.

AGENTS.md / package constraints:

- pi-subagents is a minimal core; the surviving UI is an in-core reactive consumer.
  This extraction adds a command surface only — no policy, no new core dependency.
- Modules marked `← removing` (the `/agents` subtree) must not gain features — this plan adds nothing to `agent-menu.ts`.

## Design Overview

`SubagentsSettingsHandler` is a faithful lift of `showSettings` into a standalone, independently-registered command.
It owns the settings UI interaction and depends on two narrow interfaces it declares itself (ISP — neither carries a field the handler does not use).

### Narrow interfaces

```typescript
/** Narrow settings interface required by the subagents-settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}
```

`SubagentsSettingsManager` is shape-identical to `AgentMenuSettings` but owned by the new module (zero import from `agent-menu.ts`, which is doomed).
`SubagentsSettingsUI` is narrower than `MenuUI` — it drops `confirm`, `editor`, and `custom`, which `showSettings` never calls.

### Handler

```typescript
export class SubagentsSettingsHandler {
  constructor(private readonly settings: SubagentsSettingsManager) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    // verbatim lift of showSettings: one select → input → apply* → notify
  }
}
```

The body is copied character-for-character from `showSettings` (the same three `if` branches, the same `parseInt` / validation / toast wiring), with `this.settings` resolving against the new narrow interface.

### Registration call site (index.ts)

```typescript
const subagentsSettings = new SubagentsSettingsHandler(settings);
pi.registerCommand("subagents-settings", {
  description: "Configure subagent settings (concurrency, turn limits)",
  handler: async (_args, ctx) => {
    await subagentsSettings.handle({ ui: ctx.ui });
  },
});
```

`settings` (the `SettingsManager` instance) is passed directly — it structurally satisfies `SubagentsSettingsManager`.
The command handler needs only `ctx.ui` (no `modelRegistry`, no `parentSnapshot`), so its params are narrower than the `/agents` handler's.

### Design-review findings

| Smell           | Location                               | Evidence                                                                                                                                    | Result            |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Wide interface  | `SubagentsSettingsManager` (6 members) | `handle` reads all 3 accessors and calls all 3 apply methods                                                                                | None — 100% usage |
| Wide interface  | `SubagentsSettingsUI` (3 methods)      | `handle` calls `select`, `input`, `notify`                                                                                                  | None — 100% usage |
| LoD violation   | `subagents-settings.ts`                | `this.settings.applyMaxConcurrent(n)` is a direct call; `ui.notify(toast.message, toast.level)` reads a returned value, not a reach-through | None              |
| Output argument | `subagents-settings.ts`                | handler reads accessors + calls apply methods; never writes back into `settings` or `ui`                                                    | None              |

The extraction introduces a genuine new collaborator (a focused command handler owning the settings interaction) with its own narrow contracts — it is not procedure-splitting.

### Edge cases (preserved verbatim from `showSettings`)

- `select` returns `undefined` (operator cancels) → return early, no change.
- `input` returns falsy (empty / cancel) → no apply call.
- `maxConcurrent` / `graceTurns`: reject `n < 1` with `"Must be a positive integer."` warning.
- `defaultMaxTurns`: accept `n >= 0` (0 = unlimited); reject `n < 0` with `"Must be 0 (unlimited) or a positive integer."` warning.
- Single selection then return — no settings re-show loop (matches current `showSettings`).

## Module-Level Changes

- **New** `src/ui/subagents-settings.ts` — `SubagentsSettingsHandler` class, `SubagentsSettingsManager` interface, `SubagentsSettingsUI` interface.
  ~80 LOC.
- **Changed** `src/index.ts` — add the `SubagentsSettingsHandler` import, construct it, and register the `subagents-settings` command.
  No other lines change; the `/agents` block stays intact.
- **New** `test/ui/subagents-settings.test.ts` — unit tests for the handler.
- **No change** to `src/ui/agent-menu.ts` (and its `AgentMenuSettings` / `showSettings` / `MenuUI` stay as-is — deleted later in [#442]).

Doc / skill grep results (no stale references to update in this step):

- `architecture.md` Step 2 already names `src/ui/subagents-settings.ts`, `SubagentsSettingsHandler`, `SubagentsSettingsManager`, and the `/subagents-settings` command with `Outcome: new subagents-settings.ts (~80 LOC) and focused command registered; agent-menu.ts untouched` — the file appears as a *planned* addition, so no doc edit is needed now; its status line flips to ✅ at ship time only if the operator wants it folded in.
- The package skill (`.pi/skills/package-pi-subagents/SKILL.md`) lists the UI domain by count (`ui/` = 10 modules); adding one file makes it 11, but the table is a coarse summary that is not maintained per-file — leave it for a later Phase 19 doc-sync unless the operator asks otherwise.
- `settings.ts` comments reference `/agents → Settings` as the writer of project settings; those are still accurate (the in-menu path keeps working), so no edit.
  They become stale only when [#442] deletes `agent-menu.ts`; do not pre-edit them here.

## Test Impact Analysis

1. **New tests enabled by the extraction.**
   `test/ui/subagents-settings.test.ts` can unit-test the settings flow in isolation against the standalone handler — no `AgentsMenuHandler` construction (registry, fileOps, two agent dirs) required.
   This is strictly more focused than the current `agent-menu.test.ts` "agent menu — settings" describe block, which has to drive the full top menu (`"Settings"` from the main menu) before reaching the settings list.
2. **Existing tests that become redundant.**
   None are removed in this step.
   The "agent menu — settings" tests in `agent-menu.test.ts` still genuinely exercise the live in-menu path, which keeps working until [#442].
   They are superseded only when `agent-menu.ts` is deleted in Step 5 — removing them now would drop coverage of a still-shipping surface.
3. **Existing tests that must stay as-is.**
   All of `agent-menu.test.ts` stays unchanged — this step does not touch `agent-menu.ts`.

## Invariants at risk

This step adds a new module and one registration; it does not touch the Phase 18 spine that prior steps refactored.
The ADR-0004 / Phase 18 invariants (runtime holds zero UI state [#422]; widget is a reactive consumer with no inbound core calls [#423]; the `subagent` tool depends only on manager/runtime/settings/registry [#424]; declared event channels equal emitted channels [#425]) are untouched and stay pinned by their existing suites.
The new handler adds no inbound call into the core and emits no events — it reads/applies through the existing `SettingsManager` surface only, so it preserves these invariants by construction.

## TDD Order

1. **Red→Green: extract `SubagentsSettingsHandler` with its narrow interfaces.**
   Test surface: `test/ui/subagents-settings.test.ts`.
   Write tests against a `makeSettings()`-style manager stub (lift the stub shape from `agent-menu.test.ts`) and a narrow UI stub (lift `makeMenuUI`, or reuse it — it already provides `select`/`input`/`notify`):
   - constructable;
   - cancel at the settings list (`select` → `undefined`) → no apply call;
   - `maxConcurrent`: valid input delegates to `applyMaxConcurrent(n)` and notifies the returned toast; `n < 1` notifies the positive-integer warning and does not apply;
   - `defaultMaxTurns`: `0` delegates `applyDefaultMaxTurns(0)`; a positive value delegates; `n < 0` notifies the warning;
   - `graceTurns`: valid input delegates to `applyGraceTurns(n)`; `n < 1` notifies the warning;
   - empty/cancelled `input` → no apply call.
   Implementation: create `src/ui/subagents-settings.ts` with the class and both interfaces; body lifted verbatim from `showSettings`.
   Commit: `feat: add SubagentsSettingsHandler for focused settings command (#447)`.
2. **Green: register the `/subagents-settings` command in `index.ts`.**
   Test surface: none new (command registration in `index.ts` is exercised by the package's existing index-level wiring tests if present; otherwise verify by `pnpm run check` and the suite).
   Implementation: import `SubagentsSettingsHandler`, construct it with `settings`, and `registerCommand("subagents-settings", ...)` passing `{ ui: ctx.ui }`.
   Run `pnpm run check` immediately (the registration is the only call site of the new export — it must compile alongside the new module).
   Commit: `feat: register /subagents-settings command (#447)`.

Both steps may be folded into one commit if preferred — the export and its single call site are small — but keeping the handler (with its tests) separate from the wiring keeps each commit self-contained and reviewable.

## Risks and Mitigations

- **Risk: the lift diverges from `showSettings`, causing the standalone command to behave differently from the in-menu option while both ship.**
  Mitigation: copy the body verbatim and assert the same validation/toast behavior in the new test file; the two surfaces share the same `SettingsManager`, so applied values are identical.
- **Risk: passing `SettingsManager` directly fails structural typing against the new narrow interface.**
  Mitigation: `SettingsManager` already declares all six members with matching signatures (verified in `src/settings.ts`); `pnpm run check` in Step 2 confirms it.
- **Risk: command-name drift from the ADR.**
  Mitigation: the name `subagents-settings` is fixed by the ADR-0004 addendum (Criterion 4) and the roadmap Step 2; use it exactly.
- **Risk: an unused-import or dead-export flag if the wiring lands in a separate commit from the handler.**
  Mitigation: Step 2 adds the sole call site immediately; run `pnpm fallow dead-code` before pushing.

## Open Questions

- Whether to also flip the `architecture.md` Step 2 status line to ✅ in this issue or defer to a Phase 19 doc-sync — decide at ship time (the architecture entry currently lists the file as planned, which is harmless until then).
- Whether a settings re-show loop (apply one setting → re-show the list) is desirable for the standalone command — deferred; the lift preserves single-selection-then-return to match current behavior, and a loop is a separate UX decision.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#444]: https://github.com/gotgenes/pi-packages/issues/444
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#447]: https://github.com/gotgenes/pi-packages/issues/447
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
