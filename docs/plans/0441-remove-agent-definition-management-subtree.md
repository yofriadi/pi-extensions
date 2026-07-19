---
issue: 441
issue_title: "pi-subagents: remove the orphaned agent-definition management subtree"
---

# Remove the orphaned agent-definition management subtree

## Release Recommendation

**Release:** ship now — batch "dissolve-agents" tail (this issue completes the batch)

This issue is Phase 19 Step 6, the tail of release batch "dissolve-agents" (Steps 5–6) in `docs/architecture/architecture.md`.
Step 5 ([#442], commit `cb813f2c`) landed a breaking `feat(pi-subagents)!:` that is still **unreleased** — it sits after the latest tag `pi-subagents-v17.5.0`.
Landing this tail completes the batch and lets release-please cut the major bump that carries Step 5's `/agents` removal.

## Problem Statement

ADR-0004 Decision C removes both agent-definition surfaces: creating a new agent is better done by asking a Pi session directly (more capable than a fixed wizard) or by writing the `.md` file in an editor, and viewing or editing definitions is better served by opening the `.md` files in an editor or IDE.
Phase 19 Step 5 ([#442]) deleted `agent-menu.ts` — the only importer of the creation wizard, config editor, and their file-ops helpers — so this subtree is now pure dead code.
This step is the second of two deletion commits in the Phase 19 terminal cut: a clean `git rm` of the orphaned modules, with no surviving references and no edit to any doomed file.

## Goals

- Delete the orphaned creation wizard, config editor, and their two file-ops helper modules, plus their tests.
- Delete the transient `menu-ui.ts` module, orphaned once its only consumers (the wizard and editor) are gone.
- Prune the now-unused helpers from `test/helpers/ui-stubs.ts`, keeping only the helper a surviving test still uses.
- Drive the package's remaining production duplication to zero (the 11-line internal clone in `disableAgent`/`ejectAgent` dies with `agent-config-editor.ts`).
- This is **not** a breaking change at this step: the modules are already unreachable after Step 5, so deleting them changes no observable behavior — the user-facing removal already shipped (unreleased) in Step 5's `feat!:`.

## Non-Goals

- No change to `index.ts` — it already references none of the deleted symbols (verified by grep); the dewiring happened in Step 5.
- No change to the surviving UI modules (`agent-widget.ts`, `display.ts`, `session-navigation.ts`, `session-navigator.ts`, `subagents-settings.ts`, `widget-renderer.ts`).
- No change to `subagents-settings.ts`, which carries its own `SubagentsSettingsUI` interface and never depended on `MenuUI`.
- Test clone consolidation (Phase 19 Step 7, [#443]) — runs after this cut so no surviving helper is extracted into a doomed file.

## Background

Relevant modules and their current dependency facts (verified against `main`):

- `src/ui/agent-creation-wizard.ts` (235 LOC) — `AgentCreationWizard` class; imports `AgentFileOps`, `writeAgentFile`, and `MenuUI` from its siblings.
- `src/ui/agent-config-editor.ts` (201 LOC) — `AgentConfigEditor` class plus `buildMenuOptions`/`buildEjectContent`; imports `AgentFileOps`, `writeAgentFile`, and `MenuUI`.
  Contains the package's only remaining production clone (the 11-line `disableAgent`/`ejectAgent` block).
- `src/ui/agent-file-ops.ts` (59 LOC) — `AgentFileOps` interface + `FsAgentFileOps`; only consumers were the wizard and editor.
- `src/ui/agent-file-writer.ts` (55 LOC) — `writeAgentFile` + narrow interfaces; only consumers were the wizard and editor.
- `src/ui/menu-ui.ts` (9 LOC) — the `MenuUI` interface, extracted in Step 5's tidy-first prep commit (`bb03efd7`) to break a bidirectional type cycle.
  After this step deletes the wizard and editor, `menu-ui.ts` has zero importers.
  The architecture doc marks it for removal here: its current-state directory listing reads `menu-ui.ts transient: MenuUI interface (removed with wizard/editor in #441)` (line 346), and the Step 5 entry states "The `menu-ui.ts` module is transient and is removed with the wizard/editor in Step 6" (line 1076).

Orphan verification (grep across `src/`, excluding the doomed files themselves): **no** surviving importer of any of the five modules or their exported symbols (`AgentCreationWizard`, `AgentConfigEditor`, `FsAgentFileOps`, `writeAgentFile`, `MenuUI`).
`src/index.ts` references none of them.

Test-helper facts (`test/helpers/ui-stubs.ts`), evaluated **after** the four doomed test files are deleted:

- `makeMenuUI` — still imported by `test/ui/subagents-settings.test.ts` → **survives**.
- `makeFileOps` — only remaining importer is its own self-test `ui-stubs.test.ts` → orphan.
- `makeMenuManager` (including the wizard `spawnAndWait` relay) — only remaining importer is `ui-stubs.test.ts` → orphan.
- `createTestSubagentConfig` (and its private `DEFAULT_TEST_AGENT_CONFIG`) — only remaining importer is `ui-stubs.test.ts` → orphan.

AGENTS.md constraints that apply:

- Run `pnpm fallow dead-code` locally before pushing — CI gates on it.
- Conventional Commits; reference the issue as `(#441)` in the subject, never `Closes #441`.
- `pnpm` only; package-scoped scripts via `pnpm --filter @gotgenes/pi-subagents`.

## Design Overview

This is a deletion-only change — no new collaborators, no shared-interface edits, no behavior moved.
There is nothing to extract and no decision model beyond "delete the orphans, leave `fallow` clean."

Two clarifications where the issue body is less precise than the authoritative architecture doc:

1. **`menu-ui.ts` is in scope.**
   The issue body's "Proposed change" lists only the four modules, but `menu-ui.ts` is orphaned by the same cut and the architecture doc (lines 346, 1076) explicitly schedules its removal here.
   Deleting it in the same commit as the wizard/editor avoids a dangling `import type { MenuUI }` and a `fallow dead-code` flag.

2. **`makeMenuManager` is removed whole, not just its `spawnAndWait` field.**
   The issue body says to prune the "wizard `spawnAndWait` relay," but after the four test files are deleted, `makeMenuManager`'s only remaining caller is its own self-test.
   A test helper whose sole consumer is its own unit test is exactly the residual clutter the Phase 19 cut eliminates, so the whole helper (and its `describe` block) goes.
   The architecture doc's Step 6 phrasing — "delete … `spawnAndWait` from `makeMenuManager` **if no surviving consumer remains**; delete the file outright once all consumers are gone" — licenses this: no real consumer remains.
   `ui-stubs.ts` itself survives because `makeMenuUI` still has a real consumer.

End state of `test/helpers/ui-stubs.ts`: a single `makeMenuUI` export plus its file header.
End state of `test/helpers/ui-stubs.test.ts`: the `makeMenuUI` `describe` block only.

Commit-type rationale: deleting already-unreachable code is `refactor(pi-subagents):` — it neither adds a feature nor fixes a bug, and it changes no observable behavior at this step.
The release is driven by Step 5's unreleased `feat!:` already in the queue, not by this commit's type.

## Module-Level Changes

Source (deleted):

- `src/ui/agent-creation-wizard.ts` — deleted (235 LOC).
- `src/ui/agent-config-editor.ts` — deleted (201 LOC); removes the 11-line internal production clone.
- `src/ui/agent-file-ops.ts` — deleted (59 LOC).
- `src/ui/agent-file-writer.ts` — deleted (55 LOC).
- `src/ui/menu-ui.ts` — deleted (9 LOC); orphaned once the wizard and editor are gone.

Tests (deleted):

- `test/ui/agent-creation-wizard.test.ts` — deleted (296 LOC).
- `test/ui/agent-config-editor.test.ts` — deleted (392 LOC).
- `test/ui/agent-file-ops.test.ts` — deleted (112 LOC).
- `test/ui/agent-file-writer.test.ts` — deleted (148 LOC).

Tests (pruned, not deleted):

- `test/helpers/ui-stubs.ts` — remove `makeFileOps`, `makeMenuManager`, `createTestSubagentConfig`, and the private `DEFAULT_TEST_AGENT_CONFIG`; keep `makeMenuUI`.
  Also drop the file's `import type { AgentConfig }` — it serves only the removed helpers, and `makeMenuUI` references no package-local type.
- `test/helpers/ui-stubs.test.ts` — remove the `makeFileOps`, `makeMenuManager`, and `createTestSubagentConfig` `describe` blocks and the now-unused imports; keep the `makeMenuUI` `describe` block.

Docs (updated):

- `docs/architecture/architecture.md` — in the current-state directory tree (lines ~341–346), remove the five deleted `ui/` entries including the `menu-ui.ts` transient line; add a `Landed` note to the Step 6 entry and mark it ✅, mirroring the Step 5 entry's format.
- `.pi/skills/package-pi-subagents/SKILL.md` — update the UI domain-table row: module count `11` → `6`, and drop "creation wizard, config editor" from the responsibility summary.

Doc-reference grep results (the removed symbols / mechanism):

- `docs/plans/*` and `docs/retro/*` and `docs/architecture/history/*` mention the deleted modules only as **historical record** of prior phases (extraction, narrowing, clone removal).
  Per markdown conventions these are immutable records of completed work — do not rewrite them.
- The only **current-state** docs that describe the live layout are `architecture.md` (directory tree + Step 6 entry) and `SKILL.md` (UI domain row), both listed above.

## Test Impact Analysis

This is a deletion, not an extraction, so the standard extraction lenses invert:

1. **New tests enabled:** none — nothing new is created.
2. **Tests that become redundant:** all four deleted test files exercised only the deleted modules; they go with their subjects.
   The three pruned `ui-stubs.test.ts` `describe` blocks tested helpers that no longer exist.
3. **Tests that must stay as-is:** `test/ui/subagents-settings.test.ts` (the surviving real consumer of `makeMenuUI`) and the `makeMenuUI` `describe` block in `ui-stubs.test.ts` — both genuinely exercise the surviving helper.

After the cut, `pnpm --filter @gotgenes/pi-subagents run test` must stay green with the reduced suite.

## Invariants at risk

This step touches surfaces that Phase 19 Step 5 ([#442]) and earlier phases refactored, but only by deleting them, so no earlier `Outcome:` is regressed — it is fulfilled:

- Step 5's outcome ("`/agents` dissolved; the definition-management leaves orphaned for Step 6") is the precondition this step consumes.
  Verification that the leaves are still orphaned is the grep in Background (no surviving importer) — the standing guarantee that nothing re-wired them between Step 5 landing and this step.
- The "production duplication → 0 lines" target in the Phase 19 health-metrics table is met when `agent-config-editor.ts` is deleted.
  Pin: `pnpm fallow dupes` after the cut shows no production clone group.

No green-suite regression risk exists because no surviving code path is modified; the type checker and `fallow dead-code` are the guards that the deletion is complete and clean.

## Step Order

This is a pure-deletion plan with no red→green cycles, so it routes to `/build-plan`, not `/tdd-plan`.
Two commits, ordered for reviewability.

1. **Remove the orphaned subtree and prune the test helpers.**
   `git rm` the five source modules and four test files; prune `test/helpers/ui-stubs.ts` and `test/helpers/ui-stubs.test.ts` to `makeMenuUI` only.
   The `menu-ui.ts` deletion and the four-module deletion go together — deleting them in one commit means no dangling `import type { MenuUI }` ever exists at the type-check boundary.
   The helper prune rides in the same commit as the test-file deletion that orphans the helpers, so `fallow dead-code` sees a consistent state.
   Verify: `pnpm --filter @gotgenes/pi-subagents run check`, `… run test`, `pnpm fallow dead-code`, and `pnpm fallow dupes` (expect no production clone group) all green.
   Commit: `refactor(pi-subagents): remove orphaned agent-definition management subtree (#441)`.

2. **Update the current-state docs.**
   Edit `docs/architecture/architecture.md` (directory tree + Step 6 `Landed`/✅ note) and `.pi/skills/package-pi-subagents/SKILL.md` (UI domain row count + summary).
   Verify: `pnpm run lint` (rumdl) green.
   Commit: `docs(pi-subagents): record agent-definition subtree removal (#441)`.

## Risks and Mitigations

- **Risk:** a non-obvious importer of one of the five modules exists and the deletion breaks the type check.
  **Mitigation:** the Background grep already confirms zero `src/` importers and `index.ts` is clean; the Step 1 `check` is the backstop.
- **Risk:** pruning `ui-stubs.ts` removes a helper a surviving test still imports.
  **Mitigation:** verified `makeMenuUI` is the only helper imported outside the doomed test files (by `subagents-settings.test.ts`); it is explicitly kept.
- **Risk:** deleting `menu-ui.ts` was not anticipated by the issue body and could be seen as scope creep.
  **Mitigation:** it is mandated by the architecture doc (lines 346, 1076) and is a forced consequence of the orphan analysis; documented in Design Overview.
- **Risk:** `refactor:` commit type fails to trigger the batch release.
  **Mitigation:** Step 5's unreleased `feat(pi-subagents)!:` (`cb813f2c`, after `v17.5.0`) is already queued; release-please cuts the major bump on the next release regardless of this commit's type.
  `/ship-issue` reads the `**Release:** ship now — batch tail` marker and releases.

## Open Questions

None.
The two interpretation points (deleting `menu-ui.ts`; removing `makeMenuManager` whole) are resolved in Design Overview against the authoritative architecture doc and orphan analysis, not deferred.

[#442]: https://github.com/gotgenes/pi-packages/issues/442
[#443]: https://github.com/gotgenes/pi-packages/issues/443
