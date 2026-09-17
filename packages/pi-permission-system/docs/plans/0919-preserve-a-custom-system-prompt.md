---
issue: 919
issue_title: "pi-permission-system: renderToolSurface appends duplicate Available tools and Guidelines when a custom SYSTEM.md is used"
---

# Remove a tool-surface section only where this package or Pi wrote it

## Release Recommendation

**Release:** ship independently

Issue [#919] appears in no roadmap step, so it carries no `Release:` batch annotation.
It is a user-visible data-loss fix reported independently by two people, and nothing in the current Phase 15 batches depends on it.

## Problem Statement

`renderToolSurface` (`src/exposure/tool-surface-prompt.ts`) removes any line whose trimmed text equals `Available tools:` or `Guidelines:`, wherever in the prompt it sits, and `findSection` ends the removed region at the next line that merely *ends with a colon*.
Nothing ties either match to Pi's authorship.

When Pi builds the prompt from `systemPromptOptions.customPrompt` — a user's `~/.pi/agent/SYSTEM.md` or `.pi/SYSTEM.md`, `--system-prompt`, and also every `@gotgenes/pi-subagents` child — Pi writes **no** tool-surface sections at all (`buildSystemPrompt`'s `if (customPrompt)` branch).
So every match in such a prompt is somebody else's text, and removing it destroys user content.

Reproduced live against pi 0.85.1 with this package loaded, a temp `PI_CODING_AGENT_DIR`, and a dump extension capturing the prompt after the `before_agent_start` chain.
With a `SYSTEM.md` carrying literal headers, the prompt that reached the model had lost the user's tool list, **both** of their guideline bullets, their own trailing instruction (`Answer with one word.`), and Pi's `<project_context>` **opening tag** — swept because Pi's own lead-in line `Project-specific instructions and guidelines:` ends with a colon — leaving an unbalanced `</project_context>`.
What survived read as a generic Pi-default block, which is the observation issue [#932] reports as "pi agent send the default one".
With a `SYSTEM.md` carrying Markdown headings instead (`## Available Tools`), nothing is removed and this package's block is appended anyway, so the agent is given two tool lists — the shape [#919] reports.

[#932] is the same defect seen from the other side, not a separate one: `SYSTEM.md` loading is not broken (the control run showed the custom prompt intact in `ctx.getSystemPrompt()` and `customPrompt` present on the event), and the loss happens entirely in this package's `before_agent_start` pass.

## Goals

- Never remove prompt text this package did not write and Pi did not write.
- Keep Pi's own sections removed where Pi wrote them, so the relocation ADR [0014](../decisions/0014-tool-surface-is-node-local-prose.md) describes is unchanged for a default prompt.
- Keep the tool-surface block rendered in **every** node, including every `pi-subagents` child — whose prompt is also a `customPrompt`.
- Bound a removed section to its own body, so a matched header can never sweep the prose that follows it.
- Leave a region this pass did not edit byte-identical.
- Close [#932] with the same change.

This is not a breaking change: it restores user-authored text and alters no config, default, or public type.
Prompt layout is explicitly not a documented contract (ADR 0014, "The block is always rendered").

## Non-Goals

- **Standing aside entirely for an operator-authored prompt** (no removal *and* no append).
  Considered and declined at the planning gate: a user who wrote their own tool list still sees this session's honest one appended after it.
  Revisit only if duplication is reported again as a problem in its own right.
- **A config switch** (`toolSurfacePrompt: "relocate" | "off"`).
  Declined at the same gate — the defect must be fixed on by default.
- **Implementing [#901]'s `pi-subagents`-side writer.**
  This change preserves the contract that makes the two order-independent (remove any tool-surface block in the tail, then render at the tail) but adds no second writer.
- **Changing what the block renders.**
  `renderToolSurfaceBlock`, `renderAvailableTools`, `renderGuidelines`, and `fileExplorationGuideline` are untouched.
- **Changing tool exposure.**
  `shouldExposeTool`, `resolveExposedTools`, and the `ToolSurfaceBaseline` are untouched; this is prose only.
- **Normalizing line endings or trailing whitespace differently.**
  `normalizePrompt` still rewrites CRLF to LF and the assembled body is still `trimEnd`ed; see Open Questions.

## Background

### The two branches of `buildSystemPrompt`

Read at `../../pi/packages/coding-agent/src/core/system-prompt.ts` and confirmed in the pinned `@earendil-works/pi-coding-agent@0.79.1` dist:

- **Default branch** — Pi writes the preamble, then `Available tools:`, the `In addition to the tools above…` filler, `Guidelines:`, and the `Pi documentation (read only…):` section, then the append text, `<project_context>`, the skills catalogue, and the `Current working directory:` footer.
- **`customPrompt` branch** — Pi writes the custom text, the append text, `<project_context>`, the skills catalogue, and the footer.
  No tool-surface sections, no filler, no documentation section.

The footer is written **unconditionally in both branches**, and it is the last thing Pi writes.
That is the same anchor `pi-subagents` uses to locate Pi's session-resolved tail (`inheritedIdentity`, `packages/pi-subagents/src/session/prompts.ts`), and the anchor ADR 0014's own residual bullet nominates as the fix "if one is ever needed".

### Every subagent child is a `customPrompt` session

`createSubagentSession` builds the child's loader with `systemPromptOverride: () => cfg.systemPrompt` (`packages/pi-subagents/src/lifecycle/create-subagent-session.ts:251`).
In the pinned SDK that override becomes `ResourceLoader.systemPrompt` (`dist/core/resource-loader.js:329`), which `_rebuildSystemPrompt` passes as `customPrompt` (`dist/core/agent-session.js:761`).

So the field the issue proposes to branch on is truthy in **every** child, not only when a user authored a `SYSTEM.md`.
The issue's suggested one-line fix — skip `renderToolSurface` when `customPrompt` is present — would therefore strip the tool block from every child, reversing the case ADR 0014 built render-from-parts for:

> Rendering rather than filtering is what makes the child case work at all: a child's inherited identity carries no tool section to narrow, because its parent's node already relocated it.
> A subtractive implementation would leave such a child with no tool prose.

The existing handler test that pins the child case (`states the session's tools for a prompt that carries no tool surface`) builds its event without `customPrompt`, so that regression would ship green.
Step 3 below adds the test that kills it.

### The greedy end boundary has been half-fixed once already

`docs/plans/archive/0033-fix-findsection-greedy-end.md` (upstream-era issue numbering) fixed `findSection` eating to EOF and kept "stop at the next top-level section header" as the primary rule.
Its Non-Goals recorded why that looked safe: "the real Pi system prompt always places `Guidelines:` after `Available tools:`" — true of the default branch only.
Its own risk note called the behavior "security-adjacent: silently deleting post-section content could remove user-authored safety instructions from the system prompt", which is precisely what [#932] measured.

### Constraints from AGENTS.md and the package skill

- The system prompt is a shared mutable artifact several parties write.
  Besides Pi and this package, `@gotgenes/pi-subagents` composes a child's prompt, and `pi-anthropic-auth` reshapes the payload at the transport layer, after every `before_agent_start` handler has run.
  This change edits only what this package removes; it adds no new writer and moves nothing.
- ADR 0012 and the package skill require the relocation to run in **every** node.
  Nothing here makes it conditional on node role.
- The architecture module-tree entry for a module describes current behavior, and cites an issue only when the ref encodes an active constraint.

## Design Overview

### The rule

> Remove a tool-surface section only in a region this package or Pi wrote, and remove no more of it than the section's own body.

Two regions, split at Pi's footer:

| Region | Bounds                                                               | Who wrote it                                                                             | Removal                  |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| Head   | Start of prompt through the last `Current working directory: …` line | Pi, when `customPrompt` is falsy; otherwise a user, `pi-subagents`, or another extension | Only when Pi authored it |
| Tail   | Everything after that line                                           | This package, or a peer implementing [#901]                                              | Always                   |

The tail removal is what keeps the pass idempotent and order-independent with a second writer: whichever extension runs last drops the block already there and renders the correct one.

### Shapes

```typescript
export interface ToolSurfaceInputs {
  readonly allowedTools: readonly string[];
  readonly toolSnippets: Readonly<Record<string, string>>;
  readonly guidelinesByTool: ReadonlyMap<string, readonly string[]>;
  /**
   * Whether Pi wrote the prompt's preamble itself.
   *
   * False when Pi assembled the prompt from `customPrompt` — a user's
   * SYSTEM.md, or a subagent child's assembled prompt — in which case Pi
   * wrote no tool-surface sections and every line above its footer belongs
   * to somebody else.
   */
  readonly piAuthoredPreamble: boolean;
}
```

The handler supplies it with the same truthiness test Pi itself uses (`if (customPrompt)`), so an empty-string custom prompt is "no custom prompt" here exactly as it is there:

```typescript
const toolSurfacePrompt = renderToolSurface(event.systemPrompt, {
  allowedTools,
  toolSnippets: event.systemPromptOptions?.toolSnippets ?? {},
  guidelinesByTool: registered.guidelinesByTool,
  piAuthoredPreamble: !event.systemPromptOptions?.customPrompt,
});
```

### Locating the footer

```typescript
const FOOTER_PREFIX = "Current working directory: ";
```

Scan from the end for the last line starting with that prefix; the tail begins at the following index.
Taking the **last** occurrence is what makes the anchor safe without knowing the cwd: Pi appends its footer after everything it assembled, so a user's own line of that shape is always earlier.
When no footer is found — something downstream rewrote Pi's output wholesale — the tail is empty and the whole prompt is the head, which keeps the default-prompt behavior unchanged and is recorded as an accepted edge below.

### Bounding a section

`findSection` keeps its first-occurrence start (`lines.findIndex`, unchanged) and drops the "stop at the next top-level section header" scan entirely.
A section is its header plus its own contiguous body:

- a blank line,
- a `-` bullet,
- an indented line,
- Pi's `(none)` placeholder, which it writes when no selected tool has a snippet.

`isTopLevelSectionHeader` has no other caller and goes with the rule.

Traced against Pi's real default prompt, the result is byte-identical to today's: the `Available tools:` section ends at the filler sentence (removed separately), and the `Guidelines:` section ends at `Pi documentation (read only…):`.
What changes is only the case the old rule could not see — a matched header with prose, not another header, after it.

### Leaving an unedited region alone

`collapseExtraBlankLines` runs on a region only when that region actually lost lines.
A custom prompt containing a run of three blank lines then comes through byte-identical rather than being reflowed by a pass that removed nothing from it.

### Call-site sketch

```typescript
const lines = normalizePrompt(systemPrompt).split("\n");
const tailStart = extensionTailStart(lines);
const head = settle(lines.slice(0, tailStart), inputs.piAuthoredPreamble);
const tail = settle(lines.slice(tailStart), true);
const body = [head, tail].filter((part) => part.length > 0).join("\n").trimEnd();
return body.length > 0 ? `${body}\n\n${renderToolSurfaceBlock(inputs)}` : renderToolSurfaceBlock(inputs);
```

`settle(region, removalAllowed)` removes the two sections and the filler line when `removalAllowed`, collapses blank runs only if it removed something, and returns the joined text.
The render half is called exactly as before.

### What the two reporters see afterwards

- A `SYSTEM.md` with literal headers keeps its list, its guidelines, its prose, and Pi's `<project_context>` tag, and gains this session's block after the footer.
- A `SYSTEM.md` with Markdown headings is unchanged from today: its sections were never matched, and the block is still appended.
  The duplicate-list complaint in [#919] is answered by the appended block being the authoritative one, not by suppressing it — see Non-Goals.

## Module-Level Changes

| File                                                      | Change                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/exposure/tool-surface-prompt.ts`                     | Add `piAuthoredPreamble` to `ToolSurfaceInputs`; split the prompt at Pi's footer; gate head removal on authorship; always remove in the tail; bound a section to its own body and delete `isTopLevelSectionHeader`; scope the filler-line filter and `collapseExtraBlankLines` to the region that was edited. Module docstring updated to state the rule. |
| `src/handlers/before-agent-start.ts`                      | `BeforeAgentStartPayload.systemPromptOptions` gains `customPrompt?: string`; `handle` passes `piAuthoredPreamble: !event.systemPromptOptions?.customPrompt`.                                                                                                                                                                                              |
| `test/exposure/tool-surface-prompt.test.ts`               | Rename `piPrompt()` → `piAuthoredPrompt()` (26 call sites); add a `customAuthoredPrompt()` fixture; add the `piAuthoredPreamble` default to `inputs()`; invert the project-context residual test; add the new cases listed under Test Impact Analysis.                                                                                                    |
| `test/handlers/before-agent-start.test.ts`                | Add cases passing `customPrompt` through `makeEvent`'s existing `Partial<BuildSystemPromptOptions>` overrides — no fixture reshape needed.                                                                                                                                                                                                                |
| `docs/decisions/0014-tool-surface-is-node-local-prose.md` | Rewrite the first accepted-residual bullet: the trimmed-text match is now bounded by authorship and region, with the narrower residual that remains.                                                                                                                                                                                                      |
| `docs/configuration.md`                                   | `before_agent_start` hook-table row and the relocation bullet under "Additional behaviors": Pi's sections are removed only where Pi wrote them, and a custom system prompt's own text is never edited.                                                                                                                                                    |
| `docs/architecture/architecture.md`                       | Module-tree entry for `tool-surface-prompt.ts` (line ~964) restated to the region rule.                                                                                                                                                                                                                                                                   |
| `.pi/skills/package-pi-permission-system/SKILL.md`        | The tool-surface paragraph currently reads "removes the `Available tools:` and `Guidelines:` sections pi wrote and renders this session's own at the end of the prompt" — reworded prose with no removed symbol to grep, so it is listed explicitly.                                                                                                      |

### Predicted unchanged, with the claim each rests on

- `test/composition-root.test.ts` — its untyped fake `before_agent_start` payloads omit `customPrompt`, and the tidy-first assessment found no assertion in that file against resulting `systemPrompt` content, so an absent field reads as "Pi authored it" and nothing there changes.
- `README.md` — no occurrence of "system prompt" or "Available tools"; the package README documents config and commands, not prompt assembly.
- `docs/subagent-integration.md` — does not name the tool surface (verified by grep over `packages/pi-permission-system/docs`).
- Every `renderAvailableTools` / `renderGuidelines` / `fileExplorationGuideline` test — the render half takes no new input and is not re-entered.
- The `prefix a subagent child shares with its parent` tests — the change only ever removes *less*, so a shared identity can lengthen but not shorten.

### Greps run at planning time

- `grep -rn "renderToolSurface\|ToolSurfaceInputs"` across `src/` and `test/` — one production caller (`before-agent-start.ts`), one test file.
- `grep -rln "Available tools\|tool-surface\|renderToolSurface\|toolSurface"` across `packages/pi-permission-system/docs`, `README.md`, and `.pi/skills/` — the four doc targets above, plus plans, retros, and `docs/architecture/history/`, which are historical records and are not edited.
- `isTopLevelSectionHeader` — referenced only inside `findSection`.

## Test Impact Analysis

### New tests the change enables

At `test/exposure/tool-surface-prompt.test.ts`:

1. A custom-authored preamble with literal `Available tools:` / `Guidelines:` sections keeps both, keeps the prose after them, and keeps a following `<project_context>` opening tag.
2. The same prompt still gains this session's block at the tail.
3. A custom-authored preamble containing this package's own tail block has that block replaced, not duplicated — idempotence under `piAuthoredPreamble: false`.
4. A Pi-authored prompt is unchanged from today (the existing suite, re-run).
5. A section whose header is followed by prose, then a colon-ended line, loses only the header and its own body.
6. Pi's `(none)` placeholder is removed with its section.
7. A custom-authored preamble with a three-blank-line run comes through byte-identical.

At `test/handlers/before-agent-start.test.ts`:

1. With `customPrompt` set, the handler still appends the tool block (the child guard — the test the rejected one-line fix would fail).
2. With `customPrompt` set, a literal `Available tools:` section in the prompt survives.
3. Without `customPrompt`, Pi's section is still removed (the existing case, retained).

### Tests that change

- `removes a section-header-shaped line in project context, indented or not` — currently documents ADR 0014's residual.
  It has no Pi-authored tool surface at all, so under the new rule the same input with `piAuthoredPreamble: false` must **preserve** the heading and its bullets.
  Rewrite as the preservation assertion and keep the Pi-authored variant as a sibling.
- `keeps a Guidelines section that ends the prompt from swallowing later prose` — expected to stay green under the body-only boundary; if the fixture's shape makes it trivially green, extend it with the colon-ended-line case from item 5 above rather than deleting it.

### Tests that stay as-is

Everything under `the Available tools section`, `the Guidelines section`, `placing this session's block`, `the prefix a subagent child shares with its parent`, and `stability across turns` — they exercise the render half and the Pi-authored path, both of which this change is required not to move.

## Invariants at risk

| Invariant                                                                               | Source                                                            | Pinned by                                                                                                                                      | Action                                                                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The block is rendered in every node, including one whose prompt carries no tool surface | ADR 0014, "The block is always rendered"; [#901]                  | `renders a block for a prompt carrying no tool surface at all`; handler `states the session's tools for a prompt that carries no tool surface` | Neither sets `customPrompt`, so neither pins the real child case — add a `customPrompt` variant of both in step 3 |
| The relocation runs in every node, unconditionally                                      | ADR 0014, "Every node, not only children"                         | The same two tests                                                                                                                             | Unchanged: authorship gates *removal*, never rendering                                                            |
| A child's inherited identity stays byte-identical to its parent's                       | [#890]; ADR 0014                                                  | `the prefix a subagent child shares with its parent` (two tests)                                                                               | Unchanged; the change can only preserve more bytes, never fewer                                                   |
| The pass is idempotent over its own output                                              | ADR 0014's remove-then-render contract; [#901] order-independence | `is unchanged by a second pass over its own output`                                                                                            | Extend to `piAuthoredPreamble: false`, which is where the tail removal is the only thing preserving it            |
| The wire prompt is stable across turns for a stable policy                              | [#437]                                                            | `keeps the wire system prompt stable across the tool-listing drift between turns`                                                              | Unchanged; that test is Pi-authored and its removal path is identical                                             |
| Tool exposure is restrict-only and rebuilt from the baseline each turn                  | [#873]; [#815]                                                    | `test/exposure/tool-surface-baseline.test.ts`, the `policy changes across turns` block                                                         | Untouched — no exposure code changes                                                                              |

The quantitative invariant ADR 0014 records — the shared-identity length, measured at 365 characters before #890 and the full identity after — is not disturbed: for a Pi-authored prompt the removal is byte-identical to today's, and for any other prompt the change removes strictly less.

## TDD Order

Each step is red → green → verify (`pnpm run check`, `pnpm --filter @gotgenes/pi-permission-system run test`) → commit.

1. **`test(pi-permission-system): name the Pi-authored prompt fixture for what it is`** Rename `piPrompt()` to `piAuthoredPrompt()` across its 26 call sites in `test/exposure/tool-surface-prompt.test.ts`.
   Pure rename, no behavior change.
   Prepares the friction the Tidy-First assessment named: step 3 adds a `customAuthoredPrompt()` sibling, and an asymmetric pair (`piPrompt` / `customAuthoredPrompt`) would read as "the prompt" versus "a variant".
   No killing mutation — this step adds no assertion.

2. **`fix(pi-permission-system): stop a removed prompt section from swallowing the prose after it`** Test surface: `test/exposure/tool-surface-prompt.test.ts`.
   Covers: a `Guidelines:` header followed by bullets, then prose, then a colon-ended line — only the header and its bullets go; Pi's `(none)` placeholder is removed with its section; the whole existing Pi-authored suite stays green.
   Implementation: `findSection` ends at the first line that is not a section-body line; `isSectionBodyLine` accepts the `(none)` placeholder; delete `isTopLevelSectionHeader`.
   **Killing mutation:** restore the old end scan — `for (let i = start + 1; i < lines.length; i++) if (isTopLevelSectionHeader(lines[i])) return { start, end: i }` ahead of the body walk.
   The prose-survival test must turn red; the Pi-authored suite must stay green under it, which is what shows the two rules agree on Pi's own prompt.

3. **`fix(pi-permission-system): keep a custom system prompt's own tool and guideline sections`** Test surface: `test/exposure/tool-surface-prompt.test.ts` and `test/handlers/before-agent-start.test.ts`.
   Covers: the head/tail split at Pi's footer; head removal only when `piAuthoredPreamble`; tail removal always; the filler-line filter scoped the same way; the handler deriving the flag from `event.systemPromptOptions?.customPrompt`.
   The required field on `ToolSurfaceInputs`, the `inputs()` default, the handler payload interface, and the handler call site all land in this commit — a required field cannot be added in a separate one.
   Also invert the project-context residual test here, since this commit is what changes its answer.
   **Killing mutations,** one per equivalence class:
   - Remove the authorship gate (`settle(head, true)` unconditionally) → the custom-prompt preservation tests and the inverted project-context test go red; the Pi-authored suite stays green.
   - Skip the tail removal (`settle(tail, false)`) → the `piAuthoredPreamble: false` idempotence test goes red.
   - Hardcode `piAuthoredPreamble: true` in the handler → the handler's custom-prompt preservation test goes red while the module tests stay green, which is what proves the wiring is pinned.
   - Apply the issue's proposed fix — return `event.systemPrompt` unchanged when `customPrompt` is set → the new handler test asserting a `customPrompt` session still receives the block goes red.
     This is the regression the current suite would not have caught.

4. **`fix(pi-permission-system): leave an unedited prompt region byte-identical`** Test surface: `test/exposure/tool-surface-prompt.test.ts`.
   Covers: a custom-authored prompt containing a three-blank-line run and no tool-surface sections is returned with its head byte-identical, followed by the block.
   Implementation: `collapseExtraBlankLines` runs on a region only when that region lost lines.
   **Killing mutation:** collapse unconditionally → the byte-identical test goes red, and only that one.

5. **`docs(pi-permission-system): record the tool-surface removal boundary`** Update ADR 0014's first accepted-residual bullet, the two `docs/configuration.md` passages, the `docs/architecture/architecture.md` module-tree entry, and the `.pi/skills/package-pi-permission-system/SKILL.md` tool-surface paragraph.
   Verify with `pnpm exec rumdl check` on the edited files and a re-grep of the terms listed under Greps run at planning time.

## Risks and Mitigations

| Risk                                                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A prompt with no `Current working directory:` footer puts our own previous block in the "head", where a non-Pi-authored pass will not remove it — a second pass would duplicate it | Pi writes the footer unconditionally in both branches and last; only a downstream rewrite of Pi's whole output removes it, and that rewrite has already broken `pi-subagents`' identity anchor too. Documented as an accepted edge in the module docstring, with a test recording the behavior rather than endorsing it |
| A user's `SYSTEM.md` ends with a line starting `Current working directory:` and is mistaken for Pi's footer                                                                        | Impossible by construction: Pi appends its own footer after the custom text, so the last occurrence is always Pi's. Pinned by a test whose custom prompt contains such a line                                                                                                                                           |
| Pi rewords the `In addition to the tools above` filler upstream, leaving it in a default prompt                                                                                    | Pre-existing exposure, unchanged by this plan; the sentence is matched by prefix and its absence costs one stale line, not a removal                                                                                                                                                                                    |
| A future `pi-subagents` writer ([#901]) renders a block and this pass then removes it, or the reverse                                                                              | The tail removal is unconditional, so whichever extension runs last produces the correct block — the contract [#901] records. Pinned by the `piAuthoredPreamble: false` idempotence test                                                                                                                                |
| The duplicate-list complaint in [#919] is not fully answered                                                                                                                       | Deliberate: the direction gate chose preserve-and-append over standing aside. `docs/configuration.md` will state that a custom system prompt keeps its own text and still receives this session's block                                                                                                                 |
| A user whose `SYSTEM.md` deliberately shortened the prompt still receives an appended block                                                                                        | Same decision; the block is the only honest statement of a policy-narrowed surface, and Non-Goals records the alternative if it is reported again                                                                                                                                                                       |

## Open Questions

- `normalizePrompt` rewrites CRLF to LF and the assembled body is `trimEnd`ed, so a Windows-authored `SYSTEM.md` is still not returned byte-for-byte even when nothing is removed.
  Both predate this change and neither was reported; left alone rather than widening the diff.
  Revisit if a Windows user reports it.
- Whether `ToolSurfaceInputs` should eventually split into a removal input and a render input.
  The Tidy-First assessment considered and declined splitting the module, and the interface carries one extra boolean; revisit only if a third removal-shaping input appears.

[#437]: https://github.com/gotgenes/pi-packages/issues/437
[#815]: https://github.com/gotgenes/pi-packages/issues/815
[#873]: https://github.com/gotgenes/pi-packages/issues/873
[#890]: https://github.com/gotgenes/pi-packages/issues/890
[#901]: https://github.com/gotgenes/pi-packages/issues/901
[#919]: https://github.com/gotgenes/pi-packages/issues/919
[#932]: https://github.com/gotgenes/pi-packages/issues/932
