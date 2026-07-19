---
issue: 441
issue_title: "pi-subagents: remove the orphaned agent-definition management subtree"
---

# Retro: #441 — pi-subagents: remove the orphaned agent-definition management subtree

## Stage: Planning (2026-06-23T00:00:00Z)

### Session summary

Produced a deletion-only plan for Phase 19 Step 6: `git rm` the orphaned creation wizard, config editor, and their two file-ops helpers (plus tests), prune `test/helpers/ui-stubs.ts` to just `makeMenuUI`, and update the two current-state docs.
Verified against `main` that the five modules are pure orphans (no `src/` importer, `index.ts` clean) and that this is the unreleased tail of release batch "dissolve-agents".
The plan routes to `/build-plan` (no test cycles) with two commits.

### Observations

- Two deviations from the issue body, both forced by the codebase + the authoritative architecture doc rather than by preference, so no `ask_user` gate was used:
  1. `menu-ui.ts` (the `MenuUI` interface) must also be deleted — it is orphaned by the same cut, and `architecture.md` lines 346/1076 explicitly schedule its removal under #441.
     The issue body omits it.
  2. `makeMenuManager` is removed whole, not just its `spawnAndWait` field — after the four test files go, its only consumer is its own self-test, so it is residual clutter.
     The architecture doc's "if no surviving consumer remains" phrasing licenses this.
- `ui-stubs.ts` survives because `makeMenuUI` still has a real consumer (`subagents-settings.test.ts`); only the three other helpers (and the private `DEFAULT_TEST_AGENT_CONFIG` + the `AgentConfig` import) are pruned.
- Commit type is `refactor(pi-subagents):`, not `feat!:` — deleting already-unreachable code changes no observable behavior at this step.
  The release is driven by Step 5's unreleased breaking `feat!:` (`cb813f2c`, after tag `pi-subagents-v17.5.0`); landing this tail lets release-please cut the major bump.
- Production duplication goes to zero when `agent-config-editor.ts` is deleted (the 11-line `disableAgent`/`ejectAgent` clone); pin with `pnpm fallow dupes`.
- Historical docs under `docs/plans/`, `docs/retro/`, and `docs/architecture/history/` mention the deleted modules only as records of completed phases — left untouched per convention; only `architecture.md` current-state and `SKILL.md` are updated.

## Stage: Implementation — Build (2026-06-23T17:00:00Z)

### Session summary

Executed the two-commit plan: `git rm` the five orphaned `src/ui/` modules and four test files in one atomic commit; pruned `test/helpers/ui-stubs.ts` and `ui-stubs.test.ts` to `makeMenuUI` only in the same commit.
Second commit updated `architecture.md` (directory tree, Step 6 ✅ and Landed note, Mermaid node) and `SKILL.md` (UI domain row 11→6).
Three additional doc-fixup commits addressed stale `architecture.md` prose (domain flowchart, cross-extension diagram, "What the core owns," "Composition model") deferred from #442.
All checks green: 62 test files / 950 tests, `fallow dead-code` clean, `fallow dupes` shows 0 production clone groups.

### Observations

- The pre-completion reviewer surfaced five stale `architecture.md` sections not covered by the plan's declared doc scope — all carried over from #442's retro note "Deferred the holistic architecture-doc refresh … to the batch tail [#441]."
  Required three extra doc-fixup commits (`e440d0d1`, `04b13812`, and the SKILL.md file-count fix) beyond the plan's two.
  **Lesson:** when a retro note explicitly defers a doc refresh to the batch tail, include it in the batch-tail plan's "Module-Level Changes" doc section so it isn't discovered only by the reviewer.
- `makeMenuManager` was removed whole (not just its `spawnAndWait` relay) because its only post-cut consumer was its own self-test — exactly the right call, consistent with the planning decision.
- Final file count in `src/`: 57 (was 58 in SKILL.md header; now corrected).
- Pre-completion reviewer: **PASS** (third dispatch, after two WARN rounds on the stale doc sections).

## Stage: Final Retrospective (2026-06-23T18:30:00Z)

### Session summary

Shipped #441 as the tail of release batch "dissolve-agents": pushed, CI green, closed both #441 and the stacked #442, merged release-please PR #469, and cut `pi-subagents-v18.0.0`.
The whole arc (plan → build → ship) executed in one session with no rework to the deletion itself — the only friction was doc staleness inherited from #442, caught by the pre-completion reviewer across two WARN rounds.

### Observations

#### What went well

- The fresh-context `pre-completion-reviewer` earned its keep on a deletion task: it caught five stale `architecture.md` sections (a domain Mermaid diagram, a cross-extension diagram label, and three prose passages) that referenced modules deleted in #442, none of which the plan or the implementation agent flagged.
  Doc staleness is exactly the category a focused deletion misses, and the reviewer is the safety net that held.
- Batch-tail release mechanics worked exactly as planned: a `refactor(pi-subagents):` tail commit carried no version weight itself, the unreleased `feat(pi-subagents)!:` from #442 (`cb813f2c`) drove the major bump, and `release-please` cut `v18.0.0` cleanly while both issues closed with curated comments.

#### What caused friction (agent side)

1. `missing-context` (cross-session) — `#442`'s retro explicitly deferred a "holistic architecture-doc refresh" to the batch tail (#441), but #441's planning stage never pulled that deferred work into the plan's `Module-Level Changes` doc scope.
   The `/plan-issue` "Check for prior session context" step reads only the **current** issue's retro (`NNNN` matching the issue number), so a predecessor batch member's deferred work is invisible to it.
   Impact: three extra doc-fixup commits (`e440d0d1`, `04b13812`, and the `SKILL.md` file-count fix) and three pre-completion reviewer dispatches (two WARN, then PASS) during the build stage.
2. `wrong-abstraction` (fix scope) — after the first reviewer WARN named three stale sections, the fix addressed exactly those three rather than grepping `architecture.md` exhaustively for every reference to the deleted modules (`conversation-viewer`, `agent-menu`, `/agents`).
   Impact: the second review round found two more stale sections, forcing another fix → commit → re-review cycle that one exhaustive grep would have collapsed into the first round.

#### What caused friction (user side)

- None substantive.
  The user's two `Continue.` prompts during the build stage were mechanical resumptions (after an autoformat tool message and a context boundary), not redirections — the work was well-specified by the plan throughout.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` ran on `anthropic/claude-sonnet-4-6` (per its agent frontmatter), an appropriate match for judgment-heavy doc-staleness and design review; no high-cost-model-on-mechanical-work or weak-model-on-judgment mismatch.
  No other subagents were dispatched.
- **Unused-tool detection** — friction point 2 was a `grep`/`colgrep` gap: an exhaustive search for the deleted-module names across `architecture.md` after the first WARN would have surfaced all five stale references in one pass instead of two.
- **Feedback-loop gap analysis** — no gap; verification ran incrementally (baseline `check`/`lint` before edits, then `check`/`test`/`lint`/`fallow dead-code`/`fallow dupes` after each step, then the reviewer), not bunched at the end.

### Changes made

1. `.pi/prompts/plan-issue.md` — added step 5 to "Check for prior session context": a release-batch tail plan must read earlier batch members' retros for deferred work and fold it into `Module-Level Changes`.
2. `.pi/skills/pre-completion/SKILL.md` — added a line under "Overall: WARN": when a WARN names stale references to a deleted symbol, grep the file exhaustively for every instance before fixing, to avoid a second WARN round.

### Post-commit follow-up — stale `README.md`

After the retro commit, the user caught that `packages/pi-subagents/README.md` still documents the removed `/agents` command and conversation viewer and omits `/subagents:settings` and `/subagents:sessions` — a published, user-facing miss that shipped in `pi-subagents-v18.0.0`.

- `missing-context` (cross-session, user-caught) — the README was stale from #442's deletions (it documents `/agents`, not the module `agent-menu.ts`) and was never folded into #442's or #441's plan.
  The pre-completion reviewer's README check keyed on module names, not the command names a README actually documents, so a module-name match missed it.
  Impact: a user-facing doc defect shipped to npm; tracked as a follow-up in #470 (recommend `/plan-issue`).

3. Filed #470 to rewrite the stale `README.md` (removed `/agents` surface, missing `/subagents:` commands, eject UI gone).
4. `.pi/prompts/plan-issue.md` — `Module-Level Changes`: when a change adds, removes, or renames a slash command or user-facing feature, grep `packages/<PKG>/README.md` for the command/feature name (the `src/`-symbol grep misses command names).
5. `.pi/agents/pre-completion-reviewer.md` — broadened the forward-doc README check: when a change removes or renames a slash command or user-facing feature, grep the package `README.md` for the command/feature name, not just module names.
