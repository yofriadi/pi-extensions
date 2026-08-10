# Design: pi-subagent-herdr

## Context

The fork already runs each child as a real Pi process in a visible Herdr pane and has attached layout, completion polling, result extraction, a widget, and async/blocking delivery. This revision makes delegation explicit and bounded: the parent model selects only a user-authored agent, the agent file owns its execution profile, skills use progressive disclosure, child lifecycle tools are hard-gated in code, and admission/delivery are deterministic under concurrency.

The extension has no code dependency on `@gotgenes/pi-permission-system`. It composes through documented contracts: canonical `<active_agent>` identity, the same Pi agent root in parent and child, `PI_SUBAGENT_PARENT_SESSION`, ordinary tool registration, standard `<available_skills>` metadata, and conventional path-bearing tool input.

## Goals / Non-Goals

**Goals:**

- One active foreground blocking run and up to four active background runs per parent session, with FIFO queueing instead of capacity errors.
- Strict resolution of user-owned agents; no bare/default/generated agent and no model-facing agent-list tool.
- Minimal tool schemas: agent files, not per-call arguments, control tools, skills, seed, and identity prompt; declared model/thinking values are authoritative and omitted values inherit the invoking parent runtime.
- Only `subagent_done` and `caller_ping` from this extension are available inside children.
- Skills are advertised by metadata and loaded on demand, including explicitly selected manual-only skills.
- Permission identity, path, project-trust, skill, and resume behavior compatible with `@gotgenes/pi-permission-system`.
- Transactional launch, exclusive session resume, idempotent cleanup, and exactly-once delivery.

**Non-Goals:**

- Built-in agent definitions, agent generation, or instructions that tell the model to create agents after an error.
- A model-facing list of available or running agents; users maintain routing in `AGENTS.md`, and humans use the widget for runtime state.
- Nested subagent trees, worktrees, durable process-restart recovery, a general orchestration kernel, or a balanced grid.
- Eager skill invocation, preloading full skill bodies, or bypassing permission-system policy.
- Claude, tmux, SDK, or headless backends.

## Decisions

### 1. Strict canonical agent resolution

`subagent.agent` is required. The canonical ID is a validated filename stem, used consistently for lookup, `<active_agent>`, environment metadata, widget/result identity, persisted session metadata, definition-owned model routing, and resume.

Lookup order is:

1. Trusted project definition: `<cwd>/.pi/agents/<id>.md`.
2. Global definition: `${PI_CODING_AGENT_DIR}/agents/<id>.md`, where Pi's default agent directory is `~/.pi/agent`.

A project definition is ignored when `ctx.isProjectTrusted()` is false, matching permission-system project-agent policy loading. An omitted or unresolved ID returns a concise error such as `Unknown subagent "<id>".` It does not suggest creating or editing a definition. Validation completes before queue admission and before writing any session, artifact, sidecar, or pane resource.

The ID grammar rejects separators, traversal, quotes, markup, controls, and ambiguous Unicode. If frontmatter `name` is retained as an optional assertion, it must equal the filename stem. Project/global definitions with the same canonical ID follow the precedence above; there is no package/examples tier.

Agent-owned frontmatter is `name` (optional assertion), `model` (optional), `thinking` (optional), `tools`, `skills`, and `seed`. The Markdown body is the sole agent-authored identity prompt; obsolete `system-prompt` frontmatter is a validation error before queueing rather than being ignored or applied. When `model` or `thinking` is omitted, the effective value inherits from the parent runtime invoking that launch or resume; a declared value remains authoritative and no caller argument may override either value. `permission:` is a reserved compatibility key consumed only by `@gotgenes/pi-permission-system` and is preserved untouched. There is no agent `enabled` or agent-level model-discovery behavior because there is no listing/discovery tool. Skill-level `disable-model-invocation` remains a separate supported skill concept.

### 2. Minimal model-facing API

Parent tools:

| Tool | Purpose |
|---|---|
| `subagent` | Required `agent` and `task`; optional presentation-only `label`, `blocking`, `layout`, `surface`, and `direction` |
| `subagent_interrupt` | Send Escape to an active child turn after existence checks |
| `subagent_resume` | Resume an owned session using path, optional message/label, and surface options |

`subagents_list` is removed. `subagent` does not expose `name`, `model`, `thinking`, `tools`, `skills`, `systemPrompt`, `fork`, `cwd`, `interactive`, or `autoExit`. Run display defaults to canonical agent ID; `label` never affects identity, permissions, lookup, capacity, or session ownership. Every run also has a stable internal run ID, and human/result presentation includes that ID wherever equal labels or repeated runs would otherwise be ambiguous; labels need not be unique.

`subagent_resume` uses a conventional `path` parameter rather than `sessionPath`, allowing permission-system `path` and `external_directory` gates to inspect and canonicalize it without a package dependency.

### 3. Child tool invariant

When `PI_SUBAGENT_ID` is present, the main extension does not register `subagent`, `subagent_interrupt`, or `subagent_resume`. Every child launch also puts these parent tools in the hard deny environment as defense in depth. `subagents_list` does not exist.

The child companion extension registers only:

- `subagent_done`: finish and write a done sidecar.
- `caller_ping`: write a help sidecar and exit so the parent can answer through resume.

The agent `tools:` allowlist is authoritative and cannot be widened per call. Launch construction adds the two child control tools so the protocol remains operable; `@gotgenes/pi-permission-system` can still deny either tool. No permission configuration can restore hidden parent tools.

### 4. Progressive-disclosure skill selection

`skills:` is a comma-separated ordered allowlist owned by the agent definition. Normalize whitespace, reject empty names, reject duplicates, and resolve every name using Pi's skill resource loader with the parent's exact agent directory, cwd, package/settings paths, and project-trust state. A missing skill or more than one matching skill is a validation error before queueing; no first-wins behavior is used.

The child launches with skill discovery disabled and each resolved canonical skill path supplied explicitly (conceptually `--no-skills --skill <path> ...`). Thus only selected skills are loaded into the child resource set. Remove the current initial `/skill:<name>` prompt generation.

Pi normally omits a skill with `disable-model-invocation: true` from `<available_skills>`. Here, listing it in an agent's `skills:` is an explicit, child-scoped visibility grant. The explicitly loaded child companion extension assembles selected resources as standard XML skill entries containing only escaped name, description, and canonical location inside the child prompt's single `<available_skills>` section; Pi's explicit-extension precedence ensures this transform runs before normally discovered extensions such as the permission system. If Pi emitted no section because every selected skill is manual-only (or no ordinary selected skill produced one), create the standard container; do not append orphan `<skill>` nodes or create duplicate containers. If ordering cannot be guaranteed or verified, launch fails closed before the task is sent. Do not alter the skill file or preload its body. The full `SKILL.md` is read or `/skill:name` is expanded only when the child chooses it while handling the task.

Permission-system compatibility is preserved: after the companion metadata transform, before-agent-start sanitization removes `permission.skill: deny` entries; skill-input gates govern `/skill:name`; skill-read gates govern the selected `SKILL.md` and its directory; `path` and `external_directory` gates continue to compose. Selection overrides visibility only, never permission.

### 5. Permission identity and session ownership

The child inherits the parent's exact Pi agent directory; it is never replaced with `<cwd>/.pi/agent`. Every named child gets one XML-escaped `<active_agent name="<canonical-id>"/>` in its assembled system prompt, followed by the definition's Markdown body as the agent-authored identity instructions. `PI_SUBAGENT_PARENT_SESSION` is unconditional subprocess lineage metadata; direct TTY asks normally render in the child pane, while the variable supports permission-system forwarding if a no-UI path occurs.

Initial launch writes an owner-only, versioned metadata sidecar associated with the session JSONL containing canonical agent ID and ownership information. Resume canonicalizes and permission-gates `path`, requires owned metadata, recovers agent identity rather than trusting caller input, resolves the same agent definition, and rejects identity mismatch or missing ownership. At most one active/queued run may hold a lease for a canonical session path.

### 6. Foreground/background admission and queues

Capacity is scoped per parent session:

- foreground class: `subagent(blocking: true)`, maximum one active;
- background class: async `subagent` and `subagent_resume`, maximum four active.

Validation precedes queue insertion. Each class has a FIFO queue so foreground work is not blocked behind background work or vice versa. A valid async call returns a queued acknowledgement immediately when no background slot is free; a watcher launches it later and delivers its result normally. A valid blocking call remains suspended while queued, then launches when the foreground slot is free. Multiple simultaneous blocking calls are therefore serialized, not rejected. The extension adds no arbitrary queue timeout; cancellation/abort signals remove a queued call before admission, while external harness/provider tool-call deadlines may still terminate a long-waiting suspended call.

Admission is atomic. Queued entries do not create sessions, artifacts, sidecars, panes, or child processes. A slot is acquired immediately before transactional launch and held through settlement, cleanup, and delivery bookkeeping. Interrupt does not release it. Completion, failure, cancellation, pane disappearance, caller ping, launch rollback, or shutdown releases exactly once and admits the next FIFO entry. A `caller_ping` from a blocking child settles that foreground run and returns the help request plus resumable path through the suspended tool call; a later `subagent_resume` is a new background-class entry subject to the four-run limit and FIFO queue.

Coordinator state, including active counts, queues, session leases, and launch ownership, lives under fork-specific `Symbol.for("pi-subagent-herdr/*")` keys so `/reload` reuses it rather than double-admitting. Final shutdown cancels queued work, aborts active watchers, closes panes idempotently, suppresses pending deliveries, and releases leases.

### 7. Transactional launch and pane layout

Launch states are `queued → admitted → pane allocated → script accepted → watcher registered → running`. A started acknowledgement is truthful only after `pane run` succeeds and the watcher/runtime row is installed. Failure before that point rolls back the pane/region row, temporary launch resources, lease, and slot exactly once.

Attached layout keeps the parent on one side and stacks children on the inverse axis. `direction:right` splits the caller right, then splits the tallest child-region pane down; `direction:down` splits the caller down, then splits the widest child-region pane right. Geometry is preferred; durable split depth and insertion order are the fallback. The layout must handle the full five-active-run shape; minimum-size checks may place an admitted run in a tab.

Pane control uses `pane get` first. A missing pane before an interactive control is an operation error, but cleanup close is idempotent: already absent counts as cleaned. The original terminal outcome is not overwritten by a cleanup-close error. Region state is reaped/reset and survives `/reload`.

### 8. Completion and delivery arbiter

Completion channels are sidecar, terminal sentinel, and pane disappearance. Settlement is atomically claimed once. A valid sidecar wins when observed in the same poll; sentinel and disappearance receive a bounded sidecar grace. Nonzero exit/error state cannot be masked by stale assistant text. Cleanup, slot release, and delivery happen exactly once.

Blocking completion—including a blocking child's `caller_ping`—returns only as its tool result. Async completion and async `caller_ping` normally send a `subagent_result` or ping notification with steer delivery. While any parent turn is suspended on queued or active foreground work, background completion, stall/recovery, and async-ping notifications are held by a delivery barrier. The foreground result returns first; held messages are flushed in settlement order with one parent wake-up. A delivery is marked delivered only after the parent API accepts it; failed delivery remains terminal/pending under a bounded retry policy instead of being silently removed. Resuming a session after a blocking ping does not restore foreground status: it enters the background class and may queue.

`/reload` transfers async watchers/delivery to the latest API without duplication. The known limitation remains that an in-flight blocking tool result cannot be reconstructed after reload; its child is nevertheless reaped, its result is suppressed rather than converted to an async steer, and its foreground slot is released.

## Risks / Trade-offs

- **User `AGENTS.md` can become stale** → unknown agents fail concisely; no model-facing list is added.
- **Queued blocking calls can exceed external tool-call deadlines** → the extension applies no arbitrary internal timeout, exposes queue status to humans, and removes queued entries on observed abort/shutdown; a harness/provider that terminates a suspended tool call may still cancel the wait before admission. An optional explicit blocking timeout remains post-v1.
- **Five attached panes can become small** → deterministic minimum-size fallback opens a tab.
- **Manual-only skill visibility is overridden for selected children** → override is explicit in the user-owned agent file, metadata-only, and still subject to all permission gates.
- **Custom hidden-skill metadata must remain compatible with Pi XML** → render one standard `<available_skills>` container (creating it when absent), inject before permission sanitization, and test both all-manual-only and mixed selected-skill sets against the real permission system.
- **Reload cannot restore a suspended tool call** → suppress replacement steer, reap resources, and document the limitation.
- **No list tool reduces dynamic discovery** → deliberate; users own routing in `AGENTS.md` and the extension introduces only mandatory controls.

## Migration Plan

1. Remove `subagents_list`, bare launches, bundled/default resolution, and per-call execution-profile fields.
2. Add strict agent/skill validation, body-only agent prompts with explicit model/thinking inheritance, canonical session metadata, permission-compatible path and agent-root handling.
3. Replace eager skill prompts with a single selected-resource metadata section, including absent-container creation for manual-only selections, and on-demand invocation.
4. Add admission queues, session leases, delivery barrier, transactional rollback, and reload/shutdown ownership.
5. Update docs/examples and rerun unit, real-Herdr, and real permission-system matrices.

## Open Questions

None; the user confirmed the agent API, skills semantics, ambiguity failures, trust behavior, queueing, and delivery ordering.
