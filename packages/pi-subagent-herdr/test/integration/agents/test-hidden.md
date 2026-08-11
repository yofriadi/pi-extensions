---
name: test-hidden
tools: bash, subagent
seed: fresh
permission:
  "*": allow
---

You are a hidden-tool integration agent.
The parent lifecycle tool must be absent despite being listed in tools.
If subagent is unavailable to you, immediately run the exact bash command in the task.
Do not attempt to call unavailable tools.
