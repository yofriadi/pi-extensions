---
issue: 172
issue_title: "refactor(pi-subagents): extract shared turn-formatting logic"
---

# Retro: #172 — Extract shared turn-formatting logic

## Stage: Planning (2026-05-24T18:00:00Z)

### Session summary

Planned the extraction of duplicated turn-formatting logic from `lifecycle/agent-runner.ts` and `ui/message-formatters.ts` into a new shared module `session/content-items.ts`.
The plan covers extracting `ToolCallContent`, `getToolCallName`, and a new `extractAssistantContent` function, with a 6-step TDD order.

### Observations

- Issue #170 (completed) shifted the duplication target from `conversation-viewer.ts` to `message-formatters.ts` — the issue body's line references are stale but the duplication still exists in the same form.
- Both dependencies (#164 and #170) are closed, so this is unblocked.
- The duplication is clearly incidental (same data extraction, different presentation) — safe to extract per the code-design skill's structural-reasons check.
- `getToolCallName` has no direct unit tests today; the extraction enables testing it for the first time.
- `getAgentConversation` also has no tests — noted as out of scope but worth a follow-up.
- Considered adding `extractText` to the new module for consistency but deferred to keep scope tight.

## Stage: Implementation — TDD (2026-05-24T19:05:00Z)

### Session summary

Completed all 6 TDD steps from the plan.
Created `session/content-items.ts` with `getToolCallName` and `extractAssistantContent`, added 11 unit tests, then refactored both `message-formatters.ts` and `agent-runner.ts` to use the shared module.
Test count went from 896 to 907 (+11).

### Observations

- Steps 1 and 2 (test-only commits) were folded into step 3's feat commit per the plan's intent — all three land together.
- The `getToolCallName` parameter type needed widening from `{ type: string }` to `{ type: string; [key: string]: unknown }` to allow test object literals to pass excess-property checking.
  This in turn required an `as unknown as` double cast at the `agent-runner.ts` call site, because the SDK's `TextContent | ThinkingContent | ToolCall` union lacks an index signature.
  Same pattern already present in `conversation-viewer.ts`.
- `message-formatters.ts` had both an import and a re-export of `getToolCallName`; simplified to a pure re-export only.
- The lint fixup (unused import) was amended into the same refactor commit before pushing.
- Architecture doc updated: `content-items.ts` added to session module listing, production-duplication section updated, Step 9 marked Done.

## Stage: Final Retrospective (2026-05-24T20:30:00Z)

### Session summary

Planned, implemented, and shipped the extraction of shared turn-formatting logic from `lifecycle/agent-runner.ts` and `ui/message-formatters.ts` into `session/content-items.ts`.
Released as `pi-subagents-v6.19.0`.
During code review the user challenged double-casts in the initial implementation, which led to discovering that the local `ToolCallContent` type was dead code and the SDK exports the real `ToolCall` type — the final implementation is significantly cleaner than what the plan specified.
Filed #188 for broader `any`-to-SDK-type cleanup discovered during the investigation.

### Observations

#### What went well

- The user's Socratic challenge ("Talk to me about these double-casts") was the pivotal moment.
  Rather than directing a fix, it prompted an investigation of the SDK's actual `ToolCall` type, which revealed that `ToolCall.name` is always required and `toolName` never appears on content items.
  This eliminated the `ToolCallContent` interface, the `toolName` fallback, the index-signature parameter type, and all double-casts — none of which the plan anticipated.
- Cross-session retro context worked well: the planning-stage note about #170 shifting the duplication target saved time during TDD.
- The SDK source investigation yielded a follow-up issue (#188) for replacing `any` casts in `extractText` and `SubscribableSession` with proper SDK types.

#### What caused friction (agent side)

- `missing-context` — Did not check SDK type exports during planning.
  The plan copied `ToolCallContent` verbatim from the existing code without verifying what `@earendil-works/pi-ai` exports.
  The source comments ("SDK doesn't export the narrow type") were wrong — the types have been exported for some time.
  Impact: the initial TDD implementation introduced a `{ type: string; [key: string]: unknown }` parameter type that forced `as unknown as` double-casts, requiring a full rework after user review.
- `premature-convergence` — When TypeScript rejected excess properties in test object literals, I widened the parameter type to include an index signature instead of exploring alternatives.
  The correct fix (using `ReadonlyArray<{ type: string }>` with `in` narrowing, or importing SDK types as test fixtures) was simpler and avoided the cast cascade.
  Impact: one round of rework plus an amended commit that muddied the git history.

#### What caused friction (user side)

- The user's intervention at the cast review stage was well-timed and effective.
  One earlier opportunity: if the user had flagged the `toolName` fallback or the SDK-type question during the plan review (before TDD started), the initial implementation would have been correct from the start.
  However, this is a marginal improvement — the plan review was clean and the friction was minor.

### Changes made

1. `.pi/skills/code-design/SKILL.md` — Added two rules to "Pi SDK boundaries": verify SDK exports before redeclaring types locally; prefer minimal structural supertypes over index-signature types for parameters accepting SDK content.
2. `.pi/skills/testing/SKILL.md` — Added TDD planning rule: verify SDK exports when extracting locally-declared types that shadow SDK types.
