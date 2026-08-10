# Proposal: pi-subagent-herdr

## Why

Pi users working inside Herdr need explicitly configured subagents that run visibly beside the parent, return results reliably, and operate under their own defined permission boundaries. The current fork has useful pane and completion machinery, but its permissive bare-agent API, model-facing agent listing, eager skill expansion, and unbounded concurrency do not provide the small, deterministic delegation surface required here.

## What Changes

- **BREAKING — explicit agents only:** `subagent.agent` is required. A spawn resolves a user-owned definition from trusted `<cwd>/.pi/agents/<agent>.md` first, then `${PI_CODING_AGENT_DIR}/agents/<agent>.md` (default `~/.pi/agent/agents/<agent>.md`). There are no bare, bundled, generated, or default agents and no fallback when resolution fails.
- **BREAKING — minimal parent tool surface:** keep only `subagent`, `subagent_interrupt`, and `subagent_resume`; remove `subagents_list`. Users describe available agents and routing in their own `AGENTS.md`. The human-only status widget continues to show queued and running work.
- **BREAKING — agent-owned execution profile:** remove per-call `name`, `model`, `thinking`, `tools`, `skills`, `systemPrompt`, and `fork`. The canonical agent file controls identity, tool visibility, skills, and `seed`; its Markdown body is the sole agent-authored identity prompt. Declared `model`/`thinking` values are authoritative, while omitted values inherit the parent runtime. Obsolete `system-prompt` frontmatter fails validation before queueing. An optional per-call `label` affects presentation only.
- **Child tool invariant in code:** child processes never register or receive parent lifecycle tools. The only subagent-extension tools available in a child are `subagent_done` and `caller_ping`, regardless of user permission configuration. `@gotgenes/pi-permission-system` may narrow this surface but cannot widen it.
- **Bounded foreground/background execution:** per parent session, run at most one blocking foreground subagent and four async background subagents. Valid excess calls enter FIFO foreground/background queues instead of failing. Validation happens before queueing; pane/session/artifact creation happens only after admission.
- **Progressive-disclosure skills:** an agent's comma-separated `skills:` is an explicit child-only visibility allowlist. Selected skills contribute only standard name/description/location metadata to the child system prompt; they are not eagerly invoked or expanded. Explicit selection overrides the selected skill's `disable-model-invocation: true` visibility for that child, creating a standard `<available_skills>` container when Pi would otherwise omit it. The explicitly loaded child companion performs this transform before normally discovered permission-system sanitization and fails closed if ordering cannot be guaranteed; permission-system `skill`, `path`, and `external_directory` gates remain authoritative. Missing or ambiguous skill names fail before queueing.
- **Permission-system compatibility:** bind a canonical, validated agent identity to the resolved file and persisted session metadata; inject that identity through `<active_agent>` on spawn and resume; inherit the parent's exact Pi agent directory; preserve `PI_SUBAGENT_PARENT_SESSION`; expose `permission:` as a reserved compatibility key consumed by `@gotgenes/pi-permission-system`; and make resume paths visible to path gating.
- **Deterministic lifecycle:** prevent concurrent resumes of one session, make launch rollback transactional, make cleanup idempotent, define completion-channel precedence and exactly-once delivery, preserve queues/leases/layout across `/reload`, and defer background steers while a parent turn is suspended by foreground work. A blocking `caller_ping` settles that foreground run; any later resume is new background-class work and may queue behind other background runs.
- Keep real Pi subprocesses in visible Herdr panes, attached-stack layout, tab/single overrides, completion extraction, widget/watchdog, `caller_ping`, resume/interrupt, classified pane retry, and close-on-settlement.
- Remain Pi-only and remove the upstream slash commands and Claude backend.

## Capabilities

### New Capabilities

- `subagent-dispatch`: Strict named-agent resolution, minimal tools, foreground/background admission queues, child tool isolation, session resume identity, and progressive-disclosure skills.
- `pane-surface`: Visible Herdr pane creation, attached-stack geometry, transactional launch, and idempotent pane lifecycle.
- `completion-delivery`: Completion detection and exactly-once async/blocking delivery, including foreground delivery barriers and reload/shutdown behavior.

### Modified Capabilities

None; this repository has no archived baseline capabilities yet. The capability files in this change are pre-archive planning artifacts and are intentionally being redefined in place.

## Impact

- **Model-facing API:** smaller `subagent` schema; `subagents_list` removed; no bare/default launch path.
- **Agent files:** user-owned definitions only; project definitions require project trust; filename stem is canonical identity; the Markdown body supplies identity instructions; omitted model/thinking inherit the parent runtime; `permission:` composes with `@gotgenes/pi-permission-system`.
- **Skills:** current eager `/skill:<name>` launch prompts are removed in favor of selected metadata plus on-demand reads/invocation.
- **Runtime:** a per-parent admission coordinator, session leases, queued delivery arbiter, launch rollback, and stable run IDs for disambiguating duplicate presentation labels are added.
- **Compatibility:** no hard dependency on `@gotgenes/pi-permission-system`; behavior composes through its documented subprocess, active-agent, prompt-sanitization, and path-gating contracts.
- **Migration:** users must list/route agents in `AGENTS.md`, pass `agent`, move execution-profile choices into agent files, and place agent identity instructions in each definition's Markdown body rather than a `system-prompt` frontmatter field.
