---
issue: 380
issue_title: "Resolve the cross-package settings-loader duplication"
---

# Extract a layered settings loader into the pi-subagents public surface

## Problem Statement

`pnpm fallow:dupes` reports a 23-line cross-package production clone: `src/settings.ts:198-211` ↔ `@gotgenes/pi-subagents-worktrees`'s `src/config.ts:51-73`.
Both implement the same layered global/project settings-file loader — read each path, sanitize parsed JSON, warn to stderr on malformed input, and merge with the project file overriding global.
It is the only cross-package production clone in the package.

Issue [#380] frames this as a binary decision: extract a shared `loadLayeredSettings` helper from pi-subagents' public surface, or document the duplication as intentional and record a fallow suppression.
The operator chose extraction — pi-subagents should provide layered-settings loading as core support for the `@gotgenes/pi-*` family — delivered through a **dedicated subpath export** (`@gotgenes/pi-subagents/settings`) rather than the cross-extension service contract, and sequenced as **two stages**: this plan lands the helper in pi-subagents (exported and adopted internally); a follow-up migrates worktrees onto it after a published release.

## Goals

- Add a generic `loadLayeredSettings<T>(...)` function that owns the read-sanitize-warn-merge idiom: global file under `<agentDir>/<filename>`, project file under `<cwd>/.pi/<filename>`, project overriding global, missing files silent, malformed files warned-but-continued.
- Export it from pi-subagents via a new dedicated subpath, `@gotgenes/pi-subagents/settings`, keeping the existing `.` service contract (spawn/abort/workspace seam) cohesive and unchanged.
- Adopt the helper internally: `src/settings.ts`'s `loadSettings` delegates to `loadLayeredSettings`, proving the helper against a real consumer and removing the pi-subagents copy of the idiom.
- Extend the `.d.ts` bundle (`rollup.dts.config.mjs`) and the `verify:public-types` harness to cover the new subpath, so the export is provably type-consumable from the packaged tarball.
- Document the helper for third-party extension authors (input/return contract, throw/warn semantics, a minimal wiring example).
- This is a non-breaking, additive change: `feat:` — a new public capability plus an internal refactor.
  `loadSettings`'s observable behavior is preserved.

## Non-Goals

- Migrating `@gotgenes/pi-subagents-worktrees` onto the helper.
  Worktrees resolves pi-subagents from the **registry** (`linkWorkspacePackages: false`), so it can only consume the helper after a pi-subagents release carrying it.
  That migration — swap `config.ts`'s loader, raise the peer/dev dependency floor, delete the worktrees copy — is a separate follow-up issue (created at ship time).
  Until it lands, the worktrees copy of the idiom persists (see Risks).
- Touching `saveSettings` or the `SettingsManager` class beyond the `loadSettings` delegation.
  Saving is pi-subagents-specific (worktrees has no save path) and stays as-is.
- Changing how Pi loads the extension (`pi.extensions: ["./src/index.ts"]` is untouched).
- Adding a fallow suppression — extraction is the chosen path, not Option 2.

## Background

Relevant modules and facts:

- `packages/pi-subagents/src/settings.ts` — owns `SubagentsSettings`, the `SettingsManager` class, and the free functions `loadSettings`, `saveSettings`, `persistToastFor`, plus private `sanitize`, `globalPath`, `projectPath`, `readSettingsFile`.
  The cloned block is `readSettingsFile` (lines 197-208) plus the `loadSettings` merge (lines 209-211).
  `loadSettings(agentDir, cwd = process.cwd())` is called once, by `SettingsManager.load()`, which passes `this.cwd` explicitly.
  `saveSettings` calls `projectPath(cwd)` — so `projectPath` stays; only `globalPath` and `readSettingsFile` lose their callers after the refactor.
- `packages/pi-subagents-worktrees/src/config.ts` — the clone partner.
  `loadWorktreesConfig(agentDir, cwd)` with private `sanitize`, `globalPath`, `projectPath`, `readConfigFile`.
  Its `sanitize` validates a `string[]` (`worktreeAgents`); pi-subagents' validates numeric fields with ceilings.
  The per-package `sanitize` is the genuinely-different part; the read/merge/warn mechanism is identical.
- `packages/pi-subagents/rollup.dts.config.mjs` — rolls `src/service/service.ts` into `dist/public.d.ts` (the only public entry today), externals = `@earendil-works/*` + `@sinclair/typebox`.
  Exports a single config object.
- `packages/pi-subagents/scripts/verify-public-types.sh` — packs the tarball, asserts `dist/public.d.ts` is `#src`-free and carries the expected symbols, then type-checks a throwaway consumer importing from `@gotgenes/pi-subagents`.
  Run in CI via the existing `verify:public-types` step (no `ci.yml` change needed — the extended script covers the new probe).
- `package.json` `exports` has only `"."`; `files` already allowlists `src` and `dist`, so a new `src/` module and a new `dist/*.d.ts` ship automatically.

Constraints from `AGENTS.md` and skills:

- Public API documentation: a new cross-extension export must be documented for third-party authors, not just typed ([code-design] skill).
- Library functions must not read `process.cwd()` / `process.env` internally — accept them as parameters ([code-design] skill).
  The new helper takes `agentDir` and `cwd` explicitly (no `process.cwd()` default), matching the only caller, which already passes `this.cwd`.
- The published `dist/*.d.ts` must be self-contained (no `#src/*`) — the harness gates on it.
  The helper imports only `node:fs` / `node:path` and is generic over `T`, so its rolled declaration is trivially self-contained.
- This is the package with the repo's only build step ([ADR-0003]); the subpath export extends that machinery rather than introducing a new mechanism.

Why a dedicated subpath rather than `service/service.ts`: the `.` entry is the cross-extension **service contract**.
A stateless settings-file utility is a different kind of thing; folding it into the service surface dilutes its cohesion.
A `./settings` subpath keeps the two concerns separate at the cost of a second rollup entry and a second `verify:public-types` probe (accepted in the decision).

## Design Overview

### Public API shape

```typescript
/**
 * Describes one layered settings source: a global file at `<agentDir>/<filename>`
 * and a project file at `<cwd>/.pi/<filename>`. @public
 */
export interface LayeredSettingsSource<T> {
  /** Directory holding the global settings file (typically the Pi agent dir). */
  agentDir: string;
  /** Project root; the project file lives at `<cwd>/.pi/<filename>`. */
  cwd: string;
  /** Base filename, e.g. "subagents.json". */
  filename: string;
  /** Validate/coerce parsed JSON into a partial settings object. Garbage → {}. */
  sanitize: (raw: unknown) => Partial<T>;
  /** Label for the malformed-file stderr warning, e.g. "pi-subagents". */
  warnLabel: string;
}

/**
 * Load merged layered settings: global provides defaults, project overrides.
 * Missing files are silent ({}). A file that exists but cannot be parsed warns
 * to stderr (prefixed `[warnLabel]`) and is treated as absent so startup proceeds.
 */
export function loadLayeredSettings<T>(source: LayeredSettingsSource<T>): Partial<T>;
```

The helper internalizes everything the two copies share: the two path constructions (`join(agentDir, filename)` and `join(cwd, ".pi", filename)`), the single-file read (`existsSync` → `JSON.parse(readFileSync)` → `sanitize`, `catch` → `console.warn("[label] Ignoring malformed settings at ...")` → `{}`), and the project-over-global merge.
Callers supply only what genuinely differs: `filename`, `sanitize`, `warnLabel`.

Returning `Partial<T>` fits both consumers: `SubagentsSettings`'s fields are all optional (`Partial<SubagentsSettings>` is identical), and worktrees applies its `?? []` default in its own caller after the merge.

### Internal consumer call site (pi-subagents `settings.ts`)

```typescript
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  return loadLayeredSettings({
    agentDir,
    cwd,
    filename: "subagents.json",
    sanitize,
    warnLabel: "pi-subagents",
  } satisfies LayeredSettingsSource<SubagentsSettings>);
}
```

The `satisfies` annotation both validates the call site and gives `LayeredSettingsSource` an in-repo reference, so fallow does not flag the exported interface as an unused type.
The warn message stays `"[pi-subagents] Ignoring malformed settings at ..."`, so the existing `/Ignoring malformed settings/` assertion in `settings.test.ts` still passes.
`process.cwd()` default is dropped from `loadSettings`; the sole caller (`SettingsManager.load`) already passes `this.cwd`.

### Subpath export wiring

```jsonc
"exports": {
  ".": {
    "types": "./dist/public.d.ts",
    "default": "./src/service/service.ts"
  },
  "./settings": {
    "types": "./dist/settings.d.ts",
    "default": "./src/layered-settings.ts"
  }
}
```

`rollup.dts.config.mjs` becomes an array with a second entry (`input: "src/layered-settings.ts"` → `dist/settings.d.ts`), same plugin/externals.
`files` already covers `src` and `dist`, so no allowlist change.

### Edge cases

- Both files missing → `{}` (no warn).
- A file present but unparseable → warn once per bad file, that layer treated as `{}`.
- Both present → shallow merge, project wins per key.
- `sanitize` returning `{}` for garbage shapes is the caller's concern; the helper never inspects field types.

## Module-Level Changes

- `packages/pi-subagents/src/layered-settings.ts` — **new**.
  Exports `loadLayeredSettings` and `LayeredSettingsSource<T>`; imports only `node:fs` (`existsSync`, `readFileSync`) and `node:path` (`join`).
  Private helpers (path builders, single-file reader) stay in-file below the public function (stepdown order).
- `packages/pi-subagents/src/settings.ts`
  - `loadSettings` delegates to `loadLayeredSettings`; drop the `process.cwd()` default.
  - Remove private `readSettingsFile` and `globalPath` (no remaining callers once `loadSettings` delegates).
  - Keep `projectPath` (still used by `saveSettings`), `sanitize`, `saveSettings`, `persistToastFor`, `SettingsManager`.
- `packages/pi-subagents/package.json` — add the `"./settings"` conditional export.
- `packages/pi-subagents/rollup.dts.config.mjs` — export an array; add the `src/layered-settings.ts` → `dist/settings.d.ts` entry.
- `packages/pi-subagents/scripts/verify-public-types.sh` — add a self-containment guard for `dist/settings.d.ts` (no `#src`, carries `loadLayeredSettings`) and a probe importing `loadLayeredSettings` from `@gotgenes/pi-subagents/settings`.
- `packages/pi-subagents/test/layered-settings.test.ts` — **new** unit tests (see TDD Order).
- `packages/pi-subagents/docs/architecture/architecture.md`
  - Step 9 entry (lines ~1027-1033): record the chosen approach (extraction via `./settings` subpath; internal adoption; worktrees migration deferred to a follow-up) and restate the Outcome (see Risks — full fallow elimination completes with the follow-up).
  - "Production duplication" metric note (line ~900) and any roadmap-summary line referencing the 23-line cross-package clone: update once the pi-subagents copy is gone.
- `packages/pi-subagents/README.md` and/or `.pi/skills/package-pi-subagents/SKILL.md` — note the new `@gotgenes/pi-subagents/settings` public entry and its contract (third-party-author documentation).

No symbol named in this plan is referenced by `.pi/skills/package-*/SKILL.md` today (`readSettingsFile` / `globalPath` are private and not documented) — verified by grep; the only SKILL/README edits are additive (documenting the new export).

## Test Impact Analysis

1. New tests this enables: direct unit coverage of the generic loader — the `warnLabel`-parametrized warning prefix, an arbitrary `filename`, and an arbitrary `sanitize` — none of which `settings.test.ts` can reach because it only exercises the `"subagents.json"` / `"pi-subagents"` wiring.
2. Existing tests that become partly redundant: the generic mechanics in `settings.test.ts` (missing→{}, malformed→warn, project-over-global precedence) are now also covered at the lower level.
   They are **kept** — they still genuinely exercise `loadSettings`'s wiring and the `SubagentsSettings`-specific `sanitize` (numeric ceilings), which the lower-level tests do not.
3. Tests that must stay as-is: all of `settings.test.ts` (wiring + `SubagentsSettings` sanitize + `saveSettings` + `persistToastFor`).

## Invariants at risk

`settings.ts` was not refactored by an earlier Phase 17 step (it is outside the `Subagent`/lifecycle cluster), so no prior step's documented `Outcome:` is regressed.
The invariant under change is `loadSettings`'s observable behavior (merge precedence, silent-missing, warn-malformed) — pinned by the existing `settings.test.ts` cases, which stay green throughout the refactor.
No new pin is needed.

## TDD Order

1. **Add `loadLayeredSettings` + unit tests.**
   Red: `test/layered-settings.test.ts` driving the helper directly via temp dirs (mirroring `settings.test.ts`'s tmp-dir pattern): missing files → `{}`; malformed file → `console.warn` with the `[warnLabel]` prefix + `{}`; project overrides global; custom `filename` resolves `<agentDir>/<filename>` and `<cwd>/.pi/<filename>`; `sanitize` applied to parsed JSON.
   Green: implement `src/layered-settings.ts`.
   The test import keeps the new export live for fallow dead-code.
   Commit: `feat(pi-subagents): add loadLayeredSettings layered config loader`.
2. **Adopt internally in `settings.ts`.**
   Refactor `loadSettings` to delegate to `loadLayeredSettings` (with the `satisfies` call site); remove `readSettingsFile` and `globalPath`.
   No test changes — the existing `settings.test.ts` suite (including the `/Ignoring malformed settings/` warn assertion) must stay green, proving behavior preservation.
   Run `pnpm fallow dead-code` to confirm no orphaned private helper remains.
   Commit: `refactor(pi-subagents): load settings via loadLayeredSettings`.
3. **Publish the `./settings` subpath + document it.**
   Add the `"./settings"` export, the second `rollup.dts.config.mjs` entry, and the `verify-public-types.sh` guard + probe; add the third-party-author JSDoc/README/SKILL note.
   Run `pnpm run build:types` and `pnpm run verify:public-types` — the new `dist/settings.d.ts` must be `#src`-free and the subpath probe must type-check.
   Commit: `feat(pi-subagents): export loadLayeredSettings via ./settings subpath`.
4. **Record the decision in the architecture doc.**
   Update the Step 9 roadmap entry and the duplication-metric notes to reflect extraction + the deferred worktrees follow-up; run `pnpm fallow:dupes --skip-local` and record whether the cross-package pair still reports (see Risks).
   Commit: `docs(pi-subagents): record settings-loader extraction decision (#380)`.

## Risks and Mitigations

- **The cross-package clone may still report after this plan.**
  Worktrees' copy persists until the follow-up.
  The extracted helper is generic (parametrized `warnLabel`/`sanitize`), so its token sequence diverges from worktrees' inlined copy; the contiguous identical run likely drops below fallow's `min-lines: 5`, dissolving the pair — but this is not guaranteed.
  Mitigation: Step 4 runs `fallow:dupes --skip-local` and records the actual result.
  Definitive elimination of the pair is an explicit outcome of the worktrees follow-up, not a hard gate on this plan; this plan's measurable outcome is that pi-subagents owns and publishes the canonical loader.
- **`rollup-plugin-dts` second-entry resolution.**
  Low risk — the module is dependency-free apart from `node:*`.
  Step 3's `build:types` + `verify:public-types` is the checkpoint; if `dist/settings.d.ts` is not self-contained, stop and reassess before wiring the export.
- **Permanent public-API surface growth.**
  Accepted per the [#380] decision; mitigated by isolating the helper on its own subpath so the service contract stays minimal, and by documenting it for third-party authors.
- **`loadSettings` signature change (dropped `process.cwd()` default).**
  Internal only — the sole caller passes `cwd` explicitly; verified by grep.

## Open Questions

- Exact new module filename (`src/layered-settings.ts` proposed) — settle in Step 1.
- Whether the third-party docs live in `README.md`, the package `SKILL.md`, or both — settle in Step 3.
- The follow-up worktrees-migration issue number — created at ship time; referenced from the Step 9 roadmap entry.

[#380]: https://github.com/gotgenes/pi-packages/issues/380
[ADR-0003]: ../decisions/0003-publish-bundled-type-declarations.md
[code-design]: ../../../../.pi/skills/code-design/SKILL.md
