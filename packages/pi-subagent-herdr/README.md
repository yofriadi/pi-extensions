# pi-subagent-herdr

Run explicit, user-authored Pi agents in visible Herdr panes. Calls are asynchronous by default or can await a foreground result with `blocking: true`.

Fork of [`0xRichardH/pi-herdr-subagents`](https://github.com/0xRichardH/pi-herdr-subagents) at `d654eae7` (MIT), but designed around [`gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) and actually replacement I made for [`gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) because it does not show the subagent in upfront, it use widget instead and I can't steer it manually.

## Requirements

- Pi ≥ 0.81
- Herdr with `pane layout` support
- `HERDR_ENV=1` and `herdr` on `PATH`

## Install

```bash
pi install ./packages/pi-subagent-herdr
# pi install npm:pi-subagent-herdr  # once published
```

## Define agents

There are no bundled/default agents and no model-facing list tool. Define routing in your `AGENTS.md`, and place each definition at one of:

1. trusted project `<cwd>/.pi/agents/<id>.md`;
2. `${PI_CODING_AGENT_DIR}/agents/<id>.md` (default `~/.pi/agent/agents/<id>.md`).

A trusted project definition wins over the global definition. The filename stem is the canonical ID. Optional frontmatter `name` must match it.

```markdown
---
name: reviewer
model: provider/model       # optional; omitted means inherit parent
thinking: high              # optional; omitted means inherit parent
tools: read,grep
skills: code-review, colgrep
seed: fresh                 # fresh (default) or fork
permission:                 # preserved for pi-permission-system
  bash: deny
---
You are a focused reviewer. Report correctness and security issues.
```

Owned keys are `name?`, `model?`, `thinking?`, `tools`, `skills`, and `seed`. The Markdown body is the sole agent-authored identity prompt. Obsolete `system-prompt` is rejected. Legacy `enabled`, `interactive`, `auto-exit`, `cwd`, spawning/deny fields, and per-call profile overrides are not part of this API.

## Use

```text
subagent({ agent: "reviewer", task: "Review the authentication changes" })
subagent({ agent: "reviewer", task: "Review before I continue", blocking: true })
subagent({ agent: "reviewer", label: "auth-review", task: "Review auth" })
```

`agent` and `task` are required. `label` is presentation-only; permissions, tools, skills, model routing, ownership, and resume remain bound to the canonical agent ID and stable run ID.

### Parent tools

| Tool | Parameters |
|---|---|
| `subagent` | required `agent`, `task`; optional `label`, `blocking`, `layout`, `surface`, `direction` |
| `subagent_interrupt` | active run `id` or unambiguous display `name` |
| `subagent_resume` | owned session `path`; optional `message`, `label`, `layout`, `surface`, `direction` |

Children never receive those parent lifecycle tools. This extension exposes only `subagent_done` and `caller_ping` inside children and hard-denies the parent tools as defense in depth.

## Capacity and delivery

Each parent session has independent FIFO classes:

- foreground: one active `subagent(blocking: true)`; excess calls remain suspended;
- background: four active async spawns/resumes; excess calls return a truthful queued acknowledgement and launch later.

Queued work creates no pane, session, script, or artifact. Foreground work creates a delivery barrier: background results, pings, and status notifications wait until all queued/active foreground calls settle. A blocking `caller_ping` returns through its tool call; resuming its owned path is new background work.

Sessions carry owner-only metadata with canonical identity. Resume accepts `path`, canonicalizes it, validates ownership, and rejects concurrent aliases through an exclusive session lease.

## Progressive skills

`skills:` is an ordered comma-separated selection. Names are validated with Pi's effective resource loader before admission. Children start with general discovery disabled and only selected canonical resources supplied. Startup advertises escaped name/description/location metadata in one `<available_skills>` section—never full `SKILL.md` bodies. Full content is read or expanded on demand. Explicit selection makes manual-only metadata visible but does not bypass permission skill/path/external-directory gates.

## Layout

Attached layout is default:

- `direction: right`: first split right; then stack down on the tallest region pane;
- `direction: down`: first split down; then stack right on the widest region pane;
- `layout: single`: isolated caller split;
- `surface: tab`: explicit tab;
- undersized geometry or a conflicting nonempty attached direction falls back to an isolated tab with a warning.

The layout supports one foreground plus four background panes. Region/coordinator/lease state uses `pi-subagent-herdr/*` process-global symbol keys across `/reload`.

## Runtime lifecycle and recovery

Background delivery uses only a session-bound, active completion API:

- The extension factory registers tools/handlers only. Pi binds action methods at `session_start`, which is the sole activation boundary; a discovery-only factory evaluation (e.g. selected-skill validation) can never publish or replace the active delivery API.
- Selected-skill validation resolves ordinary project/global/package skills with extension execution disabled, so it never runs a configured extension factory and never mutates the live parent runtime.
- A completion settling during the reload gap (between `session_shutdown` and the replacement `session_start`) stays pending as `awaiting runtime` in the widget, consumes no ordinary send attempts, and is delivered once the replacement session activates. Retry scheduling is an owner-neutral process-global service: it survives reload gaps and can be started by a pre-reload watcher after replacement activation. Deferral is bounded by a one-hour budget even if no replacement session ever activates; past it the entry is marked undeliverable with the cause recorded.
- Status/recovery notifications are best-effort: while no matching session-bound runtime is active they are dropped, never queued or retried.

## Permission-system composition

There is no code dependency on `@gotgenes/pi-permission-system`. Integration contracts are:

1. exactly one escaped `<active_agent name="<canonical-id>"/>` plus the agent Markdown body;
2. the parent's exact `PI_CODING_AGENT_DIR` is preserved on spawn and resume;
3. `PI_SUBAGENT_PARENT_SESSION` is unconditional; direct child-TTY `ask` dialogs render in the child pane, while no-UI forwarding can use lineage metadata;
4. ordinary `path`, skill, and external-directory gates still inspect resume and selected skill resources.

## Defaults

No package `config.json` is required or shipped. Runtime defaults are code-owned:

- **Status** is always enabled (aggregated widget + capped transition steers).
- **Spawn class** is background/async unless you pass `blocking: true`.
- **Layout** defaults: `attached`, `surface: pane`, `direction: right` (first split right, then stack down). Override per call with `layout` / `surface` / `direction` when needed.
- **Model** selection is agent-owned (`model:` / `thinking:` frontmatter). Omitted values inherit the parent runtime. There is no package model map.

If you still have a local package `config.json`, delete it — leftover keys are inert.

Environment controls: `PI_SUBAGENT_SHELL_READY_DELAY_MS`, `PI_SUBAGENT_HERDR_PANE_RETRIES`, `PI_TEST_MODEL`, and `PI_TEST_TIMEOUT`.

## Attribution

MIT. Upstream © HazAT / 0xRichardH. This fork adds strict named agents, bounded foreground/background admission, progressive skills, owned resume, transactional panes, and deterministic delivery.
