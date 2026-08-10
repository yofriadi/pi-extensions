# Changelog

## Unreleased

### Breaking

- Require explicit canonical `agent` and `task` for every spawn; remove bare/default agents and `subagents_list`.
- Reduce the parent API to `agent`, `task`, optional `label`, `blocking`, `layout`, `surface`, and `direction`.
- Rename resume `sessionPath` to `path` and recover the execution profile from owner-only session metadata.
- Remove per-call model, thinking, tools, skills, system-prompt, fork, cwd, interactive, and auto-exit controls.
- Reject obsolete agent `system-prompt` frontmatter; the Markdown body is now the sole identity prompt.
- Remove package `config.json` / `config.json.example`. Status is always on; spawn defaults are hard-coded (async, attached, pane, direction `right`); model selection is agent frontmatter + parent inheritance only. Leftover package JSON is inert.

### Security

- Sanitize shell-comment preamble values in launch/resume scripts (`safeCommentValue`): strip CR/LF/Unicode line separators and C0/C1 control characters so a model-supplied session path containing a newline (legal in POSIX filenames) cannot break out of a `# Session: <path>` comment and execute arbitrary shell.
- Bound `herdrExecAsync` with a 5-second subprocess timeout so a hung `herdr pane read`/`pane get` call cannot strand the completion watcher indefinitely.
- Reorder `waitForCompletion` to inspect pane existence before reading the terminal tail, so a hung terminal read no longer blocks pane-missing detection (the cause of permanently "pending" deliveries).
- Add post-delivery verification (`verifyDeliveryPersisted`) that checks the session log for the custom message entry after `sendMessage`, making silent fire-and-forget delivery failures observable.
- Prevent discovery-time runtime poisoning: the process-global completion API is now a session-bound active record activated only at `session_start` (under a new `pi-subagent-herdr/active-completion-runtime` key), so a discovery-only extension factory evaluation — such as selected-skill validation's standalone resource loader, which now runs with extension execution disabled — can never replace the live parent delivery API. Deliveries attempted while no matching session-bound runtime is active defer without consuming send attempts, render as `awaiting runtime`, and recover on the next `session_start`. An owner-neutral process-global retry service survives reload gaps and accepts late enqueueing from pre-reload watcher closures, while enforcing the one-hour deferral budget even when no replacement session activates.

### Added

- Strict trusted-project/global agent resolution and body-only canonical identity tags.
- Agent-owned model/thinking/tools/skills/seed profiles.
- Progressive selected-skill metadata with Pi resource-loader validation and permission-sanitizer composition.
- Per-parent foreground/background admission (one blocking plus four async), FIFO queues, queue cancellation, and delivery barriers.
- Owner-only resume metadata, canonical session leases, transactional pane launch, rollback, and atomic settlement ownership.
- Stable run IDs and foreground/background/queued widget presentation.
- Replace the bordered subagent widget with a theme-aware tree dashboard that shows adaptive runtime, run labels, turn/tool/context telemetry, compaction counts, bounded queued/delivery rows, and responsive per-line degradation.
- Keep failed, stopped, and watch-abandoned runs visible as reload-safe sticky terminal rows until a new admission or correlated manual-resume completion clears them.
- Shorten opaque run IDs to collision-aware eight-character prefixes in the dashboard while preserving full IDs for runtime operations.

### Verified

- TypeScript, oxlint, 262 unit tests across 59 suites, `pnpm test`, and strict OpenSpec validation.
- Real Herdr blocking spawn, abort, same-parent resume, attached stacking, async/reload/fork/ping flows, queue/capacity behavior, and permission/selected-skill flows using `tokenrouter-openai/gpt-5.6-luna`; serialized acceptance suites passed (blocking/layout 9/9, terminal/mux 8/8, lifecycle 18/18). Shared-workspace suites are explicitly serialized, and the selected-skill ask and mixed-skill fixtures deny `caller_ping` so approved reads deterministically continue to the asserted bash actions.
