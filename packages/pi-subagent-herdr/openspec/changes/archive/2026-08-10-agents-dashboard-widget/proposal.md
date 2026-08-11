# Proposal: agents-dashboard-widget

## Why

The parent-window subagent widget is a bordered box of lifecycle labels.
It answers "is it running?"
but not "how far has it gotten?"
— an operator watching several concurrent agents cannot see turns taken, tools used, context-window pressure, or compaction history without opening each pane.
Context pressure in particular is the signal that predicts degraded output quality, and it is currently invisible until a pane is inspected.

## What Changes

- Replace the bordered-box parent widget with a tree-style "Agents" dashboard.
  Each tracked run renders as two lines: an identity line (state glyph, agent display name, run ID, admission class, elapsed) and an activity line that leads with the run's current state — the run label for active runs, the state name for waiting/blocked/stalled runs, or the specific delivery-wait reason for settled runs — followed by `↻` turns, `⚙` tool calls, `◈` context tokens with color-coded window-utilization percent, and `⇊` compaction count.
- Queued entries render as individual rows (name, run ID, class, queued state), capped with a `+N more queued` overflow line.
- Pending-delivery entries remain visible as `⚠` rows with the sanitized last delivery error; retrying, awaiting-runtime, and undeliverable stay distinctly counted and labelled.
- Extend the child→parent activity channel (versioned JSON sidecar) with optional telemetry fields: tool-call count, context tokens, context window, context percent, compaction count.
  Additive only; no schema version bump; mixed-version reload skew degrades gracefully (rows simply omit missing metrics).
- Duration rendering becomes adaptive (`12.3s` / `2m17s` / `1h04m`).
- Colors come from theme tokens (dim/warning/error tiers for utilization) instead of hardcoded RGB accents.
- **BREAKING (test contract only)**: the bordered-box render invariants asserted in tests (full-width lines, literal accent escapes) are replaced by tree-layout invariants.
  No runtime API changes.
- Sticky terminal rows: success clears the widget entirely, while failure outcomes persist until evicted — `✗` failed, `■` stopped (interrupted, or self-paused via `caller_ping`), `⚠` watch-abandoned — with frozen duration and final telemetry.
  Eviction: next subagent launch clears the set; a manual resume that completes clears its own row.
  Sticky rows are capped at 3 with overflow.
  The header is `● Subagents` with counts while live work exists, `○ Subagents` bare when only terminal rows and/or exhausted deliveries remain.

The child-pane identity widget (Ctrl+J) is unchanged.

## Capabilities

### New Capabilities

- `subagent-telemetry`: child sessions report cumulative turn, tool-call, context-token, and compaction metrics through the existing activity sidecar; the parent consumes them for widget rendering.
  Covers the additive schema fields, write cadence, graceful degradation under version skew, and the context-utilization color tiers.

### Modified Capabilities

- `completion-delivery`: the "status widget includes queued and active work" requirement's presentation changes from a bordered box to the tree dashboard.
  All existing obligations are preserved (always-on widget, class + run IDs per entry, active/open/queued counts, queued visibility without claiming a started process, duplicate-label disambiguation, distinct retrying/undeliverable labelling, last-error surfacing, per-wait durations); the delta adds the two-line row format, the queued cap-and-overflow presentation, and the metric fields.
  The "settled row clears" behavior is amended: success clears, failure outcomes persist as sticky terminal rows with defined eviction.

## Impact

- `packages/pi-subagent-herdr/src/index.ts` — parent widget renderer replaced; sticky terminal capture at the watcher's row-removal sites; widget show/hide extended for the sticky set; widget refresh cadence unchanged (1s tick).
- `packages/pi-subagent-herdr/src/activity.ts` — `SubagentActivityState` gains optional fields; validators extended; recorder gains counters.
- `packages/pi-subagent-herdr/src/subagent-done.ts` — child event wiring: count `tool_execution_end` and `session_compact`, sample `ctx.getContextUsage()` on settle points.
- `packages/pi-subagent-herdr/src/status.ts` — explicitly untouched: its duration helper feeds model-facing steer text, so the adaptive format stays widget-local.
- `packages/pi-subagent-herdr/test/test.ts`, `packages/pi-subagent-herdr/test/delivery-observability.test.ts`, `packages/pi-subagent-herdr/test/runtime-safety.test.ts` — renderer assertions migrate from bordered-box invariants to tree invariants; spec-backed assertions (class/run-id formats, count chunks, distinct delivery labels, error surfacing, delivery-wait reasons) are preserved.
- `packages/pi-subagent-herdr/test/agents-widget.test.ts`, `packages/pi-subagent-herdr/test/activity-telemetry.test.ts` — new; registered in the package's `package.json` `test` script.
- `packages/pi-subagent-herdr/CHANGELOG.md` — new entry under `## Unreleased`.
- No dependency, API, or config changes.
  Requires pi >= 0.81 extension API (`ctx.getContextUsage`, `session_compact`), already the declared peer floor.
