---
issue: 424
issue_title: "pi-subagents: drop the widget and activity-map dependencies from the subagent tool"
---

# Drop the widget dependency from the subagent tool

## Problem Statement

The LLM-facing `subagent` tool's real concern is dispatch, yet `AgentTool` still takes a `widget` constructor dependency and calls `this.widget.setUICtx(ctx.ui)` at the start of `execute`.
Every `AgentTool` unit test has to stub the widget through `createToolDeps` — testability friction that marks the domain seam.
Now that the widget self-drives its timer from lifecycle notifications (Phase 18 Step 4, [#423]) and `ToolStartHandler` already captures the UI context on every `tool_execution_start`, the tool no longer needs the widget at all.

Note: the issue title and the roadmap entry for this step also mention an `agentActivity` / activity-map dependency, but that was already removed from `AgentTool` and the runtime in Phase 18 Step 3 ([#422]).
The only remaining dependency to drop is `widget`.
This plan corrects that stale wording where it appears in the roadmap.

## Goals

- Remove the `widget` constructor parameter from `AgentTool`; the tool depends only on manager / runtime / settings / registry / agentDir.
- Remove the now-redundant `this.widget.setUICtx(ctx.ui)` call from `AgentTool.execute` — UICtx capture stays in `ToolStartHandler`.
- Delete the `AgentToolWidget` interface and the `UICtx` import that only that interface used.
- Drop the `widget` field, its stub, and the `AgentToolWidget` import from the `createToolDeps` fixture.
- Update the `index.ts` call site and all affected tests in the same commit (the constructor-signature change breaks them at typecheck time).
- This change is **not breaking** — `AgentTool` is internal (the package's only public exports are the service and settings entries), and observable behavior is preserved because `ToolStartHandler` already captures UICtx before the tool executes.

## Non-Goals

- No change to `ToolStartHandler`, `AgentWidget`, or the `UICtx` type itself (it stays in `src/ui/agent-widget.ts`, consumed by the widget and `ToolStartHandler`).
- No change to `foreground-runner.ts` / `background-spawner.ts` (their widget driving was already removed in [#423]).
- No work on Phase 18 Steps 6–8 ([#425], [#426], [#427]) — the public-event-contract reconciliation, test-clone consolidation, and UI-direction ADR are separate steps.

## Background

Relevant modules and their current state:

- `src/tools/agent-tool.ts` — `AgentTool` constructor signature is `(manager, runtime, widget, settings, registry, agentDir)`.
  `execute` opens with `this.widget.setUICtx(ctx.ui as UICtx)`.
  The file defines the narrow `AgentToolWidget` interface (`setUICtx` only, already narrowed in [#423]) and imports `UICtx` from `#src/ui/agent-widget` solely for that interface and the cast.
- `src/handlers/tool-start.ts` — `ToolStartHandler.handleToolExecutionStart` already calls `this.widget.setUICtx(ctx.ui)` then `this.widget.onTurnStart()`.
  `tool_execution_start` fires before any tool's `execute`, so the widget already has the current UICtx by the time `AgentTool.execute` runs.
  This handler is wired in `index.ts` and is the canonical UICtx-capture site.
- `src/index.ts:152` — the sole `new AgentTool(...)` call site, passing `widget` as the third argument.
  `widget` is still constructed and registered as a lifecycle observer (`observer.add(widget)`) and passed to `ToolStartHandler` — those usages stay.
- `test/helpers/make-deps.ts` — `createToolDeps` builds an `AgentToolFixture` with a `widget` field stub (`{ setUICtx: vi.fn() }`) and imports `AgentToolWidget`.
- `test/helpers/make-deps.test.ts` — has a `describe("widget defaults")` block asserting the stub.
- `test/tools/agent-tool.test.ts` — `makeTool` passes `deps.widget`; the test `"sets UI context on runtime at start of execute"` asserts `deps.widget.setUICtx` was called.

AGENTS.md constraint: pi-subagents is a minimal core whose dependency arrows point inward.
Removing an outbound widget dependency from the LLM tool moves the package further toward "UI is a pure consumer of broadcast events," which is the stated precondition for the Phase 18 UI-direction decision.

## Design Overview

This is a purely subtractive refactor — no new collaborator, no new interface, no moved behavior.
The widget already receives its UICtx from `ToolStartHandler` on every turn's first tool execution, so the tool's own `setUICtx` call is redundant.

`AgentTool.execute` after the change opens directly with the registry reload:

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
	// Reload custom agents so new .pi/agents/*.md files are picked up without restart
	this.registry.reload();
	const config = resolveSpawnConfig(params, this.registry, this.runtime.getModelInfo(), this.settings);
	// ... unchanged
}
```

The `ctx` parameter is still required by the `defineTool` `execute` signature; the tool simply no longer reads `ctx.ui`.

New constructor signature:

```typescript
constructor(
	private readonly manager: AgentToolManager,
	private readonly runtime: AgentToolRuntime,
	private readonly settings: AgentToolSettings,
	private readonly registry: AgentTypeRegistry,
	private readonly agentDir: string,
) { /* unchanged body */ }
```

Edge cases:

- UICtx availability — `tool_execution_start` always precedes `execute`, so removing the tool's capture loses no coverage; the widget is registered as an observer and already has the UICtx when it renders.
- No behavior depends on the tool calling `setUICtx` twice per turn; the second call (in the tool) was idempotent for the same `ctx.ui` and a no-op when unchanged.

## Module-Level Changes

- `src/tools/agent-tool.ts`
  - Remove the `import { type UICtx } from "#src/ui/agent-widget";` line.
  - Remove the `AgentToolWidget` interface (and its doc comment).
  - Remove the `private readonly widget: AgentToolWidget` constructor parameter.
  - Remove the `this.widget.setUICtx(ctx.ui as UICtx);` statement and its comment from `execute`.
- `src/index.ts`
  - Update line 152: `new AgentTool(manager, runtime, settings, registry, getAgentDir())` (drop `widget`).
  - Leave the `widget` construction, `observer.add(widget)`, and `new ToolStartHandler(widget)` wiring unchanged.
- `test/helpers/make-deps.ts`
  - Drop `AgentToolWidget` from the imports from `#src/tools/agent-tool`.
  - Remove the `widget: AgentToolWidget` field from `AgentToolFixture` (and its doc comment).
  - Remove the `const widget: AgentToolWidget = { setUICtx: vi.fn() };` stub and the `widget,` entry in the returned object.
- `test/helpers/make-deps.test.ts`
  - Remove the `describe("widget defaults", ...)` block.
- `test/tools/agent-tool.test.ts`
  - Update `makeTool` to drop `deps.widget` from the `new AgentTool(...)` call.
  - Remove the `"sets UI context on runtime at start of execute"` test (UICtx capture is covered by `test/handlers/tool-start.test.ts`).
- `docs/architecture/architecture.md`
  - Mark Phase 18 Step 5 complete (✅) with a `Landed:` bullet, mirroring the Step 4 entry.
  - Correct the stale `agentActivity` mention in the Step 5 description (line ~979) — only the `widget` param remains to drop.
  - Update the step dependency diagram node `S5` to the completed (✅) marker.

Grep confirmation performed during planning: `AgentToolWidget` appears only in `src/tools/agent-tool.ts` and `test/helpers/make-deps.ts`; the `UICtx` type stays in use by `src/ui/agent-widget.ts`, `src/handlers/tool-start.ts` (via `unknown`), and `test/ui/agent-widget.test.ts`.
No `package-*/SKILL.md` references `AgentToolWidget` or the tool's widget dependency.

## Test Impact Analysis

1. New tests enabled: none required — this is a subtractive refactor, not a new seam.
   The remaining `AgentTool` tests get simpler (no widget stub to thread).
2. Tests that become redundant:
   - `test/tools/agent-tool.test.ts` → `"sets UI context on runtime at start of execute"` — the tool no longer captures UICtx; `test/handlers/tool-start.test.ts` (`"calls setUICtx with the context's ui"`) already pins that behavior on its true owner.
     Remove it.
   - `test/helpers/make-deps.test.ts` → `describe("widget defaults")` — the fixture no longer has a widget field.
     Remove it.
3. Tests that must stay as-is:
   - `test/handlers/tool-start.test.ts` — genuinely exercises UICtx capture, now the sole owner of that responsibility.
   - `test/ui/agent-widget.test.ts` — exercises the widget's own `setUICtx`, unaffected.
   - All other `AgentTool` dispatch/resume/background/foreground tests — exercise the tool's real concern and only shed the unused widget argument.

## Invariants at risk

Phase 18 Step 4 ([#423]) documented Outcome: "the widget is a reactive consumer; no inbound calls from core spawn tools."
This step extends that to the LLM tool.
The invariant that UICtx is captured exactly once per turn by `ToolStartHandler` is pinned by `test/handlers/tool-start.test.ts` (`"calls setUICtx with the context's ui"` and `"calls setUICtx before onTurnStart"`) — both stay green and require no new test.
No earlier step's `Outcome:` is regressed: the widget's self-driving timer (Step 4) is independent of the tool's removed `setUICtx` call.

## TDD Order

This is a behavior-preserving refactor; the green suite stays green.
Because removing the constructor parameter breaks the `index.ts` call site, the `make-deps` fixture, and the `agent-tool` tests at typecheck time, all source and test edits land in one commit.

1. **Refactor: drop the widget dependency from `AgentTool`.**
   Edit `src/tools/agent-tool.ts` (remove the `UICtx` import, `AgentToolWidget` interface, `widget` param, and `setUICtx` call), `src/index.ts` (drop `widget` from the constructor call), `test/helpers/make-deps.ts` (drop the field, stub, and import), `test/helpers/make-deps.test.ts` (remove the widget-defaults block), and `test/tools/agent-tool.test.ts` (drop `deps.widget` from `makeTool`, remove the UICtx test).
   Run `pnpm run check` and the full package suite.
   Commit: `refactor: drop the widget dependency from the subagent tool (#424)`.
2. **Docs: mark Phase 18 Step 5 complete.**
   Update `docs/architecture/architecture.md` — Step 5 ✅ + `Landed:` bullet, correct the stale `agentActivity` wording, update the `S5` diagram node.
   Commit: `docs: mark Phase 18 Step 5 complete and drop the tool widget dep (#424)`.

## Risks and Mitigations

- Risk: removing the tool's `setUICtx` loses UICtx for the widget in some path.
  Mitigation: `tool_execution_start` fires before every `execute`, and `ToolStartHandler` captures UICtx there; the existing handler tests pin this.
  Run the full suite, not just `agent-tool.test.ts`, since the change touches a shared fixture (`make-deps.ts`).
- Risk: an orphaned import left behind after deletions (Biome `noUnusedImports` is warning-level, exit 0).
  Mitigation: re-read `agent-tool.ts` and `make-deps.ts` after editing; confirm `UICtx` and `AgentToolWidget` have no remaining references via grep.
- Risk: the stale `agentActivity` wording is mistaken for live work to do.
  Mitigation: this plan explicitly records that `agentActivity` was already removed in [#422]; only `widget` remains.

## Open Questions

None — the scope is fully determined by the established roadmap and the verified current code state.

[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#426]: https://github.com/gotgenes/pi-packages/issues/426
[#427]: https://github.com/gotgenes/pi-packages/issues/427
