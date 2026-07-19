---
issue: 424
issue_title: "pi-subagents: drop the widget and activity-map dependencies from the subagent tool"
---

# Retro: #424 — pi-subagents: drop the widget and activity-map dependencies from the subagent tool

## Stage: Planning (2026-06-18T15:01:42Z)

### Session summary

Planned Phase 18 Step 5: dropping the `widget` constructor dependency from `AgentTool` and shedding the widget stub from `createToolDeps`.
Verified against current `main` that the `agentActivity` / activity-map dependency named in the issue and roadmap was already removed in Phase 18 Step 3 ([#422]) — only `widget` remains to drop, so the plan corrects that stale wording.
Produced `docs/plans/0424-drop-widget-dep-from-subagent-tool.md` and committed it.

### Observations

- The issue body and the architecture roadmap's Step 5 entry both still say `agentActivity`, but `grep` found no live `agentActivity`/`AgentActivity` references in `src/` — the only hit is a comment in `test/lifecycle/usage.test.ts`.
  Flagged the roadmap Step 5 description for a stale-wording fix during implementation.
- This is a purely subtractive, non-breaking refactor: `AgentTool` is internal (public exports are only the service and settings entries), and `ToolStartHandler` already captures UICtx on every `tool_execution_start`, which fires before any tool's `execute`.
  So removing the tool's own `setUICtx` call loses no behavior — `test/handlers/tool-start.test.ts` already pins UICtx capture on its true owner.
- Folded all edits into one refactor commit because removing the constructor parameter breaks the `index.ts:152` call site, the `make-deps.ts` fixture, and `agent-tool.test.ts` at typecheck time — they cannot land separately.
- Two obsolete tests to remove: `agent-tool.test.ts` → `"sets UI context on runtime at start of execute"` and `make-deps.test.ts` → `describe("widget defaults")`.
  The `UICtx` type itself stays (used by `agent-widget.ts`, `tool-start.ts`, and the widget test) — only the `UICtx` import in `agent-tool.ts` and the `AgentToolWidget` interface go.
- Skipped the `ask-user` gate: operator-authored issue (`gotgenes`), unambiguous proposed change following an established roadmap, clearly non-breaking.

## Stage: Implementation — TDD (2026-06-18T15:10:13Z)

### Session summary

Executed the two-step plan: one `refactor:` commit dropping the `widget` constructor dependency from `AgentTool` (plus the `UICtx` import, `AgentToolWidget` interface, the redundant `setUICtx` call, the `index.ts` call site, the `createToolDeps` field/stub, and two obsolete tests), and one `docs:` commit marking Phase 18 Step 5 complete in the architecture doc.
Test count went from 1039 to 1037 (−2 removed obsolete tests); `check`, root `lint`, full `test`, and `fallow dead-code` all green.

### Observations

- The refactor was purely subtractive and folded all src + test edits into one commit, as the plan predicted — the constructor-signature change breaks `index.ts`, `make-deps.ts`, and `agent-tool.test.ts` at typecheck simultaneously.
- Renamed the unused `execute` `ctx` parameter to `_ctx` rather than removing it — the inner `defineTool` `execute` closure must keep the 5-arg signature, so the method keeps the positional slot but ignores it.
- Corrected the architecture doc's Step 5 `Outcome` from "fixture drops 2 fields" to "drops 1 field" and noted the `agentActivity` half was already done in [#422] — the plan flagged this stale wording in advance.
- Pre-completion reviewer: WARN (1 non-blocking finding).
  The `package-pi-subagents` SKILL test count was stale (994/63 "as of Phase 17 Step 4"); refreshed to 1037/64 "as of Phase 18 Step 5" in a follow-up `docs:` commit.
  All cross-step invariants verified — UICtx capture stays pinned by `handlers/tool-start.test.ts`, and no `setUICtx` calls remain in spawn tools or the tool.

## Stage: Final Retrospective (2026-06-18T15:20:14Z)

### Session summary

Planned, implemented, and shipped Phase 18 Step 5 across three stages: a subtractive refactor dropping the `widget` constructor dependency from `AgentTool`, landed as one `refactor:` commit plus two `docs:` commits.
CI passed, `#424` closed; all commits since `pi-subagents-v16.6.0` are non-releasing (`refactor:`/`docs:`/`style:`), so release-please batches until a `feat`/`fix` lands.
Net test count 1039 → 1037 (−2 obsolete tests); the pre-completion reviewer returned WARN on a single stale-doc finding that was fixed inline.

### Observations

#### What went well

- Planning caught that the issue body and roadmap Step 5 both named an `agentActivity`/activity-map dependency that was already removed in [#422]; a `grep` of `src/` for `agentActivity` confirmed only `widget` remained.
  The `/plan-issue` "treat the proposed change as a hypothesis, verify against current code" discipline worked exactly as intended and prevented planning around a phantom dependency.
- The plan correctly predicted the atomic-commit shape: removing the constructor parameter breaks `index.ts`, `make-deps.ts`, and `agent-tool.test.ts` at typecheck simultaneously, so the implementation folded all edits into one commit with zero rework.
- Verification ran incrementally — `pnpm run check` plus the affected test files after the edits, then the full suite + root `lint` + `fallow dead-code` at the end of TDD — so no feedback-loop gap.
- Clean handoff between stages: the planning retro entry flagged the stale `agentActivity` wording in advance, and the TDD stage acted on it without re-deriving the context.

#### What caused friction (agent side)

- `missing-context` (low impact, recurring) — the `package-pi-subagents` SKILL.md hardcoded test count (`994 tests across 63 files as of Phase 17 Step 4`) was stale by four issues.
  The SKILL.md was edited by `docs:` commits in [#421], [#422], [#423], and [#424], yet none refreshed the count until the [#424] pre-completion reviewer flagged it.
  Impact: one extra `docs:` commit (`18900d3f`) at ship time; no rework, but the precise count is structurally prone to per-step drift and the reviewer caught it only by chance at one of five Phase 18 steps.

#### What caused friction (user side)

- None.
  The session was fully operator-authored and roadmap-driven; no user intervention or correction was needed at any stage.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (per its agent frontmatter), appropriate for judgment-heavy review; it produced a thorough, correctly-structured PASS/WARN report.
  The parent session switched models several times (`opus-4-8` → `sonnet-4-6` → `deepseek-v4-flash` → `opus-4-8`); execution stayed clean throughout, so no model-quality mismatch was observable.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no error sequence exceeded one tool call.
- **Unused-tool detection** — nothing notable; the work was fully specified by the plan and needed no exploratory dispatch.
- **Feedback-loop gap analysis** — verification was incremental (typecheck + affected tests per edit, full gates at end of TDD, root `lint` + `fallow` before push); no end-only verification gap.

### Changes made

1. Rewrote the opening sentence of the `## Testing` section in `.pi/skills/package-pi-subagents/SKILL.md` to drop both the hardcoded test count and the fork framing.
   The operator judged the precise count (`1037 tests across 64 files as of Phase 18 Step 5`) to provide no real value and to be structurally prone to per-step drift — it had gone stale across four issues ([#421]–[#424]) before the [#424] reviewer caught it.
   The fork is already introduced at the top of the skill, so the Testing section need not re-reference upstream; the sentence now reads "The package has an extensive `vitest` suite."

[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
