---
issue: 227
issue_title: "Evolve AgentRecord into Agent with behavior (Phase 15, Step 1)"
---

# Retro: #227 — Evolve AgentRecord into Agent with behavior

## Stage: Planning (2026-05-27T12:00:00Z)

### Session summary

Produced an 8-step TDD plan to move per-agent behavior (`abort`, `queueSteer`/`flushPendingSteers`, `setupWorktree`) from `AgentManager` into `AgentRecord`, then rename `AgentRecord` → `Agent` across the codebase.
The plan follows a "add behavior first, rename last" strategy to keep behavior diffs small and the rename commit purely mechanical.

### Observations

- `AgentRecord` is internal-only (public API is `SubagentRecord` in `service.ts`), so the rename is non-breaking.
- The `queueSteer` method can be removed from `AgentManagerLike` and `SteerToolManager` interfaces entirely — both callers (`steer-tool`, `service-adapter`) already hold the agent reference from `getRecord()`, so they can call `agent.queueSteer()` directly.
- Queue removal in `abort()` must stay on `AgentManager` until #230 extracts `ConcurrencyQueue`.
- `RunHandle` ownership explicitly deferred to #228 — the plan does not touch `RunHandle` at all.
- The rename step (step 7) touches ~30 files but is purely mechanical; all behavior changes land in steps 1–6.

## Stage: Implementation — TDD (2026-05-27T13:00:00Z)

### Session summary

Completed all 8 TDD steps from the plan.
Added 9 new tests (steer buffering, `abort()`, `setupWorktree()`) and migrated 977 existing tests to the renamed `Agent` class.
Test count went from 977 to 986 across 62 test files.

### Observations

- Fallow reported `AgentInit` and `AgentStatus` as unused type exports from `types.ts`; suppressed with `// fallow-ignore-next-line unused-type` (correct singular form — tool's error message hints at this).
- `ESLint` auto-removed an `as any` cast in the `setupWorktree` test (the mock `WorktreeManager` already satisfied the interface structurally); staged and re-committed cleanly.
- Biome auto-formatted several test files during the rename commit; re-staged and re-committed.
- Pre-completion reviewer returned **WARN** for 4 stale diagram/table references in `architecture.md` and the `package-pi-subagents` skill table; all fixed before the final commit.
- No deviations from the plan's behavior design; the `queueSteer` removal from manager interfaces worked exactly as anticipated in the retro notes.

## Stage: Final Retrospective (2026-05-27T17:22:00Z)

### Session summary

Completed all stages in a single session: planning, 8 TDD steps, pre-completion review, shipping, and release as `pi-subagents-v10.1.0`.
Three behaviors (`abort`, steer buffering, worktree setup) moved from `AgentManager` to `Agent`, followed by a codebase-wide rename (33 files).

### Observations

#### What went well

- The "add behavior first, rename last" strategy kept behavior-adding commits small (1–2 files each) and the rename commit purely mechanical.
- Planning identified that `queueSteer` could be removed from `AgentManagerLike` and `SteerToolManager` entirely — this simplified the delegation step and eliminated an unnecessary indirection layer.
- Pre-completion reviewer caught 4 stale Mermaid diagram references and a skill table entry that the plan's step 8 did not anticipate; all fixed before shipping.

#### What caused friction (agent side)

1. `scope-drift` — Added `AgentInit` and `AgentStatus` to the `types.ts` re-export barrel during the rename step without verifying any file imports them from that path.
   Impact: fallow flagged dead code, triggering a 4-call suppression trial (`unused-export` → `unused-types` → `unused-type`), then the user identified the real fix (remove the speculative re-exports entirely), requiring a follow-up `fix:` commit after docs were already done.
2. `missing-context` — During the mechanical rename (step 7), `sed` commands matched `#test/helpers/make-record` but missed the relative import `"./helpers/make-record"` in `conversation-viewer.test.ts`.
   Impact: `pnpm run check` caught it in 1 tool call; minimal rework.
3. `missing-context` — The fallow skill documents `unused-export` as a suppression kind but not `unused-type`.
   Impact: 3 wrong guesses before the correct suppression syntax.
   Self-identified after fallow's error message suggested the correct kind name.

#### What caused friction (user side)

- The user's question about whether the fallow suppressions could be removed in a future step was a valuable prompt — it surfaced that the re-exports were speculative and could be removed immediately.
  Earlier intervention (e.g., during the TDD stage when the suppressions were added) would have avoided the `fix:` commit.

### Diagnostic details

- **Model-performance correlation** — Pre-completion reviewer ran as `pre-completion-reviewer` subagent (default model); appropriate for judgment-heavy work (doc staleness, code design review).
  No model mismatches.
- **Feedback-loop gap analysis** — `pnpm run check` was run after every delegation step (steps 2, 4, 6, 7) and after every behavior-adding step (steps 1, 3, 5).
  Verification was incremental throughout, not deferred to the end.
  The `conversation-viewer.test.ts` import miss in step 7 was caught immediately by the type checker.

### Changes made

1. `.pi/skills/fallow/SKILL.md` — Added `unused-type` suppression example alongside existing `unused-export` example.
2. `AGENTS.md` — Added "no speculative re-exports" rule to Code Style section.
