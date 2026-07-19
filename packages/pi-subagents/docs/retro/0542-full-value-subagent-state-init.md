---
issue: 542
issue_title: "pi-subagents Phase 20 Step 8: full-value SubagentStateInit"
---

# Retro: #542 — pi-subagents Phase 20 Step 8: full-value SubagentStateInit

## Stage: Planning (2025-02-14T00:00:00Z)

### Session summary

Planned Phase 20 Step 8: extend `SubagentStateInit` to optionally seed the full value (`toolUses`, `lifetimeUsage`, `compactionCount`, `turnCount`, `activeTools`, `responseText`) so `SubagentState` is constructible anywhere in its value space, then collapse `createTestSubagent`'s post-construction mutation loops into direct init to drop its cyclomatic complexity from 19 to ≤ 8.
The change is purely additive and internal — no removed exports, no public-surface impact, no production behavior change.
Release recommendation: ship independently (Phase 20 Step 8 is tagged `Release: independent` and lands as a `refactor:`/`test:` commit).

### Observations

- Two design decisions worth flagging for implementation: `activeTools` is seeded by name (`string[]`) through `addActiveTool`, not by a full `Map`, to preserve the internal `_toolKeySeq` invariant (a caller-supplied map with hand-picked keys could collide with a later `addActiveTool` call).
  And `lifetimeUsage` must be spread-copied in the constructor, not aliased — `addUsage` mutates `_lifetimeUsage` in place, so a direct assignment would leak a mutable reference (output-argument smell).
  A dedicated test should mutate the source object after construction and assert the state is unchanged.
- The change is additive, so no existing `new SubagentState(...)` call site breaks at the type level — all current callers pass only transition fields.
  The default-construction tests in `test/lifecycle/subagent-state.test.ts` are the invariant guard for the `?? default` seeding branches; they must stay unchanged.
- Verified against `code-design` heuristics that this is legitimate design improvement, not procedure-splitting: the seeding moves onto the value object's own constructor which owns that state, widening a narrow init surface rather than relocating statements to lower a metric.
- Planned the architecture-doc `✅` step-mark (heading + Mermaid `S8` node + `Landed:` note) as a Step 3 TDD commit per the roadmap convention that `/tdd-plan` lands the mark at implementation completion.

## Stage: Implementation — TDD (2025-02-14T10:00:00Z)

### Session summary

Executed the 3 planned TDD steps plus one unplanned cleanup commit (4 total).
Extended `SubagentStateInit` with six optional value fields seeded in the constructor, collapsed `createTestSubagent`'s mutation loops into direct init, and landed the architecture-doc `✅` Step 8 mark.
Test count went from 991 → 996 in `pi-subagents` (5 new `subagent-state.test.ts` cases: full-value stats seeding, `lifetimeUsage` copy semantics, live-activity seeding, `activeTools` by-name removability, and a live-activity defaults case).

### Observations

- Tidy-First assessor reported no preparatory commits warranted; folded its two Optional notes into the impl commits (refreshed stale `TestSubagentOptions` JSDoc in Step 2; had the constructor own the defaults — dropped the now-redundant field-initializer literals — in Step 1 to avoid a double source of truth).
- Deviation from the plan: collapsing `createTestSubagent` removed the sole callers of three `Subagent` delegation wrappers (`incrementToolUses`, `addUsage`, `incrementCompactions`), which `fallow dead-code` then flagged.
  `record-observer` calls the `SubagentState` methods directly, so the `Subagent`-level wrappers were genuinely dead — removed them in a 4th `refactor:` commit rather than suppressing.
  The plan's Non-Goals covered the `SubagentState` accumulation methods (which stay); the delegation wrappers were a distinct, now-orphaned surface.
- Behavior-preservation check: `createTestSubagent` callers pass `toolUses: 0` and `turnCount: 1`/higher; the `??` seeding preserves both (`0 ?? 3` = 0; `1 ?? 1` = 1), and no caller passes `turnCount: 0`, so no drift from the old `turnCount > 1` loop guard.
- Verified the quantitative target via `fallow health --format json`: `createTestSubagent` dropped off both the `targets` and `large_functions` lists (was 19 cyclomatic, the workspace's most complex function).
- Pre-completion reviewer: PASS — all deterministic checks green (996 tests), Mermaid validated, cross-step invariants (#373 defaults) preserved, no stale doc references.

## Stage: Final Retrospective (2025-02-14T18:00:00Z)

### Session summary

Shipped Phase 20 Step 8 across three sessions (plan → TDD → ship) with near-zero friction: 4 implementation commits plus plan/retro breadcrumbs, all gates green on the first CI run.
The change widened `SubagentStateInit` to a full-value construction surface and collapsed `createTestSubagent` off the top of the fallow complexity list (19 → gone).
No release cut — the whole range since `pi-subagents-v18.0.3` is `refactor:`/`test:`/`docs:`(exclude-path), all hidden changelog types that auto-batch into the next unhidden release.

### Observations

#### What went well

- The plan's two flagged design hazards (`lifetimeUsage` aliasing, `activeTools` key-seq collision) both landed as concrete tests and constructor decisions without rework — planning-stage foresight paid off directly at implementation.
- The `fallow dead-code` gate in `/tdd-plan` caught the three orphaned `Subagent` delegation wrappers the plan did not anticipate, converting a latent dead-code leak into a clean 4th `refactor:` commit — the designed safety net worked exactly as intended.
- Incremental verification held: `pnpm run check` ran right after the Step 1 interface change, the full package suite after the Step 2 shared-helper change, and `fallow health --format json` confirmed the quantitative target before commit — no end-of-session verification pile-up.

#### What caused friction (agent side)

- `missing-context` — the plan's Module-Level Changes asserted "No removed or renamed exports, so no cross-file symbol grep for deletions is needed," but collapsing the test factory removed the sole callers of three public `Subagent` methods, orphaning them.
  Impact: one extra `refactor:` commit (`db4bb3a4`); no rework, caught by the `fallow dead-code` gate.
  Self-identified via the workflow gate.
- `instruction-violation` — the planning commit added a `[#542]:` reference-link definition for the doc's own issue number, which `rumdl` MD053 rejected; the `markdown-conventions` skill already says "Do not add a definition for the doc's own issue number — it lives in frontmatter."
  Impact: one edit before the plan commit; no rework.
  Self-identified (caught by the pre-commit `rumdl check`).

#### What caused friction (user side)

- None — the operator authored the issue and the plan direction was unambiguous, so no mid-session redirection was needed or missed.

### Diagnostic details

- **Model-performance correlation** — two read-only subagents dispatched: `tidy-first-assessor` (68s, 4 tool calls) correctly reported no preparatory commits warranted and stayed change-scoped; `pre-completion-reviewer` (216s, 37 tool calls) did judgment-heavy work (deterministic checks, Mermaid validation, cross-step invariant tracing) appropriate for a capable model.
  No mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no error sequence exceeded one tool call.
- **Unused-tool detection** — none; `colgrep`/`grep` used for caller discovery and `fallow` for the complexity target as designed.
- **Feedback-loop gap analysis** — verification was incremental, not end-loaded (see "What went well"); no gap.

### Changes made

1. `packages/pi-subagents/docs/retro/0542-full-value-subagent-state-init.md` — added this Final Retrospective stage entry.
   No prompt or `AGENTS.md` changes: both friction points (the plan-time dead-wrapper gap and the MD053 self-reference slip) were self-caught by existing gates (`fallow dead-code`, `rumdl`) and covered by existing rules, so no new instruction was warranted.
