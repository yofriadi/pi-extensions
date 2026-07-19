---
issue: 442
issue_title: "pi-subagents: dissolve /agents and remove the conversation-viewer subtree"
---

# Dissolve `/agents` and remove the conversation-viewer subtree

## Release Recommendation

**Release:** mid-batch — defer (batch "dissolve-agents"); confirm at ship time

This is Phase 19 Step 5, the first of the two deletion commits in release batch "dissolve-agents" (Steps 5–6).
The batch tail is Step 6 ([#441]); per the architecture roadmap's `Release batches` subsection the two ship together, and the operator has confirmed: do not release until both [#442] and [#441] have landed on `main`.
Hold the release-please PR open after this issue merges; the release is cut when [#441] (the tail) lands.

## Problem Statement

Phase 19 Steps 2–4 re-homed all four `/agents` menu responsibilities: settings moved to the `/subagents:settings` command, running-agent visibility moved to the background widget, and session viewing moved to native session navigation (`/subagents:sessions`).
With those replacements live, the `/agents` command and everything reachable only from `agent-menu.ts` is an orphaned subtree.
This issue performs the first of two terminal-cut deletions: dissolve the `/agents` command and delete the conversation-viewer subtree (`agent-menu.ts`, `conversation-viewer.ts`, `message-formatters.ts`, and their tests).
Deleting the hub `agent-menu.ts` wholesale — rather than surgically narrowing it once per option — is what orphans the definition-management leaves, so the hub must go first (it statically imports the wizard, editor, and file-ops, and dynamically imports the viewer).

## Goals

- Remove the `/agents` slash command and its menu hub (`agent-menu.ts`).
- Delete the conversation-viewer subtree: `conversation-viewer.ts` (the bespoke session overlay) and `message-formatters.ts` (its only consumer), plus all three tests.
- Dewire `index.ts`: drop the `registerCommand("agents", …)` block, the `AgentsMenuHandler` and `FsAgentFileOps` imports/construction, and the now-dead `join` and `buildParentSnapshot` imports.
- Keep `pnpm run check`, `pnpm run lint`, `pnpm run test`, and `pnpm fallow dead-code` green at every commit by breaking the hub↔leaf type cycle first (see Design Overview).
- Leave the agent-definition-management leaves (`agent-creation-wizard.ts`, `agent-config-editor.ts`, `agent-file-ops.ts`, `agent-file-writer.ts`) orphaned but compiling, for [#441] to `git rm`.

This change is **breaking**: removing the `/agents` command alters observable behavior on upgrade with no user edit.
The deletion commit uses `feat(pi-subagents)!:` with a `BREAKING CHANGE:` footer naming the replacements (`/subagents:settings`, `/subagents:sessions`, the background widget).

## Non-Goals

- Deleting the agent-definition-management subtree (`agent-creation-wizard.ts`, `agent-config-editor.ts`, `agent-file-ops.ts`, `agent-file-writer.ts`) and the transient `menu-ui.ts` — that is [#441] (Step 6), the batch tail.
- Consolidating residual test clone families — that is [#443] (Step 7), which runs after the cut.
- Cleaning up `test/helpers/ui-stubs.ts` (`makeFileOps`, `makeMenuManager`, `createTestSubagentConfig`) — its helpers still have surviving consumers (the wizard/editor tests) until [#441].
- The holistic architecture-doc refresh (health-metrics final numbers, the domain Mermaid diagram, the complexity tables, migrating Phase 19 to `docs/architecture/history/`) — deferred to the batch tail [#441] to avoid editing the same analytical tables twice, since they also reference files [#441] deletes.

## Background

Relevant modules and their current coupling:

- `src/ui/agent-menu.ts` (331 LOC) — the `AgentsMenuHandler` god-command; statically imports `AgentConfigEditor` and `AgentCreationWizard` (constructs them), and dynamically imports `ConversationViewer` in `viewAgentConversation`.
  Defines three exported interfaces: `AgentMenuManager`, `AgentMenuSettings`, and `MenuUI`.
- `src/ui/conversation-viewer.ts` (241 LOC) — the bespoke scrollable session overlay; its only consumer is `agent-menu.ts`'s dynamic `import("./conversation-viewer")`.
- `src/ui/message-formatters.ts` (195 LOC) — pure per-message-type formatters; its only consumer is `ConversationViewer`.
- `src/index.ts` — registers the `/agents` command, constructs `AgentsMenuHandler` (wiring in `FsAgentFileOps` and the two agents dirs), and uses `join` + `buildParentSnapshot` only inside that block.

The hub↔leaf type cycle (the key constraint):

- `agent-menu.ts` value-imports the wizard and editor classes.
- `agent-creation-wizard.ts` and `agent-config-editor.ts` each `import type { MenuUI } from "#src/ui/agent-menu"` and use `MenuUI` as a parameter type throughout.

This is a bidirectional cycle: the hub imports the leaf classes; the leaves import the hub's `MenuUI` type.
Deleting either subtree first leaves the other half referencing a deleted module, so `tsc --noEmit` (which type-checks all of `src` + `test`) fails.
The issue's premise that the leaves become "pure orphans" once the hub is gone holds for *runtime* reachability but not at the *type* level — the `MenuUI` back-import keeps them coupled.

Constraints from AGENTS.md / package skill:

- Each commit must leave the repo in a valid state (`pnpm run check` green).
- This package builds public `.d.ts` bundles; none of the deleted modules are part of the public surface (`service.ts`, `layered-settings.ts`), so no `verify:public-types` impact.
- `MenuUI`, `AgentMenuManager`, `AgentMenuSettings` are internal — not exported from any package subpath.

## Design Overview

Resolve the cycle with a **tidy-first** preparatory move (per the operator's decision and the `code-design` skill's "preparatory refactoring"): relocate the `MenuUI` interface to its own surviving module before deleting the hub.

Only `MenuUI` needs to survive the cut — `AgentMenuManager` and `AgentMenuSettings` have no consumers outside the hub (verified) and die with it.
`MenuUI` is self-contained (its members reference only SDK-shaped primitives), so the extracted module carries no upstream-dependency baggage and introduces no Tell-Don't-Ask or output-argument smell.

New module `src/ui/menu-ui.ts`:

```typescript
/** Narrow UI interface — only the ctx.ui methods menu handlers actually call. */
export interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  editor(title: string, content: string): Promise<string | undefined>;
  custom<R>(component: any, options?: any): Promise<R>;
}
```

Consumer call sites after the move (the leaves import the relocated type unchanged):

```typescript
// agent-creation-wizard.ts / agent-config-editor.ts
import type { MenuUI } from "#src/ui/menu-ui";
async showCreateWizard(ui: MenuUI, parentSnapshot: ParentSnapshot): Promise<void> { … }
```

`menu-ui.ts` is **transient**: after this issue it is imported only by the wizard and editor (both alive until [#441]), so it has live consumers and stays off the fallow dead-code list.
[#441] deletes the wizard, editor, and `menu-ui.ts` together, so the transient module never outlives its consumers.

Two-commit sequence within this issue:

1. `refactor(pi-subagents): extract MenuUI to its own module` — pure move; repoints the hub, wizard, and editor imports.
   Green.
2. `feat(pi-subagents)!: dissolve /agents and remove the conversation-viewer subtree` — delete the three source files + three tests, dewire `index.ts`, update docs.
   Green (wizard/editor now import `MenuUI` from the surviving `menu-ui.ts`; the hub is gone).

Edge cases / verifications already confirmed:

- `subagents-settings.ts` defines its own `SubagentsSettingsUI` interface — it does **not** import `MenuUI`, so the relocation does not touch the surviving settings command.
- `test/helpers/ui-stubs.ts`'s `makeMenuUI` is structurally typed and does **not** import the `MenuUI` type, so no test-helper repointing is needed.
- After dewiring, `join` (node:path) and `buildParentSnapshot` are used nowhere else in `index.ts` (verified) and their imports are removed; `getAgentDir`, `process.cwd`, `registry`, `settings`, and `manager` retain other live uses and stay.
- `FsAgentFileOps` becomes production-unused after the `index.ts` construction is removed, but `test/ui/agent-file-ops.test.ts` still imports it, so fallow (syntactic import analysis) keeps it off the dead-code list until [#441].
- Deleting the consumers does not orphan any local export: `formatDuration`/`getDisplayName`/`getModelLabelFromConfig` retain other consumers, and `wrapTextWithAnsi` is an external `@earendil-works/pi-tui` import.

## Module-Level Changes

Commit 1 — extract `MenuUI` (refactor):

- Add `src/ui/menu-ui.ts` — the `MenuUI` interface (moved verbatim from `agent-menu.ts`).
- `src/ui/agent-menu.ts` — remove the `MenuUI` interface definition; import `MenuUI` from `#src/ui/menu-ui`.
- `src/ui/agent-creation-wizard.ts` — change `import type { MenuUI } from "#src/ui/agent-menu"` to `from "#src/ui/menu-ui"`.
- `src/ui/agent-config-editor.ts` — same import repoint.

Commit 2 — dissolve `/agents` and delete the viewer subtree (feat!):

- Delete `src/ui/agent-menu.ts`, `src/ui/conversation-viewer.ts`, `src/ui/message-formatters.ts`.
- Delete `test/ui/agent-menu.test.ts`, `test/conversation-viewer.test.ts`, `test/message-formatters.test.ts`.
- `src/index.ts`:
  - Remove the `import { FsAgentFileOps } from "#src/ui/agent-file-ops"` and `import { AgentsMenuHandler } from "#src/ui/agent-menu"` lines.
  - Remove the now-dead `import { join } from "node:path"` and `import { buildParentSnapshot } from "#src/lifecycle/parent-snapshot"` lines.
  - Remove the `// ---- /agents interactive menu ----` comment, the `agentsMenu` construction, and the `registerCommand("agents", …)` block.
  - Remove the `/agents — Interactive agent management menu` line from the top-of-file `Commands:` doc comment.
- `packages/pi-subagents/docs/architecture/architecture.md` — update the current-state `ui/` file tree (remove the `agent-menu.ts`, `conversation-viewer.ts`, `message-formatters.ts` entries; add a `menu-ui.ts` entry), and annotate the Step 5 roadmap entry's `Outcome:` to record the actual approach (the `MenuUI` relocation prep; `index.ts` import-removal also drops `join`/`buildParentSnapshot`).
  The structural-analysis tables, domain Mermaid diagram, and health-metrics numbers are deferred to the batch tail [#441] (see Non-Goals).
- `.pi/skills/package-pi-subagents/SKILL.md` — update the UI domain row: count `13` → `11`, and drop "conversation viewer, /agents menu" from the responsibility description (keep "creation wizard, config editor" — those survive until [#441]).

The Step 5 `Outcome:` line in `architecture.md` currently asserts "no edit to doomed files" and "`index.ts` edited once."
Both are now slightly inaccurate: the tidy-first prep repoints the doomed wizard/editor `MenuUI` import (one line each), and `index.ts` also sheds two now-dead imports.
The annotation should reflect this, not leave the stale claim.

## Test Impact Analysis

This is a deletion, not an extraction-for-testability, so no new unit tests are enabled.

1. New tests enabled: none.
2. Tests that become redundant / removed: `test/ui/agent-menu.test.ts`, `test/conversation-viewer.test.ts`, `test/message-formatters.test.ts` (the largest test function by LOC) — they exercise deleted production code and are deleted with it.
3. Tests that must stay as-is: the wizard/editor tests (`test/ui/agent-creation-wizard.test.ts`, `test/ui/agent-config-editor.test.ts`) keep compiling against the relocated `MenuUI` and survive until [#441]; `test/ui/subagents-settings.test.ts`, the session-navigation tests, and `test/ui/agent-widget.test.ts` pin the replacement surfaces and must stay green (see Invariants at risk).

## Invariants at risk

The cut removes surfaces whose responsibilities Steps 2–4 already re-homed.
Each replacement's invariant must remain green after this deletion:

- Settings management (Step 2, [#447]) → pinned by `test/ui/subagents-settings.test.ts`.
  The `/subagents:settings` command and `SubagentsSettingsHandler` are untouched here.
- Running-agent visibility (Step 3, [#444]) → pinned by `test/ui/agent-widget.test.ts`.
  The background widget is untouched.
- Session viewing (Step 4 / 4a, [#445]) → pinned by the session-navigation / session-navigator tests.
  The `/subagents:sessions` command is untouched.

The deletion touches none of those files, so the full suite (minus the three deleted tests) staying green is the verification that no replacement regressed.

## Implementation Order

This issue has no red→green test cycles (a pure interface move plus deletions verified by the existing suite), so it is a build-style change — the next step is `/build-plan`, not `/tdd-plan`.

1. `refactor(pi-subagents): extract MenuUI to its own module`
   - Add `src/ui/menu-ui.ts`; remove the interface from `agent-menu.ts` and import it; repoint the wizard and editor imports.
   - Verify: `pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code` all green.
2. `feat(pi-subagents)!: dissolve /agents and remove the conversation-viewer subtree`
   - Delete the three source files and three tests; dewire `index.ts`; update `architecture.md` file tree + Step 5 `Outcome:`; update `SKILL.md` UI row.
   - `BREAKING CHANGE:` footer: the `/agents` command is removed; its responsibilities are served by `/subagents:settings` (configure concurrency/turn limits), `/subagents:sessions` (read-only transcript viewing), and the always-on background widget (running-agent visibility).
   - Verify: `pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code` green; confirm `/agents` no longer registers and `menu-ui.ts` retains its wizard/editor consumers.

## Risks and Mitigations

- Risk: deleting the hub before the leaves breaks `tsc` via the `MenuUI` back-import.
  Mitigation: the tidy-first Commit 1 relocates `MenuUI` to a surviving module so Commit 2 compiles; verified that only the wizard and editor consume `MenuUI` and that `subagents-settings.ts` and `ui-stubs.ts` do not.
- Risk: `FsAgentFileOps` becomes production-unused and trips `fallow dead-code`.
  Mitigation: verified `test/ui/agent-file-ops.test.ts` still imports it; fallow's syntactic import analysis keeps it live until [#441].
  Run `pnpm fallow dead-code` after Commit 2 to confirm.
- Risk: the transient `menu-ui.ts` looks like speculative indirection.
  Mitigation: it is short-lived by design (one issue), has two live consumers immediately, and is deleted by the batch tail [#441]; the alternative (inlining a throwaway type into doomed files, or merging [#441] into [#442]) was considered and rejected via the operator decision.
- Risk: stale architecture docs mid-batch (the domain diagram and tables still show the deleted modules between [#442] and [#441]).
  Mitigation: accepted deliberately — the analytical-table refresh is batched into the tail [#441] to avoid double-editing tables that [#441] also touches; the current-state file tree and SKILL.md count are kept accurate at each commit.

## Open Questions

None.
The hub↔leaf type-cycle resolution (relocate `MenuUI`, keep two commits) and the release-timing (defer until [#441] lands) were settled with the operator during planning.

[#441]: https://github.com/gotgenes/pi-packages/issues/441
[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#443]: https://github.com/gotgenes/pi-packages/issues/443
[#444]: https://github.com/gotgenes/pi-packages/issues/444
[#445]: https://github.com/gotgenes/pi-packages/issues/445
[#447]: https://github.com/gotgenes/pi-packages/issues/447
