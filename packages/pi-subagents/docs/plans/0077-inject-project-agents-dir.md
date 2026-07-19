---
issue: 77
issue_title: "refactor: add projectAgentsDir to AgentMenuDeps instead of reading process.cwd() inline"
---

# Inject projectAgentsDir into AgentMenuDeps

## Problem Statement

`createAgentsMenuHandler` computes the project agents directory by reading `process.cwd()` inline via a lambda on line 63 of `ui/agent-menu.ts`:

```typescript
const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
```

The `AgentMenuDeps` interface already carries `personalAgentsDir: string` as an explicit field, but the project-side equivalent bypasses the injection boundary entirely.
`projectAgentsDir()` is called in at least five places inside the handler (`findAgentFile`, `ejectAgent`, `disableAgent`, `showCreateWizard`, `showManualWizard`).
This violates the code-style rule: "Do not read `process.cwd()` inside library/utility functions — accept the value as a parameter."

## Goals

- Add `projectAgentsDir: string` to `AgentMenuDeps`.
- Remove the inline `projectAgentsDir` lambda from `createAgentsMenuHandler`.
- Replace all five call sites with `deps.projectAgentsDir`.
- Wire the value at the call site in `index.ts` as `join(process.cwd(), ".pi", "agents")`.
- Update the test helper `makeDeps()` in `agent-menu.test.ts` to supply the new field.

## Non-Goals

- Removing other `process.cwd()` calls in `index.ts` (e.g., `loadCustomAgents`, `GitWorktreeManager`).
  Those are separate concerns tracked or already addressed elsewhere (e.g., #76 for `AgentManager`).
- Changing `personalAgentsDir` wiring or any other `AgentMenuDeps` fields.

## Background

### Relevant modules

| Module                       | Role                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/ui/agent-menu.ts`       | Contains `AgentMenuDeps` interface and `createAgentsMenuHandler` factory. Owns the inline `projectAgentsDir` lambda. |
| `src/index.ts`               | Extension entry point. Constructs the `AgentMenuDeps` object at line 228. Already passes `personalAgentsDir`.        |
| `test/ui/agent-menu.test.ts` | Tests for the menu handler. Has a `makeDeps()` helper that constructs `AgentMenuDeps`.                               |

### Constraints

From code-style skill:

> Do not read `process.env`, `process.cwd()`, or `process.platform` inside library/utility functions — accept the value as a parameter.

This is the same pattern applied in #76 (inject `cwd` into `AgentManager`), now applied to the UI layer.

`AgentMenuDeps` is internal — the public API surface (`exports` in `package.json`) is `service.ts` only, so this is a non-breaking change for consumers.

## Design Overview

The change is mechanical — add a field, remove a lambda, replace call sites:

1. Add `projectAgentsDir: string` to `AgentMenuDeps` (mirrors the existing `personalAgentsDir` field).
2. Delete the `const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");` lambda inside `createAgentsMenuHandler`.
3. Replace all five `projectAgentsDir()` call sites with `deps.projectAgentsDir`:
   - `findAgentFile` (line 68)
   - `ejectAgent` (line 312)
   - `disableAgent` (line 378)
   - `showCreateWizard` (line 416)
   - `showManualWizard` — uses the `targetDir` value from `showCreateWizard`, so not a direct call site
4. At the call site in `index.ts`, add `projectAgentsDir: join(process.cwd(), ".pi", "agents")` to the deps object.
5. In `makeDeps()`, add `projectAgentsDir: "/test-project/.pi/agents"`.

No new types, no interface changes beyond the one added field.

## Module-Level Changes

### `src/ui/agent-menu.ts`

- Add `projectAgentsDir: string` to the `AgentMenuDeps` interface.
- Remove the `const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");` lambda.
- Replace `projectAgentsDir()` with `deps.projectAgentsDir` at all call sites inside the factory closure.
- The `join` import from `node:path` may become unused in this file if no other call uses it — verify and remove if so.

### `src/index.ts`

- Add `projectAgentsDir: join(process.cwd(), ".pi", "agents")` to the `createAgentsMenuHandler({...})` call.
- Import `join` from `node:path` if not already imported.

### `test/ui/agent-menu.test.ts`

- Add `projectAgentsDir: "/test-project/.pi/agents"` to `makeDeps()`.
- No other test logic changes.

## Test Impact Analysis

1. No new unit tests are strictly required — the refactoring is mechanical and preserves behavior.
   However, a targeted test verifying that `findAgentFile` uses the injected `projectAgentsDir` (not `process.cwd()`) is valuable to prevent regression.
2. No existing tests become redundant.
3. All existing tests stay as-is; only the `makeDeps()` helper needs the new field.

## TDD Order

1. **Red: test that the injected projectAgentsDir is used** — add a test in `agent-menu.test.ts` that mocks `existsSync` and verifies `findAgentFile` (exercised via the menu handler) checks a path under the injected `projectAgentsDir`, not under `process.cwd()`.
   Commit message: `test: verify projectAgentsDir injection in agent menu (#77)`

2. **Green: add projectAgentsDir to AgentMenuDeps and wire it** — add the field to `AgentMenuDeps`, remove the inline lambda, replace all call sites with `deps.projectAgentsDir`, wire the value in `index.ts`, and update `makeDeps()` in the test helper.
   Commit message: `refactor: inject projectAgentsDir into AgentMenuDeps (#77)`

## Risks and Mitigations

| Risk                                            | Mitigation                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing a `projectAgentsDir()` call site        | `grep 'projectAgentsDir'` in `agent-menu.ts` confirms exactly five call sites (one definition + four usages). After the change, grep again to verify no `process.cwd()` calls remain. |
| `join` import becomes unused in `agent-menu.ts` | Check whether `join` is used elsewhere in the file (it is — `findAgentFile` uses `join` for the personal path). The import stays.                                                     |
| Behavioral change                               | Production call site passes `join(process.cwd(), ".pi", "agents")`, which produces the same value the lambda computed. No behavioral change.                                          |

## Open Questions

None — the issue's proposed change is unambiguous and mirrors the established `personalAgentsDir` pattern.
