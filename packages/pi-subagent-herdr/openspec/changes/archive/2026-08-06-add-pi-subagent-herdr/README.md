# add-pi-subagent-herdr implementation notes

The final implementation follows the strict explicit-agent schema in this change. See the package `README.md`, `AGENTS.md`, and `CHANGELOG.md` for user-facing behavior.

## Verification snapshot

- `npm run typecheck`: pass
- `npm run lint`: pass
- `npm test`: 262/262 pass across 59 suites
- `pnpm test`: pass
- `openspec validate add-pi-subagent-herdr --strict --json`: valid
- real Herdr with `tokenrouter-openai/gpt-5.6-luna`: serialized blocking/layout passed 9/9, terminal/mux passed 8/8, and the complete lifecycle suite passed 18/18, including the corrected same-parent resume, parallel lifecycle, selected-skill ask, path, and external-directory cases; the shared-workspace suites use `concurrency: 1`, and the selected-skill ask and mixed-skill fixtures deny `caller_ping` so their approved reads are followed by the asserted bash actions
- real `@gotgenes/pi-permission-system`: the permission and selected-skill cases passed in the current 18/18 lifecycle run, covering trusted/global identity, exact agent-root inheritance, per-agent deny, direct child-TTY ask approval, hidden parent tools, mixed/manual-only selected skills, denied and ask selected-skill policies, path-gated resume, external-directory gating, and identity continuity
- the real verification command is `PI_TEST_MODEL=tokenrouter-openai/gpt-5.6-luna PI_TEST_TIMEOUT=180000 node --test --test-concurrency=1 <suite>`; focused serial runs are authoritative because earlier concurrent shared-workspace runs could race cleanup, and Herdr may still emit benign `pane_not_found` polling diagnostics after a pane has settled
