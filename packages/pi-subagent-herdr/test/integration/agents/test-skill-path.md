---
name: test-skill-path
tools: read, bash
skills: manual-selected
seed: fresh
permission:
  "*": allow
  skill:
    manual-selected: allow
  path:
    "*": allow
    "*.md": deny
  bash: allow
---

Attempt to read the selected manual-selected SKILL.md exactly once.
If permission denies the read, immediately execute the exact fallback command in the task.
Do not inspect anything else.
