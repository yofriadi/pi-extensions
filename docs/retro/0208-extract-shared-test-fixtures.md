---
issue: 208
issue_title: "Extract shared test fixtures to reduce test duplication"
---

# Retro: #208 — Extract shared test fixtures to reduce test duplication

## Stage: Final Retrospective (2026-05-25T22:00:00Z)

### Session summary

Reviewed the planning, TDD, and shipping sessions for issue #208.
The work completed Phase 12 of the pi-subagents improvement roadmap.
Identified Vitest v4 type compatibility as the dominant friction pattern, and the user surfaced a strategic insight: shared test factories are treating symptoms of ISP violations in production interfaces.

### Observations

#### What went well

- The planning session's duplication diff (comparing default values across all copies before writing the shared factory) prevented cascading assertion failures during migration — the testing skill rule paid off.
- Using a Python script for the `agent-manager.test.ts` spawn consolidation (step 9) handled 42 multi-line replacements with 7 distinct patterns cleanly in one pass.
- `pnpm run check` caught 4 separate type errors that Vitest's esbuild would have silently ignored at runtime: wrong `findAgentFile` parameter type, dropped `AgentConfig` import, unused `@ts-expect-error` directives, and `Mock<Procedure>` incompatibility.

#### What caused friction (agent side)

1. `missing-context` — Wrote `vi.fn().mockReturnValue([])` in the shared factory without checking whether `Mock<Procedure>` is structurally assignable to the production function signatures (`RunnerIO`, `AgentFileOps`).
   The testing skill warns about `ReturnType<typeof vi.fn>` at the field level, but I didn't connect this to the structural-compatibility scenario where a factory's return value flows to a typed production parameter.
   Impact: 37 type errors after step 2, requiring a fixup commit (2953adc) and removal of the `assemblerOverrides` parameter.
2. `missing-context` — Assumed `findAgentFile` took `(dir: string, name: string)` based on test usage patterns rather than checking the `AgentFileOps` interface.
   The actual signature is `(name: string, dirs: string[])` — the second parameter is `string[]`.
   Impact: caught by `pnpm run check`, fixed in the same commit, no rework.
3. `scope-drift` — Removed `import type { AgentConfig }` from `agent-config-editor.test.ts` because the symbols it was needed for (`testDefaultConfig`, `testCustomConfig`) were being removed.
   Didn't check that `buildEjectContent` tests 400 lines later also used `AgentConfig`.
   Impact: caught by `pnpm run check`, one-line fix, no rework.
4. `premature-convergence` — Added `@ts-expect-error` directives for `.mock` property access in the factory tests, assuming TypeScript wouldn't know about Mock's `.mock` property.
   Once the `vi.fn()` stubs were typed with implementations, TypeScript recognized the Mock type and `.mock` was accessible, making all 5 directives unused.
   Impact: added friction but no rework — eslint caught them.

#### What caused friction (user side)

- No friction caused by the user.
  The user's post-ship reflection ("we need to eliminate complex setup, right?") was a strategic insight that elevated the conversation from mechanical duplication reduction to ISP-driven interface narrowing.
  This kind of mid-session reframing is valuable and came at exactly the right time — after the work was done, so it informs future phases rather than disrupting the current one.

#### Phase 13 guidance: ISP narrowing targets

The `test/helpers/` factory inventory is a concrete map of production interfaces worth narrowing:

| Factory             | Production interface                                          | Methods                       | Consumer usage                   |
| ------------------- | ------------------------------------------------------------- | ----------------------------- | -------------------------------- |
| `createRunnerIO`    | `RunnerIO` (`EnvironmentIO & SessionFactoryIO`)               | 8 (7 functions + assemblerIO) | Most tests use 2–3               |
| `makeFileOps`       | `AgentFileOps`                                                | 6                             | Most tests use `exists` + `read` |
| `createToolDeps`    | `AgentToolManager` + `AgentToolRuntime` + `AgentToolSettings` | 12+ across 3 interfaces       | Spawners use 2–3 each            |
| `createMockSession` | `AgentSession` (SDK class)                                    | 5 stubs                       | Observers use `subscribe` only   |
| `createAgentLookup` | `AgentConfigLookup`                                           | 2                             | Already narrow ✓                 |

When a factory needs its own unit tests, the interface it stubs is too wide for its consumers.
The fix is ISP narrowing of the production interface, not more test infrastructure.

### Changes made

1. Added rule to `testing` skill: typed implementations in shared factories when return value satisfies a production interface.
2. Added ISP signal to `improvement-discovery` skill Category D table: shared factory complexity → narrow the production interface.

## Stage: Implementation — TDD (2026-05-25T21:00:00Z)

### Session summary

Completed all 10 TDD steps plus a type-fix commit.
Created 4 new files (`runner-io.ts`, `runner-io.test.ts`, `ui-stubs.ts`, `ui-stubs.test.ts`) and migrated 7 existing test files.
Test count grew from 884 → 913 (+29 tests in new helper unit tests).

### Observations

- Vitest v4 changed `vi.fn()` without implementation annotation to type `Mock<Procedure | Constructable>`, which is NOT assignable to specific function signatures in production interfaces.
  The fix was to add typed implementation annotations (`vi.fn((_path: string): boolean => false)`) to all vi.fn() stubs in the shared factories.
  This was a new friction point not anticipated in the plan.
- The plan's `assemblerOverrides` parameter in `createRunnerIO()` was removed because the `??` union typing caused `Mock<Procedure | Constructable> | Mock<specific-fn>` which TypeScript couldn't resolve as assignable to `RunnerIO`.
  No consumer test actually used the override parameter, so removing it simplified both the implementation and the type story.
- The `findAgentFile` signature in `AgentFileOps` is `(name: string, dirs: string[])` — the second parameter is `string[]`, not a second string as initially assumed from test patterns.
  This was caught by `pnpm run check`.
- The `agent-config-editor.test.ts` migration removed the `import type { AgentConfig }` import that was still needed by `buildEjectContent` tests further down the file.
  Also caught by `pnpm run check`.
- `STUB_SNAPSHOT` replacement was safe: no consumer test asserts on snapshot field values.
  The `mockSnapshot` in `agent-manager.test.ts` had `systemPrompt: "parent prompt"` vs `STUB_SNAPSHOT`'s `"test prompt"` but this caused no test failures.
- Architecture doc was updated to reference `test/helpers/` (correcting `test/fixtures/` from the original entry).

## Stage: Planning (2026-05-25T20:00:00Z)

### Session summary

Analyzed the three heaviest test clone families identified by fallow and designed a 10-step TDD plan to extract shared factories into `test/helpers/`.
Decided to follow the existing `test/helpers/` convention rather than the `test/fixtures/` directory mentioned in the issue and architecture doc.

### Observations

- Issue #131 (closed) already extracted `createMockSession`, `createToolDeps`, and `createTestRecord` — this issue targets the remaining duplication.
- The `createRunnerIO` factory in `agent-runner.test.ts` and `agent-runner-extension-tools.test.ts` includes stale `buildMemoryBlock` and `buildReadOnlyMemoryBlock` stubs that no longer match the `AssemblerIO` interface — the shared factory will clean these up as a side benefit.
- Session mock factories in the runner tests are structurally specialized (each serves a different test purpose) and were explicitly scoped as non-goals — extracting them would create a confusing multi-mode factory.
- The `agent-runner-extension-tools.test.ts` uses a mutable `agentConfigMock.current` pattern that doesn't fit into a shared static factory — only `createRunnerIO` is shared from that file.
- `STUB_SNAPSHOT` from `stub-ctx.ts` can replace all 5 local `ParentSnapshot` definitions — verified no test asserts on the specific field values.
- The `agent-manager.test.ts` internal duplication (~42 repetitive spawn calls) is best handled with local `spawnBg()`/`spawnFg()` helpers rather than cross-file extraction.
