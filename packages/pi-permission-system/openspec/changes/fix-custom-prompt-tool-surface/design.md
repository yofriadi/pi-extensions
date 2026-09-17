## Context

`renderToolSurface` (`src/exposure/tool-surface-prompt.ts`) states a session's tool surface by relocation: remove the `Available tools:` and `Guidelines:` sections Pi wrote wherever they sit, then render this session's own at the end.
Relocation rather than in-place narrowing is deliberate and documented in the module header — a subagent implementation copies everything ahead of the skills catalogue into a child's prompt verbatim, so editing the region in place would end the shared leading-byte prefix for every child whose allowed set differs from its parent's (#890).

Relocation assumes Pi's sections exist to be removed.
That holds only on Pi's default path.
`buildSystemPrompt` returns early when `customPrompt` is set, emitting the operator's text plus project context, skills, and the working-directory footer, and no tool surface.
`AgentPrepHandler.handle` calls `renderToolSurface` unconditionally, so on that path strip-then-append degrades into pure append.

The strip could not match an operator's headers anyway: `findSection` compares `line.trim()` against the literals `Available tools:` and `Guidelines:`, while `SYSTEM.md` files conventionally use `## Available Tools` and `## Guidelines`.

Two constraints shape the decision.
First, the prompt is descriptive: `toolRegistry.setActive` and the permission gates decide what a session may call, so an inaccurate list is a UX defect rather than a policy hole.
Second, prompt text the operator wrote is theirs; a permission extension that silently rewrites it fails worse than one that leaves a list over-broad.

## Goals / Non-Goals

**Goals:**

- Remove the duplicate tool surface when a custom system prompt is in use.
- Guarantee the operator's prompt is never modified by tool-surface handling.
- Leave the assembled-prompt path byte-for-byte unchanged, so the #890 prefix guarantee is untouched.
- Keep tool filtering, skill filtering, and enforcement running identically on both paths.

**Non-Goals:**

- Correcting an operator's tool list against the session's allowed set.
- Parsing Markdown, normalizing headers, or interpreting the operator's prompt structure in any way.
- Merging tool-contributed guideline bullets into an operator's prompt.
- Changing what any session may call.

## Decisions

### Skip rendering when the prompt is operator-authored

`AgentPrepHandler.handle` guards the `renderToolSurface` call on a non-empty `systemPromptOptions.customPrompt` and otherwise passes `event.systemPrompt` through untouched to skill sanitization.

This is the fix the upstream issue proposed, and after review it is also the one with the best safety properties: the operator's prompt is not read, parsed, or rewritten, so no defect in this change can damage it.
The guard is on a value Pi already supplies on `BeforeAgentStartEvent`, so nothing is inferred from prompt text.

Non-empty rather than merely present, because an empty string is not a prompt the operator authored.

### The stated list may be less specific than the real surface, and that is acceptable

Under a custom prompt the extension no longer states the session's tool surface, so a prompt listing a tool that policy denies will keep listing it.
The consequence is bounded: the model may attempt a denied tool and be refused by the gates.

This is preferable to the alternative, which is rewriting the operator's document to keep the prose exact.
Adversarial review verified three distinct ways that rewriting deletes operator text (recorded in the proposal), each traced to the same root cause — inferring structure from prose the extension does not own.

The operator retains the direct remedy: their prompt is theirs to keep accurate, and a subagent's prompt comes from its own agent definition.

### Children are covered by the same rule

`pi-subagent-herdr` passes the agent definition body with `--system-prompt`, which short-circuits Pi's `SYSTEM.md` discovery, so a child's prompt is its own agent file and `customPrompt` is set.
A child therefore takes the skip too, and states the tools its agent definition declares.

This is why the skip does not leave children describing a surface they lack: the child's prompt is no longer the parent's.
Before that change a child inherited the parent's `SYSTEM.md` through agent-directory discovery, which is what made a bare skip look unsafe and motivated the rejected reconcile design.

### Nothing else about the turn changes

The guard is placed on the render call alone, after tool resolution and `setActive` and before skill sanitization.
Tool filtering, the active-set write, the changed-surface debug record, and skill filtering all continue to run unconditionally.

Placing the guard earlier — returning from `handle` before those steps — would silently disable policy enforcement for every operator-authored prompt, which is the one outcome this package must never produce.

## Risks / Trade-offs

- **A custom prompt keeps naming a denied tool** → Bounded to a refused call; the gates hold.
  Accepted by decision above, and the reason the alternative was rejected is recorded so the tradeoff is not revisited without the evidence.
- **A newly registered tool contributes `promptGuidelines` an operator's prompt does not mention** → That guidance goes unstated under a custom prompt.
  Operators who generate their prompt from their active tool set already emit it; those who hand-write take on keeping it current.
  This is the specific residual cost of not writing to the operator's prompt.
- **The guard is placed too early during implementation, skipping filtering** → Prevented by a test asserting `setActive` receives the same argument and skills are still filtered when `customPrompt` is set.
- **`customPrompt` is absent from the installed Pi typings** → The payload type is local to the handler, so a local widening would compile even if the field did not exist and the guard would silently never fire.
  Verified against the installed version before implementation, and a test asserts the skip actually happens.

## Migration Plan

The package is imported as a git subtree from `gotgenes/pi-packages`, and this fix lands as a separate commit on top of that import.

Four import constraints were verified against this repository and must be handled in the import phase, or the package will not install, compile, or lint here:

- The upstream manifest uses `"catalog:"` for five dev dependencies.
  This repository's `pnpm-workspace.yaml` defines no catalog, so `pnpm install` fails until they are pinned to the versions this repo already uses.
- The package `tsconfig.json` extends `../../tsconfig.base.json`, which after import resolves to this repository's stricter base (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ES2022).
  Upstream source is not written against those options — `tool-surface-prompt.ts:241` indexes `lines[index]` unguarded — so the package needs a local tsconfig that does not inherit the fork base.
- This repository's `biome.json` includes `packages/**/*.ts` and excludes every other vendored package by name.
  Without adding this one, `biome check` reformats the whole subtree to tab/width-4, destroying the byte relationship an upstream patch depends on.
- Upstream's ESLint config carries three rules scoped specifically to this package (a same-directory import convention, a ban on interior `process.platform` reads, and an import restriction keeping the permission manager string-based).
  Biome cannot express them; dropping ESLint here is acceptable only as a recorded, knowingly unenforced invariant, re-checked upstream before any patch is offered.
- Upstream uses constructor parameter properties in roughly 89 places, which this repository's conventions forbid for code it authors.
  Bare `node --experimental-strip-types` rejects them, but Pi loads extensions through jiti, which compiles them, as do vitest and the type-checker, so the imported source runs unmodified on every path the extension actually takes.
  The one exception is the package's own `gen:schema` script, which invokes native stripping directly; its import chain reaches no parameter property today, so it works, but that is a boundary to record rather than a guarantee.
  This is recorded as a deliberate exception rather than fixed: rewriting 89 constructors would break the byte relationship an upstream patch depends on, and the rule exists for code this repository writes.

Rollback is reverting the fix commit.
Sessions without a custom system prompt are unaffected by construction, which bounds the blast radius to prompts the operator authored.

## Open Questions

- Should the extension emit a one-time diagnostic when a custom prompt is in use and policy withholds a registered tool, so the operator learns their prompt has drifted without the prompt being touched?
  Deferred: it is additive, and the debug stream already records the withheld set.
- Should Pi emit the tool surface on the `customPrompt` branch, or expose the region structurally on `BeforeAgentStartEvent`?
  Either would make extension-side handling unnecessary.
  Worth filing upstream and citing from the pull request; it does not block this fix.
