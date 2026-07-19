---
issue: 114
issue_title: "refactor(pi-subagents): narrow AgentToolDeps and AgentMenuDeps"
---

# Retro: #114 — narrow AgentToolDeps and AgentMenuDeps

## Final Retrospective (2026-05-21T21:43:48-04:00)

### Session summary

Narrowed `AgentToolDeps` from 9 to 6 fields and `AgentMenuDeps` from 8 to 7 fields.
Moved `subagents:created` event emission from the Agent tool to a new `AgentManagerObserver.onAgentCreated` method.
Extracted `buildTypeListText` to `tools/helpers.ts`, derived description text inside `createAgentTool`, removed dead `emitEvent` from `AgentMenuDeps`, and narrowed `agentActivity` to typed `AgentActivityAccess`/`AgentActivityReader` interfaces.
Test count increased from 638 to 660.
Released as `pi-subagents-v6.9.0`.

### Observations

#### What went well

- The `ask_user` gate during planning was well-targeted.
  The first question (where to move `emitEvent`) had a clear answer.
  The second (description-text derivation) genuinely needed user input, and the user requested more context via the "I could use more context" response — the follow-up `preview`-type question with fenced code blocks handled this cleanly.
- The 6-step TDD plan mapped to implementation with only one deviation (see below), caught exactly where the workflow is designed to catch it (the `pnpm run check` step).
- All 6 prerequisites (#108, #109, #110, #112, #113, #118) were verified as closed before planning.
  The observer issue (#112) was correctly identified from a `gh issue list` grep despite not being explicitly numbered in the issue body (the issue said "the observer issue").

#### What caused friction (agent side)

- `missing-context` (self-identified) — Step 6 narrowed `agentActivity` from `Map<string, AgentActivityTracker>` to `AgentActivityAccess` (which exposes only `get`/`set`/`delete`), but the test in `agent-tool.test.ts` used `.has()` on the map.
  The `pnpm run check` typecheck caught `Property 'has' does not exist on type 'AgentActivityAccess'`.
  Fixed by replacing `.has(id)` with `.get(id) !== undefined` in the same commit.
  Impact: one extra read + edit cycle (~30 seconds), no rework.

#### What caused friction (user side)

- Nothing — no user corrections or redirections needed during the session.
