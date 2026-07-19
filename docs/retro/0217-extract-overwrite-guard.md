---
issue: 217
issue_title: "Extract overwrite guard from UI (Phase 13, Step 4)"
---

# Retro: #217 — Extract overwrite guard from UI

## Stage: Planning (2026-05-26T20:00:00Z)

### Session summary

Produced a 5-step TDD plan to extract the duplicated overwrite-guard + write + reload + notify pattern from `AgentConfigEditor.ejectAgent` and `AgentCreationWizard.showManualWizard` into a shared `writeAgentFile` function in a new `src/ui/agent-file-writer.ts` module.
Confirmed dependency #214 (closure-to-class conversion) is already closed.

### Observations

- The `showGenerateWizard` overwrite guard was explicitly scoped out — it has different lifecycle semantics (spawned agent writes the file, post-write check is conditional).
  This avoids a leaky abstraction with a discriminator parameter.
- Narrow ISP interfaces (`FileWriter`, `WriterUI`, `Reloadable`) keep the extracted function decoupled from the full `AgentFileOps` and `MenuUI` interfaces — 2/6 and 2/6 methods respectively.
- Both consumer call sites hold `this.fileOps` and `this.registry` as private fields and receive `ui` as a method parameter, so no constructor or wiring changes are needed.
- Existing tests in both consumer test files use `expect.stringContaining("already exists")` for overwrite prompts, which is stable across the extraction.

## Stage: Implementation — TDD (2026-05-26T20:40:00Z)

### Session summary

Implemented `writeAgentFile` in new `src/ui/agent-file-writer.ts`, replaced the inline overwrite-guard blocks in `AgentConfigEditor.ejectAgent` and `AgentCreationWizard.showManualWizard`, and updated the architecture doc.
All 5 plan steps completed across 4 commits (plan steps 1 and 2 folded into one).
Test count: 962 → 970 (+8 new tests in `test/ui/agent-file-writer.test.ts`).

### Observations

- Plan steps 1 and 2 naturally collapsed into a single commit — writing all 8 tests at once and implementing the full function body (including the guard) in one pass was cleaner than splitting them artificially.
- Both consumer refactors were straightforward one-import-add + one-block-replace edits; all existing tests passed without modification, confirming the extraction preserved exact behavior.
- The notification label `"Ejected ${name} to"` (with trailing space absorbed by `${targetPath}`) matched the pre-existing message format `"Ejected test-agent to /path"` exactly — no test assertions changed.
- `FileWriter`, `WriterUI`, and `Reloadable` narrow interfaces are exported from `agent-file-writer.ts`; both consumer files import the concrete types from their original sources, satisfying TypeScript's structural checker without any casts.

## Stage: Final Retrospective (2026-05-26T21:00:00Z)

### Session summary

Full plan → TDD → ship → release lifecycle completed in a single continuous session.
Released as `pi-subagents-v7.7.0`.
Zero rework, zero test failures, zero CI issues.

### Observations

#### What went well

- The Phase 13 roadmap's step-level issue decomposition produced an issue (#217) that was right-sized for fully autonomous execution — the entire lifecycle completed without any blocking questions or scope surprises.
- ISP-narrow interfaces (`FileWriter`, `WriterUI`, `Reloadable`) structurally satisfied both consumer types without casts, confirming the plan's design.
- Existing tests in both consumer files passed without modification after the refactors, validating that the extraction preserved exact behavior.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan split TDD steps 1 (happy-path tests) and 2 (overwrite-guard tests) for a ~10-line function with a single conditional.
  Writing all 8 tests at once and implementing the full function body in one pass was natural; splitting them would have been artificial.
  Self-corrected by folding into one commit.
  Impact: added friction but no rework — the plan said "implementation should already pass" for step 2, acknowledging the fold was expected.

#### What caused friction (user side)

- Nothing notable — the issue was well-scoped with clear target files, a concrete smell label, and an explicit dependency chain.
