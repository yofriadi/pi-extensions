---
issue: 185
issue_title: "pi-subagents: Remove persistent agent memory feature"
---

# Retro: #185 — pi-subagents: Remove persistent agent memory feature

## Stage: Planning (2026-05-24T20:46:56Z)

### Session summary

Traced all memory-related code across 9 source files, 5 test files, and the architecture doc.
Produced a 5-step TDD plan: extract shared utilities (`isSymlink`, `isUnsafeName`, `safeReadFile`) to `safe-fs.ts`, then remove memory consumers (session assembly, config, UI), then delete the module, then update docs.

### Observations

- The three utility functions in `memory.ts` are the only complication — `skill-loader.ts` imports them independently of memory.
  Extracting to `src/session/safe-fs.ts` keeps them co-located with their sole remaining consumer.
- The removal is consumers-first, declaration-last: session-config and prompts lose their memory logic before `MemoryScope` is removed from `types.ts`, avoiding intermediate type errors.
- No ambiguous design choices — the issue scope section is precise about what to remove and what to extract.
- Memory field in custom agent frontmatter will silently become a no-op (ignored by the YAML parser) — no user-facing error, just loss of the feature.
- The `AssemblerIO` interface shrinks from 4 fields to 2 after removal, which is a welcome simplification.

## Stage: Implementation — TDD (2026-05-24T22:41:23Z)

### Session summary

All 5 TDD steps completed across 5 commits.
Test count went from 901 (54 files) to 848 (53 files) — a net reduction of 53 tests and 1 file, reflecting the deletion of the `memory.test.ts` file with its memory-specific tests and the removal of memory-related tests from `session-config.test.ts`, `prompts.test.ts`, `agent-types.test.ts`, and `custom-agents.test.ts`.
New file `safe-fs.test.ts` was created with 13 tests for the extracted utilities.

### Observations

- Step 1 had a subtle bug: after re-exporting `isUnsafeName` from `safe-fs` in `memory.ts`, the function was not imported into the `memory.ts` module scope itself, so `resolveMemoryDir` got a `ReferenceError` at runtime.
  Fix was trivial: add `isUnsafeName` to the import alongside `isSymlink` and `safeReadFile`.
- Step 3 introduced a type error in `memory.ts` (still alive at that point): `MemoryScope` was imported from `#src/types` which no longer exported it.
  Fix: inline the literal union `"user" | "project" | "local"` directly in `memory.ts` as a local type, so it compiles cleanly until deletion in step 4.
- The `SKILL.md` for `package-pi-subagents` also listed `memory.ts` in the session domain table — updated alongside `architecture.md` in the docs commit.
- No deviations from the plan other than the two minor bugs above (both self-corrected within the same TDD step).

## Stage: Final Retrospective (2026-05-24T22:47:55Z)

### Session summary

Shipped issue #185 as `pi-subagents-v7.0.0`.
CI passed, issue closed, release-please PR #190 merged.
Three sessions total: planning, TDD (5 steps / 5 commits), shipping.

### Observations

#### What went well

- The issue's "Scope" section was precise enough that the planning session required no `ask_user` and the Explore agent's trace matched the final commit diff exactly.
- Consumers-first, declaration-last ordering kept each commit independently compilable (after the two self-corrected fixes).
- The `SKILL.md` domain table update was caught naturally during the docs step even though the plan didn't list it.

#### What caused friction (agent side)

- `missing-context` — In TDD step 1, `memory.ts` was updated to re-export `isUnsafeName` from `safe-fs`, but the function was not imported into `memory.ts`'s own scope.
  `resolveMemoryDir` threw a `ReferenceError` at runtime.
  Impact: one extra test-run cycle (~5 seconds) and a trivial one-line fix; no rework commit.
- `missing-context` — In TDD step 3, removing `MemoryScope` from `types.ts` broke `memory.ts` (scheduled for deletion in step 4).
  The plan said "consumers-first" but didn't account for the doomed module itself being a consumer of the type.
  Impact: one extra `pnpm run check` cycle and a local type inline; no rework commit.
  Both share the same root cause: incremental deletion plans must account for doomed files' own imports at each intermediate step.

#### What caused friction (user side)

- None observed — all three sessions ran without user corrections or redirections.

### Changes made

1. Added a TDD planning rule to `.pi/skills/testing/SKILL.md` about accounting for doomed modules' own imports during multi-step deletion.
