# Changelog

## Unreleased

### Changed

- Migrate into the pi-extensions monorepo as `packages/pi-mlflow`, published as `@yofriadi/pi-mlflow`.
- Replace the standalone eslint setup with the monorepo's biome checks (`check` / `check:fix`); the previous `check` (type-check) script is now `typecheck`.
- Keep `@opentelemetry/sdk-trace-node` in devDependencies: it is only imported by the test suite (`test/setup.test.ts`), not by `src/setup.ts` (which references it in comments only).
- Declare `@earendil-works/pi-coding-agent` as a peer dependency (already required to run inside pi).
- Remove unused `TokenUsageAttribute` / `CostAttribute` type exports from `src/metadata.ts` (fallow dead-code).
- Extract the shared root-cycle close sequence in `src/lifecycle.ts` into `endRootCycle`, deduplicating the identical settle and shutdown blocks (fallow duplication).
- Bound the `agent_settled` / `session_shutdown` flush wait at 5 s via the new shared `SERVER_WAIT_GRACE_MS` (`src/constants.ts`, also replacing `src/experiment.ts`'s local setup-timeout literal so the two cannot drift): a mid-session tracking-server outage no longer freezes pi's settle path for the SDK's ~30 s per-request timeout.
  An abandoned flush is never cancelled — the export continues in the background, its normalized promise is retained and re-awaited by the next attempt within the same session runtime, and `/mlflow` reports the degraded wait while status stays `active`.
  Accepted trade-off: a cycle whose export would have landed after the grace period can now be lost if pi exits first, widening the pre-existing no-WAL loss window in exchange for bounded session latency.
