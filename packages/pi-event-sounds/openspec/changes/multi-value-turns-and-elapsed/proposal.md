# Proposal: multi-value-turns-and-elapsed

## Why

`turns` and `elapsed` each accept exactly one trigger definition with one `files` list, so every milestone sounds the same.
The whole point of a milestone is that it escalates: a chime at turn 25, a bigger one at 50, a gong at 100 — and an elapsed reminder at 5 minutes that differs from the hourly one.
Milestones are naturally a list of (when, what) pairs, not a single interval with one sound.

## What Changes

- `turns` and `elapsed` accept one trigger block or an array of blocks, each carrying its own `files`.
- A turn block has a periodic `every` (scalar), a one-shot `at` (scalar or list of positive numbers), or both — either condition fires the block's own files.
  This supersedes the intermediate idea of putting a value list on `every`: `every: [25, 50, 100]` becomes `at: [25, 50, 100]`, so `every` keeps exactly its original periodic semantics.
- An elapsed block keeps the existing shape — `seconds` (scalar or list), `repeat` — and gains its own `files`; multiple blocks arm independently.
- `SoundConfig.turns` / `SoundConfig.elapsed` normalize to arrays of blocks (a single block wraps into a one-element list; the default is an empty list).
  Malformed blocks (no files, no valid condition, non-object entries) are dropped; invalid value entries are dropped per the existing best-effort rule; nothing throws.
- Update README settings example, trigger-reference rows, and CHANGELOG.

## Capabilities

### New Capabilities

(none — the trigger and configuration requirements are extended in place)

### Modified Capabilities

- `event-sound-triggers`: the "Turn-count milestone trigger" requirement becomes one-or-more turn-trigger blocks, each with its own files and `every`/`at` conditions; the "Elapsed-time trigger" requirement becomes per-block arming with per-block files.
- `sound-configuration`: the "Defaults and normalization" requirement documents the accepted shapes (single block or list), the defaults (empty lists), and block-level normalization.

## Impact

- **Source**: `src/config.ts` (`TurnTriggerSpec` / `ElapsedTriggerSpec`, block parsers, `SoundConfig.turns` / `elapsed` become arrays), `src/triggers.ts` (`isTurnMilestone` → `turnSpecFires(turnIndex, spec)`; `ElapsedTimer` arms across all blocks and passes the fired block to the callback), `src/index.ts` (turn handler iterates blocks; elapsed callback picks from the fired block).
- **Tests**: `test/config.test.ts` (block list normalization, malformed block dropping), `test/triggers.test.ts` (block conditions incl. combined `every`+`at`, per-block timer callbacks), `test/extension.test.ts` (per-block sounds through the wiring).
- **Compatibility**: the single-block object form keeps its exact behavior (periodic `every`, one-shot/repeating elapsed).
  Configurations written against the intermediate uncommitted list-on-`every` shape move the list to `at`; nothing was released.
- **No changes** to playback, backend detection, settings lookup order, event gating, or the mute.
