---
issue: 219
issue_title: "Reduce test duplication — top 3 clone families (Phase 13, Step 6)"
---

# Reduce test duplication — top 3 clone families

## Problem statement

After Phase 12, three test files carry the heaviest remaining clone families in pi-subagents:

1. `test/lifecycle/agent-manager.test.ts` (929 lines) — 16 clone groups, ~160 duplicated lines.
   Repeated inline runner stubs, worktree stubs, and manager-lifecycle boilerplate.
2. `test/conversation-viewer.test.ts` (307 lines) — 8 clone groups, ~91 duplicated lines.
   Near-identical `ConversationViewer` construction in every test, plus repeated width-loop assertion patterns.
3. `test/ui/agent-config-editor.test.ts` (471 lines) — 5 clone groups, ~42 duplicated lines.
   Repeated `makeEditor()` + `makeMenuUI()` + `fileOps.findAgentFile.mockReturnValue(...)` setup.

Total target: reduce test duplication by ~200 lines (from ~1,046 combined test-setup lines to < 850).

## Goals

- Extract shared setup and assertion helpers for the three target test files.
- Reduce test duplication by ~200 lines without changing test semantics.
- Follow the existing `test/helpers/` convention (factory + matching `.test.ts` file).

## Non-goals

- No production code changes.
- No new test coverage — this is purely a refactoring of existing test infrastructure.
- Not consolidating clone families in other test files beyond the top 3.
- Not changing any assertion logic or test structure beyond replacing inline stubs with factory calls.

## Background

The project already has several shared test helpers in `test/helpers/`: `make-record.ts`, `mock-session.ts`, `ui-stubs.ts`, `runner-io.ts`, `stub-ctx.ts`, `make-deps.ts`.
Each helper has a companion `.test.ts` file — this convention must be followed.

Dependencies #214 (closure-to-class conversions) and #216 (startAgent decomposition) are both closed, so the production code these tests cover is stable.

## Design overview

### File 1: `agent-manager.test.ts` — extract to `test/helpers/manager-stubs.ts`

Five clone families to extract:

1. **Never-resolving runner** — `{ run: vi.fn().mockImplementation(() => new Promise(() => {})), resume: vi.fn() }` appears 5 times.
   Extract as `createBlockingRunner(): AgentRunner`.

2. **Session-creating runner** — runner that calls `opts.onSessionCreated?.(session)` and resolves.
   Appears 5+ times with minor variations (some emit events through the session, some don't).
   Extract as `createSessionRunner(session?: MockSession): AgentRunner` that calls `onSessionCreated` and returns a standard result.

3. **Worktree stubs with path+branch** — `{ create: vi.fn().mockReturnValue({ path, branch }), cleanup: vi.fn(() => ({ hasChanges: false })), prune: vi.fn() }` appears 4 times identically, plus 1 variant with `create` returning `undefined`.
   Extract as `createMockWorktrees(overrides?)`.

4. **Standard run result shape** — `{ responseText: "done", session, aborted: false, steered: false }` is repeated in many runner factories.
   Extract as `createRunResult(overrides?)`.

5. **Gated runner** — uses `Promise.withResolvers` to control when the runner completes.
   Appears 2 times.
   Keep inline — too tightly coupled to individual test flow-control to generalize cleanly.

Tests that construct custom runners with unique behavior (event-emitting runners in the `lifetimeUsage` and `compactionCount` tests) keep their inline stubs — those encode test-specific emission sequences that a shared factory would obscure.

### File 2: `conversation-viewer.test.ts` — inline factory + assertion helper

Two clone families to extract:

1. **`ConversationViewer` construction** — 15 near-identical constructor calls with the same 8 fields.
   Extract as an inline `createTestViewer(overrides?)` factory at the top of the test file.
   The factory provides defaults for `tui`, `session`, `record`, `activity`, `theme`, `done`, `registry`, and `wrapText`, and accepts overrides including a convenience `width` and `messages` parameter.

2. **Width-loop assertion** — the `for (const w of widths) { create viewer; assertAllLinesFit(viewer.render(w), w) }` pattern repeats in 10 "render width safety" tests.
   Extract as an inline `assertRenderFitsWidths(messages, widths?, viewerOverrides?)` helper.

These helpers stay inline (not in `test/helpers/`) because they depend on file-local helpers (`mockTui`, `mockSession`, `ansiTheme`) and are only used by this one test file.

### File 3: `agent-config-editor.test.ts` — inline setup helper

One clone family to extract:

1. **Detail-test setup** — `makeEditor()` + `makeMenuUI([...])` + `fileOps.findAgentFile.mockReturnValue(...)` + optional `fileOps.read.mockReturnValue(...)` appears in ~18 tests.
   Extract as an inline `setupDetail(selectResults, options?)` factory that returns `{ fileOps, editor, ui }` with pre-configured mocks.
   Options: `filePath`, `fileContent`, `config` (merged into default via `createTestAgentConfig`).

This stays inline because it's specific to the `showAgentDetail` test suite and depends on file-local `testRegistry` setup.

## Module-level changes

### New files

| File                                 | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `test/helpers/manager-stubs.ts`      | `createBlockingRunner`, `createSessionRunner`, `createMockWorktrees`, `createRunResult` |
| `test/helpers/manager-stubs.test.ts` | Smoke tests for the factories                                                           |

### Modified files

| File                                   | Change                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `test/lifecycle/agent-manager.test.ts` | Replace inline runner/worktree stubs with `manager-stubs` factories         |
| `test/conversation-viewer.test.ts`     | Add `createTestViewer` + `assertRenderFitsWidths` inline, migrate all tests |
| `test/ui/agent-config-editor.test.ts`  | Add `setupDetail` inline, migrate `showAgentDetail` tests                   |

### Unchanged files

No production source files are modified.
No other test files are modified.

## Test impact analysis

1. **New unit tests**: `manager-stubs.test.ts` adds smoke tests verifying factory return shapes (blocking runner never resolves, session runner calls `onSessionCreated`, worktree factory returns the expected interface, run result contains the correct fields).
2. **Simplified tests**: ~30 tests across the three files replace 3–6 lines of inline stub construction with 1-line factory calls.
3. **Unchanged tests**: All existing test assertions remain identical — only the setup code changes.
   Tests with custom runner behavior (event-emitting, gated, error-throwing) keep their inline stubs.

## TDD order

1. **Create `test/helpers/manager-stubs.ts` + `manager-stubs.test.ts`** Add `createBlockingRunner`, `createSessionRunner`, `createMockWorktrees`, `createRunResult`.
   Add smoke tests verifying each factory's return shape and basic behavior.
   Commit: `test: add manager-stubs helper factories (#219)`

2. **Migrate `agent-manager.test.ts` to use manager-stubs** Replace 5 inline never-resolving runners with `createBlockingRunner()`.
   Replace 4 identical worktree stubs with `createMockWorktrees()` / `createMockWorktrees({ create: ... })`.
   Replace inline session-creating runners with `createSessionRunner(session)` where the test only needs `onSessionCreated` wiring.
   Replace inline run-result objects with `createRunResult()` where the default shape suffices.
   Run `pnpm vitest run test/lifecycle/agent-manager.test.ts` to verify green.
   Commit: `test: migrate agent-manager tests to manager-stubs (#219)`

3. **Add inline factories to `conversation-viewer.test.ts` and migrate** Add `createTestViewer(overrides?)` inline factory with defaults for all 8 constructor fields.
   Add `assertRenderFitsWidths(messages, widths?, overrides?)` inline helper.
   Migrate all 10 "render width safety" tests to use `assertRenderFitsWidths`.
   Migrate all 5 "safety net" tests to use `createTestViewer`.
   Run `pnpm vitest run test/conversation-viewer.test.ts` to verify green.
   Commit: `test: reduce conversation-viewer test duplication (#219)`

4. **Add inline `setupDetail` to `agent-config-editor.test.ts` and migrate** Add `setupDetail(selectResults, options?)` returning `{ fileOps, editor, ui }`.
   Migrate `showAgentDetail` tests to use `setupDetail`.
   Run `pnpm vitest run test/ui/agent-config-editor.test.ts` to verify green.
   Commit: `test: reduce agent-config-editor test duplication (#219)`

5. **Final verification** Run `pnpm vitest run` (full suite) to confirm no regressions.
   Run `pnpm run check` to confirm no type errors.
   Commit is not needed — this is a verification-only step.

## Risks and mitigations

1. **Factory defaults diverge from test intent** — If a shared factory's defaults don't match what an individual test expects, assertions silently pass or fail for the wrong reason.
   Mitigation: diff all inline stubs against the proposed factory defaults before writing the factory.
   Keep tests with unique mock behavior inline rather than force-fitting them into a factory.

2. **Over-abstraction obscures test intent** — Extracting too many details into helpers makes tests harder to read.
   Mitigation: only extract truly duplicated boilerplate (stub construction); keep test-specific setup and assertions inline.
   The gated runner pattern stays inline for this reason.

3. **Intermediate broken state** — Partially migrated test files may have import conflicts.
   Mitigation: each TDD step fully migrates one file before committing.

## Open questions

None — the issue scope is well-defined and the dependencies are resolved.
