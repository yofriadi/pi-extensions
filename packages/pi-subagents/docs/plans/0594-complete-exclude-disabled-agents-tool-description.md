---
issue: 594
issue_title: "fix(pi-subagents): complete exclude disabled agents from the subagent tool description"
---

# Complete excluding disabled agents from the subagent tool description

## Release Recommendation

**Release:** ship independently

Two `fix:` commits completing an incomplete bug fix (#448); not part of any open release batch (Phase 19, which contained #443/#448, is closed).
Cut a patch release independently at ship time.

## Problem Statement

Commit `9a43414b` (#448) stopped disabled built-in agents from appearing in the subagent tool's **type list** (`buildTypeListText`), but two gaps remain in the generated tool description:

1. Three per-agent usage guidelines are hardcoded as static text in `AgentTool.toToolDefinition` (`src/tools/agent-tool.ts`), so a disabled `Explore`, `Plan`, or `general-purpose` is still named in the `Guidelines:` block — the model receives guidance for an agent it cannot spawn.
2. `buildTypeListText` always emits the `Default agents:` header, even when every default agent is disabled and the section is empty.

The description should reflect the actual registry state.
This is the third-party PR #594 (`@whaoa`), adopted with a simplified design per the recorded PR-review decision (`packages/pi-subagents/docs/retro/0594-complete-exclude-disabled-agents-tool-description.md`).

## Goals

- The per-agent guideline copy is sourced from the agent config (single source of truth) rather than hardcoded parallel to `default-agents.ts`, so a disabled built-in drops its guideline automatically.
- The `Default agents:` header is omitted when no enabled default agents exist.
- Regression coverage for both: disabled built-ins and the empty default-agent list.
- Non-breaking (`fix:`): the guideline **text** is unchanged; the all-enabled description differs only in guideline line **order** (see Design Overview) — cosmetic, operator-confirmed.

## Non-Goals

- No change to the guideline **wording** for any agent.
- No parsing of a `toolGuideline` field from custom-agent `.md` frontmatter — the field is general on `AgentConfig`, but only the embedded defaults set it here.
- No broader refactor of `buildTypeListText` beyond the empty-header guard.
- Not adopting PR #594's diff as-is: its `agent-tool.test.ts` assertion (`- ${name} :`, space before colon) is tautological against the real `- ${name}:` format and is not carried over.

## Background

Relevant modules:

- `src/types.ts` — `AgentConfig` interface (extended with the new optional field).
- `src/config/default-agents.ts` — the three embedded defaults (`general-purpose`, `Explore`, `Plan`) in a `Map`, in that insertion order.
- `src/config/agent-types.ts` — `AgentTypeRegistry`; `getDefaultAgentNames()` returns names in registry (map insertion) order; `TypeListRegistry` (defined in `helpers.ts`) is the narrow interface over `resolveAgentConfig` + `getDefaultAgentNames` + `getUserAgentNames`.
- `src/tools/helpers.ts` — `buildTypeListText(registry, agentDir)` assembles the type-list section; already filters disabled agents via an `isEnabled` predicate.
- `src/tools/agent-tool.ts` — `AgentTool` computes `this.typeListText` in its constructor; `toToolDefinition()` interpolates it into the description template, which currently contains the three hardcoded guideline lines.

AGENTS.md constraints that apply:

- Every implementation/docs commit for this work carries a `Co-authored-by: whaoa <whaoa.w@outlook.com>` trailer (blank line before it, at the end of the body).
- Reference the PR as `Refs #594` / `(#594)`; never `Closes #594`.
- Run `pnpm fallow dead-code` before pushing (the new helper is wired in the same commit that introduces it — no dead-export window).

## Design Overview

### Config field

Add an optional field to `AgentConfig`:

```typescript
export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  // ...existing fields...
  /** One-line usage guideline for the subagent tool's Guidelines: block. Omitted → no guideline line. */
  toolGuideline?: string;
}
```

Populate it on the three defaults in `default-agents.ts`, preserving the current wording:

- `general-purpose`: `"- Use general-purpose for complex tasks that need file editing."`
- `Explore`: `"- Use Explore for codebase searches and code understanding."`
- `Plan`: `"- Use Plan for architecture and implementation planning."`

### Guideline assembly

Add a helper to `helpers.ts`, mirroring `buildTypeListText`'s enabled-filter and reusing the existing `TypeListRegistry` interface (ISP: it reads only `getDefaultAgentNames` + `resolveAgentConfig`, both already on `TypeListRegistry` — no new/wider dependency):

```typescript
export function buildAgentGuidelines(registry: TypeListRegistry): string[] {
  const isEnabled = (name: string) => registry.resolveAgentConfig(name).enabled !== false;
  return registry
    .getDefaultAgentNames()
    .filter(isEnabled)
    .map((name) => registry.resolveAgentConfig(name).toolGuideline)
    .filter((line): line is string => line !== undefined);
}
```

Iteration is in registry order (`general-purpose`, `Explore`, `Plan`), which matches the `Default agents:` type-list order.
This is the operator-confirmed ordering: the all-enabled description's guideline lines reorder from the current `Explore, Plan, general-purpose` to `general-purpose, Explore, Plan` — identical text, order now consistent with the type list.

### Wiring into the description

`AgentTool` computes the guidelines once in its constructor, like `typeListText`:

```typescript
this.agentGuidelines = buildAgentGuidelines(registry);
```

`toToolDefinition()` composes the `Guidelines:` block from an array so the agent guidelines splice into their original position (after the parallel-work line) and an empty list collapses cleanly with no blank line:

```typescript
const guidelines = [
  "- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.",
  ...this.agentGuidelines,
  "- Provide clear, detailed prompts so the agent can work autonomously.",
  "- Subagent results are returned as text — summarize them for the user.",
  // ...remaining static lines unchanged...
].join("\n");
```

The block is interpolated as `${guidelines}` under the `Guidelines:` label.
Edge case: all three defaults disabled → `agentGuidelines` is `[]` → the spread contributes nothing → no blank line, no orphaned label.

### Empty `Default agents:` header

In `buildTypeListText`, guard the header the same way the `Custom agents:` header is already guarded directly below it:

```typescript
return [
  ...(defaultDescs.length > 0 ? ["Default agents:", ...defaultDescs] : []),
  ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
  "",
  `Custom agents can be defined in .pi/agents/<name>.md ...`,
].join("\n");
```

## Module-Level Changes

- `src/types.ts` — add `toolGuideline?: string` to `AgentConfig`.
- `src/config/default-agents.ts` — add `toolGuideline` to the `general-purpose`, `Explore`, and `Plan` configs.
- `src/tools/helpers.ts` — add `buildAgentGuidelines(registry: TypeListRegistry): string[]`; guard the `Default agents:` header in `buildTypeListText`.
- `src/tools/agent-tool.ts` — add a `private readonly agentGuidelines: string[]` field set in the constructor via `buildAgentGuidelines`; import it from `helpers`; replace the three hardcoded guideline lines in `toToolDefinition` with the array-composed `Guidelines:` block.
- `test/helpers/make-deps.ts` — add `createToolDepsWithDisabledBuiltInAgents(...names: string[])` that builds an `AgentTypeRegistry` whose default agents are marked `enabled: false`.
- `test/tools/helpers.test.ts` — extend `makeRegistry`'s `resolve` return to carry an optional `toolGuideline`; add a `describe("buildAgentGuidelines")` block; add the empty-`Default agents:`-header test.
- `test/tools/agent-tool.test.ts` — add a parametrized test that disabling a default drops both its type-list entry and its guideline line; add an all-enabled assertion pinning the guideline lines and their registry order.

No documentation updates: the guideline strings appear only in `src/tools/agent-tool.ts` (verified by grep); no architecture doc, package SKILL, or README references them.

## Test Impact Analysis

1. **New tests enabled** — the guideline logic was previously inline hardcoded template text, untestable in isolation.
   `buildAgentGuidelines` is now a pure function with direct unit coverage (enabled subset, registry order, disabled exclusion, empty list).
   The `AgentTool` description gains a behavioral test for disabled-default guideline removal.
2. **Redundant tests** — none removed.
   PR #594's tautological `agent-tool.test.ts` assertion is not adopted, so there is nothing to simplify away.
3. **Tests that must stay** — the existing `buildTypeListText` disabled-exclusion tests (`excludes disabled agents from the default agents list`, `omits Custom agents section ...`) genuinely pin the type-list layer and are unaffected; the `derives type list from registry — includes default agents in description` test still asserts only type-list lines, so the guideline reorder does not touch it.

## Invariants at risk

- #448 (Phase 19) invariant — disabled agents are excluded from the type list; pinned by `helpers.test.ts` `excludes disabled agents from the default agents list`.
  The empty-header guard must not regress it: that test uses `defaults: ["general-purpose", "Plan"]` with one enabled, so `defaultDescs.length > 0` still holds and the header still renders.
  Keep the test; add the all-disabled case separately.

## TDD Order

1. **`buildAgentGuidelines` + config field + populated defaults, wired into the tool** (`fix:`).
   - Red: in `helpers.test.ts`, add `describe("buildAgentGuidelines")` — asserts it returns the enabled defaults' `toolGuideline` lines in registry order and omits a disabled default (extend `makeRegistry`'s `resolve` to carry `toolGuideline`).
     In `agent-tool.test.ts`, add the parametrized disabled-default test (using the new `createToolDepsWithDisabledBuiltInAgents` helper in `make-deps.ts`) asserting the description omits `- ${name}:` and `- Use ${name} for `, plus an all-enabled assertion pinning the three guideline lines in registry order.
   - Green: add `toolGuideline?: string` to `AgentConfig` (`types.ts`); populate the three defaults (`default-agents.ts`); implement `buildAgentGuidelines` (`helpers.ts`); wire `this.agentGuidelines` + the array-composed `Guidelines:` block (`agent-tool.ts`), removing the three hardcoded lines.
   - Commit: `fix(pi-subagents): source subagent guideline copy from agent config`.
   - Run `pnpm run check` immediately after (shared-interface change to `AgentConfig`).
2. **Omit empty `Default agents:` header** (`fix:`).
   - Red: in `helpers.test.ts`, add a test with only user agents (no defaults) asserting the result does not contain `Default agents:`.
   - Green: guard the header in `buildTypeListText`.
   - Commit: `fix(pi-subagents): omit empty Default agents section header`.

Both commits carry the `Co-authored-by: whaoa <whaoa.w@outlook.com>` trailer.

## Risks and Mitigations

- **Cosmetic reorder of the all-enabled default description** — operator-confirmed (registry order); the guideline text is byte-identical, only line order changes.
  The all-enabled assertion in step 1 pins the new order so it is intentional and documented, not incidental.
- **Empty-list blank-line regression** — the array-composition of the `Guidelines:` block means an empty `agentGuidelines` spread contributes nothing; covered by the all-disabled `agent-tool.test.ts` case.
- **ISP drift** — `buildAgentGuidelines` reuses `TypeListRegistry` and reads only `getDefaultAgentNames` + `resolveAgentConfig`; no wider dependency introduced.

## Open Questions

None.
