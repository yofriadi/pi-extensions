## Why

Background subagents currently settle immediately as failures when encountering transient provider/agent errors (such as HTTP 429 rate limits, provider overloads, or quota limits).
When the parent session receives this failure, the failure message instructs the model to spawn a brand new subagent from scratch, discarding all previously accumulated context, tool outputs, and reasoning, which wastes substantial tokens and time.
Furthermore, the automated wake notice delivered to the parent session is unnecessarily verbose, resuming an existing subagent session file was not supported via the `subagent` tool schema, and the legacy `seed: fork` option adds unnecessary complexity by copying parent conversation history into child agents.

## What Changes

- **Automatic In-Extension Retry (3 total attempts = initial run + up to 2 automatic retries)**:
  - When a subagent attempt ends with a well-formed child error sidecar (`type: "error"` — provider rate limit, quota exhaustion, or a child turn terminated with an error stop reason) and attempts remain, the extension closes the failed attempt's pane and relaunches **the same session file through the standard launch path**, so every agent-owned flag, the child companion extension (`-e subagent-done.ts`), the full launch environment (`PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_AUTO_EXIT`, `PI_DENY_TOOLS`, model/skills/system-prompt flags), and the terminal sentinel are reproduced verbatim.
  - Each attempt runs with a fresh per-attempt id (`PI_SUBAGENT_ID`), so stale sidecars from earlier attempts are rejected by the existing ownership check — no sidecar hand-deleting is needed — while the run's parent-side identity stays stable: presentation, delivery bookkeeping, admission, and result tagging are continuous across attempts.
  - The retry decision is intercepted between completion observation and settlement claim: a retried attempt claims no settlement and does not mark the run terminal.
  - Delays are stepped fixed delays (5s before attempt 2, 15s before attempt 3), abort-aware, outside any watch budget.
    Each attempt receives a fresh watch deadline of the same configured length.
- **Support `session` parameter in `subagent` tool schema (path-only, ownership-gated)**:
  - Optional `session` (string) — a path to an **owned** existing subagent session file to resume with full transcript and prior tool outputs.
  - Validated before queue admission and before any resource creation: must exist as a file, must live under the invoking parent's child-sessions directory for the current working directory, its session header must record `subagentOwner.parentSessionId` equal to the invoking parent session and `subagentOwner.agentId` equal to the resolved canonical agent, and it must not be held by a live session lease.
  - Launch rollback MUST NOT delete pre-existing session files or their companion directories — neither caller-supplied ones nor a run's own file from a previous attempt; only files the extension created itself are rolled back.
- **Remove `seed` (`fresh` | `fork`) Option (Always Fresh Context)**:
  - Remove `seed` from agent definitions, session seeding, and launch behavior.
    Presence of `seed` frontmatter SHALL fail validation with a migration-style error (mirroring the obsolete `system-prompt` precedent) rather than being silently ignored.
  - Subagents always launch with fresh context; task delivery is always artifact-based; the fork transcript-copying machinery (`getForkContentLines`, `mode: "fork"`) is removed.
- **Shortened Parent Wake Notice**:
  - `WAKE_MESSAGE` becomes `"Subagent result delivered. Continue."` — deliberately dropping the `[pi-subagent-herdr]` provenance prefix; provenance is carried by the delivered result payload and widget presentation, not the wake text.
- **Updated Failure Guidance**:
  - After the final attempt fails, the error presentation keeps the parseable `provider/agent error —` prefix (consumed by the widget's failure-prefix stripping), states that extension auto-retries were exhausted after 3 attempts, and references the session log path for manual inspection.
- **Telemetry Indicators for Retry State (parent-side only)**:
  - Retry attempts are tracked in the run's parent-side lifecycle state and shown by the TUI widget (e.g. `retrying (2/3)`, a new lifecycle projection kind distinct from delivery-retry vocabulary). `activity.json` is untouched — it is owned and written exclusively by the child.

## Capabilities

### Modified Capabilities

- `subagent-dispatch`: Add optional ownership-gated `session` parameter to the `subagent` tool schema (modifies `explicit named subagent tool`, `minimal subagent call schema`, and `canonical user-owned agent resolution`, whose "no model-facing resume" clause is narrowed to "no implicit metadata-derived resume — explicit gated `session` only"); remove `seed` from agent definitions with loud validation failure.
- `pane-surface`: Remove `seed` (`fresh` / `fork`) frontmatter; all initial subagent sessions always launch with fresh conversation context; authorize mid-run surface replacement during automatic retry; narrow the no-resume-API clause so resumption requires the explicit ownership-gated `session` parameter (modifies `seeded owned sessions` and `pane lifecycle closes on settlement`).
  Written against the companion-directory base produced by `folder-based-subagent-artifacts` (see Sequencing).
- `completion-delivery`: Automatic background retry on well-formed child error sidecars up to 3 total attempts with stepped fixed delays before final settlement; per-attempt watch deadline; retry-exhaustion presentation; shortened parent wake notice; `retrying` tier added to the status-widget state vocabulary (modifies `deterministic multi-channel settlement`, `text-only result extraction`, `exactly-once delivery state machine`, and `status widget includes queued and active work`).
  Written against the companion-directory settlement base (see Sequencing).
- `subagent-telemetry`: Project retry attempt counts through parent-side lifecycle state and the TUI widget.

## Impact

- **Code affected**:
  - `src/agent-definition.ts`: Remove `SeedMode` and seed parsing; reject `seed` frontmatter with a validation error before queueing.
  - `src/session.ts`: Remove `getForkContentLines`, `SeededSubagentSessionMode`, and fork-mode branching; `seedSubagentSessionFile` writes only the fresh header (plus optional `session_info`).
  - `src/subagent-launch.ts`: Retry loop (interception seam, pane reap with confirmed absence, relaunch through the post-admission launch segment targeting the existing session file, per-attempt id, abort-aware backoff, per-attempt watch deadline); accept `params.session`; conditional rollback for pre-existing files; remove fork/seed branching.
  - `src/completion.ts`: Export the well-formed-error-sidecar predicate used by the retry decision.
  - `src/index.ts` + `src/tool-execute.ts`: Add `session` to `SubagentParams`; pre-admission validation and ownership gate in `resolveLaunchContext`; update failure presentation and remove seed behavior resolution.
  - `src/delivery.ts`: Shorten `WAKE_MESSAGE`.
  - `src/lifecycle.ts` / `src/widget.ts` / `src/types.ts`: New `retrying` lifecycle projection kind, exhaustive projection records, widget activity lead `retrying (n/3)` within the existing two-line tracked-run family, update the `provider/agent error` failure-prefix handling and its pinned tests.
- **Dependencies & Tools**: No external dependency changes; updates the parameter schema of the registered `subagent` tool.

## Sequencing

- **Land after `folder-based-subagent-artifacts`.**
  That change relocates the exit sidecar to `<stem>/exit.json`, adds companion-directory delete-on-success / preserve-on-failure with deletion gated behind the runId ownership check, and rewrites `pane-surface` / `completion-delivery` requirement text.
  This change's `pane-surface` and `completion-delivery` deltas are already written against that merged base and MUST archive second; until then they are not valid against the current main specs.
- Rebase points already absorbed here: the retry loop never deletes sidecars or directories by hand (consumption is deterministic and deletion lives solely in the base's settlement disposition), preserves `<stem>/` between attempts (intermediate attempts never reach settlement), and the final attempt's settlement applies the base's delete/preserve rules.
- Activity reads key on the current attempt's id: the base makes `activity.json` per-session rather than per-runId, so the parent's activity validation must target the attempt now running, never a stale id.
