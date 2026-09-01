## MODIFIED Requirements

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

#### Scenario: obsolete system-prompt frontmatter fails

- **WHEN** an agent definition contains `system-prompt` frontmatter
- **THEN** validation fails before queueing or resource creation rather than silently ignoring or applying it

#### Scenario: obsolete seed frontmatter fails

- **WHEN** an agent definition contains `seed` frontmatter with value `fresh` or `fork`
- **THEN** validation fails before queueing with a migration-style error stating subagents always start fresh, rather than silently downgrading the definition

#### Scenario: repeated labels remain distinguishable

- **WHEN** concurrent or historical runs use the same canonical agent ID and label
- **THEN** permissions and ownership remain canonical-ID-bound while human/result presentation includes a stable internal run ID where needed to disambiguate them
