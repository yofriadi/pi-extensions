---
issue: 51
issue_title: "docs: update ADR 0001 to reflect hard-fork decision"
---

# Retro: #51 — docs: update ADR-0001 to reflect hard-fork decision

## Final Retrospective (2026-05-16)

### Session summary

Updated [ADR-0001] to reflect the hard-fork decision documented in `docs/architecture/architecture.md`.
The change was planned, implemented, shipped, and released as `pi-subagents-v1.0.2` in a single clean pass with no rework.

### Observations

#### What went well

- The entire plan→build→ship pipeline completed with zero corrections, zero CI failures, and zero user interventions.
- Parallel context gathering (issue body, `AGENTS.md`, ADR file, architecture doc, two skill files) in one tool call made the planning phase efficient.
- The 4-edit approach (`Edit` with a single call containing four `edits[]` entries) was well-matched to the task — each edit was small, unique, and non-overlapping.

#### What caused friction (agent side)

- No friction observed.
  The task was unambiguous and the tooling well-suited.

#### What caused friction (user side)

- No friction observed.
  The session required no user input beyond invoking the three slash commands.

### Follow-ups identified

- The `package-pi-subagents` skill (`.pi/skills/package-pi-subagents/SKILL.md`) still frames the fork as "a friendly fork… carrying a small number of patches" with priorities like "stays as close to upstream as possible."
  This framing is now stale given the hard-fork commitment.
  A separate issue should update the skill to reflect the architecture document's posture.

[ADR-0001]: ../decisions/0001-deferred-patches.md
