# Phase 12: Complexity reduction and test fixture extraction

## Summary

Phase 12 decomposed the three remaining high-complexity UI functions and extracted shared test fixtures into `test/helpers/`.

## Steps

### Step 1: Decompose `renderWidgetLines` (cognitive 44) — [#205]

`renderWidgetLines` in `ui/widget-renderer.ts` handled agent-status formatting, tree connectors, overflow, and empty states.
Extracted per-status renderers and a tree-connector utility.

- Target: `src/ui/widget-renderer.ts`
- Outcome: cognitive complexity < 10

### Step 2: Decompose `showAgentDetail` (cognitive 33) — [#206]

`showAgentDetail` in `ui/agent-config-editor.ts` handled display, edit, eject, and delete flows.
Extracted sub-functions per menu action.

- Target: `src/ui/agent-config-editor.ts`
- Outcome: cognitive complexity < 10

### Step 3: Decompose `update` in `agent-widget.ts` (cognitive 31) — [#207]

`update` mixed timer lifecycle, agent list assembly, render delegation, and visibility state.
Extracted `assembleWidgetState` (pure) and timer management.

- Target: `src/ui/agent-widget.ts`
- Outcome: cognitive complexity < 10

### Step 4: Extract shared test fixtures — [#208]

The 3 heaviest clone families:

- `agent-runner.test.ts` + `agent-runner-extension-tools.test.ts` (60-line shared setup)
- `agent-menu.test.ts` + `agent-creation-wizard.test.ts` + `agent-config-editor.test.ts` (54+51+24 lines)
- `agent-manager.test.ts` (18 internal clone groups, 210 duplicated lines)

Extracted shared factories into `test/helpers/runner-io.ts` and `test/helpers/ui-stubs.ts`.
Test duplication reduced from 71 clone groups (1,424 lines) to 59 clone groups (1,046 lines).

## Metrics change

| Metric                     | Before                 | After                  |
| -------------------------- | ---------------------- | ---------------------- |
| Health score               | 75/100 (B)             | 78/100 (B)             |
| Fallow refactoring targets | 4                      | 1                      |
| Test duplication           | 71 groups, 1,424 lines | 59 groups, 1,046 lines |

[#205]: https://github.com/gotgenes/pi-packages/issues/205
[#206]: https://github.com/gotgenes/pi-packages/issues/206
[#207]: https://github.com/gotgenes/pi-packages/issues/207
[#208]: https://github.com/gotgenes/pi-packages/issues/208
