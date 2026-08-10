# Design: agents-dashboard-widget

## Context

The parent-window widget (`renderSubagentWidgetLines` in `packages/pi-subagent-herdr/src/index.ts`) is a bordered box: one row per run with elapsed time, name, run ID, admission class, runtime plan, and a lifecycle label; queued and pending-delivery entries as additional rows. It refreshes on a 1s tick and consumes a versioned JSON sidecar (`subagent-activity/<id>.json`) written by the child session's activity recorder (`packages/pi-subagent-herdr/src/activity.ts`, 500ms throttled atomic writes) and read via `observeRunningSubagent` into `running.activity`.

Target layout (approved by user):

```
● Subagents · 3 active · 1 open · 4 queued
├─ ⠹ Plan Reviewer · [a1b2] · foreground · 12.3s
│    ⎿  adversarial review · ↻5 · ⚙5 · ◈33.8k (62%)
├─ ⠹ Codebase Explorer · [c7d3] · background · 2m17s
│    ⎿  repo mapping · ↻42 · ⚙38 · ◈91.0k (84% · ⇊2)
├─ ◷ Plan Reviewer [q9x2] · background · queued
├─ ◷ Code Reviewer [q4rt] · background · queued
├─ ◷ Doc Writer [m8kp] · background · queued
```

Terminal layout — success clears, failure persists (approved by user):

```
○ Subagents
├─ ✗ Plan Reviewer · [a1b2] · foreground · 12.3s
│    ⎿  adversarial review · ↻5 · ⚙5 · ◈33.8k (62%)
├─ ■ GitHub Explorer · [b2c3] · background · 4.1s
│    ⎿  doc lookup · ↻3 · ⚙3 · ◈12.4k (8%)
└─ ✗ Codebase Explorer · [d4e5] · background · 2m17s
     ⎿  auth flow · ↻42 · ⚙38 · ◈91.0k (84% · ⇊2)

Identity line shows the agent display name (title-cased canonical agent id: `plan-reviewer` → `Plan Reviewer`). The activity line leads with the run label. Both are already available parent-side with no schema or launch-payload change: at launch, `name = label?.trim() || agent`, so the label is recoverable as `name !== agent ? name : undefined`, and the display name derives from the canonical `agent` id. Both `agent` and `admissionClass` are optional on `RunningSubagent`: the display name falls back to the raw `name` when `agent` is absent (in which case there is no separate label), and the class segment is omitted when `admissionClass` is absent.

The pi >= 0.81 extension API provides the metric sources: `ctx.getContextUsage()` returning `{tokens: number | null, contextWindow: number, percent: number | null}` (shape verified against the installed type declarations in `packages/pi-subagent-herdr/node_modules/@earendil-works/pi-coding-agent`), the `session_compact` event, `turnIndex` on turn events (already recorded), and `tool_execution_end`.

## Goals / Non-Goals

**Goals:**

- Per-agent turns, tool calls, context tokens, utilization %, and compaction count visible in the main window without opening panes.
- Context-utilization urgency conveyed by color tier, not by reading numbers: <70% dim, 70–85% warning, >=85% error.
- Preserve every existing spec obligation (always-on widget, class + run IDs, header counts, queued visibility, duplicate disambiguation, distinct retry labels, last-error surfacing, delivery-wait reasons).
- Graceful degradation under reload version skew between parent and child.

**Non-Goals:**

- The child-pane identity widget (Ctrl+J) is unchanged.
- Cumulative session token burn — `◈` is current context tokens only.
- Changing the status-read interval, recorder throttle, or widget tick.
- Any delivery, retry, lifecycle, admission, or interrupt logic changes.
- `packages/pi-subagent-herdr/src/status.ts` is entirely untouched: `formatElapsedDuration` also feeds model-facing `subagent_status` steer text, so the adaptive format must not leak into it.

## Decisions

### D1: Telemetry rides the existing activity sidecar as additive optional fields

Add `toolCount`, `contextTokens`, `contextWindow`, `contextPercent`, `compactionCount` (all optional) to `SubagentActivityState` with no schema version bump. `validateActivity` already tolerates unknown keys and treats unlisted optional fields as absent, so an old parent reading a new child's file ignores the extras, and a new parent reading an old child's file simply omits the metric chunks from the row. Alternatives considered: a separate telemetry file (rejected — doubles the read/write machinery for no isolation benefit); a version bump with dual readers (rejected — the additive path already degrades correctly).

### D2: Child-sourced token data, sampled on settle points

The child samples `ctx.getContextUsage()` on `turn_end`, `after_provider_response`, and `tool_execution_end` (writes ride the existing 500ms throttle) rather than the parent consulting `runtimePlan.contextWindow`. The child is authoritative — the existing model-mismatch check proves plan and reality can diverge. Defensive fallback: if `contextPercent` is absent but `contextTokens` and a nonzero `contextWindow` are present, the parent derives the percent locally.

**Assumption (unverified at runtime):** the nullable shape of `ContextUsage` is confirmed by the installed type declarations, and the doc comment says tokens/percent are null right after compaction; however upstream documentation also describes an estimation path, so null may never occur in practice. The parent-side rule ("keep last-known tokens, omit only the percent chunk when the sample is absent") is therefore specified against fixture-injectable sidecar state, not against pi's live post-compaction behavior.

### D3: `◈` is current context tokens

The same number the percent derives from. One source, always self-consistent with the `(NN%)` annotation. Cumulative burn would require summing `message_end` usage across the session and would answer a different question (cost, not pressure).

### D4: Uniform two-line rows; activity line leads with state

Every tracked run (starting, running, active, waiting, interrupted, blocked, stalled, finalizing) renders as two lines:

- **Identity line**: state glyph, agent display name, run ID, admission class, adaptive duration.
- **Activity line** (`⎿`): leads with the run's current state —
  - starting/running/active → the run label (when provided; otherwise the line leads with the first telemetry chunk),
  - blocked → `blocked <duration>` then label/metrics,
  - waiting/interrupted/stalled → the state name and its duration,
  - finalizing → the specific delivery-wait reason (`held · foreground busy` / `awaiting turn boundary` / `confirming delivery`) and the per-wait duration,
  - followed, when reported, by `↻ turns · ⚙ tools · ◈tokens (pct · ⇊compactions)`.

The glyph animates (braille frames) only for starting/running/active; all other states use static glyphs. The frame index derives from the render clock (`Math.floor(now / 1000) % frames.length`), not a module-level counter, so the renderer stays pure and tests are deterministic. This keeps line 1 stable (identity doesn't flicker) and lets line 2 carry the churn, while preserving the existing guarantee that a settled run names why it is waiting.

### D5: Queued rows are individual, capped at 3, with overflow

Each queued entry renders its own row (`◷ Name [id] · class · queued`) up to `MAX_QUEUED_WIDGET_ROWS = 3` (exported for tests); the remainder collapses to `└─ +N more queued`. This preserves the spec's per-entry class + run-ID visibility while bounding widget height. Alternative rejected: a single `N queued` count line (violates per-entry visibility).

### D6: Theme tokens for all color, tiered utilization

The renderer gains an explicit theme parameter (the widget callback already receives a theme and currently discards it); tests supply a minimal stub exposing the color/bold lookups the renderer uses. Utilization percent: <70% dim, 70–85% warning, >=85% error. `⇊N` is always dim — the percent's color carries urgency. The hardcoded RGB accents (`ACTIVE_ACCENT`/`OPEN_ACCENT`) and the bordered-box helpers (`borderTop`/`borderLine`/`borderBottom`) are retired with the box. Percent is omitted (not colored) when the model has no declared contextWindow or while the sampled value is absent.

### D7: Adaptive duration is a widget-local helper

A new formatter in `packages/pi-subagent-herdr/src/index.ts` renders `<60s → "12.3s"`, `<60m → "2m17s"`, `>=60m → "1h04m"`. ALL widget-visible durations use it — identity-line run elapsed and activity-line state/wait durations alike (blocked/waiting/interrupted/stalled/finalizing durations are computed from the lifecycle projection's deltas and formatted locally; they no longer pass through `formatLifecycleWidgetLabel`'s formatting). `formatElapsedDuration` in `packages/pi-subagent-herdr/src/status.ts` is NOT touched — it feeds model-facing `subagent_status` steer text bounded by `MAX_STATUS_LINE_LENGTH`, and changing it would alter text the parent model reads. `formatElapsedMMSS` (`packages/pi-subagent-herdr/src/index.ts`) becomes dead once rows switch to the adaptive form and is removed.

### D8: Widget reads `running.activity` directly; no status-shape changes

The renderer already receives `RunningSubagent` records whose `running.activity` holds the latest sidecar state. Telemetry fields flow through that path; `StatusObservation`/`StatusSnapshot` gain nothing.

### D9: 1s tick stays

Dropping the widget interval to ~250ms would smooth only the spinner; `◈`/`⚙`/`%` still refresh at ~1s (status-read interval + 500ms recorder throttle). Not worth 4x the renders.

### D10: Test migration is explicit, not incidental

The renderer remains exported via `__test__` (same export name, new theme parameter). The migration replaces the full-width line invariant (borderless tree does not pad) with a max-width invariant, replaces both literal hardcoded-accent assertions (`ACTIVE_ACCENT` and `OPEN_ACCENT`) with theme-stub assertions, removes the now-dead border-helper tests, and preserves all spec-backed obligations in their new form: class/run-ID presence (rewritten to the `◷ Name [id] · class · queued` and two-line formats), header count chunks, distinct retrying/undeliverable labels, error surfacing, delivery-wait reasons, and the settled-run clock freeze (elapsed stops at `projection.runtimeEndedAt ?? now`).

### D11: Row information intentionally dropped

The per-row `(agent)` parenthetical, the `modelId|thinking` runtime tag, and the queued-row elapsed clock do not appear in the new layout. The agent display name on the identity line subsumes `(agent)`; the runtime plan remains visible in the child pane and the model-mismatch check is unaffected (it operates on observation, not presentation); queued wait time is recoverable from ordering plus the overflow line. This loss is intentional, trading density for scannability.

### D12: Sticky terminal rows — success clears, failure persists

The widget's posture is "silent success, loud failure": a fully successful run leaves no trace (when nothing else is tracked, the widget disappears entirely, as today), while failure-class outcomes pin their row on screen until evicted. Row-removal sites (the watcher's `.then` finally and `.catch`) capture a terminal record into a separate `stickyTerminalRuns` collection instead of silently deleting, when the outcome is failure-class:

- `✗ failed` — non-zero exit, error message, or watch/launch error (the `markFailed` path).
- `■ stopped` — the lifecycle recorded an interrupt request before settling (dominant over the eventual exit status), or the child sent `caller_ping` (it stopped itself to ask for help).
- `⚠ watch-abandoned` — the watch deadline expired with the pane possibly still alive.

Suppressed/already-settled dedup paths and shutdown aborts produce no sticky rows. Delivery failures remain separate `⚠` rows in the pending-delivery section (they are bookkeeping about delivery, orthogonal to the run's outcome). `stalled` is NOT terminal — it can recover — so it stays a live-only static-glyph state and never pins the widget.

A sticky record captures name/agent/id/class, the frozen duration (`runtimeEndedAt`), and the last telemetry snapshot at capture time — the child's activity file goes stale once its process exits. Sticky rows render after live, queued, and pending-delivery rows, most recent first, capped at `MAX_STICKY_WIDGET_ROWS = 3` (exported) with a `+N more` overflow line.

Eviction: the next subagent launch (foreground or background admission) clears the whole sticky set; a completion correlated to a sticky run's id — the user manually resumes the run in its pane and it calls `subagent_done` — clears just that row.

Header semantics: the title is `Subagents` in all states. `● Subagents` plus the counts segment while live work exists (running, queued, or actively-retrying deliveries); `○ Subagents` with NO counts segment when only sticky rows and/or exhausted deliveries remain; widget removed when nothing at all is tracked.

### D13: Widget run IDs use compact collision-aware prefixes

The widget displays opaque hexadecimal run IDs as an eight-character prefix to keep identity rows scannable. If two simultaneously visible entries share that prefix, each prefix expands only far enough to distinguish them. Non-opaque fixture or legacy IDs render unchanged. This is presentation-only: full IDs remain authoritative in tool results, interrupt/resume targeting, ownership, delivery, sidecars, and session correlation. Removing IDs entirely was rejected because duplicate agents and labels would become ambiguous.

## Risks / Trade-offs

- [Telemetry lags reality by up to ~1s (throttle + read interval)] → Acceptable for an operator dashboard; documented in D9.
- [pi may never actually report null usage after compaction (estimation path)] → Parent rule is specified against absent-sample sidecar state (D2), so behavior is correct whether or not null occurs.
- [Right after compaction, `◈` may show stale tokens] → Keep last-known tokens, omit only the percent chunk; `⇊N` renders alone in the parentheses (`◈33.8k (⇊2)`) so the increment still signals why.
- [Row width pressure on narrow terminals] → Per-line degradation: identity line drops duration first and truncates name last; activity line drops metric chunks right-to-left (⇊ → % → ⚙ → ↻).
- [Label-less runs have a sparse activity line] → Line leads with the first telemetry chunk; identity line already carries the agent name.
- [Stale sticky rows mislead after the user has already handled the failure] → Eviction on next launch and on correlated manual-resume completion (D12); rows carry frozen durations so their age is legible.
- [Mixed-version reload skew] → Additive schema (D1); worst case is missing metric chunks, never a broken widget.

## Migration Plan

No deployment or data migration: activity files are ephemeral per-run sidecars. Old in-flight children simply produce rows without metrics. Rollback is reverting the renderer; the additive activity fields are harmless to the old renderer.

## Open Questions

None blocking. (Resolved during exploration and review: pending-delivery rows stay visible with last error; header retains the counts segment in the live state and is bare in the hollow state; queued and sticky caps are 3; blocked joins the two-line family with a static glyph; `formatElapsedDuration` stays model-facing and untouched; stalled stays a live-only state; ping renders as ■ stopped.)
