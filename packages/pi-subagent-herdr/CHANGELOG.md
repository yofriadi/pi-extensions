# Changelog

## [Unreleased]

### Added

- Automatic in-extension retries for well-formed child error sidecars (provider rate limits, quota exhaustion, error-terminated child turns): up to 3 total attempts against the same session file, with the failed attempt's pane closed and confirmed gone before a stepped backoff (5s, 15s) relaunches through the same launch pipeline with a fresh per-attempt id. Malformed sidecars, pane disappearance, watch abandonment, and aborts are never retried. The widget presents `retrying (2/3)` during backoff, and exhaustion reports `provider/agent error — auto-retry exhausted after 3 attempts`.
- Optional `session` parameter on the `subagent` tool for explicit, ownership-gated resumption of an existing subagent session file (must live under the invoking parent's child-sessions directory, carry this parent session and agent in its ownership header, and be lease-free). Validation is side-effect-free and happens before queue admission; a failed launch never deletes the caller-supplied transcript.

### Changed

- Shorten the automated parent wake notice to `"Subagent result delivered. Continue."` — provenance is carried by the delivered result payload.
- The retry-exhaustion statement now appears only on failures that actually exhausted automatic retries; non-retried provider/agent failures print `(provider/agent error)` without an exhaustion claim.

### Breaking

- Remove the `seed` (`fresh` | `fork`) agent frontmatter option. Subagents always start with fresh conversation context; `seed` presence now fails validation before queueing with a migration-style error.

## [0.5.0] - 2026-08-16

### Fixed

- Emit `session_info` entry with display name (`label` or canonical agent ID) when seeding child subagent session files, and strip inherited parent session info on fork. Resolves unnamed and unreadable subagent session entries in the Pi session picker (`pi --resume` / tree view) which previously fell back to the first user message preamble wrapper.

### Changed

- Migrate unit test runner to Vitest via a package-local `node:test` shim (`test/alias.js`), preserving `c8` Istanbul coverage reporting for Fallow health gates and keeping serial Herdr integration tests on `node --test`.

## [0.4.0] - 2026-08-11
### Breaking

- Require explicit canonical `agent` and `task` for every spawn; remove bare/default agents and `subagents_list`.
- Reduce the parent extension API to `subagent` with required `agent` and `task` plus optional `label`, `blocking`, `layout`, `surface`, and `direction`; remove `subagent_interrupt` and `subagent_resume`.
- Reduce the child extension protocol to `subagent_done`; remove `caller_ping` and its ping settlement/delivery path. Interrupt and continuation are user-controlled directly in the visible Herdr pane or tab.
- Remove per-call model, thinking, tools, skills, system-prompt, fork, cwd, interactive, and auto-exit controls.
- Reject obsolete agent `system-prompt` frontmatter; the Markdown body is now the sole identity prompt.
- Remove package `config.json` / `config.json.example`. Status is always on; spawn defaults are hard-coded (async, attached, pane, direction `right`); model selection is agent frontmatter + parent inheritance only. Leftover package JSON is inert.

### Security

- Sanitize shell-comment preamble values in launch scripts (`safeCommentValue`): strip CR/LF/Unicode line separators and C0/C1 control characters so an unexpected newline in a path cannot break out of a `# Session: <path>` comment and execute arbitrary shell.
- Bound `herdrExecAsync` with a 5-second subprocess timeout so a hung `herdr pane read`/`pane get` call cannot strand the completion watcher indefinitely.
- Reorder `waitForCompletion` to inspect pane existence before reading the terminal tail, so a hung terminal read no longer blocks pane-missing detection (the cause of permanently "pending" deliveries).
- Add post-delivery verification (`verifyDeliveryPersisted`) that checks the session log for the custom message entry after `sendMessage`, making silent fire-and-forget delivery failures observable.
- Prevent discovery-time runtime poisoning: the process-global completion API is now a session-bound active record activated only at `session_start` (under a new `pi-subagent-herdr/active-completion-runtime` key), so a discovery-only extension factory evaluation — such as selected-skill validation's standalone resource loader, which now runs with extension execution disabled — can never replace the live parent delivery API. Deliveries attempted while no matching session-bound runtime is active defer without consuming send attempts, render as `awaiting runtime`, and recover on the next `session_start`. An owner-neutral process-global retry service survives reload gaps and accepts late enqueueing from pre-reload watcher closures, while enforcing the one-hour deferral budget even when no replacement session activates.

### Added

- Strict trusted-project/global agent resolution and body-only canonical identity tags.
- Agent-owned model/thinking/tools/skills/seed profiles.
- Progressive selected-skill metadata with Pi resource-loader validation and permission-sanitizer composition.
- Per-parent foreground/background admission (one blocking plus four async), FIFO queues, queue cancellation, and delivery barriers.
- Owner-only session provenance, canonical session leases, transactional pane launch, rollback, and atomic settlement ownership.
- Stable run IDs and foreground/background/queued widget presentation.
- Replace the bordered subagent widget with a theme-aware tree dashboard that shows adaptive runtime, run labels, turn/tool/context telemetry, compaction counts, bounded queued/delivery rows, and responsive per-line degradation.
- Keep failed, interrupted, and watch-abandoned runs visible as reload-safe sticky terminal rows until a new admission clears them.
- Shorten opaque run IDs to collision-aware eight-character prefixes in the dashboard while preserving full IDs for runtime operations.

### Verified

- Package oxlint, TypeScript, the package unit suite, changed-file formatting, and strict OpenSpec validation pass.
- Herdr integration coverage retains blocking spawn/abort, attached stacking, async/reload/fork flows, queue/capacity behavior, permission/selected-skill flows, and reduced parent/child tool-surface assertions; ping/resume fixtures and flows are removed.
