---
issue: 378
issue_title: "Consolidate lifecycle test fixtures"
---

# Consolidate lifecycle test fixtures

## Problem Statement

`pnpm fallow:dupes` reports clone families concentrated in `test/lifecycle/`: repeated spawn-and-await arrangements and session-factory stubs copy-pasted across files and within them.
This is Phase 17 Step 7 (core consolidation), sequenced after Steps 2–6 reshaped `Subagent` construction so the lifecycle tests had already churned.
The roadmap Outcome is: lifecycle clone families 5 → ≤ 1; package test duplication below 600 lines.

The issue body cites five families across six files (including `concurrency-queue.test.ts` and `subagent.test.ts` at 766 LOC).
That snapshot predates Steps 1–6.
The current state — measured with `fallow dupes -r packages/pi-subagents` against today's `main` — is **four** lifecycle clone families, because the queue was renamed to `concurrency-limiter.test.ts` ([#381]) and `subagent.test.ts`/`concurrency-limiter.test.ts` no longer report families after the Step 2–4 reshaping.

## Goals

- Consolidate the four current lifecycle clone families into shared or file-local helpers so the lifecycle tree reports ≤ 1 family.
- Bring package-wide test duplication below 600 lines (current baseline: 669 lines / 3.3% across 20 files; the four lifecycle families total ~122 lines).
- Preserve every existing test assertion — the existing suite is the regression guard for this refactor.
- Keep the change non-breaking: test-only, no production-code, public-surface, or behavior change.

## Non-Goals

- Step 8 ([#379]) — UI and tools clone families (`agent-config-editor`, `agent-creation-wizard`, `ui-observer`, `foreground-runner`, `service-adapter`).
  These are separate families outside the lifecycle tree and are deferred to their own issue.
- Step 9 ([#380]) — the cross-package settings-loader production clone.
- Any production-code change in `src/`.
- Adding new behavioral test cases — this is duplication removal, not coverage expansion (helper self-tests are the only new `it` blocks).

## Background

The lifecycle suite already has substantial shared scaffolding under `test/helpers/`:

- `subagent-session-io.ts` — `createSubagentSessionIO()`, `createAgentLookup()`, `createSubagentSessionDeps()`, `createChildLifecycleMock()`.
  The natural home for shared `createSubagentSession`-test scaffolding.
- `manager-stubs.ts` — `createBlockingFactory()`, `createSessionFactory()`.
- `mock-session.ts` — `createMockSession()`, `createSubagentSessionStub()`, `toSubagentSession()`, `toAgentSession()`.
- `make-subagent.ts` — `createTestSubagent()`, `makeStubExecution()`.

Convention: every shared helper module under `test/helpers/` has a companion `*.test.ts` (e.g. `subagent-session-io.test.ts`, `make-subagent.test.ts`).
New or extended shared helpers must extend that companion test.

The four current lifecycle clone families and the repeated blocks driving them:

| File                                              | Family             | Repeated block                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create-subagent-session.test.ts`                 | 3 groups, 31 lines | A file-local `createSession()` mock-session builder, then `io.createSession.mockResolvedValue({ session })` + `await createSubagentSession({ snapshot, type }, createSubagentSessionDeps({ io, exec, registry[, lifecycle] }))`      |
| `create-subagent-session-extension-tools.test.ts` | 3 groups, 29 lines | A near-identical file-local `createSessionWithExtensionToolRegistration()` builder, then the same `io.createSession.mockResolvedValue` + `createSubagentSession(...)` invoke block, plus post-bind `setActiveToolsByName` assertions |
| `subagent-manager.test.ts`                        | 4 groups, 40 lines | `spawn(STUB_SNAPSHOT, "general-purpose", "test", { description, isBackground: true, parentSession: { toolCallId } })` and the "spawn two bg agents under limit 1, assert one queued" arrange                                         |
| `subagent-session.test.ts`                        | 3 groups, 22 lines | Repeated arrange blocks around the already-local `createSession(finalText)` / `makeSubagentSession()` / `emitTurnEnd()` helpers                                                                                                      |

The two `createSubagentSession`-test session builders (`createSession` and `createSessionWithExtensionToolRegistration`) build near-identical mock sessions — the same eight `vi.fn()` methods — differing only in that the extension-tools variant flips `getActiveToolNames` between a before-bind and after-bind set.
That overlap is the one genuinely cross-file duplication and the strongest candidate for promotion to `test/helpers/`.
The manager and `subagent-session` families are intra-file.

AGENTS.md / testing-skill constraints that apply:

- When consolidating duplicate test factories, diff the default values across all copies before writing the shared factory — different defaults cause cascading assertion failures during migration.
- When a TDD step deletes a test helper, re-check the file's remaining imports for orphans — Biome's `noUnusedImports` is warning-level (exit 0), so it will not fail `pnpm run lint`.
- Run the full suite (not just the touched file) after each shared-helper change.

## Design Overview

The guiding distinction: **promote to `test/helpers/` only what is genuinely shared across files; keep intra-file families as file-local helpers.**
Fallow's own recommendation for three of the four families is "extract shared function from `<file>`, `<file>`" (same file on both sides) — promoting those to `test/helpers/` would manufacture cross-file coupling that does not exist.

### 1. Shared: a mock-session builder for `createSubagentSession` tests

Add `createFactorySession(overrides?)` to `test/helpers/subagent-session-io.ts`.
It returns the eight-method mock session both `createSubagentSession` test files build by hand today, with `getActiveToolNames` supporting a static set or a before/after-bind flip:

```typescript
export interface FactorySessionOptions {
  /** Tools active before bindExtensions(). Default ["read"]. */
  toolsBeforeBind?: string[];
  /** Tools active after bindExtensions(). Defaults to toolsBeforeBind (no extension registration). */
  toolsAfterBind?: string[];
}

export function createFactorySession(options: FactorySessionOptions = {}) {
  const before = options.toolsBeforeBind ?? ["read"];
  const after = options.toolsAfterBind ?? before;
  let bound = false;
  return {
    messages: [] as unknown[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getActiveToolNames: vi.fn(() => (bound ? after : before)),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => { bound = true; }),
  };
}
```

Return type is deliberately unannotated so callers retain the `Mock<...>` methods (`mock.calls`, `mockResolvedValue`) — matching the existing `createSubagentSessionIO()` convention in this file.

`create-subagent-session.test.ts` replaces `createSession()` with `createFactorySession()`; the existing static `getActiveToolNames: () => ["read"]` becomes the default branch (`bound === after === before === ["read"]`), so the lone `bindExtensions` flip is inert there — behavior-preserving.
`create-subagent-session-extension-tools.test.ts` replaces `createSessionWithExtensionToolRegistration(before, after)` with `createFactorySession({ toolsBeforeBind: before, toolsAfterBind: after })`.

Consumer call site (verifies Tell-Don't-Ask: the helper returns a ready mock; the test arranges and asserts on it):

```typescript
const session = createFactorySession({ toolsBeforeBind: ["read"], toolsAfterBind: ["read", "extension_tool"] });
io.createSession.mockResolvedValue({ session });
await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "test-agent" }, createSubagentSessionDeps({ io, exec, registry }));
expect(session.setActiveToolsByName.mock.calls[0][0]).toContain("extension_tool");
```

The repeated `io.createSession.mockResolvedValue({ session })` + `createSubagentSession(...)` invoke pair is left in the tests rather than wrapped in an `invokeCreate()` helper: it is two lines, the `params` and `deps` overrides vary per test, and wrapping it would hide the system-under-test call behind a helper (procedure-splitting, not design improvement).
Extracting only the session builder removes the bulk of both families because the builder is the larger half of each clone.

### 2. File-local: manager spawn / queued-pair arrangements

`subagent-manager.test.ts` already has file-local `spawnBg`/`spawnFg`/`createManager`/`defaultFactory`.
The remaining 40 lines are two intra-file patterns; add two file-local helpers:

```typescript
/** Spawn a background agent carrying a parentSession.toolCallId (notification path). */
function spawnBgWithToolCall(mgr: SubagentManager, toolCallId: string, prompt = "test") {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: prompt,
    isBackground: true,
    parentSession: { toolCallId },
  });
}

/** Arrange a manager at limit 1 with two bg agents: first runs, second queues. */
function arrangeQueuedPair() {
  const { manager } = createManager({ createSubagentSession: createBlockingFactory(), getMaxConcurrent: () => 1 });
  const running = spawnBg(manager, "a");
  const queued = spawnBg(manager, "b");
  return { manager, running, queued };
}
```

These stay file-local: they reference manager-specific concerns and fallow scores the family as same-file.

### 3. File-local: `subagent-session.test.ts` arrange blocks

The three small groups (22 lines) sit around the existing file-local `createSession(finalText)`, `makeSubagentSession()`, and `emitTurnEnd()` helpers.
Fold the repeated "build session, build SubagentSession, run/emit" arrange into one file-local helper (e.g. `arrangeSession(finalText, metaOverrides?)` returning `{ session, listeners, sub }`), keeping the per-test assertions inline.
No promotion to `test/helpers/` — this builder is specific to `subagent-session.test.ts`'s turn-loop assertions and is not used elsewhere.

## Module-Level Changes

- `test/helpers/subagent-session-io.ts` — add `createFactorySession()` and `FactorySessionOptions`.
- `test/helpers/subagent-session-io.test.ts` — add a `describe("createFactorySession")` block: default tool set, before/after-bind flip, all eight methods present.
- `test/lifecycle/create-subagent-session.test.ts` — delete local `createSession()`; import and use `createFactorySession()`; re-check imports for orphans.
- `test/lifecycle/create-subagent-session-extension-tools.test.ts` — delete local `createSessionWithExtensionToolRegistration()`; use `createFactorySession({ toolsBeforeBind, toolsAfterBind })`; re-check imports.
- `test/lifecycle/subagent-manager.test.ts` — add file-local `spawnBgWithToolCall()` and `arrangeQueuedPair()`; route the cloned spawn/queued-pair sites through them.
- `test/lifecycle/subagent-session.test.ts` — add a file-local `arrangeSession()` helper; route the cloned arrange blocks through it.
- `docs/architecture/architecture.md` — mark Step 7 ✅ Complete and add a `Landed:` bullet (matching Steps 1–6), updating the families and duplication figures.

No `src/` files change.
No public surface changes, so `verify:public-types` is unaffected.
The `package-pi-subagents` SKILL.md's test count line ("994 tests across 63 files as of Phase 17 Step 4") is a point-in-time figure, not a Step-7 reference, and is left untouched.

## Test Impact Analysis

This is a test-refactoring issue, so the lens is inverted from a production extraction:

1. **New tests the change enables.**
   Only helper self-tests: a `createFactorySession` block in `subagent-session-io.test.ts` (per the `test/helpers/` companion-test convention).
   No new behavioral tests — the refactor must not change coverage.
2. **Existing tests that become redundant.**
   None are removed.
   The duplication being removed is *arrange-block* duplication inside `it()` bodies, not duplicate `it()` cases.
   Every existing assertion stays.
3. **Tests that must stay as-is.**
   All 228 lifecycle test cases keep their assertions; they are the regression guard.
   Migration is green-to-green: after each file's migration the full suite must stay passing.
   In particular, the post-bind `setActiveToolsByName` assertions in the extension-tools file and the turn-limit/`emitTurnEnd` assertions in `subagent-session.test.ts` are unchanged — only their session-construction arrange is swapped.

## Invariants at risk

This step touches `subagent-manager.test.ts`, which pins invariants from earlier Phase 17 steps.
The `arrangeQueuedPair()` helper must not swallow these:

- **Step 1 ([#381]) / Step 3 ([#374]) — "every spawned agent has a `promise` at spawn, even while queued."**
  Pinned by `subagent-manager.test.ts` → `it("gives a queued agent an awaitable promise at spawn (before its slot opens)")`, which asserts `getRecord(queuedId)!.promise` is a `Promise` while status is `"queued"`.
  When this test adopts `arrangeQueuedPair()`, the helper must still return the queued id so the test can assert on `.promise` directly.
- **Step 3 ([#374]) — "zero external writes to `Subagent.promise`/`.notification` outside `subagent.ts`" (grep-verifiable).**
  The helper migration must not reintroduce `record.promise =` or `record.notification =`.
  The existing `record.notification!.markConsumed()` sites are method calls, not writes, and stay as-is.
  Re-grep `test/lifecycle/` for `\.promise =` and `\.notification =` after the manager migration to confirm none were added.

## TDD Order

This is a lift-and-shift refactor of tests; the suite is green at every step (no red phase — the existing assertions are the spec).
Each migration step runs the full package suite before committing.

1. **Add shared `createFactorySession` + helper test.**
   Surface: `test/helpers/subagent-session-io.ts`, `test/helpers/subagent-session-io.test.ts`.
   Covers: default tool set, before/after-bind flip, method presence.
   Run `pnpm --filter @gotgenes/pi-subagents exec vitest run test/helpers/subagent-session-io.test.ts` then `pnpm run check`.
   Commit: `test: add shared createFactorySession mock-session builder (#378)`.
2. **Migrate `create-subagent-session.test.ts` to `createFactorySession`.**
   Delete local `createSession()`, re-check imports, run full suite green.
   Commit: `test: use shared factory session in create-subagent-session tests (#378)`.
3. **Migrate `create-subagent-session-extension-tools.test.ts` to `createFactorySession({ toolsBeforeBind, toolsAfterBind })`.**
   Delete local `createSessionWithExtensionToolRegistration()`, re-check imports, run full suite green.
   Commit: `test: use shared factory session in extension-tools tests (#378)`.
4. **Consolidate `subagent-manager.test.ts` spawn/queued-pair arrangements.**
   Add `spawnBgWithToolCall()` and `arrangeQueuedPair()`; route the cloned sites through them; re-grep for `.promise =`/`.notification =`; run full suite green.
   Commit: `test: consolidate manager spawn arrangements (#378)`.
5. **Consolidate `subagent-session.test.ts` arrange blocks.**
   Add `arrangeSession()`; route cloned sites; run full suite green.
   Commit: `test: consolidate subagent-session arrange blocks (#378)`.
6. **Verify and record outcome.**
   Run `pnpm exec fallow dupes -r packages/pi-subagents` and confirm lifecycle families ≤ 1 and package duplication < 600 lines; run `pnpm run check && pnpm run lint && pnpm fallow dead-code`.
   Update `docs/architecture/architecture.md` Step 7 to ✅ Complete with a `Landed:` bullet and refreshed figures.
   Commit: `docs: mark Phase 17 Step 7 complete (#378)`.

Steps 2–5 are independent of each other and order-insensitive; each only depends on Step 1's helper.

## Risks and Mitigations

- **Divergent defaults between the two session builders cause assertion failures.**
  Mitigation: the two builders are diffed in Background — they share eight identical methods and differ only in `getActiveToolNames`.
  `createFactorySession` defaults `toolsAfterBind` to `toolsBeforeBind` so the non-extension file's static behavior is preserved exactly.
- **Over-extraction / procedure-splitting to chase the metric.**
  Mitigation: the invoke pair (`mockResolvedValue` + `createSubagentSession(...)`) and the per-test assertions are left inline; only value-returning builders are extracted.
  File-local families stay file-local rather than being force-promoted to `test/helpers/`.
- **Orphaned imports after deleting local builders (Biome `noUnusedImports` is warning-level, exit 0).**
  Mitigation: re-check each migrated file's imports as part of its step; the Step 6 `pnpm run lint` + dead-code pass is the backstop.
- **Regressing a cross-step invariant with a green suite (the Step 3 lesson).**
  Mitigation: the "Invariants at risk" section names the pinning tests and the grep checks folded into Step 4.

## Open Questions

- Whether package-wide duplication lands below 600 lines from Step 7 alone or needs Step 8 ([#379]).
  Arithmetic says yes (669 − ~122 ≈ 547), but the Step 6 `fallow dupes` measurement is the authority; if it lands above 600, note it and confirm the lifecycle-families target (≤ 1) is still met rather than pulling Step 8 work forward.

[#374]: https://github.com/gotgenes/pi-packages/issues/374
[#379]: https://github.com/gotgenes/pi-packages/issues/379
[#380]: https://github.com/gotgenes/pi-packages/issues/380
[#381]: https://github.com/gotgenes/pi-packages/issues/381
