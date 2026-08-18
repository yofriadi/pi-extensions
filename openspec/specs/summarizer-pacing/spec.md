# Spec: summarizer-pacing

## Purpose

Bound summarizer flush fan-out and absorb rate-limit bursts on the configured model before they enter outage fallback.

## Requirements

### Requirement: Bounded summarizer fan-out

`summarizeBatches` SHALL run at most `contextPrune.summarizerConcurrency` summarizer LLM calls concurrently for one fan-out, starting a queued batch only as an in-flight call settles. A value of `0` SHALL mean unbounded (one call per batch, started together). The returned array SHALL remain index-aligned with the input array regardless of completion order, and per-batch text-progress callbacks SHALL keep reporting the batch's index within the array passed to `summarizeBatches`. An empty input SHALL return an empty array without starting any call, and a single-batch input SHALL still take the single-batch path.

#### Scenario: Fan-out never exceeds the configured width

- **WHEN** a flush summarizes 10 batches with `summarizerConcurrency: 4`
- **THEN** at most 4 summarizer calls are in flight at any moment and all 10 batches are summarized

#### Scenario: Results stay index-aligned under out-of-order completion

- **WHEN** batches finish in an order different from their input order
- **THEN** each result occupies its input index and per-batch progress callbacks report that same index

#### Scenario: Zero means unbounded

- **WHEN** `summarizerConcurrency` is `0` and a flush summarizes 10 batches
- **THEN** all 10 calls are started without waiting for any to settle

#### Scenario: Width larger than the batch count

- **WHEN** `summarizerConcurrency` is `8` and a flush summarizes 3 batches
- **THEN** 3 calls are started and no worker idles on a missing batch

### Requirement: Fan-out abort settles in-flight work

When a summarizer call throws because the flush signal was aborted, the fan-out SHALL stop handing out queued batches, SHALL await the calls already in flight, and SHALL then re-throw the first captured error so `flushPending` can restore pending batches and report an aborted flush.

#### Scenario: Abort mid-fan-out

- **WHEN** the flush signal fires while batches remain queued
- **THEN** no further batch is started, the fan-out rejects with the abort error, and no queued batch is reported as a summarizer failure

### Requirement: In-place retry of rate-limit failures

A failed summarizer attempt whose message is rate-limit-shaped — HTTP `429`, `resource has been exhausted`, `rate limit`, `too many requests`, `quota`, `overloaded`, or a server retry-delay phrase — SHALL be retried on the same model, after a wait, up to an internal attempt cap, before the failure is reported as `transient`. Matching SHALL be case-insensitive and SHALL apply both to a thrown error message and to the `errorMessage` of a stream that stopped with reason `error`. Each wait SHALL be a server-provided delay when one is parseable and fits the internal per-wait cap, otherwise an exponentially growing internal delay. A parseable server delay larger than the per-wait cap SHALL NOT be waited out: the outcome SHALL be reported as `transient` immediately. When `summarizerMaxTimeoutMs` is greater than 0, no retry SHALL start whose planned wait would push total elapsed time past that ceiling. Waits SHALL happen outside a single attempt's idle and ceiling timers, and each attempt SHALL arm fresh timers. Retries and waits SHALL emit no user-facing notification. Attempt count, base delay, and per-wait cap SHALL be internal constants, not user configuration.

#### Scenario: Quota burst is absorbed on the configured model

- **WHEN** the first attempt fails with `Cloud Code Assist API error (429): Resource has been exhausted` and a retry on the same model succeeds
- **THEN** the call returns that summary, the fallback path is never entered, and no notification is emitted

#### Scenario: Retry cap reached

- **WHEN** every allowed attempt fails rate-limit-shaped
- **THEN** the outcome is reported as `transient` exactly as an unretried transient failure is today

#### Scenario: Long server-requested delay short-circuits

- **WHEN** an attempt fails with a server-requested retry delay longer than the internal per-wait cap
- **THEN** no wait is performed and the outcome is reported as `transient` immediately

#### Scenario: Ceiling bounds the retry chain

- **WHEN** `summarizerMaxTimeoutMs` is set and the next planned wait would exceed the remaining budget
- **THEN** no further attempt is started and the outcome is reported as `transient`

#### Scenario: Non-rate-limit failures are not retried

- **WHEN** an attempt fails with an unrecognized error, an idle timeout, or a ceiling timeout
- **THEN** exactly one attempt is made and the outcome is reported unchanged

#### Scenario: Auth and unusable outcomes are not retried

- **WHEN** an attempt returns an `auth` failure or an unusable summary
- **THEN** no retry is attempted and the outcome is returned unchanged

#### Scenario: A wait is not counted as a stall

- **WHEN** a retry waits longer than `summarizerIdleTimeoutMs` before the next attempt
- **THEN** the wait does not trigger an idle timeout and the next attempt starts with fresh timers

### Requirement: Shared rate-limit gate per fan-out

`summarizeBatches` SHALL create one rate-limit gate per fan-out and share it with every call in that fan-out. Before each attempt a call SHALL wait for the gate to open; on a rate-limit-shaped failure the call SHALL extend the gate by its computed delay. The gate SHALL only ever extend, never shorten, its open time, and its wait SHALL end early when the flush signal aborts. The gate SHALL NOT persist across fan-outs, and calls made outside a fan-out — the sequential `/pruner now` loop and range summarization — SHALL work without one, relying on in-place retry alone.

#### Scenario: One quota hit paces the whole pool

- **WHEN** one call in a fan-out fails rate-limit-shaped
- **THEN** the other calls in that fan-out wait for the gate before their next attempt instead of retrying immediately

#### Scenario: Gate does not leak into a later flush

- **WHEN** a fan-out ends while its gate is still closed and a new flush starts
- **THEN** the new fan-out begins with an open gate

#### Scenario: Abort releases a gate wait

- **WHEN** the flush signal aborts while a call waits on the gate
- **THEN** the wait ends and the call propagates the abort instead of starting another attempt

### Requirement: Concurrency configuration surface

The extension SHALL support `contextPrune.summarizerConcurrency` in `~/.pi/agent/settings.json`, defaulting to `4`. A configured value SHALL be accepted only as a finite integer greater than or equal to 0, falling back to the default otherwise, and a fractional value SHALL be floored. The `/pruner` settings overlay SHALL expose the key with cycling presets including `1`, `2`, `4` (default), `8`, and `0` labelled as unbounded.

#### Scenario: Default when unset

- **WHEN** `contextPrune` omits `summarizerConcurrency`
- **THEN** the effective width is 4

#### Scenario: Invalid value falls back

- **WHEN** `summarizerConcurrency` is negative, non-numeric, or not finite
- **THEN** the effective width is the default and no error is raised

#### Scenario: Fractional value is floored

- **WHEN** `summarizerConcurrency` is `2.7`
- **THEN** the effective width is 2

#### Scenario: Overlay round-trips the setting

- **WHEN** the user cycles the concurrency row in the `/pruner` settings overlay
- **THEN** the selected value is persisted to settings and applied to the next flush
