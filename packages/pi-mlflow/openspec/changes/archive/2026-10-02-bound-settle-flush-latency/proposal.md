## Why

When the MLflow tracking server becomes unreachable **mid-session** (not at startup), every `agent_settled` blocks pi's settle path for tens of seconds: `endRootCycle` awaits `mlflow.flushTraces()`, pi awaits extension handlers inside `_runAgentPrompt`'s `finally` block, and each underlying export request inside `mlflow-tracing` carries a 30-second default timeout (`MlflowClient` → `getDefaultTimeout()`, overridable only via `MLFLOW_HTTP_REQUEST_TIMEOUT`).
A blackholed server therefore stalls the settle path by **~30 s per settle**, repeating after every prompt (design Context derives the exact request sequencing, including the ~60 s case and why concurrent exports do not multiply it).

The startup path already treats that same 30-second figure as unacceptable for an optional observability add-on (`src/experiment.ts` bounds setup fetches to 5s with exactly this justification), but the per-cycle settle path has no bound at all.

The result contradicts the extension's founding design goal ("no noticeable resource/latency impact on the pi session") and its silent-disable philosophy: after a mid-session server death (sleep/wake, route blackhole, or a hung server — a *killed* server fails fast with ECONNREFUSED instead), the user experiences a multi-tens-of-seconds UI freeze after *every* prompt until pi is restarted. pi emits the UI `agent_settled` event only *after* extension handlers return, so the freeze is visible, and queued prompts/steers wait behind it.
The same await runs on every `session_shutdown`, which pi fires not only at quit but also on `/new`, `/resume`, `/fork`, session import, and extension `/reload` — so session switching stalls too.

## What Changes

- The awaited flush at `agent_settled` / `session_shutdown` becomes **bounded**: the extension waits for `mlflow.flushTraces()` for at most a fixed grace period (5 s, the same figure the setup path already uses, shared as one constant).
  If the combined flush work exceeds the bound, the extension stops waiting, records a degraded flag, and pi's settle/teardown path returns.
  The bound covers the **flush wait only**: `agent_settled` still awaits the git-provenance lookup first, which carries its own per-command bound (2 s each, up to ~4 s worst case), so the worst-case settle latency is ~9 s rather than 5 s.
  Provenance is normally resolved before settle, so the additive case is a slow-but-working git, not the outage this change targets.
- The underlying export is **not cancelled** — it continues in the background.
  The extension retains a normalized promise representing the abandoned flush attempt and includes that promise in the next flush attempt, so earlier work is not forgotten **on a best-effort basis within one session runtime**: a concurrent settle/shutdown interleaving can clobber the retained reference, and any session switch (`/new`, `/resume`, `/fork`, import), extension `/reload`, or cwd change rebuilds the extension instance and discards it — pi re-runs the extension factory per session runtime (its cache holds the factory *module*, not the instance), so only the process-global setup result survives.
  No stronger guarantee is claimed, and the MLflow SDK itself resets its pending-export map when `forceFlush()` settles, so the extension cannot guarantee delivery after that SDK behavior or after process exit.
- Every flush promise receives a terminal fulfillment/rejection handler immediately, so no flush attempt can surface as an unhandled promise rejection.
  This is **forward-defense**: on the pinned `mlflow-tracing@0.1.3` the export path cannot reject (`export()` stores `exportTraceToBackend(...).catch(console.error)`), so the handler and its test guard against a future SDK change rather than a reachable failure today.
- The bound is **not retried and does not disable tracing**: a slow (but working) server that occasionally exceeds 5s keeps working; only the extension's wait is abandoned, never the SDK operation.
  This deliberately differs from the startup silent-disable (D9), which fires when the server is proven unreachable — a slow flush is not proof of unreachability.
- Degradation signal: when the bound is hit, the next `/mlflow` run may surface "last flush wait exceeded the 5s bound (export continuing in background)" as an extra line **while status remains active**.
  The line is omitted entirely when tracing is disabled, preserving the existing "no misleading last flush information while disabled" contract.
  Configuration and status only, never trace content.
- No change to: trace boundary (D1), span lifecycle, metadata capture, `captureContent` gating, setup/silent-disable behavior, git-provenance bounding, or shutdown orphan-sweep ordering (summary publish still precedes root end; flush still runs last).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `session-tracing`: two requirements change.
  "Every trace is durably flushed" — the await becomes bounded, with non-cancellation, best-effort retained-promise waiting, and terminal-handler hardening specified; the existing fast-flush scenario is amended.
  "Open spans are swept and flushed at session shutdown" — the final flush on every shutdown/teardown path is bounded by the same grace period, scoped to the extension's *handling* returning in time (it makes no claim about process exit, which pi owns), and its scenarios are trigger-agnostic so they also cover session switch and extension reload, where no exit follows.
- `mlflow-status-command`: a new requirement allows reporting a degraded flush wait as an additional status line while tracing remains active — explicitly not shown while tracing is disabled, and never presented as disabled — consistent with the existing requirement that disabled states are never presented as active and captured content is never displayed.

## Impact

- **Code**: five files — a new `src/constants.ts` (the shared 5 s `SERVER_WAIT_GRACE_MS`), `src/experiment.ts` (import it instead of its local `DEFAULT_TIMEOUT_MS` literal), `src/lifecycle.ts` (bounded race, retained-promise state handling, terminal rejection handler, timer cleanup), `src/state.ts` (per-instance degraded flag + retained flush promise), and `src/status-command.ts` (degraded line).
  No public API, config, or dependency changes.
- **Tests**: new unit tests — a hung flush must not block settle beyond the bound; a stubbed flush that rejects *after* the grace period must not produce an unhandled rejection (stubbed, since the real SDK cannot reject there); the degraded flag is set/reset per attempt and absent when disabled; a later attempt includes the retained abandoned promise; no stray timer keeps the process alive; and an ordering test against the **real** SDK pinning the design's synchronous-flush invariant (or, if that proves infeasible in the harness, an explicit recorded note that the invariant is comment-enforced only).
  The existing "awaits real flushTraces completion before agent_settled returns" test still passes for a fast flush within the bound.
- **Docs**: `README.md` known-limitations bullet updated (bounded flush wait; the additive provenance wait; mid-session outage costs at most the grace period per cycle and per session switch; retained/background exports remain subject to the accepted no-WAL loss window; `MLFLOW_HTTP_REQUEST_TIMEOUT` interplay); `CHANGELOG.md` Unreleased entry; stale lifecycle comments updated.
- **Behavior risk**: with the bound hit repeatedly, traces can be lost if pi exits before background exports finish — a slow server that would have completed after 5s but before the old SDK timeout is a new loss window.
  During an ongoing outage *every* cycle pays the full 5 s bound (not just the first), because each cycle's own export is itself stalled behind its 30 s request timeout, so no bounded flush can complete until those requests abort; every session switch pays it too.
  Consecutive degraded cycles also nest the retained aggregate one layer deeper per prompt until an attempt completes in bound, so a long outage with a fast prompt cadence holds a proportionally long promise chain (self-healing, constant-size nodes; capping retention was considered and rejected because it silently forgets earlier work).
  The SDK's `_pendingExports` wipe can also stop later SDK flushes from observing some in-flight exports; retaining the extension-level promise ensures later extension attempts still wait for the earlier flush *operation*, but cannot repair SDK bookkeeping or guarantee delivery after process exit.
  A degraded-then-"completed" sequence therefore proves the extension *waited*, not that every current-cycle export was individually awaited to completion.
  These remain accepted no-WAL losses, traded for bounded session latency.
- **Non-goal**: making the grace period or SDK request timeout configurable from `pi-mlflow.json`, defaulting `MLFLOW_HTTP_REQUEST_TIMEOUT` from the extension, bounding the git-provenance await, or building an adaptive "skip the wait while degraded" backoff — all considered and rejected in the design (the last is recorded there as the natural follow-up); users who want a different SDK request timeout can set that environment variable themselves.
