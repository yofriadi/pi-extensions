---
issue: 376
issue_title: "Extract the manager observer from index.ts into a class"
---

# Retro: #376 — Extract the manager observer from index.ts into a class

## Stage: Planning (2026-06-15T00:00:00Z)

### Session summary

Planned Phase 17 Step 5: extracting the inline `SubagentManagerObserver` literal from `index.ts` into a `SubagentEventsObserver` class under `src/observation/`, constructed with narrow `emit` / `appendEntry` / `NotificationSystem` deps.
The plan is a single red→green→commit extraction (class + tests + `index.ts` wiring in one commit) plus a docs commit marking the step complete.
Classified as a non-breaking, pure internal extraction with no observable behavior change.

### Observations

- The issue is the operator's own (author `gotgenes` matches the gh user) and the architecture doc already specifies Step 5 precisely, so the `ask-user` gate was skipped.
- The class + `index.ts` swap must land in one commit: `index.ts` is the sole call site of the literal being replaced, and the new class needs a consumer to satisfy `pnpm fallow dead-code`.
- Kept `buildEventData` in `notification.ts` (it is tested there) and imported it into the new module — avoids churning `notification.test.ts`.
- Used `refactor:` for the extraction commit, matching the precedent of Phase 17 Step 4 (#375); `refactor` is hidden from the release-please changelog.
- Two structural smells were noted as out of scope: the `record.notification?.resultConsumed` Law-of-Demeter chain (track-and-watch) and narrowing `NotificationSystem` to a two-method `CompletionNotifier` per ISP (the issue prescribes passing `NotificationSystem`).
- Wiring `pi.events.emit` / `pi.appendEntry` as arrow callbacks in `index.ts` avoids the `@typescript-eslint/unbound-method` trap; mirrors the existing `SettingsManager` emit pattern.
- Step 6 (#377) depends on this step; the plan pins the previously-untested event/notification dispatch invariants so Step 6 cannot regress them.

## Stage: Implementation — TDD (2026-06-15T18:40:00Z)

### Session summary

Completed 2 TDD cycles: (1) extracted `SubagentEventsObserver` into `src/observation/subagent-events-observer.ts`, added 15 tests covering all four observer methods, and updated `src/index.ts` to replace the inline literal — all in one coupled commit; (2) marked Phase 17 Step 5 ✅ Complete in the architecture doc with a Landed note.
Test delta: 994 → 1009 (+15); file count 63 → 64 test files; `index.ts` 226 → 177 lines.
Pre-completion reviewer: PASS.

### Observations

- The typed `vi.fn<(channel: string, data: unknown) => void>()` mock triggered `@typescript-eslint/no-unnecessary-type-assertion` on `mock.calls[0]!` indexing — fixed by switching the error-status assertions to `toHaveBeenCalledWith("subagents:failed", expect.anything())` and the success-status assertion to `toHaveBeenCalledWith("subagents:completed", buildEventData(record))`.
  This eliminated all raw `mock.calls[0]` indexing from the file, which is cleaner.
- The autoformatter (`pi-autoformat`) ran after writing `index.ts`, so the import block was reflowed; re-reading before further edits would be required in any follow-up session.
- Architecture doc: Step 4's header was already missing its ✅ Complete marker (it had a Landed note); the reviewer noted this was corrected correctly, not a regression.
- All five previously-untested observer-behavior invariants are now pinned by tests for the first time.

## Stage: Final Retrospective (2026-06-15T22:55:15Z)

### Session summary

Phase 17 Step 5 ran cleanly end-to-end across planning, TDD, ship, and retro: one `refactor:` extraction commit plus a `docs:` roadmap update, +15 tests, `index.ts` 226 → 177 lines, released as `pi-subagents-v16.2.2`.
The plan correctly anticipated the class/`index.ts` coupling (one commit) and the `unbound-method` trap (arrow callbacks), so implementation followed the plan with a single minor test-assertion adjustment.
The pre-completion reviewer (on `claude-sonnet-4-6`) returned PASS and incidentally flagged a stale Step 4 checkmark that was corrected.

### Observations

#### What went well

- The lint feedback loop caught the only defect before it was committed: typed `vi.fn` made `mock.calls[0]!` an unnecessary assertion, surfaced by `pnpm run lint` between green and commit, fixed by switching to `toHaveBeenCalledWith(...)`.
  No follow-up commit was needed — verification ran incrementally (lint + test before each commit, `fallow dead-code` before push).
- The `pre-completion-reviewer` subagent earned its dispatch: beyond confirming the deterministic gates, it caught that Phase 17 Step 4's header was missing its `✅ Complete` marker (a prior-session oversight) and validated all six Mermaid diagrams.
- The plan's pre-work paid off — the coupling note (class + consumer + import removal in one commit to satisfy `fallow`) and the arrow-callback note for `emit`/`appendEntry` meant zero rework at those two known-risk points.

#### What caused friction (agent side)

- `missing-context` (self-identified) — the TDD test was written with `mock.calls[0]!` non-null assertions; typed `vi.fn<(channel: string, data: unknown) => void>()` makes the call tuple non-optional, so `@typescript-eslint/no-unnecessary-type-assertion` fired on every `!`.
  Impact: ~5 tool calls (turns 1–6) to diagnose and rewrite four assertions to `toHaveBeenCalledWith(...)`; caught by lint before commit, no rework.
- `missing-context` (self-identified) — the ship stage used `grep -oP` (Perl regex) to extract issue numbers; macOS BSD `grep` has no `-P`.
  Impact: one wasted tool call (turn 38), self-recovered with `sed` on turn 39.

#### What caused friction (user side)

- None.
  The single `ask_user` gate (release batching) was the appropriate strategic checkpoint and the user answered "close now"; no mechanical oversight was required.

### Diagnostic details

- **Model-performance correlation** — TDD ran on `claude-sonnet-4-6` (appropriate for judgment + code authoring); the `pre-completion-reviewer` subagent ran on `claude-sonnet-4-6` per its agent frontmatter (appropriate for review).
  The ship stage ran on `opencode-go/deepseek-v4-flash` — a cheaper model on a mostly-mechanical workflow (git, CI watch, issue close).
  It handled the one judgment call (release batching) correctly by asking the user and read the release-PR body for sibling bumps, but the `grep -oP` slip is the kind of environment mistake a weaker model is likelier to make; net match was acceptable.
- **Escalation-delay tracking** — no `rabbit-hole`; the longest single-issue run was the ~5-call `mock.calls[0]!` diagnosis, which was methodical (read → read → edit → lint → test), not thrashing.
- **Feedback-loop gap analysis** — no gap: `pnpm run lint` and `vitest run` ran before each commit and `fallow dead-code` ran from the repo root before push, exactly as the templates prescribe.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a § Test assertions bullet: assert mock calls with `toHaveBeenCalledWith(...)` rather than `fn.mock.calls[0]![0]`, since a typed `vi.fn` makes the call tuple non-optional and the `!` trips `@typescript-eslint/no-unnecessary-type-assertion`.
