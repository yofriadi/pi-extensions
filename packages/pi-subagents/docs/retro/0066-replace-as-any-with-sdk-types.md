---
issue: 66
issue_title: "refactor: replace `as any` casts in extracted tool/menu factories with proper SDK types"
---

# Retro: #66 — replace `as any` casts with proper SDK types

## Final Retrospective (2026-05-20T18:50:00Z)

### Session summary

Replaced all 14 `as any` casts in `src/index.ts` by typing 5 factory dep interfaces with proper SDK types (`ExtensionContext`, `AgentSession`, `ExtensionAPI`, `ModelRegistry`) and the newly-exported `SpawnOptions`.
Released as `pi-subagents-v5.8.1` with zero behavioral change across 520 tests.
The plan, implementation, and shipping were completed in a single session with 6 implementation commits.

### Observations

#### What went well

- Thorough context-gathering during planning paid off: reading all 5 dep interfaces, the SDK `.d.ts` files, test mock helpers, and the `ExtensionUIContext` shape before writing the plan meant most steps landed on first `pnpm run check`.
- The plan's risk table anticipated the cascading `as any` issue on `createAgentTool` and prepared a mitigation ("add explicit `satisfies ToolDefinition<…>` if needed"), which was close to the actual fix needed.
- Steps 4 and 5 (`GetResultDeps`, `SteerToolDeps`) were trivially clean — single-type-import changes that compiled immediately.

#### What caused friction (agent side)

- `missing-context` — The plan assumed `NotificationDeps.sendMessage.display` could be optional (`display?: boolean`) but the SDK's `CustomMessage.display` is required `boolean`.
  First `pnpm run check` after step 2 failed; required one extra edit-verify cycle.
  Impact: added friction but no rework (fixed in the same commit).

- `missing-context` — The plan did not check the `execute` function's full signature in `agent-tool.ts`.
  Removing the outer `as any` on `createAgentTool({...})` exposed three additional type mismatches: `onUpdate` parameter type (`unknown` vs `AgentToolResult<any>`), `signal` optionality (`AbortSignal` vs `AbortSignal | undefined`), and `params.description` (`unknown` vs `string`).
  The plan flagged cascading risk but assumed only the return type would be affected.
  Impact: step 3 required three extra edits and two extra `pnpm run check` cycles, noted as a deviation in the commit body.

- `missing-context` — Steps 6 and 7 had to be folded into one commit.
  The plan listed them as independent steps but typing `AgentMenuManager.spawnAndWait(ctx: ExtensionContext)` immediately made `MenuContext` incompatible — `showGenerateWizard` passes `ctx: MenuContext` to the dep callback that now expects `ExtensionContext`.
  The testing skill already warns: "when a TDD plan lists separate steps that share a type definition, changing that type in step N breaks steps N+1…N+k."
  The planner failed to recognize that `MenuContext` and `AgentMenuManager.spawnAndWait` share a type dependency through `ctx`.
  Impact: no rework — the steps were folded successfully — but the plan's step count was inaccurate.

#### What caused friction (user side)

- No user-side friction observed.
  The user ran three sequential prompts (`/plan-issue 66`, `/tdd-plan`, `/ship-issue`) with no corrections or redirects needed.
