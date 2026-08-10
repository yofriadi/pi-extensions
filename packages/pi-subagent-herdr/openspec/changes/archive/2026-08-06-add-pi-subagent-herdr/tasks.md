# Tasks: add-pi-subagent-herdr

The vendored fork, basic blocking delivery, attached layout, pane retry, tag injection, and upstream-derived lifecycle code already exist. The unchecked tasks below supersede earlier bare-agent, list-tool, eager-skill, and unbounded-concurrency work. A checked historical item is not evidence that the revised acceptance criteria are complete.

## 0. Completed foundation

- [x] 0.1 Vendor `0xRichardH/pi-herdr-subagents` at `d654eae7`, preserve MIT provenance, and record baseline verification.
- [x] 0.2 Remove upstream slash commands and Claude backend; keep Pi subprocess, completion extraction, widget/watchdog, resume/interrupt, and child done/ping extension.
- [x] 0.3 Implement initial blocking result path, attached-stack layout, Herdr retry/existence checks, active-agent tag construction, and fork-specific global keys.
- [x] 0.4 Run the original unit/OpenSpec baseline and record known smoke/layout/permission verification notes.

## 1. Strict agent resolution and minimal API

- [x] 1.1 Make `agent` and `task` required; remove bare/default launch and all fallback paths. Validate canonical filename-stem IDs and require optional frontmatter `name` to match.
- [x] 1.2 Resolve only trusted `<cwd>/.pi/agents/<id>.md` then `${PI_CODING_AGENT_DIR}/agents/<id>.md`; remove package/bundled/generated tiers and gate project definitions on `ctx.isProjectTrusted()`.
- [x] 1.3 Remove `subagents_list`, discovery diagnostics/list rendering, `enabled`, and agent-level `disable-model-invocation` migration behavior. Keep no replacement model-facing listing tool.
- [x] 1.4 Reduce `subagent` schema to required `agent`/`task` plus optional `label`, `blocking`, `layout`, `surface`, and `direction`; remove per-call name/model/thinking/tools/skills/systemPrompt/fork/cwd/interactive/autoExit.
- [x] 1.5 Derive authority from canonical agent ID and assign every run a stable internal run ID; make `label` presentation-only, allow duplicate labels, disambiguate human/result presentation by run ID where needed, and verify labels cannot affect permissions, model routing, skills, tools, leases, or resume.
- [x] 1.6 Return concise missing/unknown/invalid-agent errors before queueing and without creation, installation, trust, or editing guidance.

## 2. Agent-owned profile and child tool invariant

- [x] 2.1 Parse successful agent definitions using the final owned frontmatter schema (`name?`, `model?`, `thinking?`, `tools`, `skills`, `seed`) while preserving `permission:` untouched; make obsolete `system-prompt` frontmatter fail validation before queueing and use the Markdown body as the sole agent-authored identity prompt.
- [x] 2.2 Make agent `tools:` authoritative; delete per-call widening and obsolete deny/spawning paths.
- [x] 2.3 In child contexts, never register `subagent`, `subagent_interrupt`, or `subagent_resume`; hard-deny the same names in every child launch as defense in depth.
- [x] 2.4 Remove `subagents_list` from lifecycle denylists because the tool no longer exists; keep only child `subagent_done` and `caller_ping` as this extension's child tools and ensure launch allowlists include both.
- [x] 2.5 Remove legacy co-pilot branches so all admitted children use a visible pane and auto-exit; remove remaining `interactive` and resume `autoExit` fields/writers.
- [x] 2.6 Unit-test registered parent/child tool sets and prove neither agent tools nor permission config can restore hidden parent tools.
- [x] 2.7 Make declared agent model/thinking authoritative and inherit each omitted value from the parent runtime invoking launch or resume; unit-test declaration, partial omission, full omission, and absence of per-call overrides.
- [x] 2.8 Test body-only prompt assembly: exactly one canonical `<active_agent>` tag, one copy of the Markdown body, no duplicate identity instructions, and pre-queue rejection of obsolete `system-prompt` frontmatter.

## 3. Progressive-disclosure skills

- [x] 3.1 Use Pi's effective resource loading inputs (parent agent dir, cwd, packages/settings, and project trust) to enumerate candidate skills for validation.
- [x] 3.2 Normalize ordered comma-separated `skills:`; reject empty, duplicate, missing, and multiple-match names before queue admission.
- [x] 3.3 Launch children with general skill discovery disabled and each selected canonical skill resource explicitly supplied; remove `buildPiPromptArgs` `/skill:<name>` startup expansion.
- [x] 3.4 In the explicitly loaded child companion, render all selected resource metadata as standard escaped name/description/location entries in exactly one `<available_skills>` section before normally discovered permission sanitization; override `disable-model-invocation: true` visibility only for explicitly selected child skills, create the standard section when Pi omits it, never insert full skill bodies at startup, and fail closed before task submission if transform ordering cannot be guaranteed or verified.
- [x] 3.5 Verify full skill content loads only on child read or `/skill:name`, while unselected skills are absent.
- [x] 3.6 Integrate-test with `@gotgenes/pi-permission-system`: denied selected skill removed/blocked, ask/allow behavior preserved, and skill directory remains governed by skill/path/external-directory gates.
- [x] 3.7 Add unit tests for multiple skills, order, mixed and all-manual-only visibility, absent-container creation, single-container enforcement, XML escaping, explicit-before-discovered extension ordering, fail-closed ordering guard, permission-sanitizer ordering, unknown/ambiguous failures, and zero resource creation on failure.

## 4. Permission-system compatibility and identity

- [x] 4.1 Preserve and explicitly pass the parent's exact Pi agent directory to spawn/resume; remove `<cwd>/.pi/agent` substitution and verify globally installed extensions/config remain visible.
- [x] 4.2 Bind canonical agent ID to escaped `<active_agent>` injection for every launch path and reject unresolved/mismatched identity before tag construction.
- [x] 4.3 Keep `PI_SUBAGENT_PARENT_SESSION` unconditional and document direct child-TTY ask plus no-UI forwarding behavior.
- [x] 4.4 Write owner-only versioned session metadata at initial seed; persist canonical agent identity and ownership fields needed for safe resume.
- [x] 4.5 Rename pre-release resume input `sessionPath` to conventional `path`, remove caller-provided agent/profile fields, and let permission-system path/external-directory gates inspect it.
- [x] 4.6 On resume, canonicalize path, require ownership metadata, recover/revalidate canonical agent identity, and reject missing/mismatched ownership.
- [x] 4.7 Gate project agent precedence on trust and test trusted project override, untrusted global fallback, and untrusted unknown behavior.
- [x] 4.8 Reopen original permission task 4.4: run real child deny, ask, per-agent policy, resume identity, tool hiding, and skill/path cases with the permission extension actually loaded (not `-ne` alone).

## 5. Foreground/background admission coordinator

- [x] 5.1 Add a process-global per-parent coordinator with one active foreground slot, four active background slots, separate FIFO queues, atomic admission, and fork-specific `Symbol.for` ownership.
- [x] 5.2 Classify blocking `subagent` as foreground and async `subagent`/all resume as background. Validate fully before queue insertion.
- [x] 5.3 Keep queued foreground tool calls suspended; return truthful queued acknowledgements for async/background entries; create no pane/session/artifact/sidecar/script while queued; bind foreground queue entries to their parent tool abort signal so externally terminated blocking calls cannot launch later.
- [x] 5.4 Release slots exactly once after settlement, cleanup, and delivery bookkeeping; ping, failure, cancellation, pane disappearance, rollback, and shutdown all admit the next same-class FIFO entry. Specify that blocking ping settles foreground while any later resume enters the background class.
- [x] 5.5 Keep interrupt from releasing slot/lease. Add explicit cancellation of queued background entries and cancellation of all queued entries on parent shutdown, without resource creation.
- [x] 5.6 Persist/reuse active counts, queues, and ownership across `/reload`; prevent duplicate coordinator instances and double admission.
- [x] 5.7 Unit-test 1 foreground + 4 background coexistence, second/third foreground serialization, fifth+ background FIFO, simultaneous admission races, class independence, queue cancellation including external blocking-call abort, ping-then-background-resume, and all release paths.

## 6. Exclusive session leases and transactional launch

- [x] 6.1 Add canonical session-path leases covering queued, starting, running, interrupted, and finalizing states; reject duplicate resume across path aliases.
- [x] 6.2 Refactor launch into explicit admitted/pane/script/watcher/running states and acknowledge started only after `pane run` plus watcher registration succeed.
- [x] 6.3 Roll back pane, attached-region row, scripts/artifacts/sidecars, leases, and capacity exactly once on every pre-running failure.
- [x] 6.4 Make cleanup close idempotent: already-absent pane is cleaned, region/lease/slot cleanup continues, and the original terminal outcome is preserved.
- [x] 6.5 Define direction conflict and `layout: single` isolation; update attached geometry/min-size behavior for up to five active children.
- [x] 6.6 Failure-injection tests: validation, split, missing pane ID, script write, pane run, watcher registration, manual close, and rollback followed by next queued admission.

## 7. Deterministic settlement and delivery

- [x] 7.1 Add atomic settlement claim and deterministic sidecar/sentinel/disappearance precedence with bounded grace, run ownership checks, and malformed/stale sidecar handling.
- [x] 7.2 Preserve nonzero/error outcome over stale JSONL text and report successful exits with no current assistant text explicitly.
- [x] 7.3 Mark async delivery complete only after parent API acceptance; retain bounded pending retry state on failure and prevent duplicate delivery across watchers/reload.
- [x] 7.4 Add a foreground delivery barrier covering queued and active foreground calls; hold background completion, stall/recovery, and async-ping notifications while returning a blocking ping through its suspended tool call.
- [x] 7.5 Return foreground result first, retain the barrier across multiple queued foreground calls, clear it when the last foreground run settles (including by ping), then flush held messages in settlement order with one parent wake-up; treat every later resume as background-class work.
- [x] 7.6 Define reload loss of blocking continuation: suppress replacement steer, reap child, release foreground slot; transfer async ownership exactly once.
- [x] 7.7 Define final shutdown: cancel queues, abort active watchers, idempotently close panes, suppress pending delivery, and release all leases/slots.
- [x] 7.8 Unit/integration-test simultaneous background completions and async/blocking pings during foreground work, ping/resume class transition, delivery API failure/retry, reload races, malformed channels, and exactly-once cleanup.

## 8. Status, docs, and migrations

- [x] 8.1 Extend the human widget with foreground/background class, stable run IDs, queued state/counts, duplicate-label disambiguation, and permission `blocked` distinct from unhealthy `stalled`; do not add a model-facing status/list tool.
- [x] 8.2 Rewrite package README, change README, CHANGELOG, tool descriptions, prompt snippets, examples, and `AGENTS.md` guidance for explicit agents, body-only identity prompts, model/thinking inheritance, minimal schema, queues, progressive skills, and blocking-ping-to-background-resume behavior.
- [x] 8.3 Remove stale claims/examples for bare agents, `subagents_list`, `enabled`, per-call profile overrides, eager skills, four-child-only layout, and completed permission smoke.
- [x] 8.4 Update example agent files to the final schema without making them auto-discovered defaults; mark illustrative agent names clearly and do not imply that names absent from the user's global/project directories are installed.

## 9. Final verification

- [x] 9.1 Run type-check/lint and the full unit suite with strict agent, skills, queues, leases, rollback, permission, and delivery tests.
- [x] 9.2 Run real-Herdr matrix: one foreground plus four background, queued overflow in both classes, external abort of a queued blocking call, five-pane/tab layout, duplicate labels/run-ID presentation, manual close, interrupt, blocking/async ping and background resume, and empty-region reset.
- [x] 9.3 Run real permission-system matrix with trusted/global agents: deny/ask, active-agent policy, parent agent-root inheritance, hidden parent tools, mixed and all-manual-only selected skills (including absent `<available_skills>` creation), denied/ask skill, path-gated resume, and identity continuity.
- [x] 9.4 Refresh smoke/integration/permission notes with actual commands and outcomes; reopen or correct historical checkboxes whose notes recorded pending work.
- [x] 9.5 Run `openspec validate add-pi-subagent-herdr --strict` and reconcile every artifact with the final tool schema and behavior.

## Out-of-scope follow-ups

Optional extension-owned blocking/queue timeout (external harness/provider deadlines remain an acknowledged v1 risk); perfect layout rebalance; worktree isolation; durable recovery after full process restart; upstream synchronization and publication workflow.
