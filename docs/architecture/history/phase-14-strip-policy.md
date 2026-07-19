# Phase 14: Strip policy from core

## Summary

Phase 14 removed tool and extension policy enforcement from pi-subagents.
This code duplicated what pi-permission-system already provides with richer semantics (allow/ask/deny vs. binary hide).
Removing it simplified `runAgent`, shrunk `AgentConfig` and `SessionConfig`, and prepared a cleaner codebase for Phase 15's domain-model work.

All four steps are closed: [#237], [#238], [#239], [#242].

## Steps

### Step 1: Remove `disallowed_tools` — [#237]

Removed the `disallowedTools` field from `AgentConfig` and all code that processed it.
Users migrate to `permission:` frontmatter for tool restrictions.

- Target: `types.ts`, `custom-agents.ts`, `session-config.ts`, `agent-runner.ts`, `ui/agent-config-editor.ts`, `ui/agent-creation-wizard.ts`
- Outcome: single source of truth for access control in pi-permission-system

### Step 2: Remove `extensions` filtering — [#238]

Removed the `extensions: string[]` allowlist and simplified the field to a boolean.
The `extensions: false` case (used by `isolated`) was retained for Phase 16.

- Target: `types.ts`, `agent-runner.ts`, `session-config.ts`, `ui/agent-config-editor.ts`, `ui/agent-creation-wizard.ts`
- Outcome: `filterActiveTools` reduced to two concerns: recursion guard and `extensions: false` passthrough

### Step 3: Collapse `filterActiveTools` to recursion guard — [#239]

With Steps 1–2 complete, `filterActiveTools` was reduced to its essential purpose: filtering `EXCLUDED_TOOL_NAMES` to prevent recursive agent spawning.

- Removed `ToolFilterConfig` — the function no longer needs a config bag.
- Removed the pre-bind filter call — extension tools aren't in the active set pre-bind.
- Flattened `SessionConfig` — removed `toolFilter: ToolFilterConfig`; `toolNames` and `extensions` are top-level fields.
- Target: `agent-runner.ts`, `session-config.ts`
- Outcome: `filterActiveTools` is a one-liner; the pre-bind/post-bind dance is gone

### Step 4: Rename `Agent` tool to `subagent` — [#242]

Renamed the `Agent` tool to `subagent` to align with Pi's built-in tool naming convention (all lowercase).

- Target: `tools/agent-tool.ts`, `lifecycle/agent-runner.ts`, `docs/`, `../pi-permission-system/docs/`
- Outcome: all three tools use consistent lowercase naming

[#237]: https://github.com/gotgenes/pi-packages/issues/237
[#238]: https://github.com/gotgenes/pi-packages/issues/238
[#239]: https://github.com/gotgenes/pi-packages/issues/239
[#242]: https://github.com/gotgenes/pi-packages/issues/242
