---
name: test-hidden
tools: bash, subagent, subagent_interrupt, subagent_resume
seed: fresh
permission:
  "*": allow
---

You are a hidden-tool integration agent. The parent lifecycle tools must be absent despite being listed in tools. If subagent, subagent_interrupt, and subagent_resume are unavailable to you, immediately run the exact bash command in the task. Do not attempt to call unavailable tools.
