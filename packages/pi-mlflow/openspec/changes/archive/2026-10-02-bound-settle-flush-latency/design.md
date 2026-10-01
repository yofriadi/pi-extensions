# Bound settle-path flush latency

## Context

The tracing extension's `endRootCycle` (`src/lifecycle.ts`) awaits `mlflow.flushTraces()` at `agent_settled` and `session_shutdown` — deliberately, per the original design's D2 crash-safety goal: "a crash immediately after settlement cannot lose the completed cycle."

What the original design did not account for is where that await sits in pi's control flow:

- pi's `AgentSession._runAgentPrompt` emits `agent_settled` to extensions **inside a `finally` block**, and awaits every extension handler (`agent-session.js`: `finally { … await this._emitAgentSettled(); }` → `extensionRunner.emit(...)`).
- Therefore, the extension's flush await is on the critical path between "the assistant turn finished" and "pi is idle and ready for the next prompt / queued steer/follow-up delivery".

On the SDK side, the export path is: root span ends → `MlflowSpanProcessor.onEnd` → `MlflowSpanExporter.export()` populates `_pendingExports[traceId]` and starts `exportTraceToBackend` (at least two HTTP requests: `createTrace`, then `uploadTraceData`); `mlflow.flushTraces()` → `processor.forceFlush()` → exporter `forceFlush()`, which awaits the in-flight exports.
Each request runs through `MlflowClient`/`makeRequest` with a default timeout of **30 000 ms** (`getDefaultTimeout()` in `mlflow-tracing/dist/clients/utils.js`, overridable only via the `MLFLOW_HTTP_REQUEST_TIMEOUT` env var) — and the env var is read **per request**, not at module load.

Net effect today: if the tracking server becomes unreachable mid-session (laptop sleep/wake, route blackhole, or a hung server — a *killed* server instead fails fast with ECONNREFUSED), every subsequent turn-cycle stalls the UI after the assistant finishes.
A blackholed server costs **~30 s per settle** (`exportTraceToBackend` awaits `createTrace` first and rethrows, so when that first request aborts at 30 s the `uploadTraceData` PUT never runs — up to ~60 s only when the first request succeeds and just the artifact upload hangs). (Exports run concurrently, each arming its own 30 s timer, so several pending exports cost ~30 s wall-clock, not N×30 s.) The startup path already rejected this exact 30 s figure for this exact reason — `src/experiment.ts` bounds setup fetches to 5 s with the comment "mlflow-tracing's own client default is 30s — too long for an optional observability add-on on the session-start critical path."
The settle path is *more* user-visible than the startup path (it recurs every prompt, not once) and currently has no bound at all.

Two SDK behaviors discovered during adversarial review constrain the design (verified against `mlflow-tracing@0.1.3` sources):

1. **`forceFlush()` wipes the pending map.**
   `MlflowSpanExporter.forceFlush()` does `await Promise.all(Object.values(this._pendingExports)); this._pendingExports = {}` — a snapshot followed by an **unconditional wipe**.
   An abandoned (timed-out) flush that later resolves can remove exports belonging to *later* cycles from the SDK's map.
   Therefore, "a later flush rejoins the abandoned export" is **not** an SDK guarantee; this change must not claim it.
   Note also that exports enter `_pendingExports` at root-span end (`onEnd` → `export()`), **independent of any `flushTraces()` call** — a fact D1 relies on (the fresh flush's snapshot must happen in the same synchronous job as the root end, before any stale flush can wipe the map).
2. **The export path cannot reject — but the aggregate still needs a terminal handler.**
   `MlflowSpanExporter.export()` stores `exportTraceToBackend(trace).catch(error => console.error(...))` (`exporters/mlflow.js:151-154`), so every pending export promise fulfills, and `forceFlush()`'s `Promise.all` over them (`exporters/mlflow.js:182-184`) cannot reject either.
   On the pinned SDK, `mlflow.flushTraces()` therefore has **no reachable asynchronous rejection path**.
   The extension still attaches a terminal handler in the same turn as the SDK call: it is forward-defense against an SDK upgrade dropping that internal `.catch`, and it makes the retained aggregate non-rejecting by construction (a property D1's `Promise.all` relies on).
   Any test of the late-rejection path must stub a rejecting flush — the real SDK cannot produce one.

Four pi-side facts shape what the bound can and cannot promise.
They were verified against `@earendil-works/pi-coding-agent@0.82.0` (pi-mlflow's pinned devDependency, and the copy in its `node_modules`), with the settle-ordering fact re-verified against 0.99.2 (the version the host `pi` binary runs in this workspace).
**The line numbers below are version-specific** — the store holds a dozen pi versions, so re-verify them against the installed host at implementation time; the design relies on the *invariants*, not the offsets:

- **Settle ordering.**
  pi awaits extension `agent_settled` handlers *before* it emits the UI `agent_settled` event, so the extension's wait is user-visible: the TUI does not paint settle, and queued prompts/steers do not drain, until it returns.
  In 0.82.0, `_emitAgentSettled` does `await extensionRunner.emit({ type: "agent_settled" })` → `this._emit({ type: "agent_settled" })`, with `_resolveIdleWaitIfIdle()` in its `finally` (`agent-session.js:314-323`), called from `_runAgentPrompt`'s `finally` (`:744-756`).
  In 0.99.2 the same ordering holds (`:665-676`, called at `:1350`), but the idle bookkeeping is `_isEmittingAgentSettled` plus a `_deferredSettledActions` drain rather than `_resolveIdleWaitIfIdle()` — so cite the ordering, not the idle helper.
- **`session_shutdown` is not exit-only.**
  It is emitted on `/new`, `/resume`, `/fork`, and session import (`agent-session-runtime.js` `teardownCurrent`, `:100-110`), on extension `/reload` (`agent-session.js:2058`, `reason: "reload"`), and on quit (`agent-session-runtime.js:285-292`, awaited before `process.exit(0)` in `interactive-mode.js:2883-2902`).
  Only the quit path is followed by a process exit, so on the other paths the bound buys prompt session teardown, not faster exit.
- **Flush state is per extension-factory invocation, and the factory re-runs on every session runtime.**
  `TracingState` is created inside the factory (`src/index.ts` → `createInitialState`). pi's extension cache stores the imported *factory module*, not an instance: `extensionCache.set(extensionPath, factory)` (`extensions/loader.js:337-338`), while every `loadExtension` call — cache hit or not — does `createExtension(...)` + `createExtensionAPI(...)` + `await factory(api)` (`extensions/loader.js:363-374`).
  Each session runtime builds fresh services (`agent-session-services.js:53` → `new DefaultResourceLoader(...)` → `reload()` → `loadCurrentExtensionSet` → `loadExtensionsCached`, `resource-loader.js:344-354`), so `/new`, `/resume`, `/fork`, import, and extension `/reload` all produce a **new** `TracingState`; a cwd change additionally clears the module cache (`extensions/loader.js:119-125`).
  Only the *setup result* is process-global (`src/setup.ts:30-34,64-91`, keyed by cwd via `Symbol.for("pi-mlflow.setup-cache.v1")`), so a rebuilt instance reuses the resolved config/experiment instead of re-initializing the SDK — and a rebuild for a *different* cwd is silently disabled by that same cache (`src/setup.ts:74-79`).
  Consequence here: the retained flush reference and the degraded flag live at most as long as one session runtime, so "include retained work in the next attempt" covers successive attempts *within* a session and never crosses a switch.
- **The flush wait is not the whole settle wait.**
  `onAgentSettled` awaits `state.pendingGitProvenance` *before* `endRootCycle` reaches the flush (`src/lifecycle.ts:249-263`), and provenance runs `git rev-parse HEAD` followed by branch+remote in parallel, each bounded by `GIT_EXEC_TIMEOUT_MS = 2_000` (`src/git.ts:18,31-50`) — up to ~4 s, serially, in the worst case.
  This change bounds the flush wait only, so worst-case settle latency is ~4 s (provenance) + 5 s (flush) ≈ 9 s.
  Provenance is normally already resolved by settle, so the additive case is a slow-but-working git rather than the outage this change targets.

Constraint carried from the original design: silent-disable (D9) is a **startup-only** contract.
Mid-session server death is not detected at startup, and the extension's stated stance is "no retry loop, no interactive warning" — so the fix must not grow a mid-session health-check/retry subsystem either.

## Goals / Non-Goals

**Goals:**

- Bound the *flush wait* on the settle path and on every shutdown/teardown path to a small, fixed grace period (5 s) regardless of server state, so a dead server costs at most one bounded pause per cycle — plus the separately bounded git-provenance wait, up to ~4 s — instead of ~30 s-plus.
- Do not cancel or duplicate the underlying SDK operation.
- Retain a normalized promise for abandoned work and include it in the next extension flush attempt, so the extension does not forget the prior operation **on a best-effort basis within one extension-instance lifetime** (a concurrent attempt can clobber the reference; `/reload` or a cwd change discards it) — and without pretending that the SDK's pending-export map remains reliable after its reset.
- Guarantee no unhandled rejection from a late-settling flush promise.
  This is forward-defense: the pinned SDK's export path cannot reject (Context, SDK behavior 2).
- The extension leaves no timer of its own holding the event loop after `session_shutdown`. (On the OSS tracking-server path, the SDK's own in-flight requests — each with its own non-unref'd 30 s abort timer plus a live `fetch` — can still hold the event loop after shutdown since this design never cancels them; bounded process exit depends on pi exiting explicitly, as it does today.)
- Keep the signal visible but silent: a degraded-flush state surfaced only through `/mlflow`, never an interactive interruption, and never shown while tracing is disabled.
- Keep the change local: five files — a new `src/constants.ts` holding the shared 5 s figure, `src/experiment.ts` (import it instead of its local literal), `src/lifecycle.ts`, `src/state.ts`, and `src/status-command.ts`; no config, no dependencies, no lifecycle reordering.

**Non-Goals:**

- Changing the trace boundary (D1), span lifecycle, orphan-sweep ordering, or where the summary publish happens relative to root end.
- Making the grace period configurable (`pi-mlflow.json` stays three keys).
- A mid-session unreachability detector / re-enable loop.
  The extension still cannot tell "slow" from "dead" without new machinery, and a wrong guess either disables a working setup or keeps paying the latency this change removes.
- Cancelling or replacing `mlflow-tracing`'s exporter/processor internals; the private-SDK-surface policy stays as-is (only the already-documented `withActiveSpanContext` `_span` reach-in exists, untouched by this change).
- Defaulting `MLFLOW_HTTP_REQUEST_TIMEOUT` from the extension (see D1 alternatives — considered and rejected).
- Bounding the git-provenance await that precedes the flush on the settle path.
  It already carries its own per-command bound (`GIT_EXEC_TIMEOUT_MS = 2_000`); folding it into the flush budget would trade trace metadata for latency.
  The plan states the additive worst case instead of implying 5 s bounds the whole path.

## Decisions

### D1: Combine retained and current flushes, race them against a fixed 5 s grace period, and never cancel

`flushTracesBestEffort(state)` uses a normalized promise for every SDK call.
The important properties of the implementation are:

```ts
// src/constants.ts (NEW) — one shared "how long we wait on this optional
// server" figure for the whole extension. The setup path (src/experiment.ts's
// fetchWithTimeout, previously a local DEFAULT_TIMEOUT_MS = 5_000) and the
// settle/shutdown flush wait both import it, so the two cannot drift. It gets
// its own module rather than living in src/state.ts (a state-shape module that
// owns no constants) or src/lifecycle.ts (whose import graph pulls in the OTel
// API and git helpers the status surface does not need).
export const SERVER_WAIT_GRACE_MS = 5_000;

// src/lifecycle.ts
import { SERVER_WAIT_GRACE_MS } from "./constants.ts";

function startFlush(): Promise<void> {
	// Call the SDK SYNCHRONOUSLY in the same job as the root-span end (its
	// caller, endRootCycle, just ended the root synchronously, so the export
	// is already in _pendingExports). The full chain — mlflow.flushTraces() →
	// processor.forceFlush() → exporter.forceFlush()'s Object.values snapshot —
	// runs synchronously, so the snapshot happens before any previously-abandoned
	// flush can resolve and wipe the map. Deferring the call by even one
	// microtask (or inserting an `await` "for clarity") would reopen that
	// premature-"completed" window; do not.
	let raw: Promise<void>;
	try {
		raw = mlflow.flushTraces();
	} catch {
		raw = Promise.resolve(); // sync throw = accepted export failure
	}
	// The catch is attached in the same turn as the SDK call, so a late async
	// rejection (after the race below has already returned) can never surface
	// as unhandled.
	return raw.catch(() => undefined); // accepted no-WAL loss; never unhandled
}

async function flushTracesBestEffort(state: TracingState): Promise<void> {
	const previous = state.pendingFlush ?? Promise.resolve();
	const current = startFlush();
	// Both inputs are normalized; the defensive rejection handler keeps this
	// aggregate non-rejecting even if a future state writer violates that rule.
	const combined = Promise.all([previous, current]).then(
		() => undefined,
		() => undefined,
	);

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timed_out">((resolve) => {
		timeoutId = setTimeout(() => resolve("timed_out"), SERVER_WAIT_GRACE_MS);
	});
	const completed = combined.then(() => "completed" as const);

	try {
		const outcome = await Promise.race([completed, timeout]);
		if (outcome === "timed_out") {
			state.pendingFlush = combined;
			state.flushWaitExceeded = true;
		} else {
			state.pendingFlush = undefined;
			state.flushWaitExceeded = false;
		}
	} finally {
		// Mirror fetchWithTimeout (src/experiment.ts): a fast flush must not
		// leave a live grace timer to delay process exit.
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}
```

- **5 s** is the shared `SERVER_WAIT_GRACE_MS` from `src/constants.ts` — the same figure the setup path already justified against the SDK's 30 s client default, now imported by both call sites instead of duplicated as two equal literals.
  This resolves the change's only previous open question.
- At every attempt, the current flush starts **synchronously** (so its SDK-internal snapshot of `_pendingExports` — which `onEnd`→`export()` already populated at root-end, independent of any flush call — happens before any previously-abandoned flush can resolve and wipe the map; otherwise a stale wipe in the gap would make the fresh flush snapshot an empty map, resolve immediately, and report `completed` while the current cycle's export is still untracked) and is combined with any retained previous attempt.
  A degraded-then-`completed` sequence therefore proves the extension *waited*, not that every current-cycle export was individually awaited.
- The SDK call is **never aborted**: the extension abandons the *wait*, not the *work*.
  The retained promise is an extension-level wait guarantee, not a guarantee that the SDK will deliver an export after its own `_pendingExports` reset or after process exit.
- Terminal fulfillment/rejection handlers are attached before the race can return, so no flush promise can surface as an unhandled rejection (forward-defense; see SDK behavior 2 above).
- The grace timer is captured and cleared in `finally`, mirroring the repo's own `fetchWithTimeout` pattern.
- If the combined work finishes within the bound, the retained reference is cleared and the degraded marker reset.
  If the timer wins, the combined normalized promise is retained and the marker set.
  A flush that rejects quickly — unreachable on the pinned SDK, but handled — counts as an accepted export failure, not as a wait timeout.
- The synchronous-call invariant above is the design's most fragile point, so it is pinned by a test rather than by a comment alone — see D6.

**Alternatives considered:**

- **Propagate `AbortSignal` into the SDK.**
  Rejected — `makeRequest` accepts no signal; aborting would require reaching into private exporter internals, which the codebase's own fragility policy (`withActiveSpanContext`'s NOTE comment) already flags as last-resort-only.
  Aborting would also cancel an export that might have succeeded.
- **Default `MLFLOW_HTTP_REQUEST_TIMEOUT` from the extension.**
  The env var is read per request inside `makeRequest`, so setting it in `setupTracing` before `mlflow.init()` would work without touching SDK internals.
  **Rejected**: it mutates process-global state visible to any other in-process MLflow consumer that did not opt in; it aborts exports that the grace-period race would let finish; and — decisively — it cannot produce a deterministic settle bound at all: `forceFlush()` awaits *every* pending export, so the settle wait is bounded by the *slowest* pending export's request timeout, not by a single request's.
  `MlflowClient` is constructed with `{ trackingUri, authProvider }` and has no timeout option, so users who want this policy can set the documented environment variable themselves without the extension making that global choice.
- **Call `flushTraces()` without awaiting at all.**
  Rejected — it deletes the original D2 crash-safety property for healthy servers too.
  The bounded race keeps full durability for the common case (a healthy local server flushes quickly) and degrades only when the wait exceeds the grace period.
- **Serialize the retained promise before starting the current flush.**
  Rejected — under a bound, serialization could mean the current flush is *never issued at all* during a sustained outage (each attempt times out while still waiting on the older promise), so the extension would stop even attempting flushes. (Serialization would NOT, as an earlier draft of this decision claimed, prevent exports from entering `_pendingExports` — they enter at root-span end regardless of flush calls; and a fresh flush is gated on the earlier stalled export only *while the map has not been wiped* — once an abandoned flush resolves and wipes `_pendingExports`, a later fresh flush snapshots only what arrived after the wipe.
  The honest reason to combine rather than serialize is to keep attempting.) Consequence to be explicit about: during an ongoing outage *every* cycle pays the full 5 s bound because that cycle's own export is itself stalled behind a 30 s request timeout, so no bounded flush can complete until those requests abort.
- **Adaptive backoff — stop waiting while degraded.**
  After the first timeout, issue subsequent flushes without awaiting (fire-and-forget) until a probe or one in-bound flush shows recovery, so a sustained outage costs ~0 s per cycle instead of 5 s.
  **Rejected for this change**: resuming the wait needs a recovery probe, and a probe is the mid-session health-check machinery the Non-Goals exclude — a wrong guess either keeps paying the latency this change removes or silently drops the durability property for a server that recovered.
  The usual D9 objection ("cannot tell slow from dead") does *not* apply here, since backoff needs no diagnosis; the honest rationale is probe design and scope.
  Recorded as the natural follow-up if 5 s-per-cycle during outages proves annoying in practice.

### D2: Use an explicit tagged race and normalize late outcomes

The race winner is explicit: `completed` comes from the non-rejecting `combined` promise, while `timed_out` comes from the grace timer.
There is no second timer, elapsed-time guess, or mutable module-level marker.

`startFlush()` attaches fulfillment/rejection handling immediately.
`combined` is also normalized defensively, so both the current SDK promise and the retained prior promise are safe after the extension has returned from the settle handler.
On the pinned SDK this hardening is unreachable-by-construction rather than a live failure mode — `export()` wraps each export in `.catch(console.error)` (`exporters/mlflow.js:151-154`), so neither the pending exports nor `forceFlush()`'s `Promise.all` can reject — and it is kept because it costs one line, because it makes the retained aggregate non-rejecting by construction, and because an SDK upgrade could remove that internal `.catch`.
If a flush ever rejects quickly, the attempt completes with an accepted export failure and does not report a wait timeout; if the grace timer wins, the attempt is degraded and the normalized `combined` promise is retained.

### D3: Degraded flag and retained promise are per-extension-instance state

`flushWaitExceeded: boolean` and `pendingFlush?: Promise<void>` live on the existing `TracingState`, not in module-level variables.
The degraded marker is a boolean rather than a timestamp because nothing renders *when* degradation happened — `buildStatusLines` only needs to know that the most recent attempt exceeded the bound — and a timestamp whose sole consumer is a truthiness check is dead precision.
`flushWaitExceeded` is a required field defaulted to `false` in `createInitialState`, matching `enabled`/`finalCycleStatus`; `pendingFlush` stays optional.
They are:

- reset/updated by each flush attempt, with `pendingFlush` intentionally surviving root-cycle reset until the retained work settles or is replaced by a later aggregate,
- never read by span-status, setup, retry, or lifecycle decisions,
- rendered by `buildStatusLines` only when `state.enabled` and `state.flushWaitExceeded` are both set,
- never an interactive output and never trace content.

**Concurrency policy (accepted):** `flushTracesBestEffort` does read-then-write on `state.pendingFlush` / `state.flushWaitExceeded` across its grace-period gap, and a `session_shutdown` can fire while a settle handler is still inside that race (a realistic Ctrl+C window, now 5 s wide).
Two attempts can therefore interleave and one write can clobber the other's — e.g. the settle's later write could drop a retained reference the shutdown just stored.
This is accepted: both fields are purely observational (`/mlflow` output and the next attempt's `Promise.all` input), the underlying SDK work is never cancelled by either attempt, and the worst outcome is a transient missed re-await — not a lost export the SDK would otherwise have delivered.
Serializing the two attempts is rejected as out of scope (a mid-session mutex for a cosmetic flag).
Because of this clobbering, the proposal claims no absolute "never forgets earlier work" property; see the instance-lifetime note below.
The window is at least confined to one instance: since every session runtime rebuilds `TracingState`, a settle attempt from a previous session can never race a later session's shutdown attempt.

**Instance lifetime (accepted):** `TracingState` is per extension-factory invocation, and the factory re-runs for every session runtime (Context, pi-side fact 3: pi caches the factory *module*, not the instance — `extensions/loader.js:337-338,363-374`).
`/new`, `/resume`, `/fork`, session import, extension `/reload`, and a cwd change therefore each rebuild the state and discard both `pendingFlush` and the degraded flag mid-outage; only the process-global setup cache (`src/setup.ts:30-34,64-91`) survives, so the rebuilt instance reuses the resolved experiment without re-initializing the SDK.
Retention is thus a *within-session* guarantee: successive attempts inside one session runtime re-await abandoned work, and nothing is carried across a switch.
The abandoned export itself is unaffected by the discard — it keeps running in the background, inside the ordinary no-WAL loss window.
Nothing is persisted to extend retention (in-memory only, per the Migration Plan).

A user with a dead server sees no new console warning; `/mlflow` is the sanctioned discovery surface.
The active status remains active-with-slow-flush, while the disabled status remains status + reason only.

### D4: Spec delta shape

- `session-tracing` has two `MODIFIED` requirement blocks.
  "Every trace is durably flushed" bounds the settle flush wait and specifies non-cancellation, retained extension-level waiting (best-effort, per instance lifetime), and terminal-handler hardening for a late rejection the pinned SDK cannot currently produce.
  "Open spans are swept and flushed at session shutdown" applies the same bound to the shared teardown path, scoped to the extension's *handling* returning in time — it makes no claim about process exit, which pi owns via `process.exit(0)` after `await runtimeHost.dispose()` — and its scenarios are trigger-agnostic so they also read correctly for `/new`, `/resume`, `/fork`, and `/reload`, where no exit follows.
  Both blocks re-carry the base requirement headers and every base scenario, matching the repo's archive-merge convention (e.g. `archive/2026-08-11-flip-content-and-experiment-defaults`).
- `mlflow-status-command` has one `ADDED` requirement.
  It adds the active degraded line without modifying the existing configuration/state requirement, and explicitly says the line is omitted while tracing is disabled so the base disabled-status scenario remains satisfied.
  It specs observable behavior only — the indication is updated at the end of each attempt and cleared by a later in-bound attempt — and deliberately drops the earlier "an in-flight attempt keeps the previous value" clause, which no `/mlflow` invocation can observe (settle blocks the loop, so the command always runs between attempts).

### D5: Shutdown and session teardown use the same 5 s bound (decided)

`onSessionShutdown` → `endRootCycle` uses the same bounded flush, and `session_shutdown` fires on more than process exit: `/new`, `/resume`, `/fork`, and import (`agent-session-runtime.js:100-110`), extension `/reload` (`agent-session.js:2058`), and quit (`agent-session-runtime.js:285-292`).
Symmetry and the same reasoning as D1 apply: shutdown *handling* returns within the grace period instead of blocking on the SDK's request timeouts, which keeps session switches prompt during an outage and shortens quit teardown.
The guarantee stops at the extension's wait — the SDK's uncancelled in-flight requests (each with its own non-unref'd abort timer and live `fetch`) may still hold the Node event loop afterward, so exit latency on the quit path still comes from pi's `process.exit(0)` after `await runtimeHost.dispose()` (`interactive-mode.js:2883-2902`), exactly as today; the extension's contribution is to add no timer of its own and to stop contributing up to 30 s of handler time.
A slow server that would have completed after 5 s but before the old SDK timeout now has a smaller final-export window; that is an explicit no-WAL trade-off, and it applies per switch on the non-exit paths too.
On those paths the teardown is also the *end* of retention: the replacement session runtime rebuilds the extension instance, so a flush abandoned by the torn-down session is not carried into the new session's next attempt — it simply continues in the background and is lost if it has not landed by process exit.
A longer shutdown bound is a possible future follow-up, not an unresolved design question.

### D6: The synchronous-flush invariant is pinned by a test, not only by a comment

D1's correctness argument depends on `mlflow.flushTraces()` being *called* in the same synchronous job as the root-span end, so the SDK's `Object.values(_pendingExports)` snapshot happens before any abandoned flush can resolve and wipe the map (`exporters/mlflow.js:182-184`).
An `await` inserted between root end and the call — plausibly added later "for clarity" — reopens a window where a fresh flush snapshots an empty map, resolves immediately, and reports `completed` while the current cycle's export is untracked.
A comment alone does not survive refactors, so tasks.md carries a dedicated ordering test.
"Real SDK" there means the real `MlflowSpanExporter`/`MlflowSpanProcessor` with only the **HTTP layer** under test control — a local server that stalls the first cycle's request and then answers it on cue, or a module mock of `clients/utils.js`'s `makeRequest` — because stubbing `flushTraces` replaces the very function whose call timing is the invariant and so cannot detect the regression.
The window is also genuinely narrow: `exportTraceToBackend` deletes its own map entry in a `finally` (`exporters/mlflow.js:175`) *and* `forceFlush()` wipes unconditionally, so reproducing the bug needs the abandoned flush still pending while the new root's export is in the map — on a real stalled request that is gated on the SDK's 30 s abort timer, which is why the task names the HTTP control point first.
If no such harness proves feasible in vitest, the fallback is explicit, mandatory, and pre-authorized: record in D1 and in the `flushTracesBestEffort` docblock that the invariant is comment-enforced only, with the reason — converting a silent gap into a documented, accepted one.

## Risks / Trade-offs

- [Successful cycle's trace lost on quick pi exit after a degraded flush] → Accepted.
  A slow server that would have completed after 5 s but before the old ~30 s request window is a new loss case; the trade-off is bounded session latency for a smaller eventual-export window.
  No local WAL exists in either design.
- [SDK's `_pendingExports` wipe can un-track a later cycle's export when an abandoned flush settles] → The retained aggregate ensures the extension still awaits the earlier *operation*, but it cannot repair the SDK's internal map or promise semantics; a degraded-then-`completed` sequence proves the extension waited, not that every current-cycle export was individually awaited.
  The design intentionally makes no stronger SDK-delivery claim.
- [Retained aggregate nesting depth] → Each consecutive degraded cycle wraps the previous aggregate in one more `Promise.all` layer, so `state.pendingFlush` transitively pins a chain of depth N. N is *not* bounded by a constant: while prompts arrive faster than the SDK's ~30 s request timeout, no attempt can complete in-bound, so the chain grows by one node per prompt for the duration of the outage.
  It remains self-healing — every export eventually fulfills (the SDK's internal `.catch` turns its rejection into a fulfillment), so once the server answers again the first in-bound attempt clears the reference and the whole chain becomes garbage — and each node is constant-size.
  Capping retention (keep only the newest aggregate, or drop `previous` once it has settled) was considered and rejected: it silently forgets earlier work, the exact failure mode this change avoids, and unbounded growth needs a sustained outage plus a fast prompt cadence.
  Revisit if a long outage ever shows measurable heap growth.
- [5 s is still perceptible on a dead server] → Accepted bound; it matches the setup-path figure already shipped.
  Going lower risks flagging legitimately slow local servers under load, especially with content capture.
- [`MLFLOW_HTTP_REQUEST_TIMEOUT` interaction] → The env var bounds each SDK request (default 30s); this grace period bounds the extension's wait independently.
  Setting the env var lower makes stalled exports fail sooner, so the flush *fulfills* before the grace timer (the SDK logs the failure and its internal `.catch` turns it into a fulfillment) — an accepted export failure rather than a degraded wait, and a shorter per-cycle stall than 5 s.
- [Late rejection or timer leak] → Immediate normalization and `finally` timer cleanup are explicit implementation requirements with dedicated tests.
- [Degraded flag boundary false positive] → A flush resolving at the timer boundary may report degraded for one attempt; the flag is observational only and resets on the next attempt.
- [5 s is not the whole settle budget] → The bound covers the flush wait only; `onAgentSettled` awaits git provenance first, up to ~4 s worst case (`src/git.ts:18,31-50`), so worst-case settle latency is ~9 s.
  Accepted: provenance is normally resolved before settle, already has its own per-command bound, and folding it into the flush budget would trade trace metadata for latency.
  Proposal, design, and spec all state the additive figure rather than implying a whole-path bound.
- [Flush state lost on any session switch, `/reload`, or cwd change] → pi re-runs the extension factory per session runtime, so `/new`, `/resume`, `/fork`, import, `/reload`, and a cwd change all rebuild `TracingState`, discarding `pendingFlush` and the degraded marker mid-outage.
  Accepted: both are observational/wait-only, the SDK work is never cancelled by the discard, retention was only ever a within-session guarantee, and persisting either would add durable state for a cosmetic benefit.
- [Every session switch pays the bound during an outage] → `/new`, `/resume`, `/fork`, and `/reload` each run the same bounded teardown flush, so a dead server costs up to 5 s per switch on top of the per-cycle cost.
  Accepted; still an order of magnitude better than the ~30 s each pays today.

## Migration Plan

None — no config, schema, or persistence changes.
Rollback is a code/spec revert; no state migration is required because the retained promise and the degraded flag are in-memory only, and an extension `/reload` or cwd change already discards them by rebuilding the extension instance.

## Open Questions

None.
The previously open question — whether the 5 s figure should be one shared constant rather than two equal literals — is resolved in D1: a single `SERVER_WAIT_GRACE_MS` in a new `src/constants.ts`, imported by both the setup path and the flush wait.
