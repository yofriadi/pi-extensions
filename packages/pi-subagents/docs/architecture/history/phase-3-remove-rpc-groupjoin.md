# Phase 3: Remove group-join, ad-hoc RPC; replace output-file

Deleted `group-join.ts`, `cross-extension-rpc.ts` (#49).
Replaced `output-file.ts` with `SessionManager.create()` + `session-dir.ts` (#61).
Simplified `index.ts` to use direct individual notifications.
Lifecycle events emitted on `pi.events` for external consumers.

## Related issues

- #49 — Remove group-join and ad-hoc RPC
- #61 — Replace output-file with JSONL session transcripts
