## MODIFIED Requirements

### Requirement: Shared rate-limit gate per fan-out
`summarizeBatches` SHALL create one rate-limit gate per fan-out and share it with every call in that fan-out. Before each attempt a call SHALL wait for the gate to open; on a rate-limit-shaped failure the call SHALL extend the gate by its computed delay. The gate SHALL only ever extend, never shorten, its open time, and its wait SHALL end early when the flush signal aborts. The gate SHALL NOT persist across fan-outs. Because `/pruner now` now routes through `summarizeBatches` (see the `manual-flush-parallelism` capability), a manual flush runs inside a fan-out and uses that fan-out's gate; only range summarization (`summarizeRange`) and any other single-call paths outside `summarizeBatches` SHALL work without a gate, relying on in-place retry alone.

#### Scenario: One quota hit paces the whole pool

- **WHEN** one call in a fan-out fails rate-limit-shaped
- **THEN** the other calls in that fan-out wait for the gate before their next attempt instead of retrying immediately

#### Scenario: Manual flush uses the fan-out gate

- **WHEN** `/pruner now` summarizes multiple non-trivial batches and one is rate-limited
- **THEN** the whole manual fan-out waits out the shared gate window before retrying, exactly like an automatic flush

#### Scenario: Gate does not leak into a later flush

- **WHEN** a fan-out ends while its gate is still closed and a new flush starts
- **THEN** the new fan-out begins with an open gate

#### Scenario: Abort releases a gate wait

- **WHEN** the flush signal aborts while a call waits on the gate
- **THEN** the wait ends and the call propagates the abort instead of starting another attempt
