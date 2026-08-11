# Subagent Routing

Subagents available is:

- `plan-reviewer`
- `code-reviewer`
- `codebase-explorer`
- `github-explorer`
- `deep-researcher`

The first two will run on foreground and asked only at:

- `plan-reviewer` after `openspec propose`
- `code-reviwer` after `openspec apply`

The rest is available anytime needed.
Do not respawn subagent after it failed, let the user resume it manually.

When delegating repository work, call `subagent` with an explicit canonical ID and task.
Use `label` only for human presentation; never infer authority or execution settings from it.
Example:

```text
subagent({ agent: "deep-researcher", label: "Rust Edition", task: "Research about latest Rust edition" })
```

Blocking runs occupy the foreground slot and return their result through the tool call.
Async spawns use the background class.
