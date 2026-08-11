## Why

Package-level `config.json` / `config.json.example` duplicates settings that already have better owners: agent Markdown frontmatter for models, per-call tool args for foreground mode, and code-owned layout defaults for pane geometry.
Keeping a second config file forces users to discover, copy, and maintain a package-local file just to turn on status or pick a model—while the live model path already ignores package `models.*` and inherits from agent definitions / parent runtime.

## What Changes

- **BREAKING — delete package config surface:** remove `config.json.example`, stop reading package-root `config.json`, and drop all loaders that depend on those files.
- **Status always on:** subagent status aggregation remains permanently enabled; there is no `status.enabled` toggle or status config file requirement.
- **No package model overrides:** remove `models.default` and `models.agents`.
  Model selection stays agent-owned (`model:` frontmatter) with parent-runtime inheritance when omitted, via the existing `~/.pi/agent/agents/` (and trusted project) definitions.
- **No package spawn defaults file:** remove package-config keys `blocking`, `layout`, `surface`, and `direction`.
  Hard-code:
  - default execution class = background/async (`blocking` omitted → false)
  - default layout = attached
  - default surface = pane
  - default direction = `right` (first split right, subsequent children stack down—the existing attached-stack algorithm)
- **Per-call foreground stays explicit:** callers may still pass `blocking: true` on `subagent` to run in the foreground and await a tool result.
- **Per-call layout/surface/direction remain available** as optional tool overrides for exceptional geometry (single split, tab, inverse axis).
  They are no longer package-configurable.
- Delete the unused package model-config module path (and its tests) once nothing loads package model maps.
- Update README / package `files` / tests that assume `config.json.example` must exist for status or defaults.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagent-dispatch`: drop package config as a source of model routing and spawn defaults; model authority is agent definition + parent inheritance only; omitted `blocking` is always background.
- `pane-surface`: package config no longer supplies layout/surface/direction; hardcoded attached/`right`/pane defaults apply when per-call options are omitted, preserving the right-then-down stack.
- `completion-delivery`: status widget/aggregation is permanently enabled; package `status.enabled` (and any other package config toggle) is not required or honored.

## Impact

- **Files:** `config.json.example` removed from the package; `package.json` `files` list updated; `src/status.ts` drops file-based status config and dead parse helpers; `src/index.ts` loses `loadExtensionDefaults` file I/O; `src/model-config.ts` and related unit tests removed; optional cleanup of obsolete `config.json` ignore entry.
- **Runtime:** extension starts without any package-local JSON; missing example file is no longer an error; leftover package `config.json` is inert.
- **API:** tool schemas stay largely the same (`blocking`, `layout`, `surface`, `direction` still optional per call).
  Only the package-config layer disappears.
- **Migration:** users with a local `config.json` can delete it.
  Move any model choices into agent frontmatter; pass `blocking: true` when a foreground result is required; pass per-call layout/surface/direction only when overriding the fixed defaults.
- **Docs:** README config section replaced with the hard-coded defaults and agent-frontmatter model guidance.
