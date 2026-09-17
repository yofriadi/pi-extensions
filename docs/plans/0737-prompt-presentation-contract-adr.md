---
issue: 737
issue_title: "pi-permission-system: decide the prompt-presentation contract — invariant core, elision rules, size bounds (ADR)"
---

# ADR 0011 — the prompt-presentation contract: invariant core, elision rules, size bounds

## Release Recommendation

**Release:** ship independently

Issue #737 is not a numbered step in `docs/architecture/architecture.md`'s improvement roadmap — a grep for `737` there returns nothing — so there is no `Release:` batch tag to honor.
The deliverable is documentation only: `docs/decisions/` and `docs/architecture/` are both release-please `exclude-paths`, so this cuts no physical release on its own, exactly as the ADR 0009 plan ([#639]) did.
The decisions it records are implemented later by the dependants, and those changes release on their own merits.

## Problem Statement

Six open items change how a permission prompt presents itself, and they pull in opposite directions.

| Item   | Wants                                                                     |
| ------ | ------------------------------------------------------------------------- |
| [#710] | the prompt bounded in **height**                                          |
| [#656] | the assembled message hard-truncated to 200 characters (bounded in width) |
| [#716] | the message **expanded** into aligned `key : value` lines + pretty JSON   |
| [#713] | the inner command of unstrippable wrappers **added** to the prompt        |
| [#648] | edit diffs **added** before approval                                      |
| [#654] | contextual natural-language explanations **added**                        |

Three ask the prompt to show more, two ask it to show less, and nothing is recorded that says which wins.
The two PRs edit the same function in opposite directions, so whichever merges first silently sets the premise the other is reviewed against.

The stakes are not cosmetic.
This package's own rule is that `formatToolInputForPrompt` is never redacted, because the user must see the real input to decide.
Eliding for size trades directly against the decision quality the gate exists to protect.

The deliverable is ADR 0011, settled interactively during the build session.
The [#581] lesson applies in full: the deliberation is the deliverable, and the ADR must record decisions actually made with the operator, not transcribe the sketches produced during this planning conversation.

The decision criteria, stated in the issue, in order: the user can still decide correctly from what remains; the surface is consistent across local, forwarded, and skill asks; and the rule is simple enough that a contributor can tell whether a proposed change conforms.

## Goals

- Author `packages/pi-permission-system/docs/decisions/0011-prompt-presentation-contract.md`, with every decision settled interactively during the `/build-plan` session.
- State what an ask prompt is *for* — routing human attention to a consequential action with enough evidence to decide — and that elision removing decision-relevant evidence is a correctness bug, not a cosmetic one.
- Decide the **invariant core**: what must always be visible (requesting agent for a forwarded ask, tool name, gate surface and matched rule, decision-relevant value).
- Decide the **elision rules**: what may be summarized, what the summary must itself state, and how the user reaches the full text.
- Decide the **size bounds**: width, height, or total; fixed or configurable; and how they subsume or replace `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength`.
- Rule for **four consumers**, not one — the human dialog, the review log, the `permissions:ui_prompt` broadcast, and the agent-facing denial messages — stating what each is entitled to and where they may differ (operator decision, this session).
- Keep the **structured-payload remodel a live option**: the ADR may decide that gates emit structured facts each consumer renders, rather than a single pre-assembled string (operator decision, this session).
- End with a **staging section** naming what each of [#656], [#716], [#710], [#713], [#648], [#654] becomes under the contract — adopt, adapt, decline, or re-plan (operator decision, this session).

This change is **not breaking**: it ships no code.
If the ADR decides a structured payload, the *implementation* of that decision is breaking (the forwarded-request wire and the `permissions:ui_prompt` payload are both cross-process/cross-extension contracts); the ADR records that posture, and the implementing issue carries the `feat!:` commit and the migration note.

## Non-Goals

- Implementing anything — no `src/`, `test/`, `schemas/`, `config/`, `README.md`, or `docs/configuration.md` change.
  Current behavior is untouched and all six dependants stay open.
- Reviewing [#656] and [#716] on merit here.
  The ADR records a disposition for each; the actual `/pr-review` sessions apply that recorded decision, including the version question the 2026-08-12 triage raised about [#656]'s stale crash premise.
- Redesigning the decision model, the authority chain, or the policy model.
  This ADR governs what a prompt *shows*, not what the gate *decides*; [#639]'s ADR owns the policy model and [ADR 0007] owns live authority.
- Deciding the model-explanation mechanism of [#654].
  The ADR rules on whether a model-generated explanation is admissible in the invariant core / elision budget and how it must be marked; the seam design (`PermissionPromptExplainer` vs an `AuthorizerVerdict` advisory payload) belongs to [#654]'s own plan.
- Changing the redaction boundary of [ADR 0010].
  The ADR must stay consistent with it and may state consequences, but key-name-not-value-shape is settled.
- Filing speculative follow-ups.
  The staging section names the work; filing happens during each dependant's own re-plan or the next `/plan-improvements` pass.

## Background

### How a prompt is assembled today

Five sites assemble ask-prompt text, each independently:

| Site                                                               | Module                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `formatAskPrompt` (bash / MCP / generic-tool branches)             | `src/permission-prompts.ts`                                            |
| `formatSkillAskPrompt`, `formatSkillPathAskPrompt`                 | `src/permission-prompts.ts`                                            |
| `formatExternalDirectoryAskPrompt`, `formatBashExternalDirectory…` | `src/handlers/gates/external-directory-messages.ts`                    |
| Per-tool input previews (`edit` / `write` / `read` / search)       | `src/tool-input-prompt-formatters.ts`, `src/tool-preview-formatter.ts` |
| `formatForwardedPermissionPrompt` (parent-side prefix)             | `src/authority/forwarded-request-server.ts`                            |

Each produces a flat `string`, which becomes `PromptPermissionDetails.message` and travels unchanged to every consumer.

### The four consumers of one string

| Consumer                                 | Path                                                                   | Bound today                                    |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| TUI inline dialog                        | `LocalUserAuthorizer` → `presentInlinePermissionPrompt` → `fitToWidth` | none — wrapped, never clipped, by design       |
| `select`/`input` fallback (RPC/frontend) | `requestPermissionDecisionFromUi`                                      | none                                           |
| Review log JSONL                         | `PermissionPrompter.writeReviewEntry` → `logger.review`                | none (`toolInputPreview` is separately capped) |
| `permissions:ui_prompt` broadcast        | `buildUiPrompt` → `pi.events`                                          | none                                           |

The agent-facing side is assembled separately in `src/denial-messages.ts` (`formatDenyReason` / `formatUserDeniedReason` / `formatUnavailableReason`) and shares no bound, no formatter, and no invariant with the human-facing side.
That the two directions have drifted apart is itself a finding for the contract, and is in scope by operator decision this session.

### Measured findings, verified against `main` this session

- **The bash branch has no cap at all.**
  `formatAskPrompt` interpolates `result.command` and `input.command` raw (`src/permission-prompts.ts:44-55`), and `formatBashExternalDirectoryAskPrompt` interpolates the raw command plus the full external-path list.
  So [#710]'s forwarded PowerShell here-string was never bounded by anything.
- **The two configurable caps govern only non-bash tool-input previews.**
  `toolInputPreviewMaxLength` (default 200) bounds the inline-JSON branch and `toolTextSummaryMaxLength` (default 80) bounds pattern/glob/path summaries, both inside `ToolPreviewFormatter`.
  Nothing bounds the assembled message, which is the gap [#656] correctly observed and the reason the two caps "do not bound the prompt" as [#710] reports.
- **Nothing bounds height anywhere.**
  `fitToWidth` wraps each line with `wrapTextWithAnsi` explicitly "so no content is lost" (`src/authority/permission-prompt-component.ts:314-326`); the returned row count is unbounded by construction.
- **A forwarded prompt is assembled twice, under two configs.**
  The child assembles its message under *its* preview limits, writes it into the request JSON, and the parent prefixes three lines (`formatForwardedPermissionPrompt`) and renders it.
  The parent's own limits never apply to the child's text — so "consistent across local and forwarded asks" is not merely unstated today, it is structurally unattainable while the payload is a pre-assembled string.
- **Message text rides into the review log unredacted.**
  `writeLine` applies `redactedJsonStringify`, which masks by **key name**; `message` is not a sensitive key, so its contents pass through verbatim ([ADR 0010]'s stated boundary — a secret embedded in a command string is not masked).
  Today that persists at most a 200-character unredacted input preview per entry.
  [#716], which removes that truncation in favour of pretty-printed JSON, would therefore make the review log persist unbounded unredacted tool input — a consequence neither the PR nor [ADR 0010] anticipated, and one the contract must rule on.
- **Expand-on-demand does not reach a forwarded ask.**
  [#642] made `app.tools.expand` live during the dialog, but it toggles the *host session's* tool rendering.
  A forwarded ask has no tool-call entry in the parent transcript, so structurally there is nothing for it to expand — exactly the case [#710] reports.
  This is an inference from the wiring, not a measurement: the build session must verify it against the sibling Pi checkout at `../pi` before the ADR's elision rule relies on "the user can expand to see the full text".

### Standing constraints

- Never redact `formatToolInputForPrompt`: the user must see the real input to decide (package priority; [ADR 0010]).
- `buildUiPrompt` is the single builder for the broadcast payload, and [#292]'s hardening requires a forwarded ask's broadcast to stay non-degraded — any representation change must preserve that.
- The forwarded request/response JSON is an on-disk, cross-process contract with version skew already handled by absence-tolerant fields (`accessIntent`, `sessionApproval`); a structured payload must state its skew posture.
- `docs/decisions/` and `docs/architecture/` are **not** in the package's `files` allowlist, so the ADR must not be linked from a shipped doc (`README.md`, `docs/*.md`) — such a link resolves to nothing in the tarball.
- ADR markdown follows the `markdown-conventions` skill: one-sentence-per-line, reference-style issue links, MD053 discipline.

### Leanings from this planning conversation — explicitly not decisions

- That the invariant core should be the four facts the issue names (requesting agent, tool name, gate surface + matched rule, decision-relevant value) — a starting proposal, not a settled list.
- That a summary must state what it elided (character and line counts, per [#710]) — plausible, but the ADR must decide whether counts are the right disclosure or a false precision.
- That a structured payload is the eventual shape — admitted to the option space by operator decision, not presumed.

## Design Overview

This plan deliberately does not settle the contract.
It defines the decision framework the build session executes.

### Decision criteria (from the issue, in order)

1. **Decidability** — the user can still decide correctly from what remains.
2. **Consistency** — the same rule holds across local, forwarded, and skill asks.
3. **Contributor-checkability** — a contributor can tell whether a proposed change conforms without asking.
4. Retained unless deliberately revisited: never redact the prompt's tool input; least privilege; determinism.

### Option space to evaluate

- **O1 — width cap on the assembled string.**
  [#656]'s shape, generalized: one character bound applied after assembly at every site.
  Cheapest; blind to structure, so it can cut the decision-relevant value and keep the boilerplate.
- **O2 — structure-aware elision with a fixed invariant core.**
  The core is assembled first and never elided; the evidence section is elided to fit a budget, with the elision disclosed.
  Requires each site to distinguish core from evidence, which today none of them do.
- **O3 — height budget with expand-on-demand.**
  [#710]'s shape: bound rows, not characters, and route the full text through an expand affordance.
  Blocked on the forwarded-ask expand gap above unless the ADR also decides an in-dialog expansion.
- **O4 — structured prompt payload.**
  Gates emit facts (`surface`, `tool`, `value`, `evidence[]`, `elision`), and each consumer renders under its own budget: the dialog elides, the review log keeps full text, the broadcast carries the facts.
  Solves the double-assembly problem for forwarded asks and turns [#716] into a renderer rather than a formatter edit.
  Breaking on two contracts (forwarded wire, `ui_prompt` payload); prices in a skew window.
- **O5 — per-consumer budgets over today's string.**
  Keep the string but stop sharing it: assemble once per consumer from the same inputs.
  Middle cost; risks four assemblies drifting, the defect this ADR exists to prevent.
- **O6 — no bound; fix the renderer.**
  Argue the TUI's wrapping is the bug and a scroll/viewport affordance is the fix, leaving the prompt's content unbounded.
  Included because it is the honest counter-hypothesis to [#710]: a viewport problem may deserve a viewport fix, not a content contract.

An option is not adopted merely because it satisfies the criteria — the ADR must also state what each *rejects*, since three dependants add content and two remove it.

### Prior-art survey scope

Bounded to prompt presentation, not policy models (which [#639]'s ADR covers).
For each system extract: what the approval prompt always shows, what it elides and how the elision is disclosed, whether a full-content affordance exists, and how it bounds size.

| System                              | Why it matters                                                    |
| ----------------------------------- | ----------------------------------------------------------------- |
| Claude Code                         | edit-diff approval UX; the model [#648] explicitly cites          |
| Codex CLI                           | approval prompts paired with a sandbox; different elision posture |
| OpenCode                            | this fork's origin; baseline prompt text                          |
| Pi's own tool rendering             | the host's collapsed/expanded convention this dialog sits beside  |
| `sudo` / `gh` / `git` confirmations | long-lived conventions for consequential-action confirmation      |

### Open parameters the build session settles interactively

1. The invariant core — which facts, and whether it differs by surface (bash / tool / MCP / skill / external directory).
2. Elision rules — what may be summarized, what a summary must disclose, and whether disclosure is counts, an ellipsis, or a named affordance.
3. Full-text access — expand-on-demand, a scrollable region, the review log, or "the full text is not reachable from the prompt and that is acceptable".
4. Bounds — width, height, or total; fixed or configurable; and the fate of `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` (subsumed, retained, or deprecated).
5. Consumer entitlements — what the dialog, the review log, the broadcast, and the agent-facing denial text each get, and where they may legitimately differ.
6. Representation — flat string, per-consumer assembly, or structured payload; and if structured, the skew posture for the forwarded wire and the `ui_prompt` contract.
7. Admissibility of *added* content — diffs ([#648]), wrapper inner commands ([#713]), model explanations ([#654]) — against the same budget as everything else, and how model-generated text must be marked.
8. Staging — the per-item disposition for all six dependants, and which builds first.

The gate protocol during `/build-plan`: complete the survey and verify the two open facts (forwarded expand reach; `../pi`'s rendering of a pending tool call) first, present findings and the O1–O6 evaluation, then run `ask_user` gates per parameter cluster before authoring a word of the ADR — decisions precede prose.

### Sketch: what a structured payload would look like

Recorded so the build session evaluates a concrete shape rather than an idea, and explicitly **not** a proposal to adopt:

```typescript
interface PromptContent {
  /** Never elided. */
  core: {
    requester: { agentName: string | null; forwarded: boolean };
    surface: string;
    toolName: string | null;
    value: string;
    matchedPattern: string | undefined;
  };
  /** Elided to fit the consumer's budget. */
  evidence: ReadonlyArray<{ label: string; text: string }>;
}
```

A consumer renders it under its own budget:

```typescript
const view = renderPromptContent(content, DIALOG_BUDGET);
// view.lines: bounded rows; view.elided: { characters, lines } | undefined
```

The interaction to check at build time is Tell-Don't-Ask: the renderer receives a budget and returns a view, rather than consumers reaching into `content.evidence` and slicing it themselves — which is how four assembly sites drifted in the first place.

## Module-Level Changes

Documentation only.

- **New:** `packages/pi-permission-system/docs/decisions/0011-prompt-presentation-contract.md` — the ADR: purpose of an ask prompt, decision criteria, current-assembly inventory (five sites, four consumers), the measured findings above, prior-art survey with citations, options O1–O6 with rejected alternatives and reasons, the settled decisions (parameters 1–8), the staging section, and consequences.
  The 0011 slot is next (0001–0010 taken); the slug may sharpen at build time to reflect the settled decision, keeping the 0011 number.
- **Changed:** `packages/pi-permission-system/docs/architecture/architecture.md` — link ADR 0011 and reconcile any prose the settled decision contradicts.
  Candidate passages, all located this session: the `permission-prompts.ts` / `tool-input-preview.ts` / `tool-input-prompt-formatters.ts` / `tool-preview-formatter.ts` / `external-directory-messages.ts` / `permission-ui-prompt.ts` module-tree entries (lines 758, 775, 797–800), the cross-extension broadcast paragraph (line 534), and the design-principles list if the ADR adds a presentation principle.
  Per the architecture-doc convention, a module-tree entry cites an issue only when the ref encodes an active constraint — a contract the ADR makes binding qualifies; provenance does not.
- **Not edited:** `README.md`, `docs/configuration.md`, `schemas/`, `config/` — they describe current behavior, which this ADR does not change; the two preview-cap rows in `docs/configuration.md:109-110` stay accurate until an implementing issue changes them.
  `.pi/skills/package-pi-permission-system/SKILL.md` — it documents current behavior and constraints, all still true; the never-redact-the-prompt sentence in particular must survive the ADR unchanged unless the ADR deliberately revises it, in which case the skill is updated in the same commit.
  `docs/architecture/history/*`, `docs/plans/*`, `docs/retro/*` — frozen point-in-time records.

## Test Impact Analysis

Not applicable — the deliverable is a decision record with no code.

Tests the settled contract enables, recorded for the dependants' re-plans to inherit:

- A conformance test per assembly site asserting the invariant core is present and unelided, replacing today's 29 string-equality cases in `test/permission-prompts.test.ts` that pin exact prose and therefore make every wording change a test rewrite.
- A bound test asserting the rendered row/character count for a pathological input (the [#710] here-string), which no current test covers.
- A round-trip test asserting a forwarded ask and its local equivalent present the same core — impossible today, since the child's message is assembled under the child's config.
- A review-log test asserting what `message` persists, pinning the [ADR 0010] interaction the [#716] finding exposed.

## Invariants at risk

- **The [#581] transcription failure.**
  This planning conversation produced findings and leanings; the ADR must not launder them into settled status.
  Mitigated structurally: the Build Order puts survey, fact-verification, and `ask_user` gates before ADR authoring, and every leaning is marked reopened in Background.
- **Never redact the prompt's tool input ([ADR 0010], package priority).**
  An elision rule is a *quantity* bound, not a *content* filter; if the ADR's rule ever reads the value to decide what to hide, it has become redaction by another name.
  The ADR must state this boundary explicitly, and the wording must stay compatible with the skill's verbatim boundary sentence.
- **The non-degraded forwarded broadcast ([#292]).**
  Any representation the ADR entertains must keep `buildUiPrompt`'s forwarded payload carrying the requester's agent and session — a bound that elides provenance would regress it silently, since nothing in the broadcast's test surface asserts on message content.
- **Current-behavior docs stay true.**
  `README.md` and `docs/configuration.md` describe shipped behavior; the ADR decides direction and must not cause edits that make current-behavior docs describe unshipped design.
- **Cross-doc consistency.**
  If the decision revises the preview-cap story, the architecture doc's module-tree entries for the four preview/prompt modules must be reconciled in the same change, verified by a whole-file grep for `toolInputPreviewMaxLength`, `toolTextSummaryMaxLength`, and `preview`.

## Build Order

Documentation-only, so `/build-plan` (no red→green cycles).
Numbered `docs:` commits, each leaving the docs internally consistent.

1. **Verify the two open facts.**
   Confirm against the sibling Pi checkout at `../pi` whether a pending tool call is rendered in the transcript at gate time, and whether `setToolsExpanded` can reach anything for a forwarded ask (the parent has no tool-call entry for the child's invocation).
   Dispatch an `Explore` subagent with `model: "sonnet-5"` for this trace rather than running it inline.
   No commit — this is input to parameter 3.
2. **Survey prior art.**
   Extract the four facts per system from the table in Design Overview, with citations.
   No commit.
3. **Deliberate and settle.**
   Present the survey, the measured findings, and the O1–O6 evaluation against the three criteria; run `ask_user` gates covering parameters 1–8, clustered: core+elision; bounds+full-text access; consumers+representation; added-content admissibility+staging.
   No commit — decisions precede prose.
4. **Author ADR 0011.**
   Write `docs/decisions/0011-prompt-presentation-contract.md` recording purpose, criteria, the current-assembly inventory, the survey, options with rejected alternatives, the settled decisions, the six-item staging section, and consequences.
   Verify with `pnpm exec rumdl check` on the new file.
   Commit: `docs(pi-permission-system): record ADR 0011 deciding the prompt-presentation contract (#737)`.
5. **Reconcile the architecture doc.**
   Link ADR 0011 and reconcile contradicted prose in `docs/architecture/architecture.md` in one commit; run the whole-file greps from *Invariants at risk*; verify any touched Mermaid diagram still renders.
   Commit: `docs(pi-permission-system): reconcile architecture with ADR 0011 (#737)`.

## Risks and Mitigations

- **Risk: the ADR is written to ratify one of the two open PRs.**
  Mitigated: O1 ([#656]'s shape) and O4 (which subsumes [#716]'s) are both in the option space alongside O6, which challenges the premise that content is the problem at all; the staging section is authored *after* the criteria are applied, not before.
- **Risk: the contract is unenforceable prose.**
  A rule a contributor cannot check is the failure mode criterion 3 names.
  Mitigated: the ADR must state, for each rule, the mechanism that makes conformance checkable — a test, a lint boundary, or a review checklist item — and the Test Impact Analysis names the conformance-test shape that would carry it.
- **Risk: scope creep into code.**
  Mitigated: Non-Goals fences this to `docs/`; all six dependants stay open and implement.
- **Risk: the widened consumer scope (four surfaces) makes the ADR unfinishable.**
  Mitigated: parameter 5 asks only for *entitlements* — what each consumer gets — not for four separate presentation designs; the agent-facing side may legitimately be settled as "governed by the same core, no size bound".
- **Risk: a structured-payload decision lands with no migration discipline.**
  Mitigated: the ADR records the breaking posture and the skew window for the forwarded wire and the `ui_prompt` payload; the implementing issue's plan carries the `feat!:` commit and a verified migration note, not this ADR.
- **Risk: the two open facts turn out otherwise, invalidating a decision.**
  Mitigated: Build Order step 1 verifies them before any gate runs, and parameter 3's options are written so the answer selects among them rather than being assumed.

## Open Questions

- Parameters 1–8 in Design Overview — deliberately open; they are the ADR's subject.
- Whether the contract should bind [#654]'s model-generated explanation to a stricter budget than deterministic evidence, given it is the only prompt content that is not a fact about the request.
- Whether an in-dialog expansion affordance (as opposed to Pi's host-level `app.tools.expand`) is the right answer for forwarded asks, or whether the review log is a sufficient full-text destination.
- Where the staged dependants' follow-ups get filed — each dependant's own re-plan versus the next `/plan-improvements` pass — settled by the ADR's staging section.

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#581]: https://github.com/gotgenes/pi-packages/issues/581
[#639]: https://github.com/gotgenes/pi-packages/issues/639
[#642]: https://github.com/gotgenes/pi-packages/issues/642
[#648]: https://github.com/gotgenes/pi-packages/issues/648
[#654]: https://github.com/gotgenes/pi-packages/issues/654
[#656]: https://github.com/gotgenes/pi-packages/pull/656
[#710]: https://github.com/gotgenes/pi-packages/issues/710
[#713]: https://github.com/gotgenes/pi-packages/issues/713
[#716]: https://github.com/gotgenes/pi-packages/pull/716
[ADR 0007]: ../decisions/0007-model-judge-authorizer-chain-adr.md
[ADR 0010]: ../decisions/0010-permission-log-secret-exposure.md
