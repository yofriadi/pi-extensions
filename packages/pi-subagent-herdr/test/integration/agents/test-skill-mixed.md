---
name: test-skill-mixed
tools: read, bash
skills: manual-selected, normal-selected
seed: fresh
permission:
  "*": allow
---

Read both explicitly selected skill files in listed order, then immediately execute the exact bash command in the task.
Do not inspect the environment or use unselected-integration.
