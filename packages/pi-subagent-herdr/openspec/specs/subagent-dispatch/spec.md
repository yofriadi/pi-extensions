# Capability: subagent-dispatch

## Purpose

LLM-facing tools for running explicitly configured Pi subagents in Herdr panes, with strict identity, bounded foreground/background admission, isolated child controls, and progressive-disclosure skills.

## Requirements

### Requirement: explicit named subagent tool

The extension SHALL register `subagent` with required `agent` and `task`, and optional `session`.
It SHALL NOT support a bare or default agent.
It SHALL resolve the canonical agent definition before queue admission and derive display identity from the canonical ID unless an optional presentation-only `label` is supplied.
When optional `session` is supplied, the extension SHALL validate it as an owned existing subagent session file — existing regular file under the invoking parent's child-sessions directory, header `subagentOwner.parentSessionId` equal to the invoking parent session and `subagentOwner.agentId` equal to the resolved canonical agent, and not held by a live session lease — before queue admission, and SHALL target that session file instead of generating a new one.

#### Scenario: named async spawn

- **WHEN** the model calls `subagent({ agent: "reviewer", task })` and the definition is valid
- **THEN** the call is admitted or queued as background work and eventually launches that exact agent

#### Scenario: missing agent

- **WHEN** the model calls `subagent` without `agent`
- **THEN** validation fails with a concise required-agent error before queueing or creating resources, without instructions to create or edit an agent

#### Scenario: unknown agent

- **WHEN** `agent` does not resolve to a valid definition
- **THEN** validation fails with `Unknown subagent "<id>".` before queueing or creating resources, with no fallback and no creation guidance

#### Scenario: blocking result

- **WHEN** a valid call sets `blocking: true` and eventually settles
- **THEN** its final assistant text blocks (excluding thinking/tool blocks) return as the tool result and no completion steer is sent

#### Scenario: resume existing session via session parameter

- **WHEN** a valid call supplies `session` with a path to an owned existing subagent session file
- **THEN** the launch command invokes `pi` targeting that session file with the agent's standard launch configuration, continuing the session with existing history preserved

#### Scenario: ungated resume target rejected

- **WHEN** `session` names a nonexistent path, a path outside the invoking parent's child-sessions directory, a session whose header records a different `subagentOwner.parentSessionId` or `subagentOwner.agentId`, or a session held by a live lease
- **THEN** validation fails with a concise error before queue admission, and no pane, session, lease, or admission state is created

#### Scenario: failed launch preserves the pre-existing session

- **WHEN** a launch fails after validation — whether the session was caller-supplied or retained from a previous attempt of the same run
- **THEN** the launch rollback never deletes the pre-existing session file, its companion directory, or their provenance — only artifacts the launch itself created

### Requirement: canonical user-owned agent resolution

The extension SHALL resolve definitions only from trusted `<cwd>/.pi/agents/<canonical-id>.md` and `${PI_CODING_AGENT_DIR}/agents/<canonical-id>.md` (Pi default `~/.pi/agent/agents`).
A trusted project definition SHALL override the global definition.
Package examples, bundled definitions, generated definitions, and unrelated directories SHALL NOT participate.
The canonical ID SHALL be a validated filename stem and SHALL bind lookup, prompt tag, definition-owned model routing, permission identity, and session provenance for initial dispatch.
The canonical ID SHALL NOT by itself authorize a model-facing resume operation; resumption of an existing subagent session SHALL occur only through the explicit ownership-gated `session` parameter defined in `explicit named subagent tool`, never through implicit metadata-derived resume.

#### Scenario: trusted project override

- **WHEN** trusted project and global definitions share a canonical ID
- **THEN** the project definition is used

#### Scenario: untrusted project definition

- **WHEN** the project is untrusted and only a project definition exists
- **THEN** the project definition is ignored and the call fails as unknown without suggesting a trust or file change

#### Scenario: unsafe identity

- **WHEN** an agent ID contains traversal, separators, quotes, markup, controls, or otherwise violates the canonical grammar
- **THEN** validation rejects it before filesystem access or `<active_agent>` construction

#### Scenario: frontmatter identity mismatch

- **WHEN** optional frontmatter `name` differs from the filename stem
- **THEN** the definition is invalid and cannot be queued or launched

#### Scenario: foreign parent session rejected

- **WHEN** a `session` target resolves but its header records a `subagentOwner.parentSessionId` other than the invoking parent session
- **THEN** resumption is refused before queue admission, and canonical-ID resolution alone grants no resume authority

### Requirement: minimal subagent call schema

The `subagent` tool SHALL NOT expose per-call `name`, `model`, `thinking`, `tools`, `skills`, `systemPrompt`, `fork`, `cwd`, `interactive`, `seed`, or `autoExit`.
The agent definition SHALL own tools, skills, identity instructions, and optional model/thinking, and SHALL NOT support a `seed` frontmatter option; its presence SHALL fail validation before queueing rather than being silently ignored.
Its Markdown body SHALL be the sole agent-authored identity prompt; obsolete `system-prompt` frontmatter SHALL fail validation before queueing.
The child SHALL receive that identity as its whole system prompt (an explicit prompt source), not as text appended to a discovered one, so a parent's operator-authored `SYSTEM.md` and the tool surface it states are never inherited.
The launch SHALL also claim the append slot explicitly, so a parent's `APPEND_SYSTEM.md` is not discovered and appended to the child.
Declared `model`/`thinking` values SHALL be authoritative, while omitted values SHALL inherit the invoking parent runtime.
Package-level model maps (`models.default`, `models.agents`) and other package `config.json` keys SHALL NOT participate in routing or defaults.
Optional `label` SHALL affect presentation only.
Optional `session` SHALL specify a path to an owned existing subagent session file for resumption.
Optional `blocking` SHALL default to false (background) when omitted.
Optional `layout`, `surface`, and `direction` remain per-call overrides only—not package-configurable.

#### Scenario: schema inspection

- **WHEN** the registered `subagent` parameter schema is inspected
- **THEN** it contains required `agent` and `task`, optional `session`, `label`, `blocking`, `layout`, `surface`, and `direction`, and none of the removed execution-profile fields

#### Scenario: label does not change authority

- **WHEN** a call supplies `label: "auth-flow"` for agent `reviewer`
- **THEN** pane/widget/result presentation may use the label while permissions, skills, tools, session provenance, and routing remain bound to `reviewer`

#### Scenario: omitted model and thinking inherit

- **WHEN** a valid agent definition omits `model` or `thinking`
- **THEN** the omitted value inherits from the parent runtime invoking the launch, while any declared value is used and cannot be overridden per call or package config

#### Scenario: package model config is ignored

- **WHEN** a package-root `config.json` or `config.json.example` defines `models.default` or `models.agents`
- **THEN** launch resolves model only from agent frontmatter or parent inheritance and does not load those package keys

#### Scenario: omitted blocking is background

- **WHEN** a valid call omits `blocking`
- **THEN** the call is classified as background/async work and does not wait for a tool-result barrier

#### Scenario: Markdown body is the identity prompt

- **WHEN** a valid agent definition is assembled for launch
- **THEN** its Markdown body supplies the sole agent-authored identity instructions and no duplicate identity prompt is applied

#### Scenario: parent operator prompt is not inherited

- **WHEN** a child is launched while the parent runs an operator-authored system prompt discovered from the Pi agent directory (`SYSTEM.md`)
- **THEN** the launch passes the child's identity file as an explicit system-prompt source, so the parent's prompt and the tool surface it states do not appear in the child's prompt

#### Scenario: parent append-prompt is not inherited

- **WHEN** a child is launched while an `APPEND_SYSTEM.md` is discoverable from the inherited Pi agent directory
- **THEN** the launch claims the append slot explicitly, so that file is not discovered and no parent-authored text is appended to the child's identity

#### Scenario: obsolete system-prompt frontmatter fails

- **WHEN** an agent definition contains `system-prompt` frontmatter
- **THEN** validation fails before queueing or resource creation rather than silently ignoring or applying it

#### Scenario: obsolete seed frontmatter fails

- **WHEN** an agent definition contains `seed` frontmatter with value `fresh` or `fork`
- **THEN** validation fails before queueing with a migration-style error stating subagents always start fresh, rather than silently downgrading the definition

#### Scenario: repeated labels remain distinguishable

- **WHEN** concurrent or historical runs use the same canonical agent ID and label
- **THEN** permissions and ownership remain canonical-ID-bound while human/result presentation includes a stable internal run ID where needed to disambiguate them

### Requirement: foreground and background admission queues

Per parent session, the extension SHALL run no more than one foreground blocking run and four background runs.
A `subagent` call enters the foreground class only when `blocking: true` is explicitly supplied; omitted or false `blocking` calls belong to the background class.
No package config SHALL change that default.
Valid excess calls SHALL wait in separate FIFO queues rather than fail.
Validation SHALL occur before queue insertion; queued entries SHALL create no session, artifact, sidecar, pane, or child process.

#### Scenario: one foreground plus four background

- **WHEN** one blocking call and four background calls are active
- **THEN** all five may run concurrently and no additional run is admitted

#### Scenario: second blocking call queues

- **WHEN** a blocking call arrives while another foreground run is active
- **THEN** the new call remains suspended in the foreground FIFO and launches after the active foreground slot is released

#### Scenario: fifth background call queues

- **WHEN** a fifth asynchronous `subagent` call arrives while four background runs are active
- **THEN** it returns a queued acknowledgement and launches in FIFO order when a background slot opens

#### Scenario: default spawn is background

- **WHEN** a valid `subagent` call omits `blocking` while background capacity remains
- **THEN** it is admitted or queued as background work without a package-config override path

#### Scenario: invalid call never queues

- **WHEN** agent or skill validation fails while capacity is full
- **THEN** the call fails immediately and does not enter either queue or create resources

#### Scenario: queued blocking call is externally aborted

- **WHEN** the parent harness or provider aborts a suspended blocking tool call before admission
- **THEN** its foreground queue entry is cancelled without resource creation and it cannot launch later, while the extension itself imposes no arbitrary queue timeout

#### Scenario: exactly-once slot release

- **WHEN** a run completes, fails, is cancelled, loses its pane, rolls back launch, or is shut down
- **THEN** its slot and leases release exactly once and the next valid entry in that class is admitted

### Requirement: agent-owned progressive-disclosure skills

The extension SHALL read only plural `skills:` from the resolved agent definition as an ordered comma-separated allowlist.
It SHALL normalize and validate every name, reject duplicate entries, resolve each name against Pi's effective skill resources, and fail before queueing if a name is missing or has multiple matches.
It SHALL restrict the child resource set to selected canonical skill paths and SHALL NOT synthesize initial `/skill:<name>` prompts.
An explicitly loaded child companion SHALL advertise selected metadata inside exactly one standard `<available_skills>` container, created when absent, before normally discovered permission-system sanitization runs.
Launch SHALL fail closed before task submission if this ordering cannot be guaranteed or verified.

#### Scenario: multiple selected skills are metadata only

- **WHEN** an agent declares `skills: colgrep, code-review`
- **THEN** only those selected skills' name, description, and canonical location are advertised in the child system prompt and neither full `SKILL.md` is inserted into the initial task

#### Scenario: manual-only selected skill is visible

- **WHEN** a selected skill has `disable-model-invocation: true`
- **THEN** that skill is still advertised to this child because the agent file explicitly selected it, without changing the skill file or preloading its body

#### Scenario: every selected skill is manual-only

- **WHEN** all selected skills have `disable-model-invocation: true` and Pi emits no `<available_skills>` section
- **THEN** the extension creates one standard section containing their escaped name, description, and canonical location before permission sanitization, without orphan entries, duplicate containers, or skill bodies

#### Scenario: unselected skill remains absent

- **WHEN** an installed skill is not named by the agent definition
- **THEN** it is not advertised to or invocable through the child's selected skill resources

#### Scenario: unknown skill fails

- **WHEN** an agent names a skill that cannot be resolved
- **THEN** spawn validation fails before queueing with a concise unknown-skill error and no creation guidance

#### Scenario: ambiguous skill fails

- **WHEN** more than one effective resource has the selected skill name
- **THEN** spawn validation fails as ambiguous rather than choosing the first match

#### Scenario: permission policy remains authoritative

- **WHEN** a selected skill is denied by `permission.skill` or its path is denied by `path` or `external_directory`
- **THEN** permission-system prompt sanitization and invocation/read gates hide or block it; explicit selection does not bypass policy

### Requirement: agent-owned tool visibility and child controls

The agent definition's `tools:` SHALL be authoritative and SHALL NOT be widened per call except for the child completion protocol.
In a parent process, this extension SHALL register only `subagent`.
In a child process, this extension SHALL expose only `subagent_done`; it SHALL hide and hard-deny `subagent` regardless of agent configuration.
`subagent_interrupt`, `subagent_resume`, `caller_ping`, `subagents_list`, and replacement model-facing lifecycle or discovery tools SHALL NOT exist.

#### Scenario: parent has one extension tool

- **WHEN** the extension loads in a parent session
- **THEN** it registers `subagent` and does not register interrupt, resume, ping, list, or replacement lifecycle tools

#### Scenario: child cannot manage subagents

- **WHEN** the extension loads with `PI_SUBAGENT_ID` set
- **THEN** `subagent` is not registered and cannot be restored by tools or permission configuration

#### Scenario: child control tools remain available

- **WHEN** a valid child tool allowlist is constructed
- **THEN** `subagent_done` is included as the sole extension protocol control, subject to any stricter permission-system denial

#### Scenario: no list tool

- **WHEN** parent and child extension registrations are inspected
- **THEN** neither `caller_ping`, `subagents_list`, nor a replacement model-facing discovery tool is registered

### Requirement: permission frontmatter coexistence

The extension SHALL treat `permission:` as a reserved compatibility key in agent markdown, preserve it untouched, and leave its interpretation exclusively to `@gotgenes/pi-permission-system`.
The child SHALL inherit the parent's exact Pi agent directory, carry canonical `<active_agent>` identity, and set `PI_SUBAGENT_PARENT_SESSION` on spawn.

#### Scenario: per-agent permission applies

- **WHEN** a named child starts with a valid `permission:` block
- **THEN** its assembled system prompt contains the canonical escaped `<active_agent>` tag and the permission system resolves the matching global or trusted-project agent policy

#### Scenario: parent agent root is preserved

- **WHEN** a child launches from a project containing `.pi/agent`
- **THEN** `PI_CODING_AGENT_DIR` still points to the parent's exact Pi agent root and is not replaced by the project directory

#### Scenario: direct child ask

- **WHEN** child policy resolves to `ask` and its Herdr Pi has a UI
- **THEN** the permission dialog renders in the child pane while `PI_SUBAGENT_PARENT_SESSION` remains available for no-UI forwarding

### Requirement: always visible and auto-exiting Pi children

Every admitted launch SHALL run Pi in a real Herdr pane or tab and SHALL set auto-exit so the process ends when the task or `subagent_done` settles.
Agent frontmatter SHALL NOT provide co-pilot or alternate-backend modes.
While the pane remains open, the user SHALL be able to interact with its Pi session directly through Herdr.

#### Scenario: visible blocking or background run

- **WHEN** a foreground or background entry is admitted
- **THEN** it runs as Pi in a visible pane or tab and closes on ordinary settlement while its session JSONL remains available for diagnostics

#### Scenario: user controls a visible child

- **WHEN** the user focuses an open child pane or tab
- **THEN** interruption and follow-up input are performed directly in that surface without a parent-agent lifecycle tool

#### Scenario: legacy co-pilot keys

- **WHEN** an agent file contains `auto-exit` or `interactive`
- **THEN** those keys have no behavioral effect and runtime remains always visible and auto-exiting

### Requirement: no package runtime config

The extension SHALL NOT require, ship, or read a package-root `config.json` or `config.json.example` for status, model routing, blocking default, layout, surface, or direction.
Runtime defaults SHALL be code-owned.
Agent definitions under trusted project and global Pi agent directories remain the only user-authored configuration for model and profile.

#### Scenario: extension starts without package JSON

- **WHEN** neither package-root `config.json` nor `config.json.example` exists
- **THEN** the extension loads successfully with status enabled and hard-coded spawn defaults

#### Scenario: leftover package JSON is inert

- **WHEN** a leftover package-root `config.json` is present with status, models, blocking, or layout keys
- **THEN** those keys have no effect on runtime behavior
