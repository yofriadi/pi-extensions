# Tasks: multi-value-turns-and-elapsed

## 1. Configuration (`src/config.ts`)

- [x] 1.1 Add `TurnTriggerSpec` (`every?`, `at?: number | number[]`, `files`) and `ElapsedTriggerSpec` (`seconds: number | number[]`, `repeat`, `files`); `SoundConfig.turns` / `elapsed` become `TurnTriggerSpec[]` / `ElapsedTriggerSpec[]` with `[]` defaults
- [x] 1.2 Add `parseTurnSpecs` / `parseElapsedSpecs`: a block or an array normalizes to a list; per block, files must be non-empty, a turn block needs a valid `every` (positive finite number) or `at` (existing value normalizer: dedupe + sort, invalid entries dropped), an elapsed block needs a valid `seconds`; malformed blocks and non-object entries are dropped without affecting siblings, never throwing
- [x] 1.3 Extend `test/config.test.ts`: single block wraps to a one-element list, block lists keep per-block files, combined `every`+`at`, value-list dedupe/sort/invalid-drop on `at`/`seconds`, blocks with nothing valid dropped, malformed blocks dropped without affecting siblings, defaults `[]`

## 2. Triggers (`src/triggers.ts`)

- [x] 2.1 Replace `isTurnMilestone` with `turnSpecFires(turnIndex, spec)`: periodic `every` (turnIndex > 0 and divisible), one-shot `at` (exact membership, turnIndex > 0), either condition firing a combined block
- [x] 2.2 Rework `ElapsedTimer.arm(config, onFire)` to iterate every elapsed block and every listed second value, arming one timer per value (an interval when that block repeats) and passing the fired block to `onFire`; handles become `{ handle, interval }` pairs; one-shot handles self-remove; `clear()` clears every handle with the right function; every handle is `unref()`'d
- [x] 2.3 Extend `test/triggers.test.ts`: scalar/list `at` exact-match milestones (125 with `[25, 50, 100]` stays silent), combined `every`+`at`, empty `at`, per-block timer callbacks (the fired block carries its own files), clear across mixed one-shot/repeating handles

## 3. Extension wiring (`src/index.ts`, `test/extension.test.ts`)

- [x] 3.1 `turn_start` iterates `config.turns` and plays each matching block's own files; the elapsed `onFire` picks from the fired block's files
- [x] 3.2 Extension test: turn blocks fire their own files at their own milestones (silent at 37/75/101/125)
- [x] 3.3 Extension test: elapsed blocks fire their own files at their own marks; the shared-files seconds list still fires once per value

## 4. Docs

- [x] 4.1 README: settings example shows single-block and block-list forms for `turns` and `elapsed`; trigger-reference rows describe block semantics
- [x] 4.2 CHANGELOG `[Unreleased]` entry under Added

## 5. Verification

- [x] 5.1 `pnpm run check` clean and `pnpm test` green for the package
