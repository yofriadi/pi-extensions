---
issue: 144
issue_title: "Consolidate observation model (Phase 9, Step L)"
---

# Retro: #144 — Consolidate observation model

## Final Retrospective (2026-05-23)

### Session summary

Planned and implemented the Phase 9 Step L observation model consolidation.
Removed dual `_toolUses`/`_lifetimeUsage` counting from `AgentActivityTracker`, added `session`/`outputFile` convenience getters to `AgentRecord`, migrated 14 callsites, and dissolved `NotificationDeps` into plain constructor parameters.
Released as `pi-subagents-v6.16.0`.

### Observations

#### What went well

- The plan correctly anticipated that TDD steps 4 (remove tracker stats) and 5 (migrate UI consumers) would be type-coupled and need merging.
  This played out exactly as predicted — no surprise rework.
- Step 2's grep sweep during `execution?.` migration found two callsites (`agent-tool.ts:315`, `agent-manager.ts:353`) that the plan's file list missed.
  Systematic grep at migration time caught them before commit.

#### What caused friction (agent side)

- `instruction-violation` — Did not load the `colgrep` skill during the planning phase despite two explicit instructions: AGENTS.md ("Use `colgrep` for intent-based codebase exploration") and the `/plan-issue` prompt ("load the `code-design` skill and the `colgrep` skill for convention discovery").
  Loaded 4 other skills but skipped colgrep.
  User-caught ("I noticed you didn't load or use `colgrep`").
  Impact: one extra round-trip with the user; no rework since the plan hadn't been committed yet.
  The colgrep searches proved useful once run — highest-scoring hit for "dependency bag converted to plain constructor parameters" was `notification.ts`, directly confirming the target.
- `wrong-abstraction` — When editing `src/ui/ui-observer.ts` to remove the `message_end` accumulation block, the replacement text closed the `session.subscribe(...)` callback but also added the function's closing brace, producing a duplicate `}`.
  Autoformat caught the parse error immediately.
  Impact: one follow-up edit, no downstream rework.

#### What caused friction (user side)

- None observed.
  The user's intervention on colgrep was timely — caught before plan commit, not after.
