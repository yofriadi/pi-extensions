---
issue: 448
issue_title: "`enabled: false` does not prevent explicitly spawning disabled agents"
---

# Retro: #448 — `enabled: false` does not prevent explicitly spawning disabled agents

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Planned the fix for a third-party bug report: `enabled: false` agent overrides are hidden from the available-types list but still spawnable when named explicitly via `subagent_type`.
The plan adds a disabled-type gate in `resolveSpawnConfig` (returning an explicit error) and a `enabled` filter in `buildTypeListText`, both localized changes with no new collaborators or interface changes.

### Observations

- Issue author (`nickadminroot`) is not the operator (`gotgenes`), so I ran the `ask-user` direction gate.
  Operator confirmed: fix it, **return an explicit error** (`Agent type "<Name>" is disabled`) rather than the lenient fall-back-to-`general-purpose` alternative, and **include both fixes** (spawn path + tool-description list).
- Root cause is `resolveType` → `resolveKey` ignoring `enabled`; the registry already has `isValidType` (checks `enabled`) but it was unused on the spawn path.
  The gate reuses `isValidType`, leaving `resolveType` / `resolveAgentConfig` untouched so UI consumers that intentionally resolve disabled configs keep working.
- Rejected changing `resolveType` or `resolveAgentConfig` directly — `agent-config-editor.ts` and `agent-menu.ts` rely on resolving disabled agents to display/edit/re-enable them.
- For the tool-description fix, chose to filter inside `buildTypeListText` rather than re-define `getDefaultAgentNames` / `getUserAgentNames` semantics; those two methods have `buildTypeListText` as their sole consumer (verified by grep), but keeping their meaning intact is cleaner.
- Classified as non-breaking `fix:` — the change aligns code with the documented README/registry contract; explicit spawning of a disabled agent was undocumented buggy behavior.
- Not in any architecture roadmap step (no `#448` reference in `docs/`), so **ship independently**.

## Stage: Implementation — TDD (2026-06-20T12:40:00Z)

### Session summary

Completed 2 TDD cycles and all post-step verification gates.
Step 1 added a 3-line enabled-type gate in `resolveSpawnConfig` (reusing `isValidType`) and 2 new test cases in `test/tools/spawn-config.test.ts`.
Step 2 added an `isEnabled` predicate filter in `buildTypeListText` and 2 new test cases in `test/tools/helpers.test.ts`.
Test count delta: 1047 → 1051 (+4).

### Observations

- No deviations from the plan.
  Both changes were as small as designed: 3 lines in `spawn-config.ts`, 2 lines in `helpers.ts`.
- Extended the `makeRegistry` stub's `resolve` type in `test/tools/helpers.test.ts` to include an optional `enabled` field, so the `isEnabled` predicate could be exercised without touching production code.
- The `makeAgentConfig` helper was added to `test/tools/spawn-config.test.ts` (mirroring the pattern in `test/config/agent-types.test.ts`) rather than importing from a shared fixture, since the existing spawn-config test fixture infrastructure didn't need modification.
- All three plan-enumerated cross-step invariants held green throughout: `resolveAgentConfig` disabled-config behavior, unknown-type fallback, and `getAllTypes` disabled-agent listing.
- Pre-completion reviewer: **PASS** — all deterministic checks, code design, test artifacts, and cross-step invariants clean.

## Stage: Land — worktree (2026-06-20T17:57:54Z)

### Session summary

Ran `/land-worktree 448` from the root checkout: fast-forward merged the peer branch `issue-448-enabled-false-does-not-prevent-explicitl` onto linear `main`, pushed, verified CI green, closed issue #448, merged the release-please PR, and tore down the worktree.
Released `pi-subagents-v17.0.1` (the plan marked `Release: ship independently`).

### Observations

#### What went well

- The new `/land-worktree` flow (added in `7cbfea46`) ran cleanly end-to-end on a real issue: ff-merge → push → CI → `issue_close` → release → teardown, with no blockers or rework.
- The release-please PR returned `MERGEABLE` / `UNSTABLE` with an empty `statusCheckRollup` — the documented `GITHUB_TOKEN` no-checks case.
  Falling back from `release_pr_merge` to `gh pr merge 449 --rebase` followed by `git pull --ff-only` worked exactly as the prompt anticipates.

#### What caused friction (agent side)

- `instruction-violation` (self-identified, in retro) — the prompt's step 6.2 says to check the **full** release-PR body for which packages it bumps **before** merging.
  I requested `body` in `gh pr view 449 --json body,...` but the `--jq` filter only printed `title`/`state`/`mergeStateStatus`/`statusCheckRollup`, so the body was never actually inspected.
  I learned the bumped package (`pi-subagents`) only **after** merging, from the `git pull` output.
  Impact: none this time (a single expected package bumped), but skipping the pre-merge body check means an unexpected sibling-package bump would slip through unnoticed.

### Diagnostic details

- **Model-performance correlation** — no subagents dispatched; the land flow ran entirely on the parent session model.
  No mismatch.
- **Escalation-delay tracking** — no rabbit-holes; no error retried more than once.
- **Feedback-loop gap analysis** — no code changes in the land session, so CI (run on the pushed SHA, conclusion `success`) was the appropriate and only verification gate.

### Changes made

1. `.pi/prompts/land-worktree.md` — added a one-line nudge to step 6.2 to print the release-PR body explicitly with `gh pr view <N> --json body -q .body`, since a `--jq` that drops `body` skips the package-bump check silently.
