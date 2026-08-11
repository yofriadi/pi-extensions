## 0. Coordinate archive order

- [x] 0.1 Archive `agents-dashboard-widget` before this change; its archived dashboard contract is this change's `completion-delivery` base
- [x] 0.2 During this change's archive, apply the same-named replacements in this delta for dashboard scenario `manual resume clears its terminal row`; base `completion-delivery` scenarios `blocking caller ping settles foreground`, `blocking ping releases the barrier`, and `settled row clears`; base `pane-surface` scenarios `missing pane before interrupt`, `ownership metadata`, and `caller ping`; and base `subagent-dispatch` scenarios `child cannot manage subagents`, `child control tools remain available`, and `no list tool`.
      This prevents OpenSpec sync from preserving contradictory behavior.
- [x] 0.3 During this change's archive, update the base `subagent-dispatch` Purpose to remove “permission-compatible resume” and apply the canonical-resolution/minimal-schema deltas that remove residual resume wording.

## 1. Reduce the extension tool surface

- [x] 1.1 Remove `subagent_interrupt` and `subagent_resume` registration, schemas, renderers, execution handlers, and parent-facing guidance while retaining `subagent`
- [x] 1.2 Remove child `caller_ping` registration and append only `subagent_done` to child tool allowlists
- [x] 1.3 Remove ping-specific activity events, completion-sidecar decoding, result types, notifications, settlement branches, and rendering

## 2. Remove obsolete lifecycle machinery

- [x] 2.1 Remove interrupt target resolution and Escape-delivery helpers that existed only for `subagent_interrupt`
- [x] 2.2 Remove resume admission, ownership reads, queued launch handling, and sticky-row correlation that existed only for `subagent_resume`; preserve only whole-set sticky eviction on next admission
- [x] 2.3 Preserve observed interrupted lifecycle state, stopped widget presentation, session lineage/provenance, and ordinary session leases
- [x] 2.4 Replace model-facing CLI resume hints with diagnostic session-log references and direct-pane user guidance

## 3. Update documentation and tests

- [x] 3.1 Update `README.md`, package `AGENTS.md`, and `CHANGELOG.md` for one parent tool, one child protocol tool, and direct user pane control
- [x] 3.2 Update unit tests to assert exactly `subagent` in parents, exactly `subagent_done` in the child companion/allowlist, and no ping result path
- [x] 3.3 Remove ping/resume integration fixtures and flows; keep direct child-pane Escape interruption, reload-safe direct continuation, blocking, async, layout, permission, child-isolation, and watch-abandoned capacity-release coverage

## 4. Verify

- [x] 4.0 Run and record the package commands: `pnpm run lint` (oxlint), `pnpm run typecheck`, `pnpm test`, changed-file formatting, live Herdr integration, strict OpenSpec validation, and `git diff --check`, without hard-coding mutable test counts
- [x] 4.1 Pass `pnpm run lint`, `pnpm run typecheck`, and formatting checks on changed paths
- [x] 4.2 Run `pnpm test` and confirm all package unit tests pass
- [x] 4.3 Run the modified live Herdr integration suites (`blocking-layout`, `subagent-lifecycle`, and `configured-package`) and confirm all pass
- [x] 4.4 Pass `openspec validate reduce-subagent-tool-surface --strict` and `git diff --check`
