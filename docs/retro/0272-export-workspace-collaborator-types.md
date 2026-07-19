---
issue: 272
issue_title: "Export WorkspaceProvider collaborator types by name from the public surface"
---

# Retro: #272 — Export `WorkspaceProvider` collaborator types by name from the public surface

## Stage: Planning (2026-05-29T23:23:37Z)

### Session summary

Planned a purely additive, type-only change to `@gotgenes/pi-subagents`'s public surface: re-export `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, and `WorkspaceDisposeResult` by name from `src/service/service.ts`, alongside the already-exported `WorkspaceProvider`.
The plan bundles the source change with extending the `verify:public-types` harness (symbol guard + probe consumer) into a single `feat:` commit, since a packaged-tarball probe cannot import names the entry does not yet export.

### Observations

- The issue's "Proposed change" was unambiguous, so the `ask-user` design gate was skipped.

## Stage: Implementation — Build (2026-05-29T23:30:13Z)

### Session summary

Implemented the single plan step: widened the `#src/lifecycle/workspace` import in `src/service/service.ts` to include all four collaborator types and added them to the `export type { … }` block, updating the standing comment from a future-tracking reference to a present-tense description.
Extended `scripts/verify-public-types.sh` — the symbol guard loop and inline `probe.ts` — to assert all four new names, confirmed the harness fails (red) before the source change and passes (green) after.
Also updated two stale forward-references to #272 in `docs/architecture/architecture.md` (flagged by the pre-completion reviewer).

### Observations

- Red→green cycle through the type-level harness (`verify:public-types`) rather than vitest, exactly as planned.
- No rollup config change was needed — `rollup-plugin-dts` carries through whatever the entry exports; the symbol guard and `#src` self-containment guard both stayed green.
- The symbol guard already found the names present in the bundle (declared but not exported); the probe's type-check was the real red signal.
- Pre-completion reviewer: WARN — two stale forward-references to #272 in `docs/architecture/architecture.md`; both fixed in a follow-up `docs:` commit before shipping.
- No new vitest cycle: the re-exports are type-only and erase at runtime.
  The red→green loop lives in the type-level `verify:public-types` harness, not the runtime suite — this is closer to a `/build-plan` shape than a code TDD cycle, but it still has a clean red→green via the probe consumer.
- The four interfaces already exist in `src/lifecycle/workspace.ts` with correct shapes; only re-exporting is in scope.
- `rollup.dts.config.mjs` needs no change — `WorkspaceProvider` already pulls the four collaborator declarations into the bundle by reference, so adding named exports keeps the `grep '#src'` self-containment guard green.
- A standing comment in `service.ts` ("Named re-exports … tracked in #272") goes stale on landing — the plan updates it in the same step.
- The downstream simplification in `@gotgenes/pi-subagents-worktrees` (swap indexed-access aliases for named imports, bump the dependency) is deferred until a `pi-subagents` release carries these exports — consistent with the registry-consumption model settled in #270.
