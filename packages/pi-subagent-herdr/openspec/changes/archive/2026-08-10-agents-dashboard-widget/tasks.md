# Tasks: agents-dashboard-widget

## 1. Activity sidecar telemetry (`packages/pi-subagent-herdr/src/activity.ts`)

- [x] 1.1 Add optional fields to `SubagentActivityState`: `toolCount`, `contextTokens`, `contextWindow`, `contextPercent`, `compactionCount`
- [x] 1.2 Extend `validateActivity` with optional-integer/optional-finite checks for the new fields (unknown-key tolerance already holds)
- [x] 1.3 Add recorder support: increment `toolCount` on tool-execution end, increment `compactionCount`, and a `contextUsage(tokens, window, percent)` sampler; wire into the noop recorder as no-ops
- [x] 1.4 Unit tests in `packages/pi-subagent-herdr/test/activity-telemetry.test.ts`: counters increment, schema round-trips with and without the new fields, invalid values rejected

## 2. Child event wiring (`packages/pi-subagent-herdr/src/subagent-done.ts`)

- [x] 2.1 Count `tool_execution_end` into the recorder's tool counter
- [x] 2.2 Subscribe to `session_compact` and increment the compaction counter
- [x] 2.3 Sample `ctx.getContextUsage()` on `turn_end`, `after_provider_response`, and `tool_execution_end`; write tokens/window/percent when defined

## 3. Tree renderer (`packages/pi-subagent-herdr/src/index.ts`)

- [x] 3.1 Add a widget-local adaptive duration formatter (`12.3s` / `2m17s` / `1h04m`) in `packages/pi-subagent-herdr/src/index.ts`; do NOT touch `formatElapsedDuration` in `packages/pi-subagent-herdr/src/status.ts` (it feeds model-facing steer text); remove the now-dead `formatElapsedMMSS`
- [x] 3.2 Implement the uniform two-line row: identity line (glyph, display name, `[run-id]`, class, duration) + activity line leading with state — run label for active (label = `name` when `name !== agent`), `blocked <duration>`, state name for waiting/interrupted/stalled, or the delivery-wait reason + per-wait duration for finalizing — followed by `↻N · ⚙N · ◈Tk (NN% · ⇊M)` chunks.
      Fallbacks: display name derives from `agent` (title-cased) when present, else raw `name`; class segment omitted when `admissionClass` is absent.
      Braille spinner frames only for starting/running/active, indexed by `Math.floor(now / 1000) % frames.length` (no module-level counter).
      Identity-line elapsed freezes at `projection.runtimeEndedAt ?? now` for settled runs.
      ALL widget durations (identity and activity line) use the widget-local adaptive formatter from 3.1, not `formatLifecycleWidgetLabel`'s `formatElapsedDuration` calls
- [x] 3.3 Render `◈` from `running.activity` telemetry; omit missing chunks; derive percent from tokens/window when `contextPercent` is absent; keep last-known tokens and omit only the percent while a sample is absent
- [x] 3.4 Add an explicit `theme` parameter to the renderer signature (widget callback already receives one and discards it); percent tiers (<70% dim, 70–85% warning, ≥85% error) and always-dim `⇊N` resolved via theme tokens; retire `ACTIVE_ACCENT`/`OPEN_ACCENT` and remove the dead `borderTop`/`borderLine`/`borderBottom` helpers
- [x] 3.5 Header: title is `Subagents` in all states — `● Subagents` plus the existing counts chunks (active/open/queued/retrying/awaiting-runtime/undeliverable) while live work exists; `○ Subagents` with NO counts segment when only sticky terminal rows and/or exhausted deliveries remain
- [x] 3.6 Queued rows individual up to exported `MAX_QUEUED_WIDGET_ROWS = 3`, then `└─ +N more queued`; pending-delivery rows stay as `⚠` rows with sanitized last error and distinct retrying/undeliverable labels
- [x] 3.7 Narrow-width degradation is per-line: identity line drops duration first and truncates name last; activity line drops chunks right-to-left (⇊ → % → ⚙ → ↻); enforce max-width invariant on both lines
- [x] 3.8 Extend `updateWidget`'s show/hide logic: widget stays visible while the sticky set is non-empty (in addition to running/queued/pending); still removed when nothing at all is tracked; 1s tick unchanged; update the `__test__` export surface (renderer keeps its export name with the new theme parameter; border helpers removed)
- [x] 3.9 Sticky terminal capture: at the watcher's row-removal sites (`.then` finally / `.catch`), capture failure-class outcomes into a `stickyTerminalRuns` collection — `✗` failed (non-zero exit, error message, watch/launch error via `markFailed`), `■` stopped (interrupt recorded before settling, dominant over exit status; also `caller_ping`), `⚠` watch-abandoned.
      Each record snapshots name/agent/id/class, frozen duration (`runtimeEndedAt`), and the last telemetry at capture time.
      Suppressed/already-settled dedup paths and shutdown aborts capture nothing; successful deliveries capture nothing
- [x] 3.10 Sticky eviction and ordering: render sticky rows after live/queued/pending rows, most recent first, capped at exported `MAX_STICKY_WIDGET_ROWS = 3` with `+N more` overflow; clear the whole set on the next subagent admission (foreground or background); clear a single row when a completion correlated to its run id arrives (manual resume + `subagent_done`)
- [x] 3.11 Compact opaque run IDs to an eight-character widget-only prefix, expanding colliding visible prefixes just enough to disambiguate them while retaining full IDs internally

## 4. Test migration

- [x] 4.1 `packages/pi-subagent-herdr/test/test.ts` (7 renderer call sites): replace the full-width line invariant with max-width; replace BOTH literal accent assertions (`\x1b[38;2;77;163;255m` ACTIVE and `\x1b[38;2;214;158;46m` OPEN) with theme-stub assertions; remove the `borderLine` fixed-width tests.
      Preserve, rewritten to the new formats: class + run-ID obligations (queued rows as `◷ Name [id] · class · queued`, active rows as the two-line form — the old `(agent)` parenthetical assertion does NOT survive), header count chunks, and the settled-run clock freeze (elapsed stops at `runtimeEndedAt`, e.g. `15s` rendered adaptively, never the later wall-clock value)
- [x] 4.2 `packages/pi-subagent-herdr/test/delivery-observability.test.ts` (5 call sites): preserve distinct `delivery retrying`/`undeliverable` counts, last-error row assertions, and the delivery-wait reason labels (`held · foreground busy`, `awaiting turn boundary`, `confirming delivery`) against the new two-line layout
- [x] 4.3 `packages/pi-subagent-herdr/test/runtime-safety.test.ts` (2 call sites): update to the new renderer signature
- [x] 4.4 Add a shared theme stub for renderer tests that TAGS the tier name (e.g. wraps text in the color name) so color-tier assertions are non-vacuous; do NOT reuse the existing pass-through `createTheme()` helper

## 5. New renderer tests

- [x] 5.1 `packages/pi-subagent-herdr/test/agents-widget.test.ts`: two-line rows per state (spinner vs static glyphs), run-label vs label-less activity lines, delivery-wait rows, queued cap at 3 + overflow, `⚠` delivery rows
- [x] 5.2 Sticky terminal behavior: `✗`/`■`/`⚠` glyph mapping (incl. interrupt-dominant-over-exit-status and ping → ■), frozen duration/telemetry at capture, success leaves no row, widget removed when all succeed, eviction on next launch, single-row eviction on correlated manual-resume completion, cap at 3 + `+N more`, bare `○ Subagents` hollow header vs counted `● Subagents` live header
- [x] 5.3 Narrow-width degradation per line: identity line (duration dropped first, name truncated last) and activity line (⇊ → % → ⚙ → ↻ drop order)
- [x] 5.4 Register `packages/pi-subagent-herdr/test/agents-widget.test.ts` and `packages/pi-subagent-herdr/test/activity-telemetry.test.ts` in `packages/pi-subagent-herdr/package.json` `test` script (explicit file list, not a glob)

## 6. Verify

- [x] 6.1 `pnpm --filter pi-subagent-herdr lint`, `pnpm --filter pi-subagent-herdr typecheck`, and `pnpm --filter pi-subagent-herdr test` all pass
- [x] 6.2 Add a `CHANGELOG.md` entry under `## Unreleased` in `packages/pi-subagent-herdr/CHANGELOG.md`
- [x] 6.3 `openspec validate agents-dashboard-widget --strict` passes
