---
issue: 180
issue_title: "perf(pi-subagents): reorder append-mode system prompt to enable KV cache reuse"
---

# Retro: #180 — Reorder append-mode system prompt for KV cache reuse

## Stage: Planning (2026-05-24T20:00:00Z)

### Session summary

Produced a plan to reorder the append-mode system prompt in `buildAgentPrompt()` so the shared inherited content (~8k tokens) comes before the varying `<active_agent>` tag and env block, enabling LLM KV cache prefix reuse across subagent invocations.

### Observations

- Confirmed pi-permission-system's `ACTIVE_AGENT_TAG_REGEX.exec()` is position-independent — no changes needed in that package despite the `pkg:pi-permission-system` label on the issue.
- Only two tests assert positional ordering in append mode (`startsWith` and `tagIdx === 0`); all other prompt tests use `toContain()` and are unaffected.
- Replace mode is a separate code path and is not touched.
- The TDD cycle is minimal: one red step (update two positional assertions), one green step (reorder the return statement + update JSDoc).

## Stage: Implementation — TDD (2026-05-24T20:15:00Z)

### Session summary

Completed both TDD cycles in `buildAgentPrompt()` in `src/session/prompts.ts`.
Two positional assertions in `test/session/prompts.test.ts` were updated to expect the new ordering (red), then the append-mode return statement was reordered and the JSDoc updated (green).
Test count unchanged at 805 across 50 files.

### Observations

- The JSDoc bullet for append mode also described the old ordering ("env header + parent system prompt + ...") and was corrected as part of the green step.
- The `<active_agent>` tag is followed by a `\n\n`, so when it moves after `<sub_agent_context>`, a `\n\n` separator between the bridge and the tag was needed to maintain clean section boundaries.
- No deviations from the plan; both steps were exactly as described.

## Stage: Final Retrospective (2026-05-24T21:00:00Z)

### Session summary

Issue #180 went from external community observation through release (`pi-subagents-v6.18.3`) in a single continuous session.
The plan predicted exactly two TDD steps; both executed without deviation or rework.

### Observations

#### What went well

- End-to-end lifecycle in one session: external comment → issue → plan → TDD → ship → release.
  No corrections, no scope drift, no rework across any stage.
- The plan's test impact analysis was accurate — only two positional assertions needed updating; all `toContain()` tests passed untouched.
- Confirming pi-permission-system's `ACTIVE_AGENT_TAG_REGEX.exec()` is position-independent during planning eliminated the second `pkg:*` label's scope entirely, keeping the change to a single file.

#### What caused friction (agent side)

- `wrong-abstraction` — Launched an Explore agent (75.9s, 18 tool uses) to map the prompt assembly flow when the `package-pi-subagents` skill already listed the file layout and `prompts.ts` is 107 lines.
  Direct `read` + `grep` achieved the same confirmation in ~3 seconds during the planning phase.
  Impact: added ~75 seconds of latency but no rework.
- `missing-context` — The plan listed "Update the JSDoc comment" but missed that the mode-description bullet ("env header + parent system prompt + ...") also encoded the old ordering.
  Caught during the green step and fixed in the same commit.
  Impact: added friction but no rework.

#### What caused friction (user side)

- Nothing notable — the user's prompts were well-scoped and the issue description was unambiguous.
