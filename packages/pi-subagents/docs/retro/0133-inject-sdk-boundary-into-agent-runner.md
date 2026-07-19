---
issue: 133
issue_title: "Inject SDK boundary into `agent-runner`"
---

# Retro: #133 — Inject SDK boundary into agent-runner

## Final Retrospective (2026-05-22T13:15:00Z)

### Session summary

Injected all SDK and IO dependencies into `runAgent()` via a `RunnerIO` interface and `createAgentRunner(io)` factory.
Eliminated all 14 `vi.mock()` calls across `agent-runner.test.ts` (7) and `agent-runner-extension-tools.test.ts` (7).
Released as `pi-subagents-v6.11.0`.

### Observations

#### What went well

- The `createAgentRunner(io)` factory pattern was a clean design choice that kept the `AgentRunner` interface and `AgentManager` completely unchanged — zero downstream impact.
- Folding plan steps 1 and 2 into a single commit was the right call given `tsconfig.json` includes `test/` — recognized the constraint before attempting a broken intermediate commit.

#### What caused friction (agent side)

1. `wrong-abstraction` — Annotated `createRunnerIO(): RunnerIO` in the test helper, which erased the `Mock<...>` type information from `vi.fn()` stubs.
   TypeScript then rejected `.mockResolvedValue()` on `io.createSession` across 18 call sites.
   Required removing the annotation plus a follow-up edit to remove the now-unused `type RunnerIO` import flagged by Biome.
   Impact: two extra edit rounds and a type-check cycle before the fix landed.

2. `missing-context` — Added `SettingsManager` to the SDK import block in `index.ts` without checking that the name was already imported from `./settings.js`.
   Biome caught the redeclaration and the `noRedeclare` lint error required an alias fix (`SettingsManager as SdkSettingsManager`).
   Impact: one extra edit round triggered by the autoformat failure.

3. `premature-convergence` — Spent excessive reasoning time deliberating commit-boundary strategy (whether to combine steps 1+2, how to handle broken intermediate states, whether step 4 would have remaining work).
   The answer was straightforward once the `tsconfig` `include` was checked, but the check came late in the deliberation.
   Impact: added friction but no rework — the final decision was correct.

#### What caused friction (user side)

- None identified.
  The plan and issue were well-specified, and the user's only intervention was "Please, continue" after a message boundary, which was appropriate.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added rule: do not annotate test factory return types with production interface types (erases `Mock<...>` methods).
