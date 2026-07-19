---
issue: 135
issue_title: "Extract display helpers from `agent-widget.ts`"
---

# Retro: #135 — Extract display helpers from agent-widget.ts

## Final Retrospective (2026-05-22T19:00:00Z)

### Session summary

Extracted 11 helper functions, 3 constants, and 2 types from `agent-widget.ts` into a new `ui/display.ts` module.
Updated 10 source consumers and 2 test consumers.
Pure code-motion refactoring — no behavior change, no test-count delta (714 tests throughout).

### Observations

#### What went well

- Plan accurately identified all 10 source and 2 test import sites with no misses — the consumer import table in the plan mapped 1:1 to actual changes.
- TDD execution was mechanical and smooth: create module → update source imports → rename test file → verify.
  Zero surprises or deviations from the plan.

#### What caused friction (agent side)

- `rabbit-hole` — During `/ship-issue`, wasted ~6 tool calls investigating whether `pi-subagents-v6.12.0` was at HEAD.
  Ran `git log --oneline HEAD --not --remotes=origin/main` which dumped the entire repo history (50KB truncation), then misread `git describe --tags --abbrev=0` (nearest ancestor tag) as confirming the tag was at HEAD.
  `git tag --points-at HEAD` returned empty, disproving the assumption, but I still spent cycles reasoning about CI release-please behavior.
  Impact: added friction but no rework — the close comment and release-please merge were correct.

#### What caused friction (user side)

- None observed.
  The issue was unambiguous, the architecture doc prescribed the exact extraction set, and no user intervention was needed during implementation.

### Changes made

1. Created `packages/pi-subagents/docs/retro/0135-extract-display-helpers.md` (this file).
