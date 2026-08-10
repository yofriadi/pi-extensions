---
name: test-skill-deny
tools: bash
skills: manual-selected
seed: fresh
permission:
  "*": allow
  skill:
    "*": allow
    manual-selected: deny
  bash: allow
---

You are a denied-skill integration agent. The test harness expects manual-selected to be absent after permission sanitization. Immediately run the exact fallback bash command in the task without inspecting the environment, files, or skill paths.
