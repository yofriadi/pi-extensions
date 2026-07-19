---
issue: 541
issue_title: "pi-subagents Phase 20 Step 7: decompose the notification renderer"
---

# Decompose the notification renderer

## Release Recommendation

**Release:** ship independently

The roadmap tags this step `Release: independent` (Phase 20 Step 7), and it belongs to no release batch.
It lands as a `refactor:`/`test:` commit — hidden changelog types that cut no release on their own; the work auto-batches into the next unhidden (`feat:`/`fix:`/`docs:`) release, so this plan does not itself trigger a release.

## Problem Statement

The notification renderer arrow in `src/observation/renderer.ts` is one closure that mixes four distinct decisions: status→icon/label selection, stats-parts assembly, preview truncation (collapsed vs. expanded), and output-file linking.
At 17 cyclomatic across 41 lines it is fallow's top triage concern (estimated CRAP 79.4).
The branch density makes the closure hard to read and hard to test — every assertion currently needs a `Text` instance and a theme stub, even for pure formatting logic (line truncation, stat pluralization, status labels) that has no visual dependency.

The motivation is branch density and the testability of the pure logic, not the CRAP number: `test/observation/renderer.test.ts` already exercises the arrow, so measured risk is lower than the static estimate.

## Goals

- Extract the arrow's pure formatting decisions into directly-testable helpers that need neither `Text` nor a theme.
- Reduce the renderer arrow's cyclomatic complexity below 10; the arrow becomes a thin wrapper that composes the helpers and applies theme styling.
- Cover the extracted logic with direct unit tests at the helper level.
- Preserve the rendered output exactly — this is a behavior-neutral refactor.

## Non-Goals

- No change to `NotificationDetails`, `buildNotificationDetails`, or any other module in the observation domain.
- No change to the rendered output, whitespace layout, markers (`⎿`), or theme style keys.
- No widening of the narrow `RendererTheme` / `RendererMessage` / `RenderOptions` interfaces landed in Step 5 ([#539]).
- Not touching the `formatMs` / `formatTokens` / `formatTurns` display helpers — they are already pure and tested.

## Background

Relevant modules:

- `src/observation/renderer.ts` — `createNotificationRenderer()` returns the `pi.registerMessageRenderer` callback.
  The callback reads `message.details` (a `NotificationDetails`), a `RenderOptions` `{ expanded }`, and a `RendererTheme` `{ fg, bold }`, then assembles a multi-line string wrapped in a `Text`.
  The file already declares three narrow interfaces (`RendererTheme`, `RendererMessage`, `RenderOptions`) — the established convention here is to depend on the minimum surface, which the new helpers should extend by depending on nothing (no theme at all).
- `src/observation/notification.ts` — owns `NotificationDetails` and already demonstrates the target pattern: pure helpers (`escapeXml`, `getStatusLabel`) exported for direct unit testing under an `// ---- Pure helpers (exported for unit testing) ----` banner.
- `src/ui/display.ts` — `formatTurns`, `formatTokens`, `formatMs` are pure and used by the stats assembly.

Constraint from the package skill: this file's narrow-interface discipline is a Phase 20 Step 5 outcome — the refactor must keep the theme dependency out of the extracted logic, not reintroduce a broad theme type.

## Design Overview

Split the arrow into three pure helpers plus a thin composing wrapper.
Each helper returns a value and owns one decision; none touches `Text` or a theme.

### Status presentation (OCP dispatch point)

The status→icon/label mapping is the one place that decides presentation from `status`.
Capture it once and return the resolved product (glyph, style key, label) so the wrapper only applies `theme.fg`:

```typescript
interface StatusPresentation {
  iconGlyph: string; // "✓" | "✗"
  iconStyle: string; // "success" | "error"
  statusText: string; // "completed" | "completed (steered)" | the raw error status
}

export function resolveStatusPresentation(status: string): StatusPresentation {
  const isError = status === "error" || status === "stopped" || status === "aborted";
  if (isError) return { iconGlyph: "✗", iconStyle: "error", statusText: status };
  const statusText = status === "steered" ? "completed (steered)" : "completed";
  return { iconGlyph: "✓", iconStyle: "success", statusText };
}
```

This preserves the current behavior exactly: the error branch's `statusText` is the raw `status` string, and the non-error branch maps `steered` → `"completed (steered)"`, everything else → `"completed"`.

### Stats parts assembly

The four-branch stats list is the highest-density piece and is fully pure.
It reads only the numeric/turn fields, so its parameter is ISP-narrowed to that subset (`Pick`), not the full `NotificationDetails`:

```typescript
type StatsSource = Pick<
  NotificationDetails,
  "turnCount" | "maxTurns" | "toolUses" | "totalTokens" | "durationMs"
>;

export function buildStatsParts(d: StatsSource): string[] {
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
  return parts;
}
```

Order, thresholds (`> 0`), and the `tool use`/`tool uses` pluralization are preserved verbatim.

### Preview truncation

The collapsed and expanded modes make genuinely different truncation decisions — first line sliced to 80 columns vs. up to 30 whole lines — so a single helper returns the content lines for the active mode:

```typescript
export function buildPreviewLines(resultPreview: string, expanded: boolean): string[] {
  if (expanded) return resultPreview.split("\n").slice(0, 30);
  return [resultPreview.split("\n")[0]?.slice(0, 80) ?? ""];
}
```

The `⎿` marker, indentation, and `theme.fg("dim", …)` styling stay in the wrapper — they are presentation, not truncation logic — so the exact whitespace layout is unchanged.

### Wrapper call site

The arrow shrinks to a thin composition (≈ 3–4 branches, cyclomatic well under 10):

```typescript
return (message, { expanded }, theme): Text | undefined => {
  const d = message.details;
  if (!d) return undefined;

  const { iconGlyph, iconStyle, statusText } = resolveStatusPresentation(d.status);
  let line = `${theme.fg(iconStyle, iconGlyph)} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

  const parts = buildStatsParts(d);
  if (parts.length) {
    line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
  }

  const previewLines = buildPreviewLines(d.resultPreview, expanded);
  if (expanded) {
    for (const l of previewLines) line += "\n" + theme.fg("dim", `  ${l}`);
  } else {
    line += "\n  " + theme.fg("dim", `⎿  ${previewLines[0] ?? ""}`);
  }

  if (d.outputFile) line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);

  return new Text(line, 0, 0);
};
```

Each extracted helper returns a value and owns a real decision (status dispatch, stat selection, truncation), so this is design decomposition, not procedure-splitting.
The helpers are exported under the same "pure helpers, exported for unit testing" convention `notification.ts` already uses.

### Edge cases (all preserved)

- Empty `resultPreview` → collapsed yields `[""]`, expanded yields `[""]`; the wrapper renders an empty preview line, as today.
- `parts.length === 0` (all stats zero) → no stats line, as today.
- Absent `outputFile` → no transcript line.
- Absent `details` → `undefined` return, short-circuiting before any helper runs.

## Module-Level Changes

- `src/observation/renderer.ts`
  - Add exported `StatusPresentation` interface, `StatsSource` type alias, and three exported pure helpers: `resolveStatusPresentation`, `buildStatsParts`, `buildPreviewLines`, grouped under a `// ---- Pure helpers (exported for unit testing) ----` banner following `notification.ts`.
  - Rewrite the `createNotificationRenderer` callback body to compose the helpers; keep the three narrow interfaces unchanged.
  - Keep the existing `formatMs` / `formatTokens` / `formatTurns` and `Text` imports.
- `test/observation/renderer.test.ts`
  - Add direct helper `describe` blocks (see TDD Order); keep the wrapper-composition tests that verify theme application and multi-line assembly.
- `packages/pi-subagents/docs/architecture/architecture.md` (landed by `/tdd-plan` at implementation completion, per the roadmap step-mark convention)
  - Mark the Step 7 heading `#### ✅ Step 7 — Decompose the notification renderer ([#541])`.
  - Add a `Landed:` note under the step's `Outcome:` describing the extracted helpers and the measured arrow-complexity drop.
  - Update the Step-dependencies Mermaid `S7` node label to the `✅ Step 7 (#541)<br/>Decompose notification renderer` form used by the completed nodes.

No public export, event channel, or `Symbol.for()` accessor changes — `renderer.ts` exports only `createNotificationRenderer`, and this plan only adds exports.
Grep of `src/`, `test/`, `.pi/skills/package-*/SKILL.md`, and `packages/pi-subagents/docs/` confirms no consumer references the arrow's internals or any renamed/removed symbol (there are none).
The Phase 20 health-metrics target table (`src functions with CRAP ≥ 60`) is a phase-completion roll-up updated at phase-history-write time, not per step — out of scope here.

## Test Impact Analysis

1. **New tests the extraction enables** (previously impractical without a `Text`/theme stub):
   - `resolveStatusPresentation`: one case per status class — `completed`, `steered`, `error`, `stopped`, `aborted`, and an unknown status — asserting the full `{ iconGlyph, iconStyle, statusText }` value with `toEqual`.
   - `buildStatsParts`: all-present ordering; each `> 0` threshold gate (zero fields omitted); the `1 tool use` vs. `2 tool uses` pluralization boundary; empty result when all zero.
   - `buildPreviewLines`: collapsed first-line-only + 80-column slice boundary; expanded 30-line cap; empty-string input.
2. **Existing tests that become partially redundant:** the granular arrow assertions (steered label, stat pluralization, collapsed/expanded preview) are now covered more precisely at the helper level.
   Keep the arrow-level versions that double as composition checks, but do not add new granular assertions to the wrapper suite — put those on the helpers.
3. **Existing tests that must stay:** the wrapper-composition tests — success/error icon styling, `theme.bold` on description, the `·`-joined dim stats line, the `⎿` collapsed marker, and the `transcript:` output-file line — genuinely exercise theme application and multi-line assembly that the pure helpers do not cover.

## Invariants at risk

- **Step 5 ([#539]) — narrow tui/theme render interfaces.**
  Outcome: `renderer.ts` depends on `RendererTheme` `{ fg, bold }`, not a broad theme type.
  Pinned by `stubTheme()` in `test/observation/renderer.test.ts` (a two-method structural stub that would fail to satisfy a widened interface).
  This refactor strengthens the invariant — the new helpers depend on no theme at all — and must not widen `RendererTheme`; the existing structural stub is the guard.

## TDD Order

1. **Extract `resolveStatusPresentation`.**
   Red: add `describe("resolveStatusPresentation")` with a case per status class asserting the full value.
   Green: add the exported helper; call it from the arrow for the icon/label.
   Commit: `refactor(pi-subagents): extract status presentation from notification renderer` (`test:` + `refactor:` may be one commit since the helper and its first caller must compile together).
2. **Extract `buildStatsParts`.**
   Red: add `describe("buildStatsParts")` covering ordering, each threshold gate, pluralization, and the empty case.
   Green: add the exported helper (ISP-narrowed `StatsSource` param); call it from the arrow.
   Commit: `refactor(pi-subagents): extract stats-parts assembly from notification renderer`.
3. **Extract `buildPreviewLines`.**
   Red: add `describe("buildPreviewLines")` covering collapsed 80-column slice, expanded 30-line cap, and empty input.
   Green: add the exported helper; call it from the arrow for both modes.
   Commit: `refactor(pi-subagents): extract preview truncation from notification renderer`.
4. **Confirm the thin wrapper and prune redundant granular arrow assertions.**
   Green: verify the arrow is now a thin composition; run the full package suite and confirm the wrapper-composition tests still pass.
   Trim any granular arrow assertions fully subsumed by helper tests (keep the composition checks).
   Commit: `test(pi-subagents): focus notification renderer suite on composition`.

Each step's helper and its sole caller (the arrow) compile together, so extraction + call-site update land in one commit per step.
No large test file is rewritten wholesale — new `describe` blocks are additive and the wrapper suite is edited only lightly in step 4.
Run `pnpm --filter @gotgenes/pi-subagents exec vitest run test/observation/renderer.test.ts` after each step and the full suite before the final commit.

## Risks and Mitigations

- **Whitespace/marker drift changes rendered output.**
  Mitigation: the wrapper retains all marker/indent/theme assembly verbatim; helpers return only content.
  The retained composition tests assert the `⎿` marker, dim styling, and `transcript:` line.
- **`StatsSource` `Pick` diverges from `NotificationDetails`.**
  Mitigation: `Pick` derives structurally from `NotificationDetails`, so a field rename upstream breaks compilation rather than silently drifting.
- **A helper test false-greens on a broken fixture.**
  Mitigation: helper tests assert full return values with `toEqual` (per the testing skill's strong-assertion rule), not `toContain`.

## Open Questions

None.
The proposed decomposition is unambiguous and behavior-neutral; no follow-up work is deferred.

[#539]: https://github.com/gotgenes/pi-packages/issues/539
