---
issue: 152
issue_title: "Add promptSnippet to pi-subagents tools"
---

# Retro: #152 — Add `promptSnippet` to pi-subagents tools

## Final Retrospective (2026-05-22)

### Session summary

Added `promptSnippet` to the `Agent`, `get_subagent_result`, and `steer_subagent` tool registrations in pi-subagents, matching the convention used by pi-github-tools and pi-colgrep.
The full plan→TDD→ship pipeline completed in one session with zero rework.
Released as `pi-subagents-v6.14.0`.

### Observations

#### What went well

- Clean single-cycle execution: the issue was unambiguous, the plan correctly scoped it as one TDD step, and the implementation matched the plan exactly.
- Cross-package convention check (grepping sibling packages for `promptSnippet` usage) confirmed the `"tool_name: One-liner."` format before writing the plan, avoiding any wording rework.

#### What caused friction (agent side)

No friction points identified.
The issue was a straightforward property addition with no design decisions, no interface changes, and no downstream breakage.

#### What caused friction (user side)

No friction points identified.

### Changes made

1. Created `packages/pi-subagents/docs/retro/0152-add-prompt-snippet.md` (this file).
