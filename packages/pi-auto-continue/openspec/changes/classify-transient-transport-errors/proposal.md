# Change: classify-transient-transport-errors

## Why

Long-running gpot sessions stalled on transient provider/gateway errors
(`Error: upstream chain exhausted`, `Request timed out.`, `terminated`,
bare `502`/`524` upstream relay statuses, `under maintenance`, `No healthy …
route`, `unable to verify api key` — 503s) that the classifier mapped to
`NONE`, so pi-auto-continue never fired and every stall waited on a manual
`.`, even though the user's rate-limit policy (`rateLimit.maxRetries: "90m"`,
`baseDelayMs: "70s"`) was configured to out-wait them.

## What Changes

- `src/constants.ts`: new `TRANSIENT_ERROR_PATTERNS` list (fork addition),
  consulted only for `stopReason: "error"` turns; plus a widened
  `/(?:account|access|subscription|api.?key).{0,40}terminat/` guard in
  `BILLING_HARD_LIMIT_PATTERNS` so terminal "account terminated" texts still
  stop the loop.
- `src/classifier.ts`: classify matched transient errors as `RATE_LIMIT`
  (shared hint extraction), checked after the billing guard, inside the
  `stopReason === "error"` branch — abort/cancel texts can never match.
- `tests/classifier.test.ts`: new `transient transport & gateway failures`
  suite (~45-error corpus) with abort-safety, fatalFirst, and
  permanent-error negative cases.
- `README.md`: fork-notes + features + classifier precedence documentation.

## Capability

### Added
- `transient-error-retry`: transient transport/gateway errors
  reported as `stopReason: "error"` classify as `RATE_LIMIT` and retry under
  the rate-limit policy, guarded against billing-fatal, policy-refusal,
  and aborted texts.
