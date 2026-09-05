## 1. Phase 1 — Presentation (resume-first delivery)

- [x] 1.1 Rewrite `resolveResultPresentation`'s failure branch in `src/index.ts`: keep provider-error prefix + session log path (kept last, for the widget strip); replace "You can retry by spawning a new subagent" with the exact resume invocation `subagent({ agent: <canonical-id>, task: <continuation>, session: <sessionFile> })` and the permanent-error rule (do not resume, do not respawn, surface to the user); emit the attempt-accurate qualifier — exhausted ("auto-retry exhausted after N attempts"), short-circuit ("no further automatic retry attempted because the error looked permanent", reflecting earlier attempts when the pattern first matched after attempt 1), or plain (non-exhausted outcomes, no exhaustion claim, no "inspect its pane" wording)
- [x] 1.2 Add the canonical agent id to the presentation signature (thread from `RunningSubagent.agent` at the blocking result site and the background message site) so a labeled run emits the correct `agent:` — never the label
- [x] 1.3 Add one sentence documenting the `session` resume parameter to the tool-level `subagent` description in `registerSubagentTool` (the schema param description already exists)
- [x] 1.4 Verify both delivery paths get the message for free via the shared `resolveResultPresentation` (background steer + blocking tool result) and that the new lines survive the widget's `providerFailurePrefix`/`resultMessageSummary` strip heuristics

## 2. Phase 1 — Failure settlement reaps the pane (single site)

- [x] 2.1 In `resolveSettlementDisposition` (`src/subagent-launch.ts`): flip `reason: "error"` to `preservePane: false, releaseAdmissionNow: false` so the error path runs the same `safeCloseAndReap` + `releaseRunOwnership` as success, at the same single site (`applySettlementDisposition`) — pane closed, region removed, session lease released, session file immediately resumable
- [x] 2.2 Confirm by inspection + test that all other settlement paths stay intentionally unchanged: `settleRelaunchFailure` (surviving pane keeps its lease until confirmed absence — a live writer may persist), `handleBackgroundWatchError` (conditional preservation), `handleWatchFailure`/`settleWatchFailure` (child state unknown), sticky launch failures (preserved), watch-abandoned (preserved) — no new release site anywhere
- [x] 2.3 Confirm blocking-path ordering needs no change: with the reap inside `applySettlementDisposition`, `completeBlockingRun`'s `sessionLease.transition("finalizing")` sees the same live-lease lifecycle as a successful blocking run (watcher holds `releaseOwnership: false`) — no released-lease throw, no barrier leak

## 3. Phase 1 — Result plumbing + quota short-circuit

- [x] 3.1 `src/types.ts`: `SubagentResult` gains `agent?: string` (canonical id) and `permanentError?: boolean`; extend `resolveResultPresentation`'s Pick; stamp both in `completionResult` from `running.agent` and the short-circuit decision
- [x] 3.2 Add `PERMANENT_ERROR_RE` (conservative, case-insensitive: quota exhaust/exceed/limit, billing, invalid api key, unauthorized/authentication) in `src/completion.ts` and export for tests
- [x] 3.3 Gate `isRetryableCompletion` (or thread `errorMessage` through `shouldRetryCompletion`): a well-formed error sidecar matching the pattern is not retried; the run settles immediately through the ordinary error path (which reaps the pane per task 2.1)
- [x] 3.4 Pin the pattern against real sidecar phrasings from test fixtures; misses keep the full 3-attempt policy; verify "rate limit" without "quota" does not match

## 4. Phase 1 — Tests

- [x] 4.1 Presentation tests: exhaustion text carries the exact resume invocation with the canonical agent id (including under a differing presentation label), the permanent-error rule, and no "spawn a new subagent" instruction; short-circuit variant states no further retry was attempted (attempt-accurate when matched after attempt 1); non-exhausted outcomes (malformed sidecar, pane disappearance) carry resume + rule but no exhaustion claim and no pane-inspection wording; widget summary strip leaves the resume lines intact with the session-log line last
- [x] 4.2 Disposition tests: error-with-pane settlement closes the pane, removes region membership, releases the session lease (session passes `session`-param validation immediately after); relaunch-failure, sticky-launch-failure, and watch-abandoned panes remain preserved with leases retained until confirmed pane absence
- [x] 4.3 Blocking test: failed blocking run's tool result carries the resume-first presentation; `completeBlockingRun` runs clean (lease transition, sticky capture, barrier release) — no thrown transition on a released lease
- [x] 4.4 Retry tests: quota-pattern sidecar settles immediately with 0 retries; quota pattern first matching on attempt 2+ stamps `permanentError` and the attempt-accurate qualifier; unrecognized transient error keeps 3 attempts; boundary phrasings ("rate limit" without "quota") do not match
- [x] 4.5 Regression: background failure steer still delivers exactly once with wake; sticky `✗` row still captured and evicted at next admission; reload of a delivery-in-flight failed run unchanged (the reload/delivery machinery is untouched by this change — covered by the pre-existing delivery/reload suites, not re-pinned in `test/resume-delivery.test.ts`)

## 5. Phase 2 — Hard force (fresh-spawn gate) — separate follow-up, do not start until Phase 1 is observed

- [ ] 5.1 Add optional `fresh` parameter to the `subagent` tool schema (default absent; `fresh: true` documents discard-intent)
- [ ] 5.2 Pre-admission validation in `resolveLaunchContext`: a fresh spawn (no `session`, no `fresh`) whose agent has a failed, settled, lease-free session under this parent is rejected with an error naming the most recent resumable session path and the resume invocation
- [ ] 5.3 Gate state derives from the child session JSONL's terminal stopReason + the lease registry — NOT from sticky terminal entries (wiped by any admission, dropped on reload)
- [ ] 5.4 Gate must not fire when the failed session was already resumed or is lease-held; multiple failed sessions name the most recent
- [ ] 5.5 Phase 2 tests: gate fires on resumable failed session; `fresh: true` bypasses; `session` resume unaffected; gate survives reload (JSONL-derived state); multiple failed sessions name the most recent

## 6. Documentation & verification

- [x] 6.1 README: document the resume workflow in the auto-retry/exhaustion sections (README.md:64–72) — failure delivery hands the parent the resume command; permanent errors surface to the user; note the quota short-circuit and the failed-pane reap (session becomes immediately resumable)
- [x] 6.2 `pnpm run check` from repo root — fix all errors/warnings/infos (this package checks clean; the remaining repo-root errors are pre-existing untracked work in `pi-session-recap`, outside this change)
- [x] 6.3 `pnpm test` for the package — iterate until green
- [x] 6.4 `openspec validate resume-not-respawn --strict` passes
