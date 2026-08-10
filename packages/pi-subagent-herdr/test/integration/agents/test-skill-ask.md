---
name: test-skill-ask
tools: read, bash
skills: manual-selected
seed: fresh
permission:
  "*": allow
  skill:
    manual-selected: ask
  bash: allow
  read: allow
  caller_ping: deny
---

Read only the selected manual-selected SKILL.md, then immediately execute the exact bash command in the task. Do not call caller_ping, inspect anything else, or ask the parent for help.
