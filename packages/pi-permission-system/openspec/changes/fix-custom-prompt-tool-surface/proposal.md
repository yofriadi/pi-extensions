## Why

When a custom system prompt is in use (`.pi/SYSTEM.md`, `~/.pi/agent/SYSTEM.md`, or `--system-prompt`), Pi's `buildSystemPrompt` takes its `customPrompt` branch and returns the operator's text plus project context, skills, and the working-directory footer.
That branch emits no tool surface at all — no `Available tools:` line, no `Guidelines:` line.

`AgentPrepHandler.handle` nevertheless calls `renderToolSurface` unconditionally.
That function is written as *relocate*: strip the sections Pi wrote, re-render this session's own at the end.
With nothing of Pi's to strip, relocate degrades into pure append, so the operator's own tool surface stays where they wrote it and a second, generated one lands at the bottom past `Current working directory:`.

The strip cannot match an operator-authored surface anyway.
`findSection` compares `line.trim() === "Available tools:"`, while hand-written and generated `SYSTEM.md` files conventionally use Markdown headings such as `## Available Tools` and `## Guidelines`.
This is upstream [gotgenes/pi-packages#919](https://github.com/gotgenes/pi-packages/issues/919), reproduced here against a generator that writes exactly those two headings and is passed to Pi with `--system-prompt`.

An operator who supplies a whole system prompt has stated what the agent should be told.
Appending a second tool surface to it contradicts that, and the extension gains nothing by doing so: the prompt is prose, while `setActive` and the permission gates are what actually decide whether a call is allowed.

## What Changes

- `AgentPrepHandler.handle` skips `renderToolSurface` when Pi reports a non-empty `systemPromptOptions.customPrompt`, passing the prompt through to skill sanitization unchanged.
- Pi already supplies `systemPromptOptions.customPrompt` on `BeforeAgentStartEvent`, and the imported tip already reads it, so the fork's only interface change is the comment: `customPrompt` explains when rendering is skipped.
- Skill filtering, tool filtering, `setActive`, and the debug log for a changed surface are unaffected and continue to run on every turn for every prompt.
- When no custom prompt is in use, behavior is byte-for-byte unchanged: Pi's sections are stripped and this session's are relocated to the tail, preserving the shared leading-byte prefix a subagent child inherits (#890).
- `renderToolSurface` and its helpers are not modified.
  No header normalization, no Markdown parsing, no in-place rewriting of operator text.

## Capabilities

### New Capabilities

- `tool-surface-prompt`: When a session's tool surface is stated in the system prompt and when the operator's prompt is left alone, and what stating it may never do to prompt text the operator wrote.

### Modified Capabilities

*(none — this fork has no existing specs; upstream tracks planning under `docs/plans/` rather than OpenSpec.)*

## Impact

- **Code:** `src/handlers/before-agent-start.ts` only — guard one call and update the interface comment (the `customPrompt` field itself arrived with the imported tip). `src/exposure/tool-surface-prompt.ts` is untouched.
- **Tests:** `test/handlers/before-agent-start.test.ts` gains cases for the skip, for skill filtering still applying under a custom prompt, and for unchanged relocation without one.
  The existing `makeEvent` helper already accepts `Partial<BuildSystemPromptOptions>`, so `customPrompt` needs no fixture change.
- **Runtime:** No change to enforcement. `toolRegistry.setActive` and the permission gates remain the sole authority over what a session may call.
- **Interaction:** `pi-subagent-herdr` launches children with `--system-prompt` carrying the agent definition body, so a child's tool surface comes from its own agent file rather than from the parent's prompt.
  A child is therefore also an operator-authored prompt for the purposes of this change.
- **Package:** First local fix on top of the subtree import, kept in its own commit (offering it upstream was superseded by upstream's own #919 fix; see the tasks.md disposition).

## Alternatives considered and rejected

### Reconcile the operator's tool list in place

Rewrite the operator's `Available Tools` section, intersecting their bullets with the session's allowed set so the stated list is always exactly right.

Rejected as unsafe.
Adversarial review found three independent ways it destroys operator text, each verified against the pre-rebase import (upstream 32.0.5) and a real `SYSTEM.md`.
The line references below are to that pre-rebase code; the landed tip has since removed `isTopLevelSectionHeader` (upstream af79199) and moved the survivors (`isSectionBodyLine` to `:297`, `findSection` to `:307`).

- `isTopLevelSectionHeader` — since removed by the landed tip — required a trailing `:`, so `## Guidelines` is not a section boundary.
  A section starting at `## Available Tools` runs to the first colon-terminated line, capturing 40 of 50 lines of the reproduction prompt — the operator's entire guidelines prose, deleted.
- Removing the blank-line clause from `isSectionBodyLine` (now `:297` in the landed tip), needed so a section stops at a paragraph break, makes the other branch capture the header alone and produces a *new* duplicate.
- A bullet parser accepting "identifier then `:` or whitespace" reads prose bullets as tool names (`- Offload research…` → tool `Offload`) and dropped 13 of the reproduction prompt's guideline bullets.

`findSection` (now `:307` in the landed tip) also matches only the first occurrence, so a prompt carrying more than one surface region cannot be fully reconciled.
For a permission extension, silently deleting operator instructions is a worse failure than an over-broad tool list, and every one of these defects follows from parsing prose that the operator owns.

### Append a line naming withheld tools

Leave the operator's prompt untouched and append one sentence when `surface.withheld` is non-empty.

Rejected because the signal is empty in the case it was meant for.
`withheld` means baseline members *policy* denies, and the baseline only grows from tools observed active (`tool-surface-baseline.ts:86-92`).
A child narrowed with `--tools` never has the parent's extra tools registered, so they are absent rather than withheld and the line would never render.
Deriving the set from the operator's own list instead would reintroduce the prose parsing this change exists to avoid.

### Fix it in Pi rather than the extension

The root cause is `buildSystemPrompt` omitting the tool surface on the `customPrompt` branch while the extension assumes one is present.
Pi holds the surface structurally — it already passes `toolSnippets` on the event — so either emitting the surface on that branch or exposing the region structurally would remove the need for any extension-side handling.

Worth filing, and the upstream pull request should cite it, but it does not change this fix: skipping is correct regardless of what Pi later chooses to emit, because an operator-supplied prompt is the operator's to define.
