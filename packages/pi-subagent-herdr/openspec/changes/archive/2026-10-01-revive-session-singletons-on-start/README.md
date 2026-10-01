# revive-session-singletons-on-start

Fix subagent spawn failures after switching away from a session and resuming back: session-keyed process-global singletons (admission coordinator, foreground delivery barrier) are terminally poisoned on session switch and never revived on session_start.
Revive by replacing poisoned instances so spawning works again while keeping kill-on-switch semantics.
