---
issue: 170
issue_title: "refactor(pi-subagents): reduce buildContentLines complexity (cognitive 71)"
---

# Retro: #170 — reduce buildContentLines complexity

## Stage: Planning (2026-05-24T20:00:00Z)

### Session summary

Produced a plan to extract per-content-type formatters from `buildContentLines` (cognitive complexity 71) into a new `ui/message-formatters.ts` module.
The plan includes 8 TDD steps: 6 red→green steps for unit tests covering each formatter and the dispatcher, then 2 refactor steps to create the module and simplify `buildContentLines` to a dispatch loop.

### Observations

- The extraction is mechanical — each `if`/`else if` branch in the loop becomes a standalone pure function returning `string[] | null`.
- `FormatterContext` is deliberately narrow (2 fields: `theme` + `wrapText`) to avoid growing a dependency bag.
- File-local types (`ToolCallContent`, `BashExecutionMessage`) and helpers (`getToolCallName`, `isBashExecution`) move with the formatters since they have no other consumers.
- Existing `conversation-viewer.test.ts` tests are integration-level width-safety tests and remain unchanged — they exercise `render()` → `buildContentLines` → `truncateToWidth`, which is orthogonal to per-message formatting.
- Issue #164 (domain directory reorganization) is already implemented, so the file is at `src/ui/conversation-viewer.ts`.

## Stage: Implementation — TDD (2026-05-24T21:00:00Z)

### Session summary

Completed all 8 TDD steps: 6 red→green cycles building up `src/ui/message-formatters.ts` (one formatter per step), then 2 refactor steps moving helpers out of `conversation-viewer.ts` and replacing `buildContentLines` with a dispatch loop.
Test count went from 805 to 853 (+48 new unit tests in `test/message-formatters.test.ts`).
`conversation-viewer.ts` shrank from 325 to 251 lines.

### Observations

- `getToolCallName` needed to be exported (not just file-local) so `conversation-viewer.ts` could import it during the intermediate step 7 state; it stays exported since `message-formatters.ts` owns it permanently.
- The `AgentMessage` SDK type does not have an index signature, so the `formatMessage` call in `buildContentLines` required `as unknown as { role: string; [key: string]: unknown }` to satisfy TypeScript's structural checker — this is consistent with the existing `as any` pattern in the codebase for untyped SDK boundaries.
- The `formatStreamingIndicator` uses `◍` (U+25CD CIRCLE WITH VERTICAL FILL) to match the original `▍` character in `buildContentLines` — confirmed identical output.
- Pre-existing lint warning (`Theme` unused import in `conversation-viewer.test.ts`) was fixed as a `style:` commit alongside the final step.

## Stage: Final Retrospective (2026-05-24T22:00:00Z)

### Session summary

Shipped issue #170 (CI green, issue closed, released as `pi-subagents-v6.18.7`), then reviewed the full three-session lifecycle (planning → TDD → shipping) for friction patterns.

### Observations

#### What went well

- The extraction was clean: 48 new unit tests, no behavioral change, all 853 tests green throughout.
- The `FormatterContext` interface stayed at exactly 2 fields — the narrow-interface discipline held.

#### What caused friction (agent side)

1. `wrong-abstraction` — The plan decomposed 8 TDD steps for a mechanical extraction.
   Six separate test-only commits (one per formatter) added commit noise without meaningful red→green insight.
   Impact: added friction but no rework; a 2–3 step plan would have been cleaner for a copy-and-extract refactoring.
2. `missing-context` — Step 7 (move helpers) and step 8 (rewire `buildContentLines`) were planned as separate commits, but the intermediate state required temporarily exporting `getToolCallName` and keeping `extractText`/`describeActivity` imports.
   The plan didn't account for this intermediate dependency chain.
   Impact: one extra edit cycle to add then remove the temporary export.
3. `instruction-violation` (self-identified, user-caught) — The `/tdd-plan` prompt's step 5 says to check `packages/<PKG>/docs/architecture/` after the last TDD step.
   I did not update the architecture doc until the user asked.
   Impact: one extra commit and a user intervention; the rule was clear but missed during execution.
4. `missing-context` — The `formatMessage` dispatcher used `{ role: string; [key: string]: unknown }` as its parameter type, which required `as unknown as` at the call site because the SDK's `AgentMessage` union includes `CompactionSummaryMessage` without an index signature.
   The plan's design overview didn't anticipate this SDK type mismatch.
   Impact: one extra edit cycle during step 8, no rework.

#### What caused friction (user side)

- No friction observed — the user's single intervention (architecture doc) was a legitimate catch of a missed step.

### Changes made

1. Updated `packages/pi-subagents/docs/retro/0170-reduce-build-content-lines-complexity.md` with final retrospective stage entry.
