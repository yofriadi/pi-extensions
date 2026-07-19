---
issue: 53
issue_title: "refactor: extract model resolution from Agent.execute"
---

# Retro: #53 — extract model resolution from Agent.execute

## Final Retrospective (2026-05-17T21:00:00Z)

### Session summary

Planned and executed the extraction of inline model-resolution logic from `Agent.execute` in `index.ts` into a new `resolveInvocationModel()` function in `model-resolver.ts`.
Released as `pi-subagents-v4.1.0` with +10 new unit tests and no behavior change.
Also fixed a pre-existing `rumdl` glob-quoting bug in `package.json` discovered during the lint step.

### Observations

#### What went well

- Pre-existing lint bug surfaced and fixed: the `rumdl check '*.md' 'docs/**/*.md'` command in `package.json` used single-quoted globs that prevented shell expansion.
  Verified as pre-existing (reproduced on prior commit via `git stash`), cleanly isolated into its own `fix:` commit.
  This was a genuine find — the lint had been silently broken.

#### What caused friction (agent side)

- `missing-context` — In step 6 (refactoring `index.ts`), replaced the `resolveModel` import with `resolveInvocationModel` without first checking whether `resolveModel` was still used elsewhere in the file.
  Two other call sites (`createSubagentsService` at line 386 and `getModelLabel` at line 1043) still needed it.
  The plan explicitly listed `getModelLabel` as a non-goal that continues using `resolveModel`, so the information was available.
  Caught immediately via `grep` after the edit and fixed in the same commit.
  Impact: one extra edit + grep cycle, no rework.

- `missing-context` — The plan's type definitions specified `model: unknown` for `ModelResolutionResult`, but downstream code in `index.ts` accesses `.id` and `.name` on the model and passes it where `Model<any>` is expected.
  The plan's risk section flagged this ("reducing but not eliminating the `any`"), yet the implementation went with `unknown` first, requiring a correction after `pnpm run check` failed with 4 type errors.
  Changed to `model: any` to match the existing `resolveModel` return type.
  Impact: one extra edit cycle within the same commit, no rework.

#### What caused friction (user side)

- None observed.
  The issue was well-scoped with clear acceptance criteria, making planning and execution straightforward.
