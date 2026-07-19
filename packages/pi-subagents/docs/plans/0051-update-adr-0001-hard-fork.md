---
issue: 51
issue_title: "docs: update ADR 0001 to reflect hard-fork decision"
---

# Update ADR-0001 to reflect hard-fork decision

## Problem Statement

[ADR-0001] was written when the fork was a thin-patch layer over `tintinweb/pi-subagents`.
The new architecture document (`docs/architecture/architecture.md`) commits to a hard fork with material scope reduction — scheduling removal, a `SubagentsAPI` boundary, `index.ts` decomposition, and more.

Several claims in [ADR-0001] are now outdated:

1. The status is "accepted" but the decision has been superseded by the architecture doc.
2. The Upstream PRs section states "the fork's divergence reduces to package naming and tooling," which is no longer true.
3. The Consequences → Operational section implies that merging the upstream PRs eliminates behavioral divergence, which no longer holds.

## Goals

- Add a supersession note to [ADR-0001] pointing to `docs/architecture/architecture.md`.
- Update the "Upstream PRs are open" subsection so the "divergence reduces to…" claim reflects reality.
- Update the Consequences → Operational section to note intentional divergence per the architecture document.
- Preserve all existing rationale — no information is removed.

## Non-Goals

- Rewriting the ADR from scratch — the original context is still useful.
- Updating the architecture document itself.
- Any code changes.

## Background

[ADR-0001] has YAML frontmatter (`status: accepted`, `date: 2026-05-11`) and follows a standard ADR structure: Status, Context, Decision, Consequences.

The architecture document (`docs/architecture/architecture.md`) describes a six-phase plan that materially diverges from upstream: scheduling removal, ad-hoc RPC replacement, group-join and output-file removal, a typed `SubagentsAPI` boundary, and `index.ts` decomposition.

The three upstream PRs (#71, #72, #73) are still open and factually accurate — that section just needs the concluding sentence revised.

## Design Overview

The update touches three areas of the ADR:

1. **Frontmatter + Status section** — change `status: accepted` to `status: superseded` in frontmatter, and update the Status section body to read "Superseded" with a pointer to `docs/architecture/architecture.md`.
2. **"Upstream PRs are open" subsection** — keep the PR list and factual statements intact; revise the final sentence ("Once these land upstream, the fork's divergence reduces to package naming and tooling.") to note that the fork now diverges intentionally beyond those patches, per the architecture document.
3. **Consequences → Operational** — add a sentence noting that the fork diverges intentionally beyond patches, and that the architecture document governs the fork's direction going forward.
   Keep the existing bullet about upstream PRs.

No structural changes (new sections, removed sections, reordered content).

## Module-Level Changes

| File                                      | Change                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/decisions/0001-deferred-patches.md` | Update frontmatter `status` from `accepted` to `superseded`; revise Status section; revise closing sentence in "Upstream PRs are open"; add divergence note to Consequences → Operational |

## Test Impact Analysis

No tests are affected — this is a docs-only change.

## TDD Order

1. Update [ADR-0001] with all four edits described above.
   Commit: `docs: update ADR 0001 to reflect hard-fork decision (#51)`

## Risks and Mitigations

| Risk                                           | Mitigation                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Supersession note makes the ADR look stale     | Keep all original rationale intact; the note clarifies evolution, not obsolescence                                   |
| Wording drift between ADR and architecture doc | Use a direct pointer (`docs/architecture/architecture.md`) rather than paraphrasing the architecture doc's decisions |

## Open Questions

None — the issue's acceptance criteria are unambiguous.

[ADR-0001]: ../decisions/0001-deferred-patches.md
