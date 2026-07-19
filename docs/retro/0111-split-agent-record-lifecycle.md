---
issue: 111
issue_title: "refactor(pi-subagents): split AgentRecord lifecycle state into phase-specific objects"
---

# Retro: #111 — split AgentRecord lifecycle state into phase-specific objects

## Final Retrospective (2026-05-22T01:50:00Z)

### Session summary

Planned and implemented the `AgentRecord` lifecycle split across 12 TDD cycles plus doc updates, released as `pi-subagents-v6.8.0`.
Three new phase-specific collaborators (`ExecutionState`, `WorktreeState`, `NotificationState`) replace 9 post-construction mutable fields.
`pendingSteers` moved to a `Map` on `AgentManager`; stats (`toolUses`, `lifetimeUsage`, `compactionCount`) encapsulated behind mutation methods with read-only getters.
`AgentRecordInit` trimmed from 19 optional fields to 4.

### Observations

#### What went well

- **Lift-and-shift scaled from 7 files (#110) to 18 files (#111) without any intermediate test breakage.**
  Every commit left all 41 test files passing.
  The pattern — add new alongside old, migrate consumers with fallbacks (`record.execution?.session ?? record.session`), strip fallbacks in a final commit — is reliable for multi-step encapsulation refactors.
- **Stats encapsulation was simpler than expected.**
  Converting `toolUses`, `lifetimeUsage`, `compactionCount` to private fields with getters and mutation methods required zero changes to read-only consumers because the getter names match the old field names.
  Only `record-observer.ts` (the sole writer) needed updating.
- **The `createTestRecord` factory intersection type trick preserved backward compatibility.**
  The factory accepts `toolUses?: number` via `Partial<AgentRecordInit> & { toolUses?: number; ... }` and internally calls `record.incrementToolUses()` in a loop.
  This let 10+ test files continue passing `toolUses: 5` without rewriting each to call mutation methods directly.
- **`Promise.withResolvers` timing analysis in the plan was unnecessary.**
  The plan spent ~40 lines analyzing whether `promise` should live inside `ExecutionState` and concluded it should stay separate.
  Implementation confirmed: `record.execution` is set in `onSessionCreated` (async callback), `record.promise` is set after `runner.run()` (synchronous return) — different moments, straightforward.

#### What caused friction (agent side)

- `missing-context` — In the step 7 test for `record.execution`, the initial mock runner used `mockResolvedValue(...)` which doesn't call `onSessionCreated`, so `record.execution` stayed `undefined`.
  Had to switch to `mockImplementation(async (..., opts) => { opts.onSessionCreated?.(session); ... })`.
  The existing tests in the same file already use this pattern for record-observer tests, but I didn't check them first.
  Impact: one test rewrite (~2 minutes), no rework to production code.
- `scope-drift` — Step 4 absorbed step 5 (adding collaborator fields) without noting the merge in the commit or session log.
  Step 5 became a no-op.
  Impact: no rework, but the session narrative skipped a plan step without explanation.
- `wrong-abstraction` — Step 12 was planned as a simple cleanup ("remove old fields and trim `AgentRecordInit`") but required coordinated changes across 18 files: removing 9 fields from `AgentRecordInit`, updating the `createTestRecord` factory, fixing 5 test files that passed removed fields, and stripping all fallback patterns.
  This was 2-3 steps' worth of work compressed into one.
  Impact: step 12 took significantly longer than other steps, though it landed cleanly.
- `missing-context` — Did not proactively flag the `as ReturnType<typeof vi.fn>` cast smell in `service-adapter.test.ts` while migrating that file.
  The user noticed it and asked about it.
  Filed as #123.
  Impact: added friction but no rework; follow-up issue created.
  User-caught.

#### What caused friction (user side)

- No material friction observed.
  The user's `ask_user` decisions during planning (NotificationState collaborator, Map on AgentManager) gave clear direction.
  Quick "follow-up" response on the cast smell kept scope tight.

### Changes made

1. `packages/pi-subagents/docs/retro/0111-split-agent-record-lifecycle.md` — this retro file.
2. `.pi/skills/testing/SKILL.md` — added field-removal rule symmetric to the existing field-addition rule (esbuild silent pass-through on unknown init properties).
