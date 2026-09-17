## ADDED Requirements

### Requirement: an operator-authored system prompt is left intact

When Pi reports that the session's prompt came from a custom system prompt — a non-empty `customPrompt` in the options it assembled the prompt from — the tool surface SHALL NOT be rendered into that prompt.
The prompt SHALL be passed through with no tool-surface section added, removed, reordered, or rewritten.

No byte of the operator's prompt SHALL be altered by tool-surface handling, including whitespace, line endings, and blank-line runs.
Skill filtering remains a separate concern that MAY still rewrite the prompt's skills catalogue when policy withholds a skill, so a prompt is byte-identical only when no skill is withheld.

#### Scenario: no second tool surface is appended

- **WHEN** a session runs with a custom system prompt that states its tools under `## Available Tools` and its guidance under `## Guidelines`
- **THEN** the prompt sent to the model contains those two sections once, and no generated `Available tools:` or `Guidelines:` block is appended after the working-directory footer

#### Scenario: the operator's own text is preserved exactly

- **WHEN** a custom system prompt containing headings, bullet lists, prose paragraphs, and blank-line runs is rendered for a session that withholds no skill
- **THEN** the result is byte-identical to the input, whatever headings or list formatting the prompt uses

#### Scenario: a literal Pi-style header in a custom prompt is not treated as Pi's

- **WHEN** a custom system prompt happens to write its sections as the bare lines `Available tools:` and `Guidelines:`
- **THEN** those sections are still left untouched, because the prompt is the operator's regardless of the header style they chose

#### Scenario: a custom prompt stating no tools gains none

- **WHEN** a custom system prompt describes no tools at all
- **THEN** no tool surface is added to it

### Requirement: an assembled prompt still states this session's tool surface

When the prompt was assembled by Pi rather than supplied by the operator, the tool surface SHALL continue to be relocated: the sections Pi wrote SHALL be removed wherever they sit, the filler sentence between them SHALL be removed, and this session's own sections SHALL be rendered at the end of the prompt.

This behavior SHALL be unchanged by this capability, so the leading bytes a subagent child inherits from its parent stay identical when the two hold different tool sets.

#### Scenario: assembled prompt is relocated as before

- **WHEN** a session runs without a custom system prompt, so Pi assembled its own preamble containing `Available tools:` and `Guidelines:`
- **THEN** those sections are removed from the preamble and this session's own are rendered at the end

#### Scenario: an assembled prompt reflects the session's allowed set

- **WHEN** a policy withholds a tool from a session whose prompt Pi assembled
- **THEN** the rendered tool surface lists the remaining allowed tools and omits the withheld one

### Requirement: filtering and enforcement are independent of prompt shape

Skipping tool-surface rendering SHALL NOT skip any other work the turn performs.
Tool filtering, the active-tool registration derived from it, skill filtering, and the record of a changed tool surface SHALL run on every turn for every prompt, whether or not the operator supplied it.

Prompt text SHALL NOT determine what a session may call.
The active tool registration and the permission gates SHALL remain the sole authority, so a tool named by an operator's prompt but withheld by policy SHALL still be refused.

#### Scenario: denied tools stay inactive under a custom prompt

- **WHEN** a policy fully denies a tool in a session running a custom system prompt that lists that tool
- **THEN** the tool is absent from the session's active tool registration and any call to it is refused, even though the prompt still names it

#### Scenario: skills are filtered under a custom prompt

- **WHEN** a policy denies a skill in a session running a custom system prompt that carries a skills catalogue
- **THEN** that skill is filtered from the prompt and recorded as inactive for the session, on this turn and on every later turn

#### Scenario: a changed surface is still recorded

- **WHEN** a policy change alters which tools a session withholds while a custom system prompt is in use
- **THEN** the change is recorded on the debug stream, exactly as it is for an assembled prompt
