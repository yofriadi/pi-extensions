---
issue: 108
issue_title: "refactor(pi-subagents): extract AgentTypeRegistry class from module-scoped state"
---

# Retro: #108 — extract AgentTypeRegistry class

## Final Retrospective (2026-05-21T13:30:00Z)

### Session summary

Planned and implemented the `AgentTypeRegistry` class extraction from module-scoped state in `agent-types.ts`.
The lift-and-shift approach across 7 TDD steps (9 commits including plan and docs) migrated 11 source files and 11 test files while keeping 574 tests green at every commit.
The `reloadCustomAgents` callback was removed from `AgentToolDeps` and `AgentMenuDeps`, replaced by `deps.registry.reload()`.

### Observations

#### What went well

- The `AgentConfigLookup` narrow interface (ISP) for `session-config.ts` kept tests simple — plain objects with 2 methods, no class instantiation needed.
- Using `vi.spyOn` on a real `AgentTypeRegistry` instance in `agent-menu.test.ts` was cleaner than `vi.hoisted` + `vi.fn()` factories: correct types, automatic cleanup via `vi.restoreAllMocks()`.
- Step 2 (inject through 4-file config-assembly chain) was the riskiest single step but landed cleanly because the `vi.mock("agent-types.js")` stubs were narrowed to only the free functions that `session-config.ts` still imports (`getMemoryToolNames`, `getReadOnlyMemoryToolNames`).

#### What caused friction (agent side)

1. `missing-context` — The plan's "Test files affected" table listed 8 files but missed 3 (`prompts.test.ts`, `tools/get-result-tool.test.ts`, `conversation-viewer.test.ts`) that directly import symbols being removed in step 7.
   The grep during planning found `prompts.test.ts` as an importer of `registerAgents` but didn't include it in the table.
   Impact: 3 extra test files needed updating in step 7; caught by the full-suite run, not by surprise in CI.

2. `wrong-abstraction` — First `perl -0777` regex for bulk-updating 16 `ConversationViewer` constructor calls in `conversation-viewer.test.ts` failed because the character class `[^)]+` didn't match the multi-line arguments.
   A simpler pattern targeting just the `vi.fn(),\n  );` suffix worked on the second try.
   Impact: added friction but no rework — ~2 minutes.

3. `missing-context` — Type check after step 7 revealed `promptMode: string` vs `"replace" | "append"` narrowing issue in `agent-runner-extension-tools.test.ts`.
   The `agentConfigMock.current` object had `promptMode: "replace"` which TypeScript widened to `string` when spread into the mock `AgentConfigLookup` return.
   Impact: one additional edit with a return-type annotation; caught by `pnpm run check` as recommended by the testing skill.

#### What caused friction (user side)

- No user-side friction observed.
  The issue description was clear, the architecture doc had the design already sketched, and no mid-session redirects were needed.
