---
issue: 147
issue_title: "Inject text wrapping into ConversationViewer (Phase 9, Step O)"
---

# Retro: #147 — Inject text wrapping into ConversationViewer (Phase 9, Step O)

## Stage: Planning (2026-05-23T00:00:00Z)

### Session summary

Read the issue, loaded package-pi-subagents, code-design, testing, and markdown-conventions skills.
Explored `src/ui/conversation-viewer.ts`, `src/ui/agent-menu.ts`, `test/conversation-viewer.test.ts`, and the Phase 9 architecture roadmap.
Wrote and committed the plan at `packages/pi-subagents/docs/plans/0147-inject-wrap-text-into-conversation-viewer.md`.

### Observations

- The change is tightly scoped: two source files (`conversation-viewer.ts`, `agent-menu.ts`) and one test file.
- `wrapTextWithAnsi` is called in exactly four places inside `buildContentLines` — all in the same private method, making the replacement straightforward.
- The only production call site for `new ConversationViewer({…})` is `viewAgentConversation` in `agent-menu.ts`.
  `wrapTextWithAnsi` is added as a static import there and passed as `wrapText` — no threading through `AgentMenuDeps` needed.
- All `new ConversationViewer({…})` calls in the test file are inline (no shared factory helper), so every call site needs the new `wrapText` field added.
  Grep confirms the count: 11+ calls, all in `test/conversation-viewer.test.ts`.
- The plan uses 2 TDD cycles: Cycle 1 adds the field and updates all call sites (with the `vi.mock` still present for safety); Cycle 2 removes the mock and converts dynamic `await import()` to static imports.
  This ordering avoids a large simultaneous change and gives the suite a stable intermediate state.
- The "mock is intercepting wrapTextWithAnsi" test is deleted in Cycle 1 (it verified the mock mechanism, not production behavior).
- No exported API symbols are removed; `wrapText` is a new required field on `ConversationViewerOptions`, which is a breaking change only for external constructors of `ConversationViewer` — confirmed none exist outside this package.

## Stage: Implementation — TDD (2026-05-23T11:36:00Z)

### Session summary

Completed both TDD cycles from the plan.
Cycle 1 added `wrapText` to `ConversationViewerOptions`, destructured options in the constructor, replaced all four `wrapTextWithAnsi` calls with `this.wrapText`, updated `agent-menu.ts` to import and pass `wrapTextWithAnsi`, and updated all 16 test constructor call sites (11 render-width-safety + 5 safety-net) while keeping the `vi.mock` shim in place.
Cycle 2 removed the `vi.mock` block, `wrapOverride`, and `beforeEach` reset, then converted the dynamic `await import()` calls to ordinary static imports.
Test count: 806 → 805 (deleted the mock-mechanism sentinel test).
Full suite 50 files, 805 tests, all green.

### Observations

- The plan said the render-width-safety constructor calls numbered "11+" — the actual count was 16 total (11 render-width-safety + 5 safety-net), all in `test/conversation-viewer.test.ts`.
  No external call sites existed.
- `wrapTextWithAnsi` needed to be added to the dynamic import in Cycle 1 (`const { visibleWidth, wrapTextWithAnsi } = await import(...)`) because the render-width-safety tests reference it by name.
  The plan didn't call this out explicitly — minor omission.
- Used a Python script (inline via bash) to make the 17 constructor-call edits rather than 17 separate Edit-tool calls.
  The safety-net tests each had a different stub character (`X`, `Y`, `Z`, `B`, `W`) which required a regex capture group to preserve.
  The script worked on the first attempt.
- Cycle 2 was a single Edit call replacing the entire mock block + the two dynamic imports + `beforeEach`.
  The autoformatter then cleaned up import ordering automatically.
- Architecture doc updated: smells table row struck-through and Step O marked ✓.

## Stage: Final Retrospective (2026-05-23T11:45:00Z)

### Session summary

Planned, implemented, shipped, and released issue #147 across a single session chain.
Two TDD cycles completed cleanly; CI passed; issue closed; `pi-subagents-v6.17.0` released.
Test count: 806 → 805 (deleted mock-mechanism sentinel test).

### Observations

#### What went well

- Python script for bulk constructor edits worked first-try on 17 call sites with per-test regex capture groups.
  This is now a proven pattern — #116 and #147 both used it successfully for `ConversationViewer` constructor changes.
- Two-cycle TDD approach (Cycle 1: add DI with mock still present; Cycle 2: remove mock) gave a stable intermediate state and caught the missing `wrapTextWithAnsi` import before proceeding.
- Scope was tight: 3 files changed, 2 commits of substance, no rework on the production code.

#### What caused friction (agent side)

1. `instruction-violation` — Failed to load the `colgrep` skill during planning.
   Constructed the path by pattern (`.pi/skills/colgrep/SKILL.md`) instead of using the `<location>` listed in the `<available_skills>` block (`packages/pi-colgrep/skills/colgrep/SKILL.md`).
   Got ENOENT and silently moved on.
   Impact: user-caught; required a follow-up exchange to load the skill and re-review the plan.
   No rework needed — the plan was already correct.
2. `wrong-abstraction` — Cycle 2 Edit replaced the entire `vi.mock` block + dynamic imports as one chunk, leaving the `ConversationViewer` static import stranded after `const testRegistry` instead of at the top with other imports.
   Impact: user-caught ("Wait, we have a dynamic import?"); required a follow-up edit and amend into the retro commit.
3. `missing-context` — Plan stated "11+" constructor call sites; actual count was 16 (11 render-width-safety + 5 safety-net).
   The grep output during planning showed all 16 but the count wasn't verified.
   Impact: no rework — the Python script handled all 17 (16 test + 1 production) regardless.

#### What caused friction (user side)

- No friction identified — user interventions were timely and precise.

### Changes made

1. Appended this final retrospective entry to `packages/pi-subagents/docs/retro/0147-inject-wrap-text-into-conversation-viewer.md`.
2. Separated `colgrep` skill loading into its own bullet in `.pi/prompts/plan-issue.md` to reduce pattern-matching shortcuts.
3. Replaced deterministic step in `.pi/prompts/retro.md` with a "Sync with remote" section matching the other prompts.
