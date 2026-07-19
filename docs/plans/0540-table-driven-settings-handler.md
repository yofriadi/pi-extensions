---
issue: 540
issue_title: "pi-subagents Phase 20 Step 6: table-driven settings handler"
---

# Table-driven settings handler

## Release Recommendation

**Release:** ship independently

Phase 20 Step 6 carries the roadmap tag `Release: independent` (architecture.md, Step 6) and belongs to no release batch.
It ships on its own schedule.
Because the deliverable is a `refactor:` commit — a `hidden: true` changelog type — it does not cut a release by itself; it lands on `main` and auto-batches into the next `feat:`/`fix:` release.

## Problem Statement

`SubagentsSettingsHandler.handle` is 13 cyclomatic and 24 cognitive across 52 lines because it repeats the same select→input→parse→validate→apply→notify flow three times — once each for max concurrency, default max turns, and grace turns.
The three `if (choice.startsWith(...))` branches differ only in their label, input title, input default, minimum, validation message, and apply method.
The branch bodies are copy-pasted structure, not distinct logic, which puts `handle` on fallow's high-complexity list.

## Goals

- Describe each numeric setting as a descriptor (label, current-value display, input title, input default, minimum, validation message, apply method).
- Drive one loop over the descriptor table for both the select-option list and the chosen-setting handling.
- Bring `handle` to cyclomatic ≤ 6 and cognitive ≤ 10, off the fallow high-complexity list.
- Preserve observable behavior exactly — this is a refactor, not a behavior change.

## Non-Goals

- No change to the `SubagentsSettingsManager` or `SubagentsSettingsUI` interfaces.
- No change to the `index.ts` wiring (`new SubagentsSettingsHandler(settings)`) or the `/subagents:settings` command registration.
- No change to the settings surface itself — the three numeric settings, their prompts, minimums, and toast messages stay identical.
- No new public export; the descriptor table stays module-private.

## Background

Relevant module: `packages/pi-subagents/src/ui/subagents-settings.ts`.
It defines two narrow interfaces (`SubagentsSettingsManager`, `SubagentsSettingsUI`) and the `SubagentsSettingsHandler` class with a single `handle({ ui })` method.
The handler is constructed once in `src/index.ts:162` and invoked from the `/subagents:settings` command registration.

The three settings and their per-branch differences today:

| Setting           | Select label prefix | Current-value display            | Input title                                        | Input default                  | Minimum | Validation message                             | Apply method           |
| ----------------- | ------------------- | -------------------------------- | -------------------------------------------------- | ------------------------------ | ------- | ---------------------------------------------- | ---------------------- |
| Max concurrency   | `Max concurrency`   | `maxConcurrent`                  | `Max concurrent background agents`                 | `String(maxConcurrent)`        | 1       | `Must be a positive integer.`                  | `applyMaxConcurrent`   |
| Default max turns | `Default max turns` | `defaultMaxTurns ?? "unlimited"` | `Default max turns before wrap-up (0 = unlimited)` | `String(defaultMaxTurns ?? 0)` | 0       | `Must be 0 (unlimited) or a positive integer.` | `applyDefaultMaxTurns` |
| Grace turns       | `Grace turns`       | `graceTurns`                     | `Grace turns after wrap-up steer`                  | `String(graceTurns)`           | 1       | `Must be a positive integer.`                  | `applyGraceTurns`      |

The only per-setting display irregularity is default max turns: its select display coalesces `undefined` to the string `"unlimited"`, and its input default coalesces `undefined` to `0`.
Both are captured as descriptor callbacks so the loop stays uniform.

Test file: `packages/pi-subagents/test/ui/subagents-settings.test.ts` already drives all three settings through `handle` (valid apply, below-minimum warning, cancelled input) plus the shared select-list and cancel paths.
`makeMenuUI` (`test/helpers/ui-stubs.ts`) provides the UI stub with sequential `select` responses.

AGENTS.md constraint: a `refactor:` commit is a `hidden: true` changelog type and does not cut a release on its own — reflected in the Release Recommendation rationale above.

## Design Overview

Introduce a module-private descriptor type and a table of three descriptors, then collapse `handle` to a single pass over the table.

### Descriptor shape

```typescript
interface NumericSettingDescriptor {
  /** Prefix used both to build the select option and to match the user's choice. */
  label: string;
  /** Current value rendered in the select option (e.g. "unlimited" for an unset default). */
  currentDisplay: (settings: SubagentsSettingsManager) => string | number;
  /** Title shown on the input prompt. */
  inputTitle: string;
  /** Value pre-filled into the input box. */
  inputDefault: (settings: SubagentsSettingsManager) => string;
  /** Minimum accepted integer, inclusive. */
  minimum: number;
  /** Warning shown when the parsed value is below the minimum. */
  validationMessage: string;
  /** Applies the validated value and returns the toast to display. */
  apply: (
    settings: SubagentsSettingsManager,
    n: number,
  ) => { message: string; level: "info" | "warning" };
}
```

The `apply`/`currentDisplay`/`inputDefault` callbacks receive the `SubagentsSettingsManager` and pluck the one accessor they need (`settings.applyMaxConcurrent(n)`, `settings.maxConcurrent`, etc.), so the table itself holds no captured state and reads live values on each invocation.

### Rewritten handle

```typescript
async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
  const options = NUMERIC_SETTINGS.map(
    (d) => `${d.label} (current: ${d.currentDisplay(this.settings)})`,
  );
  const choice = await ui.select("Settings", options);
  if (!choice) return;

  const descriptor = NUMERIC_SETTINGS.find((d) => choice.startsWith(d.label));
  if (!descriptor) return;

  const val = await ui.input(descriptor.inputTitle, descriptor.inputDefault(this.settings));
  if (!val) return;

  const n = parseInt(val, 10);
  if (n >= descriptor.minimum) {
    const toast = descriptor.apply(this.settings, n);
    ui.notify(toast.message, toast.level);
  } else {
    ui.notify(descriptor.validationMessage, "warning");
  }
}
```

### Edge cases and behavior preservation

- **NaN / non-numeric input.**
  The comparison direction must stay `n >= descriptor.minimum` (apply on the true branch, warn on the false branch), not `n < minimum`.
  `parseInt("abc", 10)` is `NaN`, and every comparison with `NaN` is `false`; the original code's `if (n >= 1)` therefore falls into the warning branch.
  Inverting the test to `if (n < minimum) { warn }` would make `NaN < minimum` false and silently apply `NaN`.
  Keeping `>=` preserves the original rejection of non-numeric input.
- **Label prefix disambiguation.**
  The three prefixes (`Max concurrency`, `Default max turns`, `Grace turns`) are mutually non-overlapping, so `find(d => choice.startsWith(d.label))` resolves the same branch the original `if/else if` chain did.
- **No-match guard.**
  `find` can in principle return `undefined`; the `if (!descriptor) return` guard makes that a no-op, matching the original chain's implicit "no branch taken" fall-through.
- **Cancel paths.**
  `if (!choice) return` and `if (!val) return` preserve the original early exits for a cancelled select or input.

### Complexity outcome

`handle` drops to four decision points (`!choice`, `!descriptor`, `!val`, `n >= minimum`) over a single linear flow — cyclomatic ≈ 5, cognitive well under 10, comfortably inside the Step 6 targets (≤ 6 / ≤ 10).

### Structural review

The change is internal to one method and introduces no shared-interface, layer-wiring, or dependency-width change (`SubagentsSettingsManager`/`SubagentsSettingsUI` are untouched), so the design-review checklist finds nothing to act on.
The descriptor callbacks read a single accessor each from the manager — no Law-of-Demeter reach-through, output-argument mutation, or scattered-reset smell.
The three settings share one genuine flow (the copy-paste the issue calls out), so this is a legitimate extraction, not a leaky abstraction papering over a real structural difference.

## Module-Level Changes

- `src/ui/subagents-settings.ts`
  - Add module-private `NumericSettingDescriptor` interface (not exported).
  - Add module-private `NUMERIC_SETTINGS: readonly NumericSettingDescriptor[]` table with the three descriptors, placed below the class per the stepdown rule (function declarations hoist; `const` does not, so the table must precede the class — see Risks).
  - Rewrite `SubagentsSettingsHandler.handle` as the table-driven loop above.
  - The `SubagentsSettingsManager`, `SubagentsSettingsUI` interfaces and the class constructor are unchanged.
- `test/ui/subagents-settings.test.ts`
  - Existing tests are unchanged — they already assert per-setting behavior through `handle` and must stay green across the refactor.
  - Add one regression test: a non-numeric input (`"abc"`) is rejected with the descriptor's validation warning and does not apply.
    This pins the `>=`-vs-`<` decision described in Edge cases, which the refactor touches.

No removed or renamed exports; no README, skill, or architecture symbol references to update.
The architecture doc's Step 6 `Outcome:` bullet is the acceptance record and needs no edit here (it is updated when the phase history is written, outside this plan's scope).

## Test Impact Analysis

1. **New tests enabled.**
   A non-numeric-input regression test locks in the NaN-rejection behavior that the comparison-direction change could otherwise regress silently.
   No lower-level unit surface is newly exposed (the descriptor table stays private), so the refactor does not unlock new unit tests beyond that guard.
2. **Redundant tests.**
   None.
   The existing per-setting tests exercise the same behavior the descriptor table now drives; they remain the behavioral contract and should not be removed or collapsed.
3. **Tests that must stay as-is.**
   All existing tests in `subagents-settings.test.ts` — they are the green baseline proving the refactor preserved behavior.

## Invariants at risk

This surface was last shaped in Phase 19 Step 3 ([#447], extract `/subagents:settings` command).
Its documented invariant — the three numeric settings with their exact prompts, minimums, and toast routing — is pinned by the existing `subagents-settings.test.ts` suite (select-list contents, per-setting apply/warn/cancel).
No prose-only invariant needs a new test; the added non-numeric-input test strengthens the coverage the refactor touches.

## TDD Order

1. **Add non-numeric-input regression test.**
   Test surface: `test/ui/subagents-settings.test.ts` (max-concurrency describe block, or a new "input validation" block).
   Covers: an `"abc"` input is rejected with `"Must be a positive integer."` and `applyMaxConcurrent` is not called.
   This passes against the current implementation (it green-pins the pre-refactor behavior).
   Commit: `test: pin non-numeric settings input rejection (#540)`
2. **Rewrite handle as a table-driven loop.**
   Test surface: no test changes — the full existing suite plus the step-1 guard stay green.
   Covers: replacing the three copy-pasted branches with the `NumericSettingDescriptor` table and single loop, preserving behavior and the `n >= minimum` comparison direction.
   Verify: `pnpm --filter @gotgenes/pi-subagents exec vitest run test/ui/subagents-settings.test.ts` green; `pnpm run check` clean; fallow no longer lists `subagents-settings.handle` (`handle` cyclomatic ≤ 6, cognitive ≤ 10).
   Commit: `refactor(pi-subagents): drive settings handler from a descriptor table (#540)`

## Risks and Mitigations

- **Silent NaN behavior change.**
  Inverting the validation comparison would apply `NaN` on non-numeric input.
  Mitigation: keep `n >= descriptor.minimum` (apply/warn order unchanged) and land the step-1 regression test first so any inversion fails loudly.
- **Stepdown-rule vs. hoisting tension.**
  A `const` table does not hoist, so it must be declared before the class that reads it, which inverts the newspaper "class first" order.
  Mitigation: place `NUMERIC_SETTINGS` above the class with a short comment; the class remains the file's public surface and the interfaces stay at the top.
  This is the standard const-before-use ordering and does not affect readability materially.
- **Label-prefix collision on a future setting.**
  A new setting whose label is a prefix of another would break `startsWith` matching.
  Mitigation: out of scope for this change (no new settings); the three current prefixes are mutually exclusive.
  Noted for future additions.

## Open Questions

None.
The refactor is fully specified by the existing behavior and the descriptor table; no follow-up issues are named.

[#447]: https://github.com/gotgenes/pi-packages/issues/447
