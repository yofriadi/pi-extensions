# Capability: subagent-dispatch

## MODIFIED Requirements

### Requirement: minimal subagent call schema

The `subagent` tool SHALL NOT expose per-call `name`, `model`, `thinking`, `tools`, `skills`, `systemPrompt`, `fork`, `cwd`, `interactive`, or `autoExit`.
The agent definition SHALL own tools, skills, seed, identity instructions, and optional model/thinking.
Its Markdown body SHALL be the sole agent-authored identity prompt; obsolete `system-prompt` frontmatter SHALL fail validation before queueing.
Declared `model`/`thinking` values SHALL be authoritative, while omitted values SHALL inherit the invoking parent runtime.
Package-level model maps (`models.default`, `models.agents`) and other package `config.json` keys SHALL NOT participate in routing or defaults.
Optional `label` SHALL affect presentation only.
Optional `blocking` SHALL default to false (background) when omitted.
Optional `layout`, `surface`, and `direction` remain per-call overrides only—not package-configurable.

#### Scenario: schema inspection

- **WHEN** the registered `subagent` parameter schema is inspected
- **THEN** it contains required `agent` and `task`, optional `label`, `blocking`, `layout`, `surface`, and `direction`, and none of the removed execution-profile fields

#### Scenario: label does not change authority

- **WHEN** a call supplies `label: "auth-flow"` for agent `reviewer`
- **THEN** pane/widget/result presentation may use the label while permissions, skills, tools, session ownership, and routing remain bound to `reviewer`

#### Scenario: omitted model and thinking inherit

- **WHEN** a valid agent definition omits `model` or `thinking`
- **THEN** the omitted value inherits from the parent runtime invoking the launch or resume, while any declared value is used and cannot be overridden per call or package config

#### Scenario: package model config is ignored

- **WHEN** a package-root `config.json` or `config.json.example` defines `models.default` or `models.agents`
- **THEN** launch and resume still resolve model only from agent frontmatter or parent inheritance and do not load those package keys

#### Scenario: omitted blocking is background

- **WHEN** a valid call omits `blocking`
- **THEN** the call is classified as background/async work and does not wait for a tool-result barrier

#### Scenario: Markdown body is the identity prompt

- **WHEN** a valid agent definition is assembled for launch
- **THEN** its Markdown body supplies the sole agent-authored identity instructions and no duplicate identity prompt is applied

#### Scenario: obsolete system-prompt frontmatter fails

- **WHEN** an agent definition contains `system-prompt` frontmatter
- **THEN** validation fails before queueing or resource creation rather than silently ignoring or applying it

#### Scenario: repeated labels remain distinguishable

- **WHEN** concurrent or historical runs use the same canonical agent ID and label
- **THEN** permissions and ownership remain canonical-ID-bound while human/result presentation includes a stable internal run ID where needed to disambiguate them

### Requirement: foreground and background admission queues

Per parent session, the extension SHALL run no more than one foreground blocking run and four background runs.
A `subagent` call enters the foreground class only when `blocking: true` is explicitly supplied; omitted or false `blocking` and all `subagent_resume` calls belong to the background class.
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

- **WHEN** an async call or resume arrives while four background runs are active
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

- **WHEN** a run completes, fails, is cancelled, loses its pane, pings, rolls back launch, or is shut down
- **THEN** its slot and leases release exactly once and the next valid entry in that class is admitted

## ADDED Requirements

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
