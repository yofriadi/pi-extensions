## Context

`pi-subagent-herdr` executes child Pi subagents in dedicated Herdr panes.
When a child agent encounters a provider error (such as a 429 rate limit, network timeout, or quota exhaustion), the child agent loop terminates with `stopReason: "error"`, the child companion writes a well-formed error sidecar — `{type: "error", errorMessage, stopReason: "error", runId}` (`src/subagent-done.ts:62-75`) — and deliberately keeps the pane alive (`shouldAutoExitOnAgentEnd` returns false for error stops; pinned by `test/review-fixes.test.ts:618-633`).

Previously, the extension treated any error sidecar as an immediate terminal failure: `resolveSettlementDisposition` marks the run failed, the result flows into the settlement registry claim and `markFailed`, and the delivered message tells the parent to spawn a brand new subagent — discarding all accumulated context.

## Goals / Non-Goals

**Goals:**

- Transparent, in-extension automatic retries for retryable child errors, continuing the exact same session file with the exact same agent configuration, capped at 3 total attempts (initial + up to 2 retries).
- An optional `session` parameter on the `subagent` tool for explicit, ownership-gated resumption of an existing subagent session file.
- Remove the `seed` (`fresh` | `fork`) frontmatter option — loudly (validation error), not silently.
- Shorten the automated parent wake prompt to `"Subagent result delivered. Continue."`.
- Parent-side retry presentation (`retrying (2/3)`) in the TUI widget, distinct from delivery-retry vocabulary.
- Clear error messaging when all attempts are exhausted.

**Non-Goals:**

- Unbounded retries (hard cap: 3 total attempts).
- Changing Pi core's internal provider retry logic.
- Auto-retrying user-interrupted runs (Escape / abort produces `stopReason: "aborted"` and writes no sidecar at all, so the retry predicate cannot fire) and watch abandonment (`reason: "timeout"`).
- Writing retry state into `activity.json` (child-owned; see Decision 5).
- A new widget row family or presentation mode (see Decision 5 — `retrying` renders within the existing two-line tracked-run family, added to that requirement's enumerated state vocabulary by modifying it).

## Decisions

### 1. Retry Execution: Reap-and-Relaunch Through the Post-Admission Launch Segment

**Why not `pi --session <file> "Continue"` in the existing pane (the original sketch):**

- A bare resume command drops everything agent-owned that `buildLaunchCommand` assembles (`src/subagent-launch.ts:526-553`): `-e subagent-done.ts` (the only writer of the exit sidecar and of `activity.json`), `PI_SUBAGENT_SESSION` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_AUTO_EXIT` / `PI_DENY_TOOLS` (`buildLaunchEnvironment`, `:593-608`), model/thinking flags, `--append-system-prompt` identity, `--tools`, skills flags, and the `; echo '__SUBAGENT_DONE_'$?'__'` sentinel — the production fallback channel (`completion.ts:307-316`; `watchSubagent` passes no `sentinelFile`).
  A sidecar written without a matching `PI_SUBAGENT_ID` runId is silently discarded by `consumeExitSidecar`'s ownership check (`src/completion.ts:88-94`), and a child without `PI_DENY_TOOLS`+`PI_SUBAGENT_ID` would register a nested `subagent` tool, breaking child containment.
- There is no way to inject a command into the pane anyway: on a retryable error the child stays alive, so the pane's shell is not at a prompt — `runScriptInPane` → `herdr pane run` would type the command into the child's TUI as a chat message.

**Identity model (run identity vs attempt id).**
Run identity is the existing `state.id` on the single `RunningSubagent`; it is STABLE across all attempts and keys everything parent-side: the `runningSubagents` map and widget rows (`subagent-launch.ts:651`, `widget.ts:246, :337-348`), the settlement registry claim (`:787`), delivery `expectedRunId`/`deliveredRunIds`/pending-delivery id (`:1060-1065, :1091`), result `details.id` and the `[runId]` tag matching the launch acknowledgement (`:1040`, `tool-execute.ts:449, :287`), the admission lease id (`coordinator.ts:108`), the launch-transaction key (`launch-transaction.ts:73`), and the foreground barrier lease (`tool-execute.ts:213`).
A separate per-attempt id (`state.attemptId`) keys everything child-facing and is regenerated per attempt: `PI_SUBAGENT_ID` (`:603`), `waitForCompletion`'s sidecar `expectedRunId` (`:763`), the activity-read expected id passed to `readSubagentActivityFile` (`index.ts:549`) — under the sibling change's per-session `<stem>/activity.json`, the read must validate against the CURRENT attempt's id, never a stale one — the synthetic `hydrationActivity` state's `runningChildId` (`index.ts:484`, deliberately left on `state.id` — it never crosses `readSubagentActivityFile`'s wrong-id validation), and, after the sibling change, the settlement disposition's success-deletion runId match: a sidecar-derived result's runId must equal the CURRENT attempt id or deletion is fail-closed (a stale comparand would preserve `<stem>/` on every retried run).
Result presentation, sticky rows, and delivery bookkeeping therefore remain continuous while stale sidecars from earlier attempts are rejected by the ownership check.

**Mechanism:**

1. **Seam**: the retry decision is intercepted in the launch runner between completion observation and settlement — before `getSettlementRegistry(...).claim(...)` (`:787`) and before `markFailed` (`:870-874`).
   A retried attempt claims no settlement; `markFailed`/`isTerminal` never runs for it, so `observeActivity`/`observePaneInspection` stay live.
2. **Predicate**: retry only when `reason === "error"` AND the completion result identifies a well-formed child error sidecar (`type: "error"` — a real child-reported terminal error).
   `CompletionResult` gains the discriminator field this requires (all four current `reason: "error"` producers are shape-identical: `completion.ts:56-63, :69-75, :98, :299-304`); the field ripples into `ProcessState.completion` (`lifecycle.ts:19-20`) and the pinned exact-shape tests (`test/test.ts:1603-1621`).
   Malformed sidecars, unsupported payload types, pane disappearance, and timeout/abandonment outcomes are NOT retried — retrying a vanished pane or corrupt artifact would fail identically.
   Within well-formed error sidecars, no content classification is attempted (429-vs-auth string matching is brittle); the attempt cap bounds hard failures (see Risks).
3. **Reap with confirmed absence**: the failed attempt's pane is closed, and the relaunch waits (bounded, inside the backoff window) until the pane is confirmed absent before proceeding — pane absence implies the terminal host reaped the child process tree, which is what guarantees single-writer access to the shared `.jsonl` (the child is deliberately still alive on error; a synchronous `close` call does not prove the process is gone).
   If the pane persists past the bound, the relaunch is treated as failed (Decision 1, step 7).
   Keeping the old pane is pointless — it holds a live, idle Pi TUI that cannot be reused — and three stacked panes per retry would be worse; only the final attempt's pane is preserved for inspection.
   Region membership is updated by removing the dead pane (`removePaneFromRegion`, `layout.ts:267`) when the replacement joins.
4. **Relaunch entry point — the post-admission launch segment, not tool dispatch**: the runner re-executes the launch pipeline from surface initialization onward — replacement surface creation, `buildLaunchCommand`/`writeLaunchScript`, `runScriptInPane`, watcher registration, `waitForCompletion` — inside the SAME run.
   It does NOT re-enter tool dispatch, admission (`beginAdmission`), or agent resolution, and it therefore bypasses the Decision-2 caller gate entirely: the gate exists to protect cross-call resume, while the internal relaunch targets the run's own session file under a lease the run already holds.
   `prepareLaunchSession` gains an internal path that accepts the run's existing lease object and skips `acquire` (`:500-504`), the fresh-lease `transition("running")`, `registerSessionRollbacks` (the transaction never owns the pre-existing session file or companion directory), and — critically — `seedSubagentSessionFile`, which truncates and rewrites the session file with a fresh header (`session.ts:131-134`) and would destroy the transcript this feature exists to preserve.
   **The relaunched attempt reuses the original flags and environment verbatim** — the same builder reconstructs them; nothing is re-derived or defaulted.
5. **Transaction and failure story**: the original launch transaction commits at the first successful launch (as today, `commitRunningLaunch` `:962`); the relaunch begins NO new transaction, so terminal-shutdown `abortAllLaunchTransactions()` cannot replay session-file or lease rollbacks for a run whose transcript must survive (`launch-transaction.ts:86-91`).
   Because the reused segment's steps are transaction-coupled — `attachLaunchSurface` calls `own`/`advance("pane")` (`:445-446`) and `writeLaunchScript` calls `own`/`throwIfAborted`/`advance("script")` (`:657-661`), all of which throw once a transaction has committed (`launch-transaction.ts:16, :22`) — the relaunch runs them against a LOCAL, non-registered cleanup scope exposing the same own/advance interface instead of the committed transaction.
   Relaunch mechanics (surface creation, script write, pane run) wrap their own inline cleanup on failure — close the replacement pane, remove the new launch script — then settle the run through the ordinary reported-error path.
   The run-owned session file and companion directory are pre-existing by then and never owned by relaunch cleanup.
6. **Bookkeeping updates per attempt**: the retained `RunningSubagent` has its `surface`, `activityFile`, `launchScriptFile`, `entryCountBefore`, and `abortController` re-pointed at the new attempt (`startTime` retained for row continuity); `entryCountBefore` re-snapshots only AFTER confirmed pane absence, so it cannot capture a count while the dying child still writes.
   The lifecycle's per-attempt activity state is RESET alongside — `lastActivitySequence`, the cached activity read, and `activityRead` health — because the new attempt's recorder starts fresh at `sequence: 0` (`activity.ts:329-341`) while `isStaleActivity` compares sequence only (`lifecycle.ts:276`); without the reset every attempt-2 write would be discarded as stale until it passed attempt 1's high-water mark, freezing the row for the whole attempt.
   Region membership (dead pane removed), `layoutWarning` recomputation, and `tryRederiveRegionFromLayout` (`:478`) operate on the updated surface, and `projectLifecycle` (`lifecycle.ts:508-543`) gives the `retrying` projection precedence over stale turn state so the row reads `retrying (2/3)` during backoff instead of a stale `active 3m`.
7. **Backoff**: stepped fixed delays — 5s before attempt 2, 15s before attempt 3 — implemented with the existing abort-aware delay primitive (`abortableDelay`, `completion.ts:190`, extracted/exported per the no-inline-import rule); its `ABORT_MESSAGE` rejection is classified as cancellation, not an unexpected error.
   Delays sit outside any watch budget.
8. **Watch deadline per attempt**: `createWatchTiming` computes a fresh deadline per `waitForCompletion` call (`:221-227`); retained deliberately and specified: each attempt gets a full fresh watch of the configured length.
   A timeout is an abandoned watch, not a retry trigger.
   The run-level bound is attempts × deadline.
9. **Exhaustion**: after the third failed attempt the run settles through the ordinary failure path — pane preserved, admission released, lease retained — with the Decision-6 presentation.

### 2. `session` Parameter: Path-Only, Ownership-Gated, Validated Before Admission

- Schema: `session: Type.Optional(Type.String({ description: "Path to an owned existing subagent session log to resume instead of starting a new session" }))`.
- **Path-only** — the earlier "file or ID" wording is dropped.
  Pi's CLI happens to support ID prefixes (`resolveSessionPath`), but the extension's gate needs a concrete file path; ID resolution adds ambiguity for zero capability.
- Validation, in order, all BEFORE queue admission and resource creation (the call must remain side-effect-free on failure).
  Natural site: `resolveLaunchContext` (`tool-execute.ts:124-150`), which precedes `beginAdmission` (`:196`) and `requestAdmission` (`:230`):
  1. Resolves to an existing regular file, canonicalized with `canonicalSessionPath` (`session-leases.ts:63-69` — realpaths) so the location check cannot be escaped by symlinks and the live-lease lookup agrees on the same canonical key.
  2. Located under the invoking parent's child-sessions directory for the current working directory (the `<agentDir>/sessions/<safeCwd>/` root the extension itself writes).
  3. Session header line 1 records `subagentOwner.parentSessionId` equal to the invoking parent session AND `subagentOwner.agentId` equal to the resolved canonical agent for this call — resuming agent A's transcript under agent B would put B's identity prompt, tools, skills, and model over A's history while the header still claims A, violating provenance binding.
  4. Not currently held by a live session lease (`session-leases.ts:44-46` throws after resource creation today — the pre-admission check is what keeps failed resumes side-effect-free).
- Failure at any step yields a concise validation error; no pane, session, lease, or admission state is created.
- **Rollback conditionality**: the launch transaction never owns pre-existing state.
  `registerSessionRollbacks` (`src/subagent-launch.ts:515-518` — after the sibling change, the companion-directory + session-file rollbacks) must not register rollbacks for a caller-supplied session file, its pre-existing companion directory, or a run-owned session file and companion directory from a previous retry attempt.
  Only files the launch itself created are rolled back.
  Otherwise any post-seed launch failure destroys the user's existing transcript or a prior attempt's preserved artifacts.
- Auto-retry applies to resumed runs identically (they are ordinary runs whose session file happens to be caller-supplied), and to blocking runs — with the consequence documented in Risks.

### 3. Remove `seed` — Loudly

- Remove `SeedMode`, seed scalar extraction, and the `seed: fork` launch branch everywhere: `agent-definition.ts` (`:5, :15, :48-50, :223-241`), `session.ts` (`SeededSubagentSessionMode`, `getForkContentLines`, fork branching), `subagent-launch.ts` (`:56, :491-497, :511, :520-524, :624`), `index.ts` (`resolveEffectiveSeed`, `:177-193, :651, :703-704`).
- **`seed` presence in agent frontmatter SHALL fail validation before queueing** with a migration-style message ("`seed` is no longer supported; subagents always start fresh — remove it from the agent definition").
  This mirrors the existing obsolete-`system-prompt` precedent (`agent-definition.ts:213-216`) and avoids the silent fresh-downgrade that plain key-ignoring would cause for existing `seed: fork` agent files.
- `seedSubagentSessionFile` writes only the fresh header plus optional `session_info`; task delivery is always artifact-based (the code already routes fresh sessions to artifact delivery — `index.ts:186-192`, asserted at `test/subagent-launch.test.ts:196-215` — so the fork branch's removal changes nothing for delivery).

### 4. Shortened `WAKE_MESSAGE`

- Value: `"Subagent result delivered. Continue."` (current constant is ~166 characters, not 170).
- Dropping the `[pi-subagent-herdr]` provenance prefix is deliberate: provenance is carried by the delivered result payload and widget presentation; the wake text's only job is to start a parent turn.
  No code or test pattern-matches the notice (all tests read the constant dynamically), so the shortening is behaviorally safe.

### 5. Retry Telemetry: Parent-Side Only, Existing Widget State Vocabulary

- `activity.json` is owned and written exclusively by the child (~500ms throttled recorder; the parent only reads and strictly validates it, `KNOWN_PHASES = starting|active|waiting|done`).
  A parent-injected `retrying` phase would fail validation and flip `activityHealth` to `problem`; a parent writer would also race the child's writes.
  The extension does NOT touch activity state.
- Mechanism: a new `retrying` kind in `LifecycleProjection` (`src/lifecycle.ts:68-79`) with `attempt`/`maxAttempts` fields, carried on the run's lifecycle state; the exhaustive `recoveredLifecycleLines` map (`lifecycle.ts:576-588`) is updated (the repo's exhaustiveness checks force this). `src/status.ts` has its own independent `SubagentStatusKind` and does not consume `LifecycleProjection`, so it needs no change.
- Widget: the `retrying` projection renders as the row's activity lead — `retrying (2/3)` / `retrying (3/3)` — WITHIN the existing two-line tracked-run family; the completion-delivery delta MODIFIES `status widget includes queued and active work` to add `retrying` to its enumerated state vocabulary (tier list, activity-lead enumeration, animated-glyph set, header live-work counts), so the merged spec covers the state explicitly instead of leaving it outside a closed enumeration.
  `lifecycleGlyph` gains an explicit glyph (not the settled `◌` fall-through) and `widgetCounts` counts a retrying run as open/active work.
  This is distinct from the unrelated delivery vocabulary (`delivery retry N` / `N delivery retrying`, `widget.ts:295, :408-411`); presentation tests pin the distinction.

### 6. Retry-Exhaustion Presentation (Conditional)

- The exhaustion statement is presented ONLY when the failure actually exhausted retries: attempt counts are plumbed onto `SubagentResult` (`types.ts:11-24`) and `resolveResultPresentation` (`index.ts:305-317`) branches on them.
  Today that branch is unconditional for any `errorMessage` — including malformed sidecars, pane disappearance, and errored watches, which are never retried — so an unconditional rewrite would print a false claim.
- Final failure text keeps the parseable `provider/agent error —` prefix (consumed by `providerFailurePrefix` stripping in `src/widget.ts:643-648` and pinned in `test/widget-result-message.test.ts:30-48` and `test/test.ts:2520-2543`), then states `extension auto-retry exhausted after 3 attempts` and references the session log path; the widget prefix parser strips both the old and new variants.
  The phrase distinguishes extension retries from Pi's internal provider retries.

## Risks / Trade-offs

- **[Risk] Hard failures (auth, hard quota) burn all attempts before final delivery.**
  No content classification is attempted; the cap bounds the cost.
  The added delay is the two backoff sleeps (20s) **plus each failed attempt's own wall time** — an attempt is bounded by its watch deadline (default is generous, hours), so the honest worst case before terminal delivery is roughly 3 × deadline + 20s, not "20-30s".
  Transient 429 windows still recover silently, which is the point.
- **[Risk] Retry re-executes a failing agent up to two extra times**, including for non-transient child errors (bad model name, prompt-driven abort paths).
  Accepted: these arrive as well-formed error sidecars, the cap bounds them, and the failure presentation after exhaustion is unchanged in kind.
- **[Risk] Blocking runs can now retry too**, tripling the worst-case suspension of a foreground tool call while the single foreground slot and delivery barrier are held across attempts (`tool-execute.ts:404-433`).
  Accepted for symmetry with background runs; the cap and per-attempt deadline bound it.
- **[Risk] Pane replacement is visible**: a retried run closes its failed pane and opens a fresh one.
  The widget row persists (stable run identity) and shows `retrying (n/3)`; only the final attempt's pane is preserved for inspection.
- **[Risk] Resume validation is policy, not sandboxing**: the ownership gate restricts `session` to the parent's own child sessions for the same agent, but a determined model could still name a stale session from the same parent and agent.
  Accepted — the threat model targets cross-parent, cross-project, and cross-agent access and arbitrary writable files, which the canonical-path location + header gates close.

## Sequencing

- **Depends on `folder-based-subagent-artifacts` landing first.**
  Its base text introduces `<stem>/exit.json`, ownership-gated sidecar settlement, deterministic consumption, single-site disposition deletion, and the rewritten `pane-surface`/`completion-delivery` requirements.
  This change's deltas for those two capabilities are written against that merged base and are invalid until it archives.
- Interaction contract with the base: the retry loop never deletes sidecars or directories (consumption is deterministic and deletion lives solely in the base's settlement disposition); intermediate attempts never reach settlement, so `<stem>/` and its artifacts survive between attempts; the final attempt settles through the ordinary path and the base's delete-on-success / preserve-on-failure rules apply unchanged.
- Absorbed rebase obligations: activity reads key on the current attempt id (the base makes `activity.json` per-session rather than per-runId); the base's `<stem>/exit.json` path is used throughout; the base's rollback model (directory + session file) is what Decision 2's conditionality conditions on.
