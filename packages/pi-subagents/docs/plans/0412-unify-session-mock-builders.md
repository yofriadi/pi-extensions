---
issue: 412
issue_title: "Unify the three overlapping session-mock builders in pi-subagents tests"
---

# Unify the overlapping session-mock builders (targeted reuse)

## Problem Statement

`test/helpers/` carries three session-mock builders whose shapes overlap on four fields — `messages`, `subscribe`, `dispose`, `steer`:

- `createMockSession` (`mock-session.ts`) — a subscribable event bus (`messages`, `subscribe`, `emit`, `dispose`, `steer`, `sessionManager`).
- `createSubagentSessionStub` (`mock-session.ts`) — a born-complete `SubagentSession` wrapper (turn-loop spies plus `messages`/`subscribe`/`dispose`/`steer` delegation).
- `createFactorySession` (`subagent-session-io.ts`) — the `createSubagentSession`-factory session (`bindExtensions`, `setActiveToolsByName`, `getActiveToolNames`, plus `messages`/`subscribe`/`prompt`/`abort`/`steer`/`dispose`).

Issue [#412] asks whether to unify the three behind one configurable builder.
The issue itself flags the risk — "trading three small honest stubs for one over-parameterized factory" — and quotes Sandi Metz: "duplication is far cheaper than the wrong abstraction."

## Goals

- Remove the one genuine independent redeclaration of the four shared base fields, which lives in `createFactorySession`.
- Make `createMockSession` the explicit shared core, and have `createFactorySession` layer its factory facet on top of that core (working event bus as the core default).
- Keep the change test-only and behavior-preserving for production code.

This change is **not breaking** — it touches only `test/helpers/` and a doc note; no published surface, default, or runtime behavior changes.

## Non-Goals

- The full composable-factory design from the issue's "Proposed change" (one `createSessionMock()` with opt-in `withTurnLoop()` / `withBindFacet()` extensions).
  Rejected at the `Decide` gate (operator chose targeted reuse) because it forces a multi-facet parameterized factory the issue itself warns against.
- Changing `createSubagentSessionStub`.
  It already **composes** a `createMockSession` internally and delegates `steer`/`dispose`/`subscribe`/`messages` to it, so its overlap is intrinsic delegation glue, not duplication.
- Renaming any builder or changing any builder's public signature.
- Touching production `src/` modules.

## Background

Relevant modules:

- `test/helpers/mock-session.ts` — defines `createMockSession` (the event-bus core), `createSubagentSessionStub` (the `SubagentSession` wrapper, which calls `createMockSession()` as its default `session`), plus the `toAgentSession`/`toSubagentSession` casts.
- `test/helpers/subagent-session-io.ts` — defines `createFactorySession` (and the IO/lookup/lifecycle stubs).
  `createFactorySession` independently redeclares `messages: []` and an **inert** `subscribe: vi.fn(() => () => {})`, plus its own `steer`/`dispose`, then adds the factory facet.
- `src/lifecycle/create-subagent-session.ts` — production consumer of the raw factory session: calls `getActiveToolNames()`, `setActiveToolsByName()`, `bindExtensions()`, and `dispose()`.
- `src/lifecycle/subagent-session.ts` — wraps the raw session and calls `session.subscribe(...)`, `session.prompt(...)`, `session.abort(...)`, `session.steer(...)`, `session.dispose()`, `session.messages`.

Structural reading (per the `code-design` "structural reasons before extracting duplication" heuristic): the three builders sit on two axes — AgentSession-vs-`SubagentSession` (type) and event-bus-vs-factory (facet).
`createMockSession` and `createFactorySession` are both AgentSession stubs; `createSubagentSessionStub` is the `SubagentSession` wrapper.
The only honest, non-delegation duplication is `createFactorySession`'s independent base, so that is the entire target.

AGENTS.md constraint: this is the `@gotgenes/pi-subagents` package; run package-scoped scripts via `pnpm --filter @gotgenes/pi-subagents exec vitest run` and type-check with `pnpm run check`.

## Design Overview

`createMockSession` is already the core shape, with the working event bus the operator chose as the default.
`createFactorySession` is rebuilt to spread that core and add only the factory facet:

```typescript
export function createFactorySession(options: FactorySessionOptions = {}) {
	const before = options.toolsBeforeBind ?? ["read"];
	const after = options.toolsAfterBind ?? before;
	let bound = false;
	return {
		...createMockSession(), // working event bus + messages/steer/dispose/sessionManager core
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		getActiveToolNames: vi.fn(() => (bound ? after : before)),
		setActiveToolsByName: vi.fn(),
		bindExtensions: vi.fn(async () => {
			bound = true;
		}),
	};
}
```

Mock-typing is preserved through the spread.
`createMockSession()` returns `MockSession & Record<string, unknown>`; the explicit facet properties added in the literal intersect with the `Record`'s `unknown` index signature, and `unknown & Mock<...>` narrows to `Mock<...>`.
Verified with a throwaway `tsc --noEmit` probe: `session.setActiveToolsByName.mock.calls[0][0]` type-checks after the spread.

Facet semantics are unchanged: `getActiveToolNames` closes over a `bound` flag flipped by `bindExtensions`, returning `before` until bind and `after` after.

Behavioral delta (intentional, per the operator's "working bus is the core default" choice): `createFactorySession`'s `subscribe` changes from inert (`() => () => {}`) to the core's real bus, and the session gains `emit` and `sessionManager`.
No factory test emits events, and production `subagent-session.ts` only registers a subscriber (never emits during these tests), so the change is inert in practice — the disposer now truly unregisters instead of being a no-op.

Edge cases:

- `create-subagent-session.test.ts:194` asserts `expect(session.dispose).toHaveBeenCalledOnce()` — `dispose` remains a `vi.fn()` spy supplied by the core, so the assertion holds.
- The factory session is returned through `io.createSession.mockResolvedValue({ session })`, not assigned as a fresh literal to a typed slot, so the extra `emit`/`sessionManager` fields raise no excess-property error.

## Module-Level Changes

- `test/helpers/subagent-session-io.ts` — rewrite `createFactorySession` to spread `...createMockSession()` and add the factory facet; import `createMockSession` from `#test/helpers/mock-session`.
  Update its docstring to state it layers the factory facet on the shared `createMockSession` core.
- `test/helpers/subagent-session-io.test.ts` — add one self-test asserting `createFactorySession` exposes the core's working event bus (subscribe a fn, `emit`, assert receipt).
  Existing `createFactorySession` self-tests remain unchanged.
- `test/helpers/mock-session.ts` — docstring touch-up only: note that `createMockSession` is the shared session-mock core that `createFactorySession` builds on (no code change).
- `docs/architecture/architecture.md` — update the Phase 17 Step 7 "Landed" closing sentence (currently "The three overlapping session-mock builders this surfaced are tracked separately [#412].") to record the resolution: targeted reuse — `createFactorySession` now layers on the `createMockSession` core; `createSubagentSessionStub`'s overlap is intrinsic delegation and was left as-is.

Grep confirmation (no other consumers break): `createFactorySession` is referenced only in `create-subagent-session.test.ts` and its own self-test/source; `.pi/skills/package-*/SKILL.md` mention none of the three builders by name; the `[#412]:` reference-link definition already exists at the bottom of `architecture.md`.

## Test Impact Analysis

1. **New tests enabled** — one self-test for `createFactorySession`'s newly-inherited working event bus (subscribe/emit), previously impossible because its `subscribe` was inert.
2. **Tests made redundant** — none.
   The existing `createFactorySession` self-tests exercise the factory facet (the eight methods, the before/after bind flip), which is unchanged and still its own concern.
3. **Tests that must stay as-is** — the `createMockSession` event-bus self-tests in `mock-session.test.ts` (they pin the core the factory now reuses); the `createFactorySession` facet self-tests; `create-subagent-session.test.ts` lifecycle tests (they exercise the production consumer of the factory session).

## Invariants at risk

The change touches the lifecycle test fixtures refactored in Phase 17 Step 7 ([#378]).
That step's documented `Outcome`/`Landed` invariants and the tests that pin them:

- "AAA structure: `createSubagentSession(...)` act kept explicit per test" — pinned by `create-subagent-session.test.ts` (the act calls remain in each `it`; this plan does not touch them).
- "`createFactorySession` flips `getActiveToolNames` from before-bind to after-bind" — pinned by the existing `subagent-session-io.test.ts` facet self-tests, which stay green through the rewrite.

No earlier outcome is regressed: the rewrite preserves every facet assertion and only adds the event-bus surface.

## TDD Order

1. **`refactor(test):` fold `createFactorySession` onto the shared core** (#412).
   - Red: add `it("exposes the core's working event bus (subscribe/emit)")` to the `createFactorySession` describe in `subagent-session-io.test.ts` — fails to compile/pass because the current return has no `emit` and an inert `subscribe`.
   - Green: rewrite `createFactorySession` to `{ ...createMockSession(), <factory facet> }`; import `createMockSession`; refresh the docstrings in both helper files.
   - Verify: `pnpm --filter @gotgenes/pi-subagents exec vitest run test/helpers/subagent-session-io.test.ts test/helpers/mock-session.test.ts test/lifecycle/create-subagent-session.test.ts`, then `pnpm run check` (spread-typing) and the full package suite.
   - Commit: `refactor(test): build createFactorySession on the shared createMockSession core (#412)`.
2. **`docs:` record the resolution in the architecture doc** (#412).
   - Update the Phase 17 Step 7 closing sentence in `docs/architecture/architecture.md` to describe the targeted-reuse outcome (no roadmap-table or metric-row change required; rerun `pnpm fallow:dupes` only to report, not to gate).
   - Commit: `docs: record session-mock builder unification outcome (#412)`.

Both steps are test/doc-only with single, isolated surfaces, so no lift-and-shift staging is needed.

## Risks and Mitigations

- **Risk:** the spread erases `Mock<...>` typing on the facet methods, breaking `.mock.calls` assertions.
  **Mitigation:** verified with a throwaway `tsc --noEmit` probe that `setActiveToolsByName.mock.calls[0][0]` type-checks after the spread (intersection narrows `unknown & Mock<...>` to `Mock<...>`); Step 1 reruns `pnpm run check`.
- **Risk:** the inert→working `subscribe` change alters a lifecycle test's behavior.
  **Mitigation:** no factory test emits events; production only registers a subscriber during these tests; `session.dispose` remains a spy.
  Step 1's verify command runs the lifecycle suite.
- **Risk:** the extra `emit`/`sessionManager` fields trip excess-property checks at a consumer.
  **Mitigation:** the factory session flows through `mockResolvedValue({ session })`, not a fresh typed literal, so excess-property checking does not apply.

## Open Questions

None.
The operator confirmed targeted reuse with a working-bus core default at the `Decide` gate.

[#378]: https://github.com/gotgenes/pi-packages/issues/378
[#412]: https://github.com/gotgenes/pi-packages/issues/412
