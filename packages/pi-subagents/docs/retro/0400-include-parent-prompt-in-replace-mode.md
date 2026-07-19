---
issue: 400
issue_title: "perf(pi-subagents): include parent system prompt in replace mode for KV cache reuse"
---

# Retro: #400 — Include parent system prompt in replace mode for KV cache reuse

## Stage: Planning (2026-06-14T00:42:49Z)

### Session summary

Produced a numbered plan for including the parent system prompt as a cacheable prefix in `buildAgentPrompt()`'s replace branch, mirroring the [#180] append-mode reorder.
The change is a single-function edit plus test and README updates, planned across three TDD/docs commits.

### Observations

- Three design decisions were confirmed with the operator (issue author = gh user) before planning:
  1. Ship as breaking `perf!:` with a `BREAKING CHANGE:` footer — replace-mode agents inherit the parent prompt on upgrade with no user edit, and the thin two-line header is removed.
  2. Use `genericBase` as the no-parent fallback, consistent with append mode.
  3. Apply uniformly to all replace agents, including built-in `Explore` and `Plan` (one code path, no special-casing).
- The operator raised a cross-extension concern about the `genericBase` fallback interacting with `@gotgenes/pi-anthropic-auth`.
  Investigation of that package's `system-prompt-shaping.ts` / `request-shaping.ts` showed no new interaction: the `x-anthropic-billing-header` block is prepended unconditionally for OAuth, and de-fingerprinting keys off `PI_DEFAULT_PROMPT_PREFIX` (absent from `genericBase`, which is already neutral).
  Captured this in the plan's Background and Risks.
- `parentSystemPrompt` is a required `string` at the `session-config` layer (sourced from `snapshot.systemPrompt`), so the `genericBase` fallback is effectively a defensive/test-only path in real sessions.
- The thin replace header string (`You are a pi coding agent sub-agent`) appears only in `prompts.ts` and its test — no skill or live doc pins it; README needs three edits (Explore/Plan rows, `prompt_mode` table, Patch 3 `<active_agent>` wording, the last already slightly stale post-#180).
- Notable emergent scope point: `Explore`/`Plan` are built-in replace-mode agents, so this change affects them visibly — surfaced and confirmed rather than assumed.

## Stage: Implementation — TDD (2026-06-14T00:54:46Z)

### Session summary

Completed all 3 TDD cycles in `packages/pi-subagents`.
The change is a single-function edit to `src/session/prompts.ts` (hoist `identity`, rewrite replace branch) plus test updates and README/skill-doc corrections.
Test count went from 973 to 975 (+2 net new tests) across 59 test files.

### Observations

- Step 1 (Red): rewrote 2 existing replace-mode tests and added 2 new ones (4 failures confirmed against old code); the old "ignores parent prompt" test premise inverted cleanly into "includes parent prompt as base."
- Step 2 (Green): hoisting `const identity = parentSystemPrompt ?? genericBase;` above the `if` block and replacing the `replaceHeader` template were the only `src/` changes; also updated two positional `<active_agent>` tests in the same commit since they broke the moment the branch changed (`tagIdx === 0` → `toBeGreaterThan(0)`).
- The `BREAKING CHANGE:` footer wording was taken verbatim from the plan and landed in the `perf!:` commit.
- Pre-completion reviewer: WARN — one finding: `.pi/skills/package-pi-subagents/SKILL.md` still said "prepends" for the `<active_agent>` tag; fixed in a follow-up `docs:` commit before shipping.
- No deviations from the plan's Module-Level Changes list; no lockfile changes; fallow dead-code exited zero.

## Stage: Final Retrospective (2026-06-14T01:11:10Z)

### Session summary

Shipped #400 across three stages (Planning on `claude-opus-4-8`, TDD + Ship on `claude-sonnet-4-6`) as a single-function edit to `buildAgentPrompt()`'s replace branch plus tests and doc updates, released as `pi-subagents` v16.0.0 (major, breaking `perf!:`).
The run was clean end-to-end: two `ask_user` gates during planning, a 3-cycle TDD pass, one pre-completion WARN resolved before push, and a no-friction release-please merge.

### Observations

#### What went well

- Cross-extension investigation on demand — when the operator asked mid-`ask_user` how the `genericBase` fallback interacts with `@gotgenes/pi-anthropic-auth`, the agent read that sibling repo's `system-prompt-shaping.ts` and `request-shaping.ts` and proved no new interaction (billing header prepended unconditionally; de-fingerprinting keys off `PI_DEFAULT_PROMPT_PREFIX`, absent from the neutral `genericBase`) before answering.
  This converted an open worry into a documented Risk row rather than a deferred unknown.
- Emergent-scope surfacing — planning noticed that built-in `Explore`/`Plan` are replace-mode agents and so are visibly affected, then confirmed uniform application via a second `ask_user` instead of assuming.
- Autoformat discipline — after `pi-autoformat` touched `README.md` mid-edit, the agent re-read the region before the next edit (turns 49–50) rather than matching against stale layout, avoiding a failed `oldText`.

#### What caused friction (agent side)

- `missing-context` (planning) — the plan listed the README's Patch 3 `<active_agent>` "prepends" wording as a doc update but missed the identical Patch 3 description in `.pi/skills/package-pi-subagents/SKILL.md`.
  Exact-grep during planning keyed on removed strings (`You are a pi coding agent sub-agent`, `prompt_mode`); the stale prose carried none of them, so the skill file's "prepends `<active_agent>`" line was not found.
  Impact: the pre-completion reviewer caught it as a WARN, requiring one follow-up `docs:` commit (8e93d2a4) during TDD before push — no rework beyond that, and the safety net worked as designed.

#### What caused friction (user side)

- None — the operator's mid-planning OAuth question was a high-value redirect that strengthened the plan, not friction.

### Diagnostic details

- **Model-performance correlation** — judgment-heavy planning ran on `claude-opus-4-8`; mechanical TDD execution and the deterministic ship steps ran on `claude-sonnet-4-6`.
  Appropriate assignment in both directions; no mismatch.
- **Unused-tool detection** — the `colgrep` skill was loaded in planning but never used; exploration was all exact-symbol grep, which was correct for known symbols.
  The one place it would have helped is the `missing-context` friction: a semantic search like "docs describing how the active_agent tag is added to the system prompt" would likely have surfaced both the README and the SKILL.md descriptions that symbol-grep missed.
- **Feedback-loop gap analysis** — verification ran incrementally throughout (green baseline before cycle 1, per-file `vitest` each cycle, full suite + `check` + `lint` + `fallow` after the last step).
  No end-loaded verification.
- **Escalation-delay tracking** — no rabbit-holes; no error sequence exceeded one tool call.

### Changes made

1. `.pi/prompts/plan-issue.md` — extended the Module-Level Changes grep bullet: when a step reworks a documented mechanism's behavior (rather than removing a symbol), grep `.pi/skills/package-*/SKILL.md` for the mechanism name, since reworded prose carries no removed symbol to match.

[#180]: https://github.com/gotgenes/pi-packages/issues/180
