---
issue: 605
issue_title: "pi-subagents: slim architecture.md to current state and open targets"
---

# Slim architecture.md to current state and open targets

## Release Recommendation

**Release:** ship independently

This is a standalone docs-only cleanup, not a numbered roadmap step — `grep 605 architecture.md` finds no `(#605)`/`[#605]` step reference, and the issue itself notes it is "schedulable any time."
It has no batch.
In practice this commit cuts no release at all: `packages/pi-subagents/docs/architecture` is a `release-please-config.json` `exclude-paths` entry (line 50), and the one non-doc touch (the `.pi/skills/package-pi-subagents/SKILL.md` heading-name reference) is a repo-level file in no package.
So "ship independently" here means "land on `main`; nothing to release."

## Problem Statement

`packages/pi-subagents/docs/architecture/architecture.md` has grown to 1265 lines — now the larger of the two package architecture docs — by accreting current design, target direction, active-phase workspace, and structural analysis, with shipped work narrated as pending in several sections.
The signal-to-history ratio keeps dropping: `## Target architecture` narrates removed responsibilities (Phase 14/16/18/19 machinery) as still-to-remove, and `## Current structural analysis` carries a 109-line `### Proposed bag decompositions` whose four entries all shipped, a `### Dependency bag inventory` mostly `✓ done`, and a resolved-and-tabled `### Session encapsulation debt` subsection.
This issue applies the [#601] playbook (already landed for pi-permission-system) to pi-subagents, adapted to that package's conventions, so the document serves its two real audiences — how the system currently works, and the genuinely open target directions.

## Goals

- Rename `## Target architecture` → `## Architecture direction` and fold its shipped subsections into current-state prose; keep the still-open direction material (the two-surface model refinement, the deeper first-principles target) in full.
- Aggressively fold `## Current structural analysis`: remove the shipped `### Proposed bag decompositions` pseudo-code (source-restating and all `done`), collapse the `### Dependency bag inventory`, `### Production duplication`, and resolved `### Session encapsulation debt` subsections to brief current-state notes; keep the live Health-metrics, Complexity, and Churn snapshots.
- Strip the residual issue-provenance sentence from the `## Module organization` intro.
- Prune reference-link definitions orphaned by the cuts, and verify every remaining `[#N]` reference resolves to a definition and every definition is referenced (both directions).
- Re-point every live in-repo link and prose reference to the renamed heading.

This change is **not breaking** — it alters no code, config, default, output shape, or public API; it is prose in a release-excluded doc plus one heading-name reference in a repo-level skill file.

## Non-Goals

- Do **not** cut the `## Phase 11 (complete)` … `## Phase 19 (complete)` completion-summary chain — the `/plan-improvements` Step 1 gate reads it to confirm prior phases are condensed, and `/finish-phase` builds it.
- Do **not** cut or restructure the active `## Phase 20 improvement roadmap` (Steps, dependency diagram, tracks, batches) — Step 9 ([#543]) is still open, so it is the live roadmap.
  Its completed steps carry `✅` marks and `Landed:` notes (already framed as done, not pending), so they are not "shipped narrated as target."
- Do **not** cut the `## Refactoring history` phase table or the `### Structural refactoring issues` table — `/finish-phase` (steps 97, 113) actively maintains both as the pi-subagents convention (the table form this issue's proposed-change 1 targets is *already* how pi-subagents records history; see Design Overview op 1).
- Do **not** rewrite the `history/phase-N-*.md` files — they are the canonical per-phase record and are unchanged.
- Do **not** rename `### First-principles refinement and the deeper target` — its anchor is cited by four `history/` references; keeping the heading preserves them, and the name is not misleading (it is genuinely-open direction material this issue keeps in full).
- Do **not** add a package-skill regrowth guard or touch `/finish-phase` — the ongoing-prevention mechanism ([#606]) and the shared-convention generalization ([#607]) are the sibling follow-ups already filed by [#601]; this issue pays down the existing backlog only.
- Do not touch any `src/` or `test/` file — no code, schema, or config changes.
- No hard line-count contract: the gates are zero information loss, a lint-clean bidirectional link graph, and the preserved sections above.

## Background

Relevant structure of `architecture.md` (heading line numbers as of this plan):

- `## Module organization` (271) → intro (271–276) carries "Issue #164 moved the 26 previously flat root-level files…"; `### Current layout` (277–355) is the module tree (already concise one-liners, little provenance); `### Observation model` (356).
- `## Target architecture` (491–643, ~152 lines) — the section to rename and fold.
  Subsections: intro (491–501, minimal-orchestrator framing, largely shipped), `### Two extension surfaces` (502), `### Core responsibilities (keep)` (529, current), `### Responsibilities to remove` (542–552, **all four already removed** — Phase 14/16), `### Composition model` (553, current), `### First-principles refinement and the deeper target` (566–643, mostly still-open direction).
- `## Current structural analysis` (644–832, ~188 lines): `### Health metrics` (646, live), `### Dependency bag inventory` (660–678, mostly `✓ done`), `### Complexity hotspots` (680, live), `### Churn hotspots` (686, live), `### Production duplication` (701–705, narrates resolved clones), `### Session encapsulation debt — resolved by [#277]` (707–722, resolved + table), `### Proposed bag decompositions` (723–832, ~109 lines, **all `done`**).
- `## Phase 11 (complete)` … `## Phase 19 (complete)` (833–911) — the completion-summary chain, keep.
- `## Phase 20 improvement roadmap` (913–1128) — active, keep in full.
- `## Refactoring history` (1129) + `### Structural refactoring issues` (1157–1183) — the maintained convention tables, keep.
- Reference-link definitions (1185–end).

Constraints from AGENTS.md and the package skill that apply:

- Markdown is one-sentence-per-line; long-lived docs use reference-style `[#N]` links; `rumdl` MD053 rejects an unused `[#N]:` definition and MD051 rejects a broken in-repo link fragment (enforced by `pnpm run lint`; also `pnpm exec rumdl check <file>`).
- Renaming a heading changes its GitHub anchor slug; every in-repo `#old-anchor` link and prose reference to it must be re-pointed (MD051 gates the fragment links, including those in `history/` files — [#601]'s retro confirmed "frozen" history links are still lint-validated).
- When reworking documented prose (not removing a symbol), the reworded prose carries no removed symbol to match — the anchor/name grep below is the only detector.

## Design Overview

Four content operations plus a link-graph sweep.
No code, so no data shapes change; the design decisions are editorial boundaries mapped from the issue's five proposed changes onto pi-subagents' actual layout.

### op 1 — Duplicated per-phase history (issue change 1): near no-op

The issue's proposed-change 1 ("collapse duplicated per-phase history the completion summaries and history files carry") targets the *prose* `### Phase N` duplication [#601] removed from pi-permission-system. pi-subagents does **not** carry that debt: it already records history in the compact table form [#601] was *migrating pi-permission-system toward* — a Phase/Title/Status table (`## Refactoring history`) plus a `### Structural refactoring issues` mapping table, both maintained by `/finish-phase`.
So op 1 finds nothing material to cut here; this is documented, not a separate build step.

### op 2 — Fold `Target architecture` → `Architecture direction` (issue change 2)

Rename the heading `## Target architecture` → `## Architecture direction` (new anchor `#architecture-direction`; distinct from the existing `## Cross-extension architecture`).
Then fold the shipped material into current-state prose:

- **Reframe the intro** (491–501) from "the long-term architectural direction is to make pi-subagents a minimal orchestrator…" to current-state ("pi-subagents *is* a minimal orchestrator with inverted dependencies…"), keeping the [ADR-0002] and `client-server-opportunities.md` pointers.
- **Collapse `### Responsibilities to remove`** (542–552) — all four (tool policy, extension filtering, worktree isolation, extension-lifecycle control) shipped in Phase 14/16 — into one current-state sentence pointing at "What the core dropped" (already documented above at line 407) and the relevant ADR/phase, or fold it into `### Core responsibilities`.
- **Lightly current-tense `### First-principles refinement and the deeper target`** where it narrates now-shipped consequences (e.g. "Phase 18 is 'reconsider the UI', not 'extract the UI'" and "the activity/metrics push tier is provisional" both resolved), but **keep the section and its heading** — it is genuinely-open direction material kept in full, and its anchor has four `history/` citers.

**Keep in full:** `### Two extension surfaces`, `### Core responsibilities (keep)`, `### Composition model`, and the conceptual spine of `### First-principles refinement…` (four conflated domains, recursive-Pi hooks, reactive-vs-discrete, sibling-package discipline, boundary-discovery method).

Anchor/name fallout from the rename (`#target-architecture` → `#architecture-direction`) — four live touch points, all updated in the same commit:

- `architecture.md` line 874 — in-file link `[Target architecture](#target-architecture)` inside the Phase 16 completion summary.
- `docs/architecture/history/phase-16-invert-dependencies.md` line 6 — `[Target architecture](../architecture.md#target-architecture)` (MD051-gated).
- `docs/architecture/client-server-opportunities.md` line 5 — `[Target architecture](./architecture.md#target-architecture)` (live sibling doc).
- `.pi/skills/package-pi-subagents/SKILL.md` line 77 — prose "documented … under \"Target architecture.\"" → "\"Architecture direction.\""

The `docs/plans/0537-*.md` line-20 mention ("the target architecture's behavior interface") is descriptive prose, not a heading link, and lives in a frozen plan — left unchanged.

### op 3 — Strip module-tree provenance (issue change 3): light

The pi-subagents module tree (`### Current layout`, 277–355) already uses concise one-line descriptions — it does not carry the multi-line issue-provenance trails [#601] stripped from pi-permission-system.
The one residual is the `## Module organization` intro sentence "Issue #164 moved the 26 previously flat root-level files into five new domain directories, reducing the root to 5 files + 8 directories."
Reframe to current-state (the domains and root layout as they are now), dropping the migration archaeology.

### op 4 — Aggressive fold of `## Current structural analysis` + trim pseudo-code (issue changes 2 + 4)

Per the operator's aggressive-fold decision (this section has no analog in the pi-permission-system doc; it is where pi-subagents' bulk lives):

- **Remove `### Proposed bag decompositions`** (723–832, ~109 lines) entirely — all four entries are `done`, and the TypeScript interface blocks restate shipped source (`SpawnIdentity`/`SpawnExecution`/`SpawnPresentation`, `ParentSessionInfo`, `RunContext`, `EnvironmentIO`/`SessionFactoryIO`).
  The detail lives in the `history/phase-10-*.md` file and the linked issues.
- **Collapse `### Dependency bag inventory`** (660–678) — the table is entirely `✓ done` or `Low (DTO/SDK)` (accepted-as-is) — to a one-line current-state note ("the 10+-field bags flagged in prior phases were decomposed; the remaining wide interfaces are DTO/SDK-boundary types accepted as-is").
- **Collapse `### Production duplication`** (701–705) — narrates resolved clones (#172, #217, #441) — to "Production duplication is 0 lines."
- **Remove `### Session encapsulation debt — resolved by [#277]`** (707–722) — fully resolved, with a detail table `[#277]` and the history file carry; its anchor has no external citer.
- **Keep** `### Health metrics`, `### Complexity hotspots`, and `### Churn hotspots` — live current-state snapshots, small and not shipped-narrated.
  Leave their values as-is (this is a slimming pass, not a re-audit).

None of the removed subsection anchors (`#proposed-bag-decompositions`, `#dependency-bag-inventory`, `#production-duplication`, `#session-encapsulation-debt-*`) is referenced outside `architecture.md` (grep-verified), so no cross-doc link update is needed for op 4.

### op 5 — Link-graph sweep (issue change 5)

After ops 2–4, some `[#N]:` definitions lose their last `[#N]` reference.
`rumdl` (MD053) flags an orphaned definition but **not** a missing one, so the sweep is two-directional:

- Run `pnpm exec rumdl check <file>` and delete every flagged orphan definition.
- Manually verify the reverse: every `[#N]` reference in the body still has a `[#N]:` definition (`grep -oE '\[#?[0-9]+\](:)?'` bijection check).

Known orphans created by op 4's removal of `### Proposed bag decompositions`: the numeric-label defs `[166]`, `[167]`, `[168]`, `[169]` (used only there).
`[#231]` is **not** orphaned — it is also referenced in the Phase 15 completion summary (line 866).
Do not delete a definition still referenced by surviving prose.

## Module-Level Changes

- `packages/pi-subagents/docs/architecture/architecture.md` — the four content operations above plus the link-definition prune; net ~1265 → ~1050 lines (soft target).
- `packages/pi-subagents/docs/architecture/history/phase-16-invert-dependencies.md` — re-point the one `architecture.md#target-architecture` link (line 6) to `#architecture-direction`.
- `packages/pi-subagents/docs/architecture/client-server-opportunities.md` — re-point the one `architecture.md#target-architecture` link (line 5) to `#architecture-direction`.
- `.pi/skills/package-pi-subagents/SKILL.md` — update the line-77 prose heading-name reference "Target architecture" → "Architecture direction".

Grep evidence that the anchor/name-rename touch points are complete (run at plan time):

- `#target-architecture` fragment links: 3 hits — `architecture.md:874` (in-file), `history/phase-16-*.md:6`, `client-server-opportunities.md:5`.
- Heading-name prose reference: `.pi/skills/package-pi-subagents/SKILL.md:77`.
- `docs/plans/0537-*.md:20` — descriptive prose, not a link; frozen plan; left as-is.

No `src/`, `test/`, schema, example-config, `README.md`, or `docs/decisions/` file references the slimmed prose by a removed symbol (README grep clean; the cuts remove no exported name, only shipped-narrated prose and provenance).

## Test Impact Analysis

Not applicable — docs-only.
No unit tests exist for or against prose content; the only automated gate is `pnpm run lint` (`rumdl` MD053/MD051 for the link graph, plus the markdown style rules).
There is no code behavior to pin, so no test is added, removed, or made redundant.

## Invariants at risk

- **`/plan-improvements` Step 1 gate + `/finish-phase` convention** — read the `## Phase N (complete)` chain, the `## Refactoring history` phase table, and the `### Structural refactoring issues` table.
  Mitigation: all three are explicit Non-Goals; the cuts touch only shipped-narrated prose in `## Target architecture` / `## Current structural analysis`, none of the maintained history structures.
- **Active Phase 20 roadmap** — the live roadmap with one open step ([#543]).
  Mitigation: fenced as a Non-Goal; its `✅`/`Landed:` framing already marks it done-not-pending, so it is not in the fold's scope.
- **Reference-link integrity (MD053 both directions + MD051 fragments)** — a stale/orphaned `[#N]:` or a broken `#anchor` fails `pnpm run lint`.
  Mitigation: op 5 is the dedicated bidirectional sweep; the rename's four fragment/name touch points are updated in op 2's commit; the lint run at build-completion verifies both.
- **Cross-doc anchors kept stable by design** — `#first-principles-refinement-and-the-deeper-target` (4 `history/` citers) is preserved by keeping that subsection heading; the removed structural-analysis anchors have no external citer.

## Build Order

Docs-only — no red→green cycles.
Each step is one reviewable `docs:` commit; ordering puts content cuts before the link sweep so the sweep sees the final reference set.
Per-step `pnpm exec rumdl check` keeps each commit independently lint-valid (MD053/MD051), so any orphan a step creates is pruned in that same step and the final sweep is a verification.

1. **Rename and fold `Target architecture` → `Architecture direction`** (op 2).
   Reframe the intro, collapse `### Responsibilities to remove`, current-tense the shipped consequences in `### First-principles refinement…` while keeping the section; update the in-file link (874), `phase-16-invert-dependencies.md`, `client-server-opportunities.md`, and the `package-pi-subagents` skill prose.
   Commit: `docs(pi-subagents): fold shipped target-architecture prose into current state (#605)`.
2. **Aggressively fold `## Current structural analysis`** (op 4): remove `### Proposed bag decompositions`; collapse the dependency-bag inventory, production-duplication, and resolved encapsulation-debt subsections to current-state notes; keep Health/Complexity/Churn.
   Prune the `[166]`/`[167]`/`[168]`/`[169]` orphans this creates.
   Commit: `docs(pi-subagents): collapse shipped structural-analysis material (#605)`.
3. **Strip the module-organization provenance sentence** (op 3).
   Commit: `docs(pi-subagents): drop module-tree migration archaeology (#605)`.
4. **Link-graph sweep** (op 5): run `pnpm exec rumdl check` on the doc, confirm no orphaned or missing `[#N]` definition, verify the bijection.
   Commit only if anything remains to prune: `docs(pi-subagents): prune orphaned link definitions after slim (#605)` (may be a no-op verification if steps 1–3 already left the graph clean).

Steps 1–3 touch disjoint regions and may be reordered; step 4 must run last so it sees the final reference set.
If the operator prefers fewer commits, steps 1–3 can collapse into one — but keep the link sweep attributable.

## Risks and Mitigations

- **Information loss during the fold.**
  Risk: collapsing `### Proposed bag decompositions` / `### Responsibilities to remove` drops a rationale a future reader wants.
  Mitigation: the cut material is shipped and preserved in the `history/phase-10-*.md` / `phase-14-*.md` / `phase-16-*.md` files and the linked issues; the fold leaves current-state prose plus those pointers.
- **Broken anchors from the rename.**
  Risk: renaming `## Target architecture` strands `#target-architecture` fragment links (MD051 fails the build).
  Mitigation: the three fragment links + one prose name reference are enumerated and updated in step 1's commit; `### First-principles refinement…` is deliberately *not* renamed to avoid touching its four `history/` citers.
- **Over-cutting a gate-relevant section.**
  Risk: trimming too aggressively removes the `## Phase N (complete)` chain, the active Phase 20 roadmap, or the `/finish-phase`-maintained tables.
  Mitigation: the Non-Goals fence each explicitly, and every cut is a scoped edit to a named region, not a bulk deletion.
- **Silent missing link reference.**
  Risk: `rumdl` catches orphaned definitions but not a `[#N]` with no definition.
  Mitigation: op 5's manual reverse bijection check.
- **Line-count target pressure.**
  Risk: chasing a number invites over-cutting.
  Mitigation: the ~1050 figure is a soft target; the gates are zero information loss, the keep-list, and a lint-clean bidirectional link graph.

## Open Questions

The issue is operator-authored, concrete ("apply the #601 playbook, adapted"), and the two adaptation decisions (aggressive structural-analysis fold; rename the target-architecture heading and fix anchors like #601) were confirmed with the operator during planning.
No open questions remain for #605's scope.
The ongoing-prevention follow-ups it pairs with — [#606] (`/finish-phase` doc-hygiene step) and [#607] (generalize the regrowth guard) — are already filed and out of scope here.

[#543]: https://github.com/gotgenes/pi-packages/issues/543
[#601]: https://github.com/gotgenes/pi-packages/issues/601
[#606]: https://github.com/gotgenes/pi-packages/issues/606
[#607]: https://github.com/gotgenes/pi-packages/issues/607
[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
