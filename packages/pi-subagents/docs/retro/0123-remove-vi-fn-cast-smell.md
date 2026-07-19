---
issue: 123
issue_title: "refactor(pi-subagents): remove vi.fn() cast smell from test helpers"
---

# Retro: #123 — remove vi.fn() cast smell from test helpers

## Final Retrospective (2026-05-22T00:00:00Z)

### Session summary

Planned and implemented removal of all 9 `as ReturnType<typeof vi.fn>` casts and 5 `vi.mocked()` calls across 3 test files, replacing them with named typed mock variables.
Released as `pi-subagents-v6.8.1`.
Pure test hygiene — no production code changes, no behavioral changes, 652 tests unchanged.

### Observations

#### What went well

- **Three-file scope executed cleanly once the plan was right.**
  Each file was an independent commit with no cross-file dependencies.
  The named-variable pattern (`const mockGetRecord = vi.fn<AgentManagerLike["getRecord"]>()`) worked identically across all three test files despite different mock construction styles (factory function vs `beforeEach` assignment).

#### What caused friction (agent side)

- `scope-drift` — The initial plan scoped the fix to `service-adapter.test.ts` only, listing `lifecycle.test.ts` and `tool-start.test.ts` as explicit Non-Goals — despite the planning-phase grep showing all 9 cast sites across 3 files.
  The user redirected with "let's eliminate this pattern of behavior."
  Updated the GitHub issue body, rewrote the plan, and amended the commit.
  Impact: plan rewrite (~2 minutes), no implementation rework.
  User-caught.
- `missing-context` — Imported `MockInstance` from `vitest` during step 1 (`service-adapter.test.ts`) but actually used `ReturnType<typeof vi.fn<...>>` — matching the pattern used in the other two files.
  The unused import was caught by `pnpm run lint` at the post-implementation check, not proactively.
  Impact: one extra edit + amend cycle.
  Self-identified (via lint).
- `other` — Ran `git commit --amend` to fix the unused import but HEAD was step 3's commit (`tool-start`), not step 1's (`service-adapter`).
  The amend landed the `service-adapter.test.ts` change into the wrong commit with the wrong message.
  Required `git reset --soft` back to the plan commit and recommitting all 3 files.
  Impact: ~1 minute of git surgery, clean result.
  Self-identified.

#### What caused friction (user side)

- The issue body scoped the fix to `service-adapter.test.ts` only, which the agent followed literally.
  The broader intent ("eliminate this pattern") was implicit.
  Flagging the desired scope as "all files with this pattern" in the issue body would have avoided the plan rewrite.

### Changes made

1. Wrote retro file at `packages/pi-subagents/docs/retro/0123-remove-vi-fn-cast-smell.md`.
