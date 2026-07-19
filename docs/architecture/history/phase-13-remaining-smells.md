# Phase 13: Remaining structural smells

## Summary

Phase 13 addressed the remaining fallow refactoring target, oversized methods, production duplication, SDK boundary coupling, and test clone families.
All six steps are closed: [#214], [#215], [#216], [#217], [#218], [#219].

## Steps

### Step 1: Convert remaining closure factories to classes — [#214]

Three closure factories converted to classes, making their dependencies explicit as constructor parameters.

| Factory → Class                                        | File                          |
| ------------------------------------------------------ | ----------------------------- |
| `createAgentConfigEditor()` → `AgentConfigEditor`      | `ui/agent-config-editor.ts`   |
| `createAgentCreationWizard()` → `AgentCreationWizard`  | `ui/agent-creation-wizard.ts` |
| `createSubagentsService()` → `SubagentsServiceAdapter` | `service/service-adapter.ts`  |

- Outcome: 0 remaining closure factories (excluding pure-function factories)

### Step 2: Decompose `buildParentContext` (cognitive 30) — [#215]

`buildParentContext` in `session/context.ts` was the only remaining fallow refactoring target.
Extracted per-entry-type formatters: `formatMessageEntry()` and `formatCompactionEntry()`.

- Target: `src/session/context.ts`
- Outcome: cognitive complexity < 10, function < 15 LOC, 0 fallow refactoring targets

### Step 3: Decompose `startAgent` in `agent-manager.ts` — [#216]

`startAgent` had two mutable closure variables and duplicated finalization logic in `.then()`/`.catch()`.
Introduced `RunHandle` lifecycle object (private to `agent-manager.ts`) that owns per-run cleanup state.
`WorktreeState` gained `performCleanup()` to eliminate ask-tell at cleanup sites.

Extracted:

1. `RunHandle` class — owns `unsub`/`detachFn`, `complete()`, `fail()`, idempotent `fireOnFinished()`.
2. `finalizeBackgroundRun()` — shared background finalization.
3. `setupWorktree()` — worktree creation with strict failure.
4. `flushPendingSteers()` — drain buffered steers on session creation.
5. `WorktreeState.performCleanup()` — self-cleanup eliminating ask-tell.

- Target: `src/lifecycle/agent-manager.ts`, `src/lifecycle/worktree-state.ts`
- Outcome: `startAgent` reduced to ~40 LOC; zero mutable `let` bindings in `.then()`/`.catch()`

### Step 4: Extract overwrite guard from UI — [#217]

Extracted the 20-line pattern duplicated between `agent-config-editor.ts` and `agent-creation-wizard.ts` into `writeAgentFile()` in `src/ui/agent-file-writer.ts`.

- Target: new `src/ui/agent-file-writer.ts`
- Outcome: 0 production clone groups (at the time; one internal group re-emerged later in `agent-config-editor.ts`)

### Step 5: Push SDK boundary in `settings.ts` — [#218]

Injected `agentDir: string` as a constructor parameter to `SettingsManager`, replacing the module-level `getAgentDir()` SDK call.

- Target: `src/settings.ts`, `src/index.ts`
- Outcome: `settings.ts` has 0 Pi SDK imports; `loadSettings`/`saveSettings` fully testable without SDK stubs

### Step 6: Reduce test duplication — top 3 clone families — [#219]

Extracted shared setup/assertion helpers for the three heaviest test clone families.

- Target: `test/lifecycle/agent-manager.test.ts`, `test/conversation-viewer.test.ts`, `test/ui/agent-config-editor.test.ts`
- Outcome: test duplication significantly reduced

## Metrics change

| Metric                     | Before                 | After                             |
| -------------------------- | ---------------------- | --------------------------------- |
| Health score               | 78/100 (B)             | 78/100 (B)                        |
| Source files               | 53                     | 56                                |
| Total LOC                  | 8,180                  | 8,382                             |
| Dead code                  | 0 files, 0 exports     | 0 files, 0 exports                |
| Maintainability index      | 90.7                   | 90.8                              |
| Avg cyclomatic complexity  | 1.5                    | 1.4                               |
| Fallow refactoring targets | 1                      | 0                                 |
| Production duplication     | 0 clone groups         | 1 internal clone group (11 lines) |
| Test duplication           | 59 groups, 1,046 lines | 38 groups, 645 lines (overall)    |
| Churn hotspots             | 6 accelerating         | 1 accelerating (`index.ts`)       |

[#214]: https://github.com/gotgenes/pi-packages/issues/214
[#215]: https://github.com/gotgenes/pi-packages/issues/215
[#216]: https://github.com/gotgenes/pi-packages/issues/216
[#217]: https://github.com/gotgenes/pi-packages/issues/217
[#218]: https://github.com/gotgenes/pi-packages/issues/218
[#219]: https://github.com/gotgenes/pi-packages/issues/219
