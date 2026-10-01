# Delta: event-sound-triggers

## MODIFIED Requirements

### Requirement: Turn-count milestone trigger

The system SHALL support one or more turn-trigger blocks, each carrying its own file list, configured via `turns` (a single block or an array of blocks).
A block with `every` (a positive number) SHALL fire on `turn_start` when `turnIndex` is greater than zero and divisible by `every`.
A block with `at` (a number or array of positive numbers) SHALL fire exactly when `turnIndex` equals one of the listed values — once per listed value — and MUST NOT fire at any other turn index, including at multiples of a listed value.
A block MAY combine `every` and `at`; either condition fires the block's own files.
Multiple blocks matching the same turn each play their own files.
The trigger MUST NOT fire for a block with empty files or no valid condition, nor when `turns` is unconfigured.

#### Scenario: Turn 100 with every=100

- **WHEN** `turn_start` arrives with `turnIndex: 100` and `turns` is `{ every: 100, files: ["century.wav"] }`
- **THEN** a randomly chosen file from that block's `files` plays

#### Scenario: Turn 37 with every=100

- **WHEN** `turn_start` arrives with `turnIndex: 37` and `turns` is `{ every: 100, files: ["century.wav"] }`
- **THEN** no turn-milestone sound plays

#### Scenario: Each block plays its own files at its own milestone

- **WHEN** `turns` is `[{ at: 25, files: ["quarter.wav"] }, { at: [50, 100], files: ["big.wav"] }]` and `turn_start` arrives sequentially with `turnIndex` 25, 50, 100, 37, 75, 101, and 125
- **THEN** "quarter.wav" plays exactly once (at 25), "big.wav" plays exactly twice (at 50 and 100), and nothing plays at 37, 75, 101, or 125 (125 being a multiple of 25 does not fire)

#### Scenario: A single-element at is one-shot, not periodic

- **WHEN** `turns` is `{ at: [100], files: [...] }` and `turn_start` arrives with `turnIndex: 200`
- **THEN** no turn-milestone sound plays (the `at` form is exact-match, not modulo)

#### Scenario: A block may combine every and at

- **WHEN** `turns` is `{ every: 25, at: 100, files: [...] }` and `turn_start` arrives with `turnIndex` 25, 50, 60, 75, and 100
- **THEN** the block fires at 25, 50, 75, and 100 via `every` (100 also satisfies `at`, but the block plays once per turn), and nothing plays at 60

### Requirement: Elapsed-time trigger

The system SHALL support one or more elapsed-time blocks, each carrying its own file list, configured via `elapsed` (a single block or an array of blocks).
On `agent_start` the system SHALL arm, for every block, one timer per listed `seconds` value: each fires after that many seconds and repeats on its own interval when that block's `repeat` is true.
When a timer fires, the fired block's own files play.
Timers MUST be cleared on `agent_settled` and `session_shutdown`, and MUST be `unref()`'d so they never keep the process alive.

#### Scenario: One-shot five-minute reminder

- **WHEN** `elapsed` is `{ seconds: 300, repeat: false, files: [...] }` and the agent runs for more than 5 minutes
- **THEN** that block's elapsed sound plays exactly once, 300 seconds after `agent_start`

#### Scenario: Timer cleared on settle

- **WHEN** `agent_settled` fires 60 seconds after `agent_start` with `elapsed` of `{ seconds: 300, repeat: false, files: [...] }`
- **THEN** the elapsed sound never plays for that run

#### Scenario: Repeating timer

- **WHEN** `elapsed` is `{ seconds: 300, repeat: true, files: [...] }` and the agent runs for 11 minutes
- **THEN** the elapsed sound plays at 300 and 600 seconds (twice)

#### Scenario: Each block plays its own files at its own mark

- **WHEN** `elapsed` is `[{ seconds: 300, files: ["tick.wav"] }, { seconds: 1000, repeat: true, files: ["gong.wav"] }]` and the agent runs for more than 1000 seconds
- **THEN** "tick.wav" plays exactly once at 300 seconds, and "gong.wav" plays at 1000 seconds and repeats every 1000 seconds while the run lasts

#### Scenario: A seconds list arms one timer per value

- **WHEN** `elapsed` is `{ seconds: [300, 1000], repeat: false, files: [...] }` and the agent runs for more than 1000 seconds
- **THEN** the block's files play exactly twice: once at 300 seconds and once at 1000 seconds

#### Scenario: Clearing removes every armed timer of every block

- **WHEN** `elapsed` is a list of blocks and `agent_settled` fires before any mark
- **THEN** no elapsed sound ever plays for that run
