---
issue: 48
issue_title: "feat: implement and publish SubagentsService at extension init"
---

# Retro: #48 — implement and publish SubagentsService at extension init

## Final Retrospective (2026-05-17T15:30:00Z)

### Session summary

Planned and implemented a typed `SubagentsService` interface with `Symbol.for()` accessor functions, an adapter wrapping `AgentManager` with model resolution and record serialization, and wired it into the extension init.
Released as `@gotgenes/pi-subagents@4.0.0` (breaking: old untyped global removed).
The plan was revised mid-session to align naming with `pi-permission-system`'s established conventions after the user flagged the discrepancy.

### Observations

#### What went well

- TDD execution was clean: 8 steps, zero rework, all 33 new tests green on first pass.
- The adapter design was well-scoped — `index.ts` wiring was +16/−12 lines, and the narrow `AgentManagerLike` interface made test mocks trivial.
- The allowlist serialization pattern (`toSubagentRecord`) prevents future leaks of non-serializable fields by default.

#### What caused friction (agent side)

- `missing-context` — The initial plan adopted the issue body's naming verbatim (`SubagentsAPI`, `api.ts`, `pi:service:subagents`, `(globalThis as any)`) without checking `pi-permission-system` for the established convention (`SubagentsService`, `service.ts`, `@gotgenes/<pkg>:service`, `Record<symbol, unknown>`).
  The user had to explicitly ask "Does this structure follow the pattern set forth by pi-permission-system?"
  Impact: full plan rewrite (replaced entire file), issue title update, issue body update — ~15 minutes of rework across 3 user turns.
  This was **user-caught**.

- `missing-context` — Same pattern as the #49 retro: following the issue spec literally without checking the codebase.
  The architecture doc also used the stale naming, reinforcing the wrong choice.
  Root cause: the "Gather context" step in `/plan-issue` didn't include a cross-package convention check.

#### What caused friction (user side)

- The user had to perform mechanical oversight ("Does this follow the pi-permission-system pattern?") that the planner should have caught independently.
  If the `/plan-issue` prompt included a step to grep sibling packages for established API patterns, this would have been a design decision surfaced during planning rather than a correction after the fact.

### Changes made

1. Created `packages/pi-subagents/docs/retro/0048-implement-subagents-api.md` (this file).
2. Updated `.pi/skills/package-pi-subagents/SKILL.md` — changed `SubagentsAPI` → `SubagentsService` in Implementation Priorities; added `service.ts` and `service-adapter.ts` to module dependency graph and descriptions.
3. Updated `.pi/prompts/plan-issue.md` — added step 7 to Gather context: check sibling packages for established API patterns before adopting issue body naming.
