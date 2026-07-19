---
issue: 539
issue_title: "pi-subagents Phase 20 Step 5: narrow tui/theme render interfaces"
---

# Narrow `tui`/`theme` render interfaces

## Release Recommendation

**Release:** ship independently

The roadmap tags Phase 20 Step 5 `Release: independent`, and it is not a member of any `Release batches` group (only Steps 1–2 formed the `result-delivery` batch, already shipped).
This is a refactor-only change, so its commits are `refactor:` (a `hidden: true` changelog type): they land on `main` and auto-batch into the next `feat:`/`fix:`/unhidden-`docs:` release rather than cutting one on their own.

## Problem Statement

Two render-callback surfaces in the package still type their Pi SDK inputs as `any` and carry file-level `eslint-disable` headers that suppress the `no-unsafe-*` family across the whole module.
`agent-widget.ts` types the widget-factory `tui` as `any` (4-rule header); `agent-tool.ts` types the `renderCall`/`renderResult` params (`theme`, `result`, options) as `any` (6-rule header).
A file-level disable hides genuine unsafe-access regressions anywhere in the file, not just on the SDK-boundary line that needs it.
Each callback actually touches a small, nameable slice of the SDK surface — `tui.terminal.columns` / `tui.requestRender()`, a couple of `theme` methods, and a typed result object — all of which the SDK exports today.

## Goals

- Replace `tui: any` in `agent-widget.ts` with a lean local `TuiSurface` interface and remove its 4-rule file-level disable header.
- Type the `agent-tool.ts` `renderCall`/`renderResult` params (`theme`, `result`, options) against the existing local `display.Theme` and the SDK's exported `AgentToolResult`/`ToolRenderResultOptions`, and remove its 6-rule file-level disable header.
- Make the tool's result-details type honest end-to-end: retype `textResult` so the tool's inferred `TDetails` is `AgentDetails | undefined`, eliminating the `result.details as AgentDetails` cast in `renderResult`.
- Retire the `details as any` cast (and its line-level disable) in `foreground-runner.ts`.
- Net outcome: package file-level disable headers drop from 3 to 1 (only `index.ts`'s `no-unsafe-argument` remains, out of scope); any residual suppression is line-level with a named rule.

Not a breaking change: this is a type-only, behavior-preserving refactor — no observable output, default, or public-contract change (`SubagentsService` is untouched).

## Non-Goals

- Do not touch `index.ts`'s remaining 1-rule `no-unsafe-argument` header — it is an accepted SDK gap and outside Step 5 scope.
- Do not bump the `@earendil-works/pi-*` dependency floor: every type this step needs (`AgentToolResult`, `AgentToolUpdateCallback`, `ToolRenderResultOptions`, `ExtensionContext`, `Theme`, `TUI`) is already exported from the public entry points of the installed `0.79.1`.
- Do not widen the narrowing to the `onUpdate: AgentToolResult<any>` parameter annotations — those `any`s live inside a generic type annotation, produce no `no-unsafe-*` usage violation, and are out of the issue's named scope (`theme`, `result`).
- Do not change `display.ts`, `result-renderer.ts`, or `widget-renderer.ts` — the pure renderer stack stays deliberately SDK-independent.

## Background

Relevant modules and how they relate:

- `src/ui/agent-widget.ts` — `AgentWidget` registers a widget factory via a local `UICtx` seam; the factory callback receives a `tui` (currently `any`) and reads `tui.terminal.columns` in `renderWidget` and calls `this.tui?.requestRender()` in `update`.
  The `UICtx` type is already a lean local abstraction of the SDK UI context, and `Theme` in `display.ts` is already a lean local interface (`{ fg, bold }`) — so lean local interfaces are the established package convention for this seam.
- `src/handlers/tool-start.ts` — the seam that feeds the SDK UI context into the widget passes it through `unknown`: `ToolStartWidget.setUICtx(ctx: unknown)` calls `this.widget.setUICtx(ctx.ui)`, and `AgentWidget.setUICtx(ctx: UICtx)` receives it.
  There is no type-checked `SDK-ctx → UICtx` assignment, so narrowing the `UICtx.setWidget` callback param is safe.
- `src/tools/agent-tool.ts` — `AgentTool.toToolDefinition()` returns a `defineTool({ execute, renderCall, renderResult, ... })`.
  `renderCall` calls `theme.fg`/`theme.bold` and `getDisplayName`; `renderResult` reads `result.details` and `result.content[0]` and delegates to `renderAgentResult(...)` (which expects `display.Theme`).
- `src/tools/helpers.ts` — `textResult(msg, details?: unknown)` is the single constructor for every tool text result (17 call sites across `agent-tool`, `foreground-runner`, `background-spawner`, `get-result-tool`, `steer-tool`); every caller passes nothing or a `buildDetails(...)` value, which is an `AgentDetails`.
- `src/tools/foreground-runner.ts` — `runForeground` builds a fully-typed `AgentDetails` in `streamUpdate` and passes it through `onUpdate?.({ content, details: details as any })`.
- `src/ui/display.ts` — owns the SDK-independent `Theme` (`fg(color: string, text: string)`, `bold(text: string)`) and `AgentDetails`.

AGENTS.md constraint that applies: Pi SDK imports are permitted in tool/handler/command modules (SDK consumers) — `agent-tool.ts` and `agent-widget.ts` qualify — but the pure renderer modules (`display.ts`, `result-renderer.ts`, `widget-renderer.ts`) must stay SDK-independent, so they keep the local `Theme`.

## Design Overview

### `tui` — a lean local `TuiSurface`

Add a minimal interface next to `UICtx` in `agent-widget.ts` and thread it through the three `any` sites (`UICtx.setWidget` callback param, the `private tui` field, `renderWidget`'s param):

```typescript
/** The slice of the TUI the widget factory callback touches. */
interface TuiSurface {
  readonly terminal: { readonly columns: number };
  requestRender(): void;
}
```

ISP-clean by construction — it lists exactly the two members the widget reads.
The widget tests already stub precisely this shape (`{ terminal: { columns: 200 }, requestRender: () => {} }`), so narrowing `any → TuiSurface` makes the production type match the test's de-facto contract.
A lean local interface (over importing the SDK `TUI` class) matches the existing `UICtx`/`display.Theme` convention and keeps the widget unit-testable without constructing a real `TUI`.

### `theme` — reuse the existing `display.Theme`

Type `renderCall`/`renderResult`'s `theme` param as the local `display.Theme`, not the SDK `Theme`.
The SDK `Theme` declares `fg(color: ThemeColor, text): string` / `bold(text): string` with method syntax (bivariant params), so the SDK object is assignable to the local `Theme`'s `fg(color: string, text)`; every renderer call site uses a valid `ThemeColor` literal (`"toolTitle"`, `"muted"`, `"dim"`, `"accent"`, `"error"`, `"warning"`, `"success"`).
This keeps the whole `agent-tool` → `result-renderer` → `display` render stack on one narrow `Theme` type — the intentional-ISP-narrowing the code-design skill permits over importing the heavier SDK type just to down-hand it.

### `result` — honest `AgentToolResult<AgentDetails | undefined>` (no cast)

`AgentToolResult<T>` is exported from `@earendil-works/pi-coding-agent` (`{ content: (TextContent | ImageContent)[]; details: T; terminate?: boolean }`), and `agent-tool.ts` already imports it.
Rather than typing `result` as `AgentToolResult<unknown>` and keeping the `result.details as AgentDetails` cast, make the tool's inferred `TDetails` honest so the cast disappears:

```typescript
// helpers.ts — details is always AgentDetails-or-nothing across all call sites
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}
```

Every `execute` return path funnels through `textResult`, so this pins the tool's `TDetails` to `AgentDetails | undefined`.
`renderResult` then types cleanly with no assertion:

```typescript
renderResult(
  result: AgentToolResult<AgentDetails | undefined>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details;                       // AgentDetails | undefined — no cast
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  // ... unchanged rendering logic
}
```

`ToolRenderResultOptions` (`{ expanded, isPartial }`) is exported by the SDK; import it in place of the `{ expanded, isPartial }: any` destructure.

### `foreground-runner.ts` — drop `details as any`

Retype `runForeground`'s local `onUpdate` param from `AgentToolResult<any>` to `AgentToolResult<AgentDetails>`.
`streamUpdate` already assembles a fully-typed `AgentDetails`, so `onUpdate?.({ content, details })` type-checks with no cast, and the line-level `no-unsafe-assignment` disable is removed.
The caller (`AgentTool.execute`) passes its own `onUpdate` (`(u: AgentToolResult<any>) => void`) into `runForeground`; an `any`-generic callback is assignable to an `AgentDetails`-generic callback param, so the call site is unaffected.

### `ctx` — type as the exported `ExtensionContext`

The only other `no-unsafe-*` trigger in `agent-tool.ts` is the inner `defineTool` `execute:` arrow forwarding `ctx: any` into `this.execute(...)` (a `no-unsafe-argument`).
Type both the arrow's `ctx` and `AgentTool.execute`'s `_ctx` param as the SDK-exported `ExtensionContext` (the method ignores it, but the annotation removes the unsafe-argument).
With `theme`, `result`, options, and `ctx` all typed, the `agent-tool.ts` file-level header is expected to be removable with zero residual; if `pnpm run lint` surfaces a genuinely irreducible SDK-gap line, add a single targeted `// eslint-disable-next-line <rule> -- <reason>` there (the issue explicitly accepts line-level precision, not zero).

### Disable-header tally

Step 4 ([#538]) already cleared the `model-resolver.ts` and `spawn-config.ts` headers, taking the package from 5 to 3.
This step removes the `agent-widget.ts` and `agent-tool.ts` headers, taking 3 → 1 (only `index.ts`'s 1-rule `no-unsafe-argument` remains), satisfying the `≤ 2` Phase 20 target.

## Module-Level Changes

- `src/ui/agent-widget.ts` — add the `TuiSurface` interface; replace `tui: any` at the `UICtx.setWidget` callback param, the `private tui` field, and `renderWidget`'s param with `TuiSurface`; remove the 4-rule file-level `eslint-disable` header.
- `src/tools/helpers.ts` — change `textResult(msg: string, details?: unknown)` to `details?: AgentDetails` (already imports `AgentDetails`).
- `src/tools/foreground-runner.ts` — retype `runForeground`'s `onUpdate` param to `((update: AgentToolResult<AgentDetails>) => void) | undefined`; drop `details as any` and its line-level `no-unsafe-assignment` disable.
- `src/tools/agent-tool.ts` — type `renderCall(args, theme: Theme)`; type `renderResult(result: AgentToolResult<AgentDetails | undefined>, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme)` and drop the `result.details as ...` cast; type `AgentTool.execute`'s `_ctx` and the inner `execute:` arrow's `ctx` as `ExtensionContext`; import `ToolRenderResultOptions`, `ExtensionContext`, and `Theme` (from `#src/ui/display`); remove the 6-rule file-level `eslint-disable` header (add a single line-level disable only if lint surfaces a residual SDK gap).
- `packages/pi-subagents/docs/architecture/architecture.md` — mark `#### Step 5` as `#### ✅ Step 5`; add a `Landed:` note recording the tally advance (3 → 1: `agent-widget` + `agent-tool` headers removed; `index.ts`'s 1-rule header remains as an accepted SDK gap) mirroring the `Landed:` notes on Steps 1–4.

No public export is removed or renamed; `SubagentsService`, the package `exports` map, and the README command surface are untouched, so no user-doc or skill grep is required.
No file listed here is also claimed unchanged in Non-Goals.

## Test Impact Analysis

This is a type-only, behavior-preserving refactor; verification is `pnpm run check` (tsc) + `pnpm run lint` (eslint) plus the existing suite staying green.

1. New unit tests enabled: none — no new seam or testable unit is extracted; the narrowing is entirely compiler-verified.
2. Tests that become redundant: none.
3. Tests that must stay as-is (they genuinely exercise the touched surface):
   - `test/ui/agent-widget.test.ts` — drives the widget factory with a `{ terminal: { columns }, requestRender }` stub and asserts rendered output; the `TuiSurface` narrowing must keep this green (the stub already matches the new type).
   - `test/tools/foreground-runner.test.ts` — exercises `streamUpdate`/`onUpdate` streaming; the cast removal must keep the emitted `details` byte-identical.
   - `test/tools/agent-tool.test.ts` — asserts `toToolDefinition()` metadata; unaffected by the render-param typing.
   - `test/tools/result-renderer.test.ts` — tests the pure per-status renderers `renderResult` delegates to; unchanged.

Optional, not required: `agent-widget.test.ts`'s local `tui: unknown` callback annotations could be tightened to `TuiSurface`, but that is cosmetic and out of scope.

## Invariants at risk

This step touches surfaces adjacent to Step 4 ([#538], the model-boundary typing) but does not modify `model-resolver.ts` or `spawn-config.ts`, so no Step 4 `Landed:` invariant is regressed.

- Step 4's disable-tally invariant (`Landed:` "5 → 3") is advanced, not regressed, to "3 → 1" — pinned by `pnpm run lint`, not a test.
- Behavior invariants (widget rendering output, foreground streaming `details` shape, tool-definition metadata) are pinned by the existing tests listed above; a green suite plus green `check`/`lint` is the gate.

## TDD Order

A type-only refactor has no red test to author first; each step is a `refactor:`/`docs:` commit that must leave the tree green (`pnpm run check && pnpm run lint && pnpm --filter @gotgenes/pi-subagents run test`).
Grouping is dictated by compile units: a shared-type change breaks its consumers in the same commit.

1. `refactor(pi-subagents): narrow the agent widget tui type to a lean interface` — add `TuiSurface`; replace the three `tui: any` sites; remove the `agent-widget.ts` file-level header.
   Self-contained to `agent-widget.ts`.
   Verify: `check` + `lint` green; `test/ui/agent-widget.test.ts` green.

2. `refactor(pi-subagents): type the Agent tool render callbacks and result details` — one commit, because retyping `textResult` flips the tool's inferred `TDetails`, which the `renderResult` and `foreground-runner` `onUpdate` signatures must match in the same compile unit (splitting them fails `tsc`):
   - `helpers.ts`: `textResult` details param `unknown → AgentDetails`.
   - `foreground-runner.ts`: retype `onUpdate` to `AgentToolResult<AgentDetails>`; drop `details as any` + its line-level disable.
   - `agent-tool.ts`: type `renderCall`/`renderResult` params (`theme: Theme`, `result: AgentToolResult<AgentDetails | undefined>`, `ToolRenderResultOptions`); drop the `result.details` cast; type `_ctx`/inner `ctx` as `ExtensionContext`; remove the file-level header (add a targeted line-level disable only if lint surfaces a residual SDK gap).
   Verify: `check` + `lint` green (0 file-level headers in these files; package tally 3 → 1); full `pi-subagents` suite green.

3. `docs(pi-subagents): mark Phase 20 Step 5 landed` — update `architecture.md` (Step 5 → ✅, `Landed:` note with the 3 → 1 tally).
   Verify: `pnpm exec rumdl check` on the edited doc.

## Risks and Mitigations

- Risk: SDK `Theme` not assignable to the local `display.Theme` (its `fg` takes `ThemeColor`, the local takes `string`).
  Mitigation: verified — both declare `fg`/`bold` with method syntax (bivariant params), so the SDK object is assignable to the local interface, and all call sites use valid `ThemeColor` literals; `tsc` confirms.
- Risk: narrowing the `UICtx.setWidget` callback param breaks the seam that feeds the SDK UI context in.
  Mitigation: verified the seam passes through `unknown` (`ToolStartWidget.setUICtx(ctx: unknown)`), so there is no checked `SDK-ctx → UICtx` assignment; narrowing a callback param is the contravariant-safe direction.
- Risk: retyping `textResult` breaks a caller passing non-`AgentDetails` details.
  Mitigation: grepped all 17 call sites — each passes nothing or a `buildDetails(...)` (`AgentDetails`); `tsc` enforces this at compile time.
- Risk: `TDetails` inference conflict inside the `defineTool` object literal.
  Mitigation: every `execute` return path funnels through `textResult` (now `AgentDetails | undefined`), matching `renderResult`'s declared param — a single consistent `TDetails`.
- Risk: a residual genuinely-SDK-gapped line still needs a suppression in `agent-tool.ts`.
  Mitigation: acceptable per the issue ("line-level precision, not zero"); add one targeted `// eslint-disable-next-line <rule> -- <reason>`.
  Expected: none, since `ctx` is typed as `ExtensionContext`.

## Open Questions

- None blocking.
  If `pnpm run lint` reveals an irreducible SDK gap in `agent-tool.ts` after the typing, it stays as a single documented line-level disable rather than reinstating a file-level header.

[#538]: https://github.com/gotgenes/pi-packages/issues/538
