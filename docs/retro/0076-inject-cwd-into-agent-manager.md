---
issue: 76
issue_title: "refactor: inject cwd into AgentManager constructor instead of reading process.cwd() in dispose()"
---

# Retro: #76 — inject cwd into AgentManager constructor

## Final Retrospective (2026-05-19T21:00:00Z)

### Session summary

Planned, implemented, and shipped a single-step refactoring that injects `cwd: string` into the `AgentManager` constructor, replacing the `process.cwd()` call in `dispose()` with `this.cwd`.
Released as `pi-subagents-v5.4.1`.
The entire cycle (plan → TDD → ship → release) completed in one session with one minor friction point.

### Observations

#### What went well

- Clean single-commit implementation: one `refactor:` commit touched 3 files, updated 18 test constructor calls plus one production call site, and added one new assertion — all green on first run.
- TDD Red phase worked well despite the plan calling this a "single-step refactoring."
  Writing a new test (`"calls pruneWorktrees with the cwd passed to the constructor"`) gave a clear Red signal before the implementation change, even though the constructor signature change had to be applied atomically.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan's "Test Impact Analysis" stated "No new unit tests are needed" and framed existing tests as sufficient.
  In practice, the existing tests only called `dispose()` in `afterEach` hooks without assertions on `pruneWorktrees` arguments, so a new test was needed for a proper Red phase.
  The user noticed the discrepancy before TDD began ("We will at least alter some tests, right?").
  Impact: one clarifying exchange, no rework.
  User-caught.

#### What caused friction (user side)

- None observed.
  The user's question about test changes was a useful early catch that would have surfaced during TDD anyway.
