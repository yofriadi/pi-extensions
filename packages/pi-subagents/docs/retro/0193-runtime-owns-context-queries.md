---
issue: 193
issue_title: "SubagentRuntime owns context queries"
---

# Retro: #193 — SubagentRuntime owns context queries

## Stage: Planning (2026-05-24T21:00:00Z)

### Session summary

Planned the Layer 1 change that types `SubagentRuntime.currentCtx` as `SessionContext`, adds three query methods (`buildSnapshot`, `getModelInfo`, `getSessionInfo`), and eliminates 4 `as any` casts from `index.ts`.
The plan covers 7 TDD steps touching `runtime.ts`, `handlers/lifecycle.ts`, `parent-snapshot.ts`, `context.ts`, `service-adapter.ts`, and `index.ts`.

### Observations

- The `pi` field in `currentCtx` is never read back — only stored.
  Dropping it is safe; `SessionLifecycleHandler` already holds `pi` as a constructor param.
- `ExtensionContext` structurally satisfies `SessionContext`, so changing `buildParentSnapshot`'s param type is source-compatible with the `/agents` command handler that passes raw SDK `ctx`.
- `service-adapter.ts` gets the biggest structural change: its two closure params (`getCtx`, `getModelRegistry`) collapse into a single `ServiceRuntimeLike` interface.
- No design ambiguity — the architecture doc's Layer 1 spec and the issue body are fully aligned.
- Test fixtures in `make-deps.ts` are unaffected because the `AgentToolDeps` interface shape doesn't change — only the wiring in `index.ts` that supplies the implementations changes.

## Stage: Implementation — TDD (2026-05-24T20:30:00Z)

### Session summary

Completed all 6 implementation TDD steps plus an architecture doc update in one session.
The `getSessionInfo` implementation needed `?.sessionManager.getSessionFile()` (not `?.sessionManager?.getSessionFile()`) since `sessionManager` is a required field of `SessionContext` — ESLint's `no-unnecessary-condition` caught this at the pre-commit hook.
Final test count: 854 (up from 848 baseline, +6 new tests for `buildSnapshot`, `getModelInfo`, `getSessionInfo`).

### Observations

- The plan's Non-Goals section incorrectly said `buildParentContext` would NOT change.
In practice it had to accept `SessionContext` instead of `ExtensionContext` — they are not substitutable in that direction.
The Module-Level Changes list was correct; only the Non-Goals prose was wrong.
- `context.ts` needed a local `BranchEntry` union type to handle `getBranch(): unknown[]`.
TypeScript's discriminated union narrowing doesn't work when the union includes a catch-all `{ type: string }` arm — explicit casts within each `if` branch were required.
- `service-adapter.ts` ended up using `runtime.currentCtx.modelRegistry` directly (no `getModelInfo()` call needed in the service adapter) — `ServiceRuntimeLike` only needs `currentCtx` and `buildSnapshot`.
This is cleaner than the plan's `getModelInfo(): { modelRegistry: unknown }` approach.
- Biome's `noUnusedPrivateClassMembers` warning caught the leftover `private readonly pi: unknown` in `SessionLifecycleHandler`.
Removed `pi` from the constructor entirely (rather than adding `_` prefix), which also cleaned up `index.ts`.
- The `eslint-disable` directive at the top of `index.ts` had two now-unused entries (`no-unsafe-member-access`, `no-unsafe-call`) removed by `eslint --fix`.

## Stage: Final Retrospective (2026-05-24T20:45:00Z)

### Session summary

All three stages (plan, TDD, ship) completed in a single session.
Released as `pi-subagents-v7.2.0`.
One plan contradiction required a judgment call during implementation; otherwise clean mechanical execution.

### Observations

#### What went well

- The architecture doc's Phase 11 Layer 1 spec was precise enough that no `ask_user` was needed at any stage — the issue body, architecture doc, and #192 retro were fully aligned.
- `ServiceRuntimeLike` ended up simpler than planned (only `currentCtx` + `buildSnapshot` instead of also requiring `getModelInfo()`) — the implementation found a cleaner design than the plan specified.
- Test count increase (+6) validates the design: methods that were previously untestable as anonymous closures now have dedicated unit tests.

#### What caused friction (agent side)

- `missing-context` — The plan's Non-Goals section claimed `buildParentContext` would not change, contradicting Module-Level Changes item #4 which explicitly listed the file.
  The planning stage didn't cross-check these sections before committing.
  Impact: brief confusion during step 3 about which section to trust (resolved by following Module-Level Changes); no rework, added ~30s of deliberation.
- `missing-context` — TypeScript's discriminated union narrowing limitation with a `{ type: string }` catch-all arm was not anticipated.
  Impact: required adding a local `BranchEntry` union type and explicit casts in `context.ts`; no rework but ~2 min of debugging the type error.

#### What caused friction (user side)

- None — no user intervention was needed at any point across all three stages.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a Non-Goals vs Module-Level Changes cross-check instruction under the Module-Level Changes bullet.
