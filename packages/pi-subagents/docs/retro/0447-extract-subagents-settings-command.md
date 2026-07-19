---
issue: 447
issue_title: "pi-subagents: extract subagent settings to a focused /subagents-settings command"
---

# Retro: #447 — pi-subagents: extract subagent settings to a focused /subagents-settings command

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Produced a numbered TDD plan for Phase 19 Step 2: a purely additive extraction of `AgentsMenuHandler.showSettings` into a standalone `SubagentsSettingsHandler` registered as the `/subagents-settings` command.
Confirmed the command name against the closed spike (#446) and its ADR-0004 addendum (Criterion 4), and verified `SettingsManager` already structurally satisfies the new narrow manager interface so it can be passed directly.
The plan ships independently (roadmap `Release: independent`).

### Observations

- The extraction is a faithful verbatim lift — `showSettings` already had zero coupling beyond `this.settings` and `ui`, so the design-review checklist came back clean (100% field usage on both new narrow interfaces, no LoD/output-arg smells).
  Classified as a genuine collaborator extraction, not procedure-splitting.
- Declared two narrow interfaces owned by the new module: `SubagentsSettingsManager` (shape-identical to the doomed `AgentMenuSettings` but with no import from `agent-menu.ts`) and `SubagentsSettingsUI` (drops `confirm`/`editor`/`custom` from `MenuUI` — ISP).
- Strictly additive: `agent-menu.ts` is untouched, and its settings tests stay as-is because the in-menu path keeps shipping until Step 5 (#442) deletes the file.
  Removing them now would drop coverage of a live surface.
- Preserved the single-selection-then-return semantics of `showSettings` verbatim (no re-show loop) — flagged a settings re-show loop as a deferred UX open question.
- Two small TDD steps (handler+tests, then `index.ts` registration); noted they may fold into one commit since the export and its sole call site are tiny, with `pnpm run check` required right after the wiring step.
- No third-party `ask_user` gate needed — issue filed by the operator (`gotgenes`), direction fixed by ADR-0004, design unambiguous.

## Stage: Implementation — TDD (2026-06-20T14:30:00Z)

### Session summary

Implemented Phase 19 Step 2 in two TDD cycles plus a doc-sync commit: added `SubagentsSettingsHandler` (with narrow `SubagentsSettingsManager` and `SubagentsSettingsUI` interfaces) lifted verbatim from `AgentsMenuHandler.showSettings`, then registered the `/subagents-settings` command in `index.ts`.
Test count went 1051 → 1062 (+11, one new file `test/ui/subagents-settings.test.ts`).
Full suite, `tsc`, root lint, and `fallow dead-code` all green.

### Observations

- The lift was clean: `SettingsManager` already exposed all six members of the new narrow manager interface, so the `index.ts` wiring passed `settings` directly with zero adapter — `pnpm run check` confirmed structural satisfaction.
- `makeMenuUI` from `ui-stubs.ts` was reused as the UI stub without modification — its wider shape (`confirm`/`editor`/`custom`) structurally satisfies the narrower `SubagentsSettingsUI`, so no new helper was needed.
- Kept the two cycles as separate commits rather than folding them; the export and its sole call site were small enough that either would have been valid.
- Deviation from plan: flipped `✅` on the architecture Step 2 heading and its Mermaid node now (the plan had flagged this as a ship-time open question).
  Applied per the `/tdd-plan` template's roadmap-completion rule; verified the diagram still renders via `mmdc`.
  The phase status row was left unchanged (only 1 of 7 steps done).
- `agent-menu.ts` was not touched (verified by the reviewer via `git log`), preserving the additive-only constraint.
- Pre-completion reviewer: WARN.
  Reviewer warnings: one non-blocking finding — `.pi/skills/package-pi-subagents/SKILL.md` records `ui/` as 10 modules (now 11); the plan intentionally deferred this coarse-summary update to a later Phase 19 doc-sync.
  No FAILs; all deterministic checks PASS, verbatim-lift fidelity and ISP of both narrow interfaces confirmed.

## Stage: Final Retrospective (2026-06-20T18:36:58Z)

### Session summary

Shipped Phase 19 Step 2 (#447) end to end across planning, TDD, and ship stages, releasing `pi-subagents` `17.1.0`.
The one off-script event was a user-reported Mermaid syntax error in `architecture.md`, which I localized by extracting all six diagram blocks and running `mmdc` on each, then fixed by quoting the offending flowchart node labels.
Execution was otherwise clean: two green TDD cycles (+11 tests), a WARN pre-completion review (one intentionally-deferred doc finding), and a correct `UNSTABLE`/`GITHUB_TOKEN` release-merge fallback.

### Observations

#### What went well

- Localizing the Mermaid error with the diagram name wrong: the user called it the "State dependency diagram" but the broken block was the "Step dependency diagram" flowchart.
  Rather than guess from the ambiguous name (I had glanced at the `stateDiagram-v2` lifecycle and the `classDiagram` first), I scripted extraction of all six `mermaid` fences and ran `mmdc` on each — block 6 failed with `got 'PS'`, pinpointing the exact line.
  Brute-force validation beat name-matching.
- The release-merge fallback worked exactly as the ship prompt describes: `release_pr_merge` refused on `merge_state: UNSTABLE`, the status-check rollup was empty (the `GITHUB_TOKEN` no-checks case), and `gh pr merge 450 --rebase` + `git pull --ff-only` landed `17.1.0` linearly.

#### What caused friction (agent side)

- `missing-context` (prior session) — the broken diagram was authored in `74e2374f docs: mark Phase 19 Step 1 spike complete (#446)`: a flowchart node label `S1[✅ Step 1 - Spike (#446)]` with unquoted parentheses, which Mermaid parses as a nested round-node shape (`Expecting ... got 'PS'`).
  It was committed without an `mmdc` pass and slipped through `pnpm run lint` (rumdl validates markdown, not Mermaid semantics) and CI.
  Impact: surfaced two sessions later as a user-caught defect; one extra `docs:` fix commit (`90ca6e2d`) this session.
  Root cause is a coverage gap: the `mermaid` skill's pitfall list does not mention parentheses/shape-delimiter characters in node labels, so the exact failure mode was undocumented.

#### What caused friction (user side)

- None material.
  The diagram-name mismatch ("State" vs "Step" dependency diagram) added one or two orienting reads but did not cause rework — the all-blocks `mmdc` sweep absorbed the ambiguity.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on `anthropic/claude-sonnet-4-6` (judgment-heavy review work); appropriate match, no over/under-powered mismatch.
- **Escalation-delay tracking** — the Mermaid detour resolved in ~5 progress-making tool calls (extract blocks → `mmdc` each → read error → quote labels → re-validate); not a rabbit-hole, no subagent escalation warranted.
- **Unused-tool detection** — none; `mmdc` (the correct validator) was used directly.
- **Feedback-loop gap analysis** — verification ran incrementally throughout TDD (per-file `vitest` in each red/green, `pnpm run check` right after the interface-bearing wiring step, full suite + root lint + `fallow dead-code` at the end), not just terminally.

### Changes made

1. `.pi/skills/mermaid/SKILL.md` — added a "Parentheses and special characters in node labels" pitfall (with the `S1[✅ Step 1 - Spike (#446)]` WRONG/RIGHT example from this session) covering the `(`/`[`/`{`/`:` shape-delimiter trap that produced the `got 'PS'` parse error.

### Follow-up (not implemented — suggest a GitHub issue + `/plan-issue`)

1. **CI Mermaid-validation gate** — run `mmdc` over every `mermaid` fence as part of `pnpm run lint` or a pre-commit hook, so a broken diagram (like `74e2374f`'s unquoted-parens node) fails at author time instead of surviving to a user-caught defect.
   Out of retro scope (infra, touches `package.json`/lint config/hooks); record as its own issue.
