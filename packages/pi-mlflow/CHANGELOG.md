# Changelog

## Unreleased

### Changed

- Migrate into the pi-extensions monorepo as `packages/pi-mlflow`, published as `@yofriadi/pi-mlflow`.
- Replace the standalone eslint setup with the monorepo's biome checks (`check` / `check:fix`); the previous `check` (type-check) script is now `typecheck`.
- Keep `@opentelemetry/sdk-trace-node` in devDependencies: it is only imported by the test suite (`test/setup.test.ts`), not by `src/setup.ts` (which references it in comments only).
- Declare `@earendil-works/pi-coding-agent` as a peer dependency (already required to run inside pi).
- Remove unused `TokenUsageAttribute` / `CostAttribute` type exports from `src/metadata.ts` (fallow dead-code).
- Extract the shared root-cycle close sequence in `src/lifecycle.ts` into `endRootCycle`, deduplicating the identical settle and shutdown blocks (fallow duplication).
