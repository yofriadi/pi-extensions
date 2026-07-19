---
issue: 116
issue_title: "refactor(pi-subagents): type housekeeping and small structural cleanups"
---

# Retro: #116 — type housekeeping and small structural cleanups

## Final Retrospective (2026-05-21T23:00:00Z)

### Session summary

Planned and executed 6 refactoring steps for issue #116: relocated 3 misplaced types from `types.ts` to their natural home modules, converted `createNotificationSystem` closure to a `NotificationManager` class, switched `ConversationViewer` to an options-bag constructor, and defined `AgentIdentity`/`AgentPromptConfig` narrow subset interfaces.
All 690 tests stayed green throughout; no behavioral changes.
Released as `pi-subagents-v6.9.2`.

### Observations

#### What went well

- The Python script approach for bulk-converting 16 `ConversationViewer` positional constructor calls to options-bag syntax was efficient and correct on the first attempt — all 17 tests passed immediately after the conversion.
- Proactive `grep -rn 'new ConversationViewer'` before step 5 caught the `agent-menu.ts` call site that the plan's Module-Level Changes section had omitted, avoiding a broken commit.
- The architecture doc update was clean — 5 targeted edits to mark E2 done, update smells table, and fix metrics.

#### What caused friction (agent side)

- `missing-context` — In all three type-relocation steps (1–3), I updated source-file imports but did not pre-flight grep for test-file imports of the relocated symbol.
  Each time, `pnpm run check` caught the stale test import, requiring an extra edit-check round trip.
  This happened with `test/renderer.test.ts` (step 1), `test/agent-runner.test.ts` + `test/agent-runner-extension-tools.test.ts` (step 2), and `test/prompts.test.ts` (step 3).
  Impact: 3 unnecessary edit-check cycles; no broken commits since the type checker caught every case before `git commit`.

- `missing-context` — In step 4, the first `Edit` call on `src/index.ts` failed because the autoformatter had merged the `NotificationDetails` type import (added in step 1) into the existing notification import line, changing the text I expected.
  Had to re-read the file to find the current import text.
  Impact: one wasted edit call plus a file read; added ~10 seconds of friction.

#### What caused friction (user side)

- No friction observed — the user's prompts were clear and the `/tdd-plan` and `/ship-issue` templates provided all needed structure.

### Takeaway

When relocating a type or symbol, always run `grep -rn 'SymbolName' src/ test/` before editing to identify *all* importers upfront — both source and test files.
This avoids the repeated pattern of "edit source → type-check fails on test → fix test → type-check again."
