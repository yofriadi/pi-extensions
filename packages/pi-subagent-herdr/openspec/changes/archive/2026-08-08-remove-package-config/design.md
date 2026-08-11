## Context

Today three independent loaders touch package-root JSON:

1. `loadStatusConfig()` — requires `config.json` or falls back to `config.json.example`; fails closed if both are missing.
   Only meaningful field: `status.enabled`.
2. `loadExtensionDefaults()` — optional read of the same files for `blocking`, `layout`, `surface`, `direction`, with code defaults when absent/invalid.
3. `loadModelConfig()` — optional `models.default` / `models.agents` from `config.json` only.
   **Not wired into spawn/resume** in the current extension path; live model routing already uses agent frontmatter and parent-runtime inheritance.

Attached layout already encodes the preferred stack: `direction: right` means first child splits the caller right and later children stack down on the tallest region pane (`src/layout.ts`).
That is the intended fixed default.

Agent definitions under trusted `<cwd>/.pi/agents/<id>.md` and `${PI_CODING_AGENT_DIR}/agents/<id>.md` already own `model` / `thinking`.
Package model maps are redundant and confusing.

## Goals / Non-Goals

**Goals:**

- Zero package-local config files required or shipped for runtime.
- Status widget/aggregation always enabled with the existing fixed line limit.
- Spawn defaults fixed in code: async, attached, pane, direction `right`.
- Model selection solely from agent definition + parent inheritance (no package map).
- Keep optional per-call `blocking`, `layout`, `surface`, and `direction` for explicit overrides.
- Clean deletion of dead model-config and status-config package machinery and config-dependent tests/docs.

**Non-Goals:**

- Changing admission capacity, delivery barriers, or completion protocol.
- Removing per-call layout/surface/direction tool parameters.
- Introducing user/global config elsewhere (e.g. `~/.pi/.../herdr.json`).
- Changing agent frontmatter schema or resolution order.
- Redesigning attached-stack geometry beyond fixing the default direction.

## Decisions

### 1. Delete the package config surface entirely

Ship no `config.json.example`.
Do not read package-root `config.json`.
Remove it from `package.json` `files`.

**Rationale:** one less discovery path; defaults live in code; agent files already own identity and models.
Keeping a silent optional `config.json` would reintroduce the dual-source problem.

**Alternatives considered:** keep example as documentation only (still implies a second config language); move config under `~/.pi` (new surface, out of scope).

### 2. Status is always enabled

Replace `loadStatusConfig()` with a constant `StatusConfig` (`enabled: true`, existing `DEFAULT_STATUS_LINE_LIMIT`).
Delete file I/O, example fallback, “missing config” errors, and the now-dead `parseStatusConfig` / validation helpers / package path constants.
Call sites that branch on `statusConfig.enabled` keep the branch or simplify to always-on—implementation may drop the boolean if nothing else needs it.

**Rationale:** status is human-only observability; toggling it via package JSON is not worth a config file.
Users who dislike the widget can ignore it; a future opt-out can be a separate change if needed.

### 3. Hard-code extension defaults; keep per-call overrides

```text
blocking  = false   // background unless caller passes true
layout    = attached
surface   = pane
direction = right   // first split right, then stack down
```

`resolveBlocking` / `resolveLayout` / `resolveSurface` / `resolveDirection` continue to prefer explicit tool params over these constants.
`loadExtensionDefaults` file parsing goes away.
Keep a single in-code `ExtensionDefaults` constant (or equivalent defaulted argument) so unit tests can still inject alternate defaults through the existing resolve-helper seam; do not force every call site to hard-code four literals.

**Rationale:** matches user intent (“default background; explicit foreground”) and the documented right-then-down stack.
Per-call overrides cover rare geometry without package config.

### 4. Remove package model-config module

Delete (or gut) `src/model-config.ts` and its unit tests once confirmed unused by launch/resume.
Do **not** add a replacement package map.
Agent `model:` frontmatter remains authoritative; omitted model/thinking inherits parent runtime as already specified.

**Rationale:** package maps were never the live routing path and conflict with the agent-owned profile design.

### 5. Spec deltas treat prior change capabilities as baseline

`openspec/specs/` is empty; capability requirements live in the completed `add-pi-subagent-herdr` change.
This change authors MODIFIED/ADDED deltas under the same capability names (`subagent-dispatch`, `pane-surface`, `completion-delivery`) so archive can fold them into the baseline later.

## Risks / Trade-offs

- **[Risk] Users relying on local `config.json` for `blocking: true` defaults** → Mitigation: document that foreground is explicit per call; README migration note.
  No startup warning for leftover package JSON (leftover files are simply inert).
- **[Risk] Users relying on package `models.*`** → Mitigation: maps were unused at launch; any hand-edited expectation moves to agent frontmatter.
  Tests that only exercised the orphan module are deleted.
- **[Risk] Always-on status noise** → Mitigation: status remains capped/aggregated; no new channels.
  Revisit only if users request an opt-out.
- **[Risk] Dead status-config parser left behind** → Mitigation: tasks explicitly delete `parseStatusConfig`, helpers, and package path constants alongside the loader.
- **[Trade-off] Per-call layout params kept while package keys removed** → Acceptable: tool args are discoverable and rare; package JSON was the footgun.

## Migration Plan

1. Implement code defaults and remove loaders.
2. Delete `config.json.example` and package `files` entry.
3. Update README: no config copy step; document fixed defaults and agent `model:`.
4. Update/remove unit tests for status/model/config loading.
5. Operators: delete any local package `config.json`; set models on agent files; pass `blocking: true` when needed.

Rollback: restore previous loaders and example file from git if a consumer urgently needs package toggles (pre-1.0 package).

## Open Questions

None blocking.
Optional later: user-level opt-out for status widget if always-on proves noisy.
