---
issue: 54
issue_title: "refactor: decompose src/index.ts into tool + menu modules"
---

# Retro: #54 — decompose index.ts into tool + menu modules

## Final Retrospective (2026-05-18T02:20:00Z)

### Session summary

Decomposed `src/index.ts` from 1,619 lines to 265 lines across 8 commits.
Extracted 7 new modules (`tools/helpers.ts`, `renderer.ts`, `notification.ts`, `tools/agent-tool.ts`, `tools/get-result-tool.ts`, `tools/steer-tool.ts`, `ui/agent-menu.ts`) with 66 new tests (379 → 445 total).
Released as `pi-subagents-v4.1.1`.
Filed follow-up #66 (replace `as any` casts with proper SDK types) and #67 (flaky `pi-autoformat` acceptance test).

### Observations

#### What went well

- Leaf-first extraction order worked cleanly — helpers, then renderer, then notification, then tools, then menu.
  Each step left the repo green with no cascading breakage.
- The `createNotificationSystem` factory pattern with arrow-closure capture of `widget` (assigned after `AgentManager` construction) preserved the existing deferred-reference semantics without restructuring initialization order.

#### What caused friction (agent side)

- `wrong-abstraction` — Applied the code-style skill's "keep Pi SDK imports out of business-logic modules" rule to tool/menu modules, which are SDK consumers, not business logic.
  Used `unknown` for `ExtensionContext`, `AgentSession`, `ModelRegistry` in factory dep interfaces, requiring 9 `as any` casts in `index.ts`.
  User caught this post-ship.
  Impact: filed #66 as a follow-up cleanup; the casts are cosmetic (no runtime effect) but degrade type safety.
  Fixed the code-style skill to clarify the boundary. (user-caught)

- `missing-context` — Four test files (`notification.test.ts`, `get-result-tool.test.ts`, `steer-tool.test.ts`, `agent-tool.test.ts`) omitted `compactionCount: 0` from `AgentRecord` factories.
  Caught at the final `pnpm run check` step, not during test writing.
  The testing skill already says "grep for ALL test files that construct a compatible mock."
  Impact: one extra fix cycle delegated to a subagent, no rework beyond that step. (self-identified)

- `other` — `Edit` tool failed 3 times matching the UTF-8 middle dot (`·`, U+00B7) in the steer tool's `stateParts.join(" · ")` line.
  The third attempt produced a partial match that left the file in a broken state (dangling orphan code after the replacement anchor).
  Required `git restore` and a fallback to `python3` line-range replacement.
  The same `python3` approach for the menu extraction lost the closing `}` of the default export function.
  Impact: ~5 minutes of rework across the two extraction steps, plus one `git restore`.

#### What caused friction (user side)

- The `as any` casts could have been caught earlier if the user had flagged the `unknown` types during the planning phase.
  However, the plan didn't prescribe exact interface types — that was an implementation decision.
  The user's post-ship review ("Why did we have to cast `as any`?
  Take a look at `packages/pi-permission-system/` as a model") was an efficient redirect that immediately scoped the investigation.

### Changes made

1. `.pi/skills/code-style/SKILL.md` — Clarified SDK-boundary guidance: tool definitions, event handlers, and command handlers may import SDK types directly; the restriction targets pure helpers and domain modules.
