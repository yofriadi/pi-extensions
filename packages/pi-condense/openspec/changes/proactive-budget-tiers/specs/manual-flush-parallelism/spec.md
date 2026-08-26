## ADDED Requirements

### Requirement: Manual flush uses the bounded summarizer pool
The `/pruner now` command SHALL summarize non-trivial, non-deduped batches through the same `summarizeBatches` worker pool used by automatic flushes, honoring `contextPrune.summarizerConcurrency` (at most that many summarizer calls in flight; `0` = unbounded). Providing progress callbacks SHALL NOT force sequential execution. Result handling — index-aligned results, first-failure restore of remaining batches, trivial/deduped/oversized skip semantics, frontier advance, and stats — SHALL be identical to the automatic parallel path.

#### Scenario: Manual flush runs concurrently
- **WHEN** `/pruner now` runs with 10 non-trivial pending batches and `summarizerConcurrency: 4`
- **THEN** at most 4 summarizer calls are in flight at once and all 10 are processed

#### Scenario: Failure restores remaining batches
- **WHEN** a batch's summarizer call fails during a manual parallel flush
- **THEN** batches before it persist normally, and it and all later batches are restored to the pending queue unchanged

#### Scenario: Unbounded opt-out
- **WHEN** `summarizerConcurrency` is `0` and `/pruner now` runs with 5 batches
- **THEN** all 5 summarizer calls start without waiting

### Requirement: Live per-row progress under concurrency
The `/pruner now` progress widget SHALL continue to show one row per batch with spinner, start/done/skipped transitions, and streamed summary character counts. The existing `onProgress` callback SHALL be retained as the row-transition signal (start, done, skipped) and SHALL be invoked by the pool path around each batch — trivial/deduped as immediate `skipped`, real batches as `start` then `done`/`skipped` — while `onBatchTextProgress` carries streamed character counts. Because the pool receives only the non-trivial subset, the `onProgress`/`onBatchTextProgress` indices the pool emits SHALL be remapped through the same subset→full-list index table before reaching the widget, so a row is always keyed to its batch in the full captured list. A row's displayed character count SHALL NOT regress when a retry re-emits progress from zero (render clamps to the maximum seen). Multiple rows MAY be in the running state simultaneously, up to the concurrency width. The widget SHALL be cleared and the normal footer restored when the flush completes, fails, or is aborted, exactly as today. On an abort that stops the fan-out, any row that never reached a terminal done/skipped transition SHALL be left non-running and the widget cleared (the pool's `onProgress` is wrapped so an in-flight batch's throw still settles its row).

#### Scenario: Rows update from pool workers
- **WHEN** a manual flush has 3 batches running concurrently and each streams text
- **THEN** each row shows its own live character progress and transitions to done via `onProgress` as its call completes

#### Scenario: Retry never regresses a row
- **WHEN** a batch's first attempt streams 500 chars, is rate-limited, and the retry restarts progress at 0
- **THEN** the row continues to show at least 500 chars and remains running until a final done/skipped transition

#### Scenario: Skipped batches show skipped immediately
- **WHEN** a manual flush includes a trivial batch and a fully-deduped batch
- **THEN** those rows show skipped without any spinner time and no summarizer calls are made for them

#### Scenario: Widget cleanup on failure
- **WHEN** the summarizer fails mid-flush
- **THEN** the progress widget is cleared, the footer shows the standard status, and the failure notification matches current wording

#### Scenario: Abort settles rows before clearing
- **WHEN** the flush signal aborts while rows are running
- **THEN** in-flight rows stop spinning, no queued row is stuck in `running`, and the widget is cleared
