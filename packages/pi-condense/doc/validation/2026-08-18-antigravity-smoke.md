# Antigravity live smoke — 2026-08-18

## Scope

Validated the fork's `pi-condense` extension with the real `google-antigravity` host provider after the smoke harness was restricted to a no-input deterministic tool.

## Configuration

| Setting | Value |
|---|---|
| Provider | `google-antigravity` |
| Summarizer model | `gemini-3.7-flash` |
| Prune trigger | `agent-message` |
| Batching | `turn` |
| Minimum batch chars | `1` |
| Summarizer concurrency | `1` |
| Loaded extensions | Antigravity provider, `scripts/smoke-payload-tool.ts`, `index.ts` |
| Tool policy | Only `pi_condense_smoke_payload`; no built-in tools, no approval, no context files, skills, or prompt templates |

The smoke-payload tool accepts no parameters and returns a fixed 6,000-character string. It cannot read files, run commands, receive arbitrary input, or access the copied credential.

## Observed result

- The configured `google-antigravity/gemini-3.7-flash` model completed the session.
- The session contained **one** `context-prune-summary` entry.
- The session contained **one** `context-prune-flush-metrics` entry with:
  - `trigger`: `message-end`
  - `outcome`: `summarized`
- No `using session model` fallback warning was present.
- No tool call other than `pi_condense_smoke_payload` was present.
- The copied `auth.json` was removed before the retained session directory could be inspected.

## Outcome

**Passed.** The configured Antigravity host provider produced the summary directly through the no-shell harness. The private session JSONL and its temporary directory are intentionally not versioned; this report retains only non-secret verification facts.
