---
issue: 242
issue_title: "Rename `Agent` tool to `subagent`"
---

# Retro: #242 — Rename `Agent` tool to `subagent`

## Stage: Planning (2026-05-27T13:45:29Z)

### Session summary

Produced a plan for renaming the `Agent` tool to `subagent` across pi-subagents source, tests, README, and architecture docs.
Verified that pi-permission-system docs do not reference the `Agent` tool name and require no changes.
Scoped the plan to two commits: one `feat!:` for source + tests, one `docs:` for documentation.

### Observations

- The general-purpose agent type's `displayName` (`"Agent"` in `default-agents.ts` and `agent-types.ts` fallback) is a separate concept from the tool name and stays unchanged.
  Several test files assert this `displayName` — they are not affected by the rename.
- Issue #239 (Step 3, collapse `filterActiveTools`) is still open but independent — #242 only changes the string value in `EXCLUDED_TOOL_NAMES`, not its structure.
- The architecture doc already contains `(née \`Agent\`)` in the "What the core owns" section, anticipating the rename.
- The `widget-renderer.test.ts` comment references `"Agent"` as the general-purpose display name, not the tool name — only the comment text needs updating for clarity.

## Stage: Implementation — TDD (2026-05-27T13:55:33Z)

### Session summary

Completed 2 TDD cycles: one `feat!:` commit renaming the tool in source + tests, one `docs:` commit updating `README.md` and `docs/architecture/architecture.md`.
Baseline was 977 tests; test count unchanged at 977 after the changes.
Pre-completion reviewer returned **PASS**.

### Observations

- All changes were pure string-literal replacements in 2 source files, 4 test files, `README.md`, and the architecture doc — no logic, type, or structural changes.
- The general-purpose agent type's `displayName: "Agent"` in `default-agents.ts` and `agent-types.ts` fallback was correctly left unchanged; `display.test.ts` still passes with `"Agent"`.
- The description body inside the `agent-tool.ts` template literal needed separate edits because the guideline lines are not tab-indented (inside a backtick template literal, tab indentation does not apply).
- Pre-completion reviewer: PASS — all deterministic checks, conventional commits, documentation, code design, tests, Mermaid diagrams, and dead-code gate all passed.

## Stage: Final Retrospective (2026-05-27T14:07:32Z)

### Session summary

Completed the full plan→TDD→ship→retro lifecycle for #242 in a single session.
Released as `pi-subagents-v10.0.0` (major bump from `feat!:` breaking change).
Found and fixed one stale `Agent` tool reference in `.pi/skills/pre-completion/SKILL.md`.

### Observations

#### What went well

- Three-model pipeline (opus for planning, sonnet for TDD, deepseek-flash for shipping) matched task complexity to model capability with no quality issues.
- The plan's distinction between tool name (`"Agent"`) and agent-type `displayName` (`"Agent"`) prevented false-positive test updates — 8 test files reference `"Agent"` but only 4 needed changes.
- Pre-completion reviewer caught no issues (PASS), confirming thorough planning.

#### What caused friction (agent side)

1. `missing-context` — Two failed `Edit` calls on `agent-tool.ts` line 175: the template literal's guideline lines have no tab indentation, but the agent initially assumed tab depth from the surrounding function.
   Impact: 3 extra tool calls (grep to inspect actual indentation, then successful edit); no rework.
   Self-identified.
2. `wrong-abstraction` — Retro file edit duplicated Planning observations into the TDD stage because the `Edit` `oldText` matched from the Observations heading and the replacement included both old and new content.
   Impact: 2 extra tool calls (read file, full `write` to fix); no rework.
   Self-identified.
3. `missing-context` — `.pi/skills/pre-completion/SKILL.md` line 32 references the `Agent` tool by name but was not in the plan's scope.
   The plan checked pi-permission-system docs, `README.md`, and architecture docs but did not grep skill files for the old tool name.
   Impact: discovered during retro; fixed as a retro change.

#### What caused friction (user side)

- None — the full pipeline ran with zero user corrections.

### Diagnostic details

- **Model-performance correlation** — Pre-completion reviewer ran as a default-model subagent (292.7s, 36 tool uses, 63.9k tokens).
  Appropriate for the judgment-heavy review task.
  Ship stage on `deepseek-v4-flash` was notably efficient for purely mechanical work.
- **Feedback-loop gap analysis** — Verification was incremental: baseline check before TDD, per-file tests after Red and Green phases, full suite after implementation, then check + lint + fallow.
  No gaps.

### Changes made

1. `.pi/skills/pre-completion/SKILL.md` — updated stale `Agent` tool reference to `subagent` on line 32.
2. `.pi/agents/pre-completion-reviewer.md` — added rename-grep heuristic to the Skills bullet under Forward documentation checks: "When the change renames a symbol, grep `.pi/skills/` and `.pi/prompts/` for the old name."
