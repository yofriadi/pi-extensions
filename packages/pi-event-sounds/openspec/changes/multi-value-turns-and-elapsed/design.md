# Design: multi-value-turns-and-elapsed

## Context

`turns` is a single `{ every, files }` object and `elapsed` a single `{ seconds, repeat, files }` object.
The turn check is `turnIndex > 0 && turnIndex % every === 0`, and `ElapsedTimer.arm` arms one timer for the whole trigger.
An intermediate design in this change put value lists on `every`/`seconds` with one shared `files` list; review feedback redirected it — each milestone needs its own sound — so the unit of configuration becomes the block.

## Goals / Non-Goals

**Goals:**

- Each turn milestone and elapsed mark can play its own files.
- One uniform shape: `turns` / `elapsed` accept a single block (today's form, unchanged behavior) or an array of blocks.
- Exact-match milestones: firing at turns 25/50/100 must not fire at 75 or 125.

**Non-Goals:**

- Interval arithmetic across blocks (e.g. auto-deriving "every 25 after turn 100").
- Changing playback, the mute, or any other trigger.

## Decisions

### D1: Blocks, not value lists — `turns.at` for one-shots, `every` stays periodic

A `turns` block is `{ every?: number, at?: number | number[], files }`.
`every` keeps exactly its original periodic semantics (`turnIndex > 0 && turnIndex % every === 0`); `at` fires exactly when `turnIndex` equals one of its values — membership, not modulo — so `at: [25, 50, 100]` plays at 25, 50, and 100 and never at 75 or 125.
A block may combine both; either condition fires it.

*Why:* the earlier list-on-`every` idea had to overload the scalar's meaning (scalar = periodic, array = one-shot), which makes `[100]` mean "once" while `100` means "repeatedly" — a trap.
Splitting the two intents into two fields keeps each keyword with one meaning, and per-block `files` follows for free: the block is the unit that owns files.

*Consequence:* `turns` gains a new field name (`at`).
The intermediate `every`-list shape is superseded before any release, so there is no migration.

### D2: Elapsed blocks arm independently; the callback receives the fired block

`elapsed` blocks keep `{ seconds: number | number[], repeat: boolean, files }`. `ElapsedTimer.arm(config, onFire)` iterates every block and every listed second value, arming one timer per value (an interval when that block repeats, a one-shot otherwise). `onFire` receives the fired block so the extension picks from that block's files.

*Why:* one timer per value is already the internal model; generalizing it across blocks is a small step, and passing the block to the callback is the minimal way to give each mark its own sound without global state.

*Accepted trade-off:* overlapping intervals (e.g. two blocks repeating at 300 and 600 seconds) fire together at shared marks — the honest reading of "both repeat".

### D3: Resolved config is always an array; defaults are empty lists

`SoundConfig.turns: TurnTriggerSpec[]` and `SoundConfig.elapsed: ElapsedTriggerSpec[]`.
A single block in settings wraps into a one-element list; the default is `[]`.
Handlers iterate without nil-checks, and "unconfigured" is simply an empty list — the same shape discipline the `events` lists already follow.

### D4: Block-level normalization: drop malformed blocks, keep valid siblings

`parseTurnSpecs` / `parseElapsedSpecs` accept a block or an array.
Per block: `files` must normalize to a non-empty list; a turn block must have a valid `every` (positive finite number) or a valid `at` (via the existing value normalizer: positive finite numbers, deduped, sorted); an elapsed block must have a valid `seconds`.
Non-object entries are dropped.
A malformed block never removes its siblings, and nothing throws — the established per-part best-effort rule lifted one level.

### D5: `ElapsedTimer` holds `{ handle, interval }` pairs

Handles become `{ handle: unknown; interval: boolean }[]` because the repeating flag now varies per block rather than per arming.
One-shot handles still self-remove on fire so a later `clear()` stays a no-op for them; `clear()` clears each handle with the right function and resets the list.
The existing "clearing twice is safe" and "re-arming replaces the previous timer" tests pass unchanged.

## Risks / Trade-offs

- [Two condition fields on a turn block (`every` + `at`)] → Documented as "either condition fires"; the combination is rarely wanted but is the natural OR once blocks exist.
- [Overlapping repeat intervals fire twice at a shared mark] → Accepted (D2).
- [A very long block list arms many timers] → All unref'd, cleared on settle; no practical limit needed.

## Migration Plan

Single-block configurations behave exactly as before.
The intermediate uncommitted list-on-`every` shape moves its list to `at`; nothing was released, so no settings migration.
Rollback is reverting the source change; nothing persists.

## Resolved During Planning

- **Why not a value list with shared files?**
  That was the first cut of this change; review asked for per-milestone sounds, and blocks still express the shared case (`at: [25, 50, 100]` in one block).
- **Does an `at` list fire at multiples of its entries?**
  No — exact membership only (D1); 125 with `at: [25, 50, 100]` stays silent.
- **What does `repeat` mean across blocks?**
  Per block (D2); each repeating block's values repeat on their own intervals.
- **Can a block have both `every` and `at`?**
  Yes — either condition fires it (D1).
