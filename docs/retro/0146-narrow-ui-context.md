---
issue: 146
issue_title: "Narrow UI context for menu handlers (Phase 9, Step N)"
---

# Retro: #146 — Narrow UI context for menu handlers

## Final Retrospective (2026-05-23T10:00:00Z)

### Session summary

Introduced a `MenuUI` interface in `agent-menu.ts` capturing the 6 `ctx.ui` methods used by menu handlers.
Replaced `ExtensionContext` with `MenuUI` (plus explicit `ModelRegistry` and `ParentSnapshot`) in all inner functions across `agent-menu.ts`, `agent-config-editor.ts`, and `agent-creation-wizard.ts`.
Dissolved three ≤4-field dependency bags (`AgentConfigEditorDeps`, `GetResultDeps`, `SteerToolDeps`) into plain parameters; destructured `AgentMenuDeps` and `AgentCreationWizardDeps` in their factory signatures.
Eliminated 42 `ctx as any` casts across 5 test files.
Released as `pi-subagents-v6.16.2`.

### Observations

#### What went well

- **User-initiated plan review caught three ordering bugs before implementation.**
  The user asked the agent to "review the plan and judge its quality and clarity" after the initial commit.
  The review identified three execution-blocking problems in the TDD order: `MenuUI` not defined before consumers, `ParentSnapshot` not threaded through the handler return type, and `index.ts` call sites not updated alongside their factories.
  All three were fixed before TDD execution began, saving significant implementation friction.
- The plan's TDD order (after fixes) worked well for a pure-refactoring change — all 806 tests stayed green throughout every step.
- The type checker served as an effective safety net: every call-site mismatch was caught immediately by `pnpm run check`, preventing runtime surprises.

#### What caused friction (agent side)

##### Planning session

- `missing-context` — The initial plan had three TDD ordering bugs: (1) `MenuUI` used before defined, (2) `ParentSnapshot` not threaded through handler return type, (3) `index.ts` call sites not updated alongside factory signature changes.
  These were caught by a user-prompted plan review, not by the planning agent itself.
  Impact: would have caused type-check failures during TDD execution; fixed before implementation started.

- `wrong-abstraction` — After fixing the plan, the agent ran `git commit --amend --no-edit` to update the plan commit, but it landed on the wrong commit (a stacked prompt-changes commit from a different session).
  This caused divergent history with origin.
  Recovery required `git reset --hard origin/main` and re-applying the plan fixes as a new commit (`3d5b591`).
  Impact: ~5 minutes of git recovery and re-application of edits.

##### Implementation session

- `missing-context` — In Step 3, the plan listed the `WizardManager.spawnAndWait` signature change (to accept `ParentSnapshot`) and the `AgentMenuManager.spawnAndWait` change as separate steps (3 and 4).
  But `agent-menu.ts` passes `deps.manager` (typed as `AgentMenuManager`) to `createAgentCreationWizard`, which expects `WizardManager`.
  Changing `WizardManager` without also changing `AgentMenuManager` broke the type checker.
  I had to pull the `AgentMenuManager` change forward from Step 4 into Step 3.
  Impact: minor — a few minutes of diagnosis and one extra edit, no rework.

- `missing-context` — In Step 2, after dissolving `AgentConfigEditorDeps` and changing `showAgentDetail(ctx)` to `showAgentDetail(ui: MenuUI)`, I forgot to update the call site in `agent-menu.ts` from `editor.showAgentDetail(ctx, agentName)` to `editor.showAgentDetail(ctx.ui, agentName)`.
  The type checker caught it immediately.
  Impact: added friction but no rework — one extra `pnpm run check` cycle.

- `missing-context` — In Step 4, the `makeUI()` test helper used `modelRegistry: {}` which didn't satisfy the `ModelRegistry` interface (requires `find` and `getAll`).
  Impact: one extra `pnpm run check` cycle and a one-line fix.

- `missing-context` — In Step 5, two tests called `createGetResultTool(makeDeps())` directly (not via the `execute()` helper).
  After dissolving deps, the factory signature changed but I only updated `execute()`.
  The type checker caught the two direct calls.
  Impact: one extra `pnpm run check` cycle.

#### What caused friction (user side)

- None observed — the session ran autonomously with no user corrections needed.

#### What caused friction (user side — planning)

- The user had to explicitly ask for a plan review (“I'd like you to review the plan and judge its quality and clarity”) to surface three ordering bugs.
  The planning agent should have caught these during plan authoring — the testing skill already contains rules about TDD step ordering and shared interface changes.
  The user's intervention prevented significant implementation friction.
