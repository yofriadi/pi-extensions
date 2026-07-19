---
issue: 403
issue_title: "Pressing Escape does not stop subagent/background agent"
---

# Abort subagents on parent interrupt (ESC)

## Problem Statement

A user reports that pressing Escape in the Pi terminal to cancel the current work does not stop a running subagent — the agent keeps going despite the cancel request.
The reporter is a third party (`khalid244`); the operator confirmed the direction is to implement ESC-to-abort for both foreground and background subagents, aborting all running and queued background agents on a single ESC.

The root cause splits cleanly by execution mode:

1. Foreground subagents already receive the parent's abort signal through the tool boundary (`tool.execute(signal)` → `Subagent.wireSignal` → `abort()` → child `session.abort()`), so they should already stop on ESC.
2. Background subagents are detached by design: `spawnBackground()` never forwards the parent signal, and `manager.abortAll()` runs only on `session_shutdown`.
   There is no wiring from a parent interrupt to background-agent abort, so ESC does nothing to them.
   This is the reproducible bug.

## Goals

- Pressing ESC (the parent agent-loop interrupt) aborts all running and queued background subagents.
- Add a regression guard test proving a foreground subagent's child session is aborted when the parent signal fires.
- Reuse the existing `manager.abortAll()` semantics (abort running, mark queued stopped, clear the limiter) so ESC stops every active subagent in one action.

This is an intentional behavior change: background subagents that previously survived ESC will now stop.
It is a bug fix (`fix:`), not a breaking change — no config key, default value, or output shape changes, and detached-survives-ESC was a limitation rather than a contract.

## Non-Goals

- Selective or interactive abort (choosing which agent to stop) — out of scope.
- A dedicated `abortBackground()` that excludes foreground agents — `abortAll()` is reused; foreground agents are already aborted by their own signal wiring, so the overlap is redundant-but-harmless.
- Changing background-agent detachment for any path other than the ESC interrupt (e.g., the tool still returns immediately on spawn).
- Confirmation prompts or status messaging on abort.

## Background

Relevant modules and the verified runtime facts behind the design:

- `src/tools/foreground-runner.ts` — `runForeground(..., signal, ...)` forwards the parent `signal` into `manager.spawnAndWait({ signal })`.
- `src/lifecycle/subagent.ts` — `run()` calls `this.wireSignal(this.execution.signal, () => this.abort())`; `abort()` fires `abortController.abort()` and marks the record stopped.
- `src/lifecycle/subagent-session.ts` — `runTurnLoop` calls `forwardAbortSignal(session, opts.signal)`, which calls `session.abort()` when the signal fires.
- `src/tools/background-spawner.ts` — `spawnBackground()` omits `signal` entirely; background agents are detached.
- `src/lifecycle/subagent-manager.ts` — `abortAll()` aborts running, marks queued stopped, and clears the limiter; currently called only from `src/handlers/lifecycle.ts` on shutdown.
- `src/handlers/tool-start.ts`, `src/handlers/lifecycle.ts`, `src/handlers/index.ts` — the existing `handlers/` pattern: small classes with a narrow injected interface, registered in `index.ts`.

Verified SDK facts (from the pinned peer deps under `node_modules/@earendil-works/`):

- The interactive ESC handler calls `agent.abort()` while streaming (`pi-coding-agent` `interactive-mode.js`, `restoreQueuedMessagesToEditor({ abort: true })`).
- `pi-agent-core` `agent.js`: each run creates a fresh `AbortController`; `agent.abort()` calls `activeRun.abortController.abort()`; on normal completion `finishRun()` discards the controller **without** aborting it.
  Therefore the parent signal's `abort` event fires only on a real interrupt, never on normal turn completion — latching `abortAll()` to it will not spuriously kill background agents at turn end.
- The signal passed to `tool.execute(...)` (`agent-loop.js` line ~419) is that same per-run signal.
- Extensions read the live per-run parent signal via `ctx.signal` (`ExtensionContext.signal: AbortSignal | undefined`, undefined when idle).
- `pi.on("turn_start", (event, ctx) => ...)` is a registered event whose handler receives `ExtensionContext`; `turn_start` fires once at the start of every turn while streaming, so its `ctx.signal` is always the current run's signal.

AGENTS.md constraint: pi-subagents is a minimal core with dependency arrows pointing inward.
The new handler depends only on a narrow manager interface; no consumer knowledge leaks into the manager.

## Design Overview

Add a small `InterruptHandler` that latches the current parent abort signal and, on abort, tells the manager to abort all subagents.
Drive it from `turn_start` so the latch always tracks the live per-run signal — including across runs and turns that execute no tools.

Why `turn_start` rather than `tool_execution_start`: a background agent can outlive the run that spawned it.
If the user later interrupts a turn that ran no subagent tool, only a turn-level latch still holds that run's signal.
`turn_start` fires every turn with the current `ctx.signal`, so the latch is always current.

The latch dedups by reference: most turns reuse the same signal (no-op); a new run's signal triggers a detach-and-rewire.
The `abort` listener is `{ once: true }`; on normal completion the run's `AbortController` is discarded and garbage-collected with its listener, and the next `turn_start` detaches the stale reference.

### Manager interface (narrow, Tell-Don't-Ask)

```typescript
/** Narrow manager interface — only the method the interrupt handler calls. */
export interface InterruptManager {
  abortAll(): number;
}

/** Minimal context shape — only the field the handler reads. */
interface InterruptCtx {
  signal: AbortSignal | undefined;
}
```

### Handler

```typescript
export class InterruptHandler {
  private latched?: AbortSignal;
  private detach?: () => void;

  constructor(private readonly manager: InterruptManager) {}

  handleTurnStart(ctx: InterruptCtx): void {
    const signal = ctx.signal;
    if (signal === this.latched) return;
    this.detach?.();
    this.detach = undefined;
    this.latched = signal;
    if (!signal) return;
    const onAbort = (): void => {
      this.manager.abortAll();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.detach = () => signal.removeEventListener("abort", onAbort);
  }
}
```

### Consumer call site (`index.ts`)

```typescript
const interrupt = new InterruptHandler(manager);
pi.on("turn_start", (_event, ctx) => interrupt.handleTurnStart(ctx));
```

The handler talks to `manager` through a one-method interface, reads one field of `ctx`, and performs no chained access — no Law-of-Demeter or output-argument smells.
The latch state (current signal, detach handle) is owned by the handler.

### Edge cases

- Same signal across consecutive turns → reference equality short-circuits; no listener churn.
- `ctx.signal` undefined (idle, defensive) → detach the old listener and hold no signal.
- Signal already aborted when latched → `{ once: true }` listener does not fire; the prior signal's listener already ran `abortAll()`, so no agent is missed.
- ESC during a foreground subagent → the foreground agent is aborted twice (once via its own `wireSignal`, once via `abortAll`); `abort()` is guarded by status and `markStopped` is idempotent, so this is harmless.

## Module-Level Changes

- `src/handlers/interrupt.ts` (new) — `InterruptHandler` class and `InterruptManager` interface.
- `src/handlers/index.ts` — add `export { InterruptHandler } from "#src/handlers/interrupt";`.
- `src/index.ts` — instantiate `new InterruptHandler(manager)` and register `pi.on("turn_start", (_event, ctx) => interrupt.handleTurnStart(ctx))`.
- `src/lifecycle/subagent-manager.ts` — no code change; `abortAll()` is reused.
  Its `// fallow-ignore-next-line unused-class-member` comment stays (it is still reached only through narrow interfaces that fallow does not trace); the pre-completion `fallow dead-code` check will confirm.
- `docs/architecture/architecture.md` — extend the `handlers/` directory listing (around line 354) with `interrupt.ts` (turn_start handler → abort all subagents on interrupt).
  Check the same file for any handler file-count or complexity row that names the `handlers/` domain and update if present.

No exports are removed or renamed.
Grep confirms `.pi/skills/package-pi-subagents/SKILL.md` does not mention `abortAll`, interrupt, or ESC, so no skill update is required.

## Test Impact Analysis

This is a feature/fix addition, not an extraction, so no existing tests become redundant.

1. New unit tests enabled — `InterruptHandler`: latches the current signal, fires `abortAll()` on abort, dedups the same signal reference, re-wires on a new signal, and handles an undefined signal.
2. New integration guard — foreground abort: aborting the parent signal passed to `runTurnLoop` invokes the child `session.abort()`.
   This pins the currently-untested foreground link in `forwardAbortSignal`.
3. Existing tests stay as-is — `test/lifecycle/subagent.test.ts` (`wireSignal`, `abort`), `test/lifecycle/subagent-session.test.ts` (max-turns abort path), and `test/handlers/lifecycle.test.ts` (`abortAll` on shutdown) continue to exercise their layers unchanged.

## TDD Order

1. Foreground guard — `test/lifecycle/subagent-session.test.ts`.
   Add a test: when the `signal` passed to `runTurnLoop` aborts while `session.prompt` is in flight, `session.abort()` is called.
   Expected to pass immediately (proving the foreground chain already works); if the trace is wrong and it fails, fix `forwardAbortSignal` in `src/lifecycle/subagent-session.ts`.
   Commit `test: guard foreground subagent abort on parent signal (#403)` (or `fix:` if a code fix is needed).
2. Interrupt handler + wiring — `test/handlers/interrupt.test.ts` (new) → `src/handlers/interrupt.ts`, `src/handlers/index.ts`, `src/index.ts`.
   Red: write the handler unit tests (latch, abort→abortAll, dedup, re-wire, undefined signal) against the not-yet-existing class.
   Green: implement `InterruptHandler` + `InterruptManager`, export from the barrel, and register `pi.on("turn_start", ...)` in `index.ts`.
   The handler, its test, and the composition-root wiring land together because the handler is inert without the registration.
   Commit `fix: abort all subagents on parent interrupt (#403)`.
3. Architecture doc — `docs/architecture/architecture.md`.
   Add `interrupt.ts` to the `handlers/` directory listing and update any handler-domain count/row if present.
   Commit `docs: note interrupt handler in subagents architecture (#403)`.

## Risks and Mitigations

- ESC now stops background agents the user might have wanted to keep running.
  Mitigation: this is the operator's explicit choice (abort all running + queued); the behavior is documented in the plan and reflected in the `fix:` commit body.
- Re-latching on every `turn_start` could add overhead.
  Mitigation: the latch is a single reference comparison and short-circuits on the common same-signal case.
- A `{ once: true }` listener lingers on a signal that completes normally.
  Mitigation: the run's `AbortController` is discarded and GC'd with its listener; the next `turn_start` detaches the stale handle.
- Non-interactive modes (print/rpc) may not emit `turn_start` the same way.
  Mitigation: ESC interrupt is an interactive concern; the handler is a no-op when no signal is present.

## Open Questions

- Should a dedicated `abortBackground()` (excluding foreground) replace `abortAll()` here?
  Deferred: `abortAll()` is simpler and foreground is already signal-aborted; revisit only if the redundant double-abort proves problematic.
- Should ESC abort surface a confirmation or status message?
  Deferred: out of scope for this fix.
