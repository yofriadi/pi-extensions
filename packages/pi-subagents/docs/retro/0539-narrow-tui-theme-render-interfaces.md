---
issue: 539
issue_title: "pi-subagents Phase 20 Step 5: narrow tui/theme render interfaces"
---

# Retro: #539 — pi-subagents Phase 20 Step 5: narrow tui/theme render interfaces

## Stage: Planning (2026-07-15T21:47:58Z)

### Session summary

Planned the type-only refactor to narrow the `tui`/`theme`/`result` render-callback params in `agent-widget.ts` and `agent-tool.ts` and remove their file-level `eslint-disable` headers.
Verified every needed SDK type (`AgentToolResult`, `AgentToolUpdateCallback`, `ToolRenderResultOptions`, `ExtensionContext`, `Theme`, `TUI`) is already exported from the public entries of the installed `0.79.1`, so no dependency-floor bump is required.
Confirmed the running file-level-disable tally is already 3 (Step 4 cleared `model-resolver`/`spawn-config`); this step takes it to 1.

### Observations

- The operator flagged that bumping the pi dependency floor was a valid option and pointed at the `~/development/pi/pi` source (0.80.7 tag).
  Investigated and found it unnecessary — the types this step consumes are all public in 0.79.1.
  Kept the plan on the installed version since `tsc` checks against what is installed.
- One genuine scope choice surfaced via `ask_user`: type `renderResult`'s `result` as `AgentToolResult<unknown>` + keep the `as AgentDetails` cast (minimal) vs. retype the shared `textResult` helper so `TDetails` infers `AgentDetails | undefined` and the cast disappears (fuller).
  Chose fuller — the issue's intent is replacing `any`-boundary implicitness with honest types, a cast is exactly the implicit assertion to avoid, and the fuller path also clears the named `foreground-runner` `details as any` target.
  All 17 `textResult` call sites were grepped and pass nothing or a `buildDetails(...)` (`AgentDetails`), so the retype is compiler-enforced-safe.
- Key assignability findings that de-risk the plan: SDK `Theme` uses method-syntax `fg`/`bold` (bivariant params), so it is assignable to the local `display.Theme` (`fg(color: string, ...)`); and the widget UI seam passes the SDK context through `unknown` (`ToolStartWidget.setUICtx(ctx: unknown)`), so narrowing `UICtx.setWidget`'s callback param has no checked `SDK-ctx → UICtx` assignment to break.
- The widget tests already stub `{ terminal: { columns: 200 }, requestRender: () => {} }` — the exact `TuiSurface` shape — so the lean local interface is the de-facto contract, favoring it over importing the SDK `TUI` class.
- Chose to type `_ctx`/inner `ctx` as the exported `ExtensionContext` to clear the last `no-unsafe-argument` in `agent-tool.ts`, aiming for zero residual there; the plan keeps a line-level-disable fallback only if lint surfaces an irreducible gap.
- This is `refactor:`-only (hidden changelog type): it auto-batches into the next release rather than cutting one, despite the roadmap's `Release: independent` tag.

## Stage: Implementation — Build (2026-07-15T22:11:44Z)

### Session summary

Executed all 3 planned steps as `refactor:`/`docs:` commits: narrowed `agent-widget.ts`'s `tui` to a lean `TuiSurface` interface, retyped `agent-tool.ts`'s `renderCall`/`renderResult`/`execute` params (`theme`, `result`, `ctx`) plus the shared `textResult` helper and `foreground-runner.ts`'s `onUpdate`, and marked Phase 20 Step 5 landed in `architecture.md`.
The `tidy-first-assessor` found no preparatory refactoring warranted — the target files were already shaped for the narrowing described in the plan.
File-level `eslint-disable` header tally landed exactly as planned: 3 → 1 (only `index.ts`'s accepted SDK gap remains).

### Observations

- Removing `agent-tool.ts`'s 6-rule header surfaced a genuinely pre-existing gap the plan didn't name: three `params.resume` (`unknown`) template-literal interpolations in the resume path tripped `no-base-to-string`/`restrict-template-expressions` once the header lifted.
  Fixed with the same `as string` cast already used a few lines away for the `getRecord`/`resume` calls, rather than re-disabling — consistent with the plan's "line-level precision, not zero" goal, but this specific site wasn't anticipated in the Risks section.
- Retyping `textResult`'s `details` param from `unknown` to `AgentDetails` broke two test call sites at the type level (not runtime): `agent-tool.test.ts`'s `makeCtx()` fake (now needs `as unknown as ExtensionContext`, matching the existing `parent-snapshot.test.ts` convention) and `helpers.test.ts`'s partial `{ displayName, status }` details fixture (now a complete `AgentDetails` literal).
  Both were anticipated risks in the plan ("grepped all 17 call sites"), but the *test* call sites weren't part of that grep — only `src/` callers were checked.
  Future plans retyping a shared helper should grep `test/` call sites too, not just `src/`.
- Pre-completion reviewer: **PASS**.
  No WARN findings — deterministic checks, doc updates (forward and reverse), code design, test artifacts, Mermaid diagrams, and dead-code all passed; acceptance-criteria and cross-step-invariant checks were correctly SKIPped (no acceptance-criteria section; no earlier-step files touched).
- All 3 plan steps completed in this session; nothing deferred.

## Stage: Final Retrospective (2026-07-16T03:14:36Z)

### Session summary

Shipped the type-only render-callback refactor cleanly across three stages (Planning → Build → Ship): 2 `refactor:` commits plus a `docs:` landed note, CI green, issue closed, no release (all commits are hidden/excluded changelog types, so the work auto-batches).
The dominant cross-stage pattern was strong front-loading — Planning verified SDK exports, resolved the one genuine scope choice via `ask_user`, and grepped call sites — with a single small enumeration gap that surfaced at Build time and was caught instantly by `tsc`/`lint`.

### Observations

#### What went well

- The Planning `ask_user` gate did real work: it surfaced the minimal-vs-fuller `textResult` retype as a genuine design choice rather than silently picking one, and the operator's "avoid implicitness" steer drove the fuller path that also cleared the named `foreground-runner` `details as any` target.
- Incremental verification was exemplary: Build ran `tsc` + `lint` after each of the three steps rather than only at the end, so the two compile-time test-fixture breaks and the latent `params.resume` lint violation each surfaced in the step that caused them and were fixed in the same commit — the feedback loop worked as intended, no batched-up surprise at the end.
- The `tidy-first-assessor` correctly returned "nothing warranted" — an accurate read that the target files were already shaped for the narrowing, avoiding busywork.

#### What caused friction (agent side)

- `missing-context` (Planning) — the plan claimed it "grepped all 17 `textResult` call sites" to de-risk the shared-helper retype, but that grep was scoped to `src/` only.
  Two `test/` fixtures (`agent-tool.test.ts`'s `makeCtx()` fake and `helpers.test.ts`'s partial `{ displayName, status }` details literal) then failed the tightened `AgentDetails` type at Build time.
  Impact: added friction but no rework — both breaks were compile-time, caught by `tsc` in the step that introduced them, and fixed in the same commit with the existing `as unknown as ExtensionContext` / complete-literal conventions.
  Self-identified during Build; the Build-stage note already recommended "grep `test/` too."
- `other` (Planning) — the plan's Risks section anticipated "add a line-level disable only if lint surfaces a residual" in general, but did not enumerate the specific `params.resume` (`unknown`) template-literal gap that removing the file-level header would expose.
  Impact: none — handled exactly as the plan's fallback anticipated (fixed with the `as string` cast already used a few lines away), no rework.
  Removing a broad suppression inherently surfaces latent violations that cannot all be enumerated ahead of time; the general fallback covered it.

#### What caused friction (user side)

- None.
  The one operator interaction (the Planning dependency-floor pointer to `~/development/pi/pi` and the "help me decide" steer on the retype) was well-timed strategic input, not mechanical oversight.

### Proposals

- Add one grep-completeness rule to `.pi/prompts/plan-issue.md`'s Module-Level Changes touch-point family: when a step tightens a shared helper's parameter type, list `test/` fixtures as touch points, not only `src/` callers.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a touch-point rule to the Module-Level Changes grep family (after the Refs #558 serialized-contract rule): when a step tightens a shared helper's parameter type (`unknown` → a concrete required-fields type), grep `test/` fixtures as well as `src/` callers and list them as touch points, since a partial literal that satisfied the loose type fails the tightened type at compile time and a `src/`-only grep misses it (Refs #539).
