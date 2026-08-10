---
name: test-skill-external
tools: read, bash
skills: external-selected
seed: fresh
permission:
  "*": allow
  skill:
    external-selected: allow
  path:
    "*": allow
  external_directory:
    "*": deny
  bash: allow
---

Read the selected external skill file exactly once. If permission denies that read, immediately execute the exact fallback command from the task. Do not call caller_ping or inspect anything else.
