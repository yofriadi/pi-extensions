# Phase 5: Decompose index.ts

Extracted tools, notifications, activity tracking, event handlers, and the `/agents` command into separate modules.
Created `SubagentRuntime` factory to hold session-scoped state.

## index.ts decomposition

The original monolithic `index.ts` has been decomposed into focused modules:

```text
src/
├── index.ts                  - slimmed entry point: init, tool registration
├── runtime.ts                - SubagentRuntime: session-scoped state + methods
├── tools/
│   ├── agent-tool.ts         - Agent tool definition, parameter validation, dispatch
│   ├── foreground-runner.ts  - foreground execution loop (spinner, streaming, result)
│   ├── background-spawner.ts - background spawn (activity setup, notification wiring)
│   ├── get-result-tool.ts    - get_subagent_result tool
│   ├── steer-tool.ts         - steer_subagent tool
│   └── helpers.ts            - shared tool utilities (textResult, buildDetails, getStatusNote, ...)
├── handlers/
│   ├── lifecycle.ts          - session_start, session_before_switch, session_shutdown
│   └── tool-start.ts         - tool_execution_start handler
├── notification.ts           - completion nudges, custom renderer
├── renderer.ts               - notification TUI component
├── ui/agent-menu.ts          - /agents slash command menu (orchestration, listing, settings)
├── ui/agent-config-editor.ts - agent detail view (edit/delete/eject/disable/enable)
├── ui/agent-creation-wizard.ts - agent creation (AI-generation and manual-form)
├── ui/agent-file-ops.ts      - AgentFileOps interface + FsAgentFileOps implementation
├── service-adapter.ts        - SubagentsService implementation wrapping AgentManager
└── (existing domain modules unchanged)
```

Each extracted module receives narrow constructor-injected dependencies rather than closing over module-level state.
Handlers call methods on narrow runtime interfaces - no raw field writes, no `widget!` reach-throughs.

## Related issues

- #54 — Decompose index.ts
- #69 — SubagentRuntime factory
- #70 — Handler extraction
- #87 — Runtime methods
