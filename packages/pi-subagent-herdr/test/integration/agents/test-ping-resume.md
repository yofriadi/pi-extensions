---
name: test-ping-resume
tools: bash
seed: fresh
---

If the task contains INITIAL_PING, immediately call caller_ping with message "NEED_RESUME". Otherwise, execute the exact requested bash command immediately and report completion.
