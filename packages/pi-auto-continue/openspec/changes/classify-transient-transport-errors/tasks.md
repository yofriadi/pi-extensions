# Tasks

## 1. Classifier patterns

- [x] Add `TRANSIENT_ERROR_PATTERNS` to `src/constants.ts` covering:
  timeouts, terminations, connection/socket failures, stream relay
  failures, upstream relay errors, provider relay statuses, maintenance,
  routing capacity, gateway verification, inference caps, bare status
  texts, HTML gateway pages, concurrency caps, Node/undici transport
  codes (`ECONNRESET`, `fetch failed`, `socket hang up`, `premature close`).
- [x] Widen the termination guard in `BILLING_HARD_LIMIT_PATTERNS` to
  `/(?:account|access|subscription|api.?key).{0,40}terminat/i` and mark it
  as a fork addition.
- [x] Move policy/safety rejection detection into
  `PERMANENT_REQUEST_ERROR_PATTERNS`, before all HTTP/rate-limit/transport
  retry paths. The former rejection-only negative lookahead allowed gateway
  wrappers or retryable statuses to override refusals (adversarial review).

## 2. Classifier logic

- [x] Classify matched transient errors as `RATE_LIMIT` with shared hint
  extraction (`retryAfterMs`, `expectedResetTime`, `isWindowEstimate`,
  `retryAfterHeaderReceived`), gated on `stopReason === "error"` and checked
  after the billing guard.
- [x] Confirm fatalFirst ordering: 401/403, quota-exhaustion-without-reset,
  and context-overflow all outrank the transient branch.

## 3. Tests

- [x] New `transient transport & gateway failures` suite: positive corpus,
  abort/cancel safety (including transient text under `stopReason:
  "aborted"`), fatalFirst retryable case, termination-text negatives,
  policy-refusal negatives, permanent entitlement/configuration negatives.
- [x] Regression matrix for policy/safety/prohibited/illegal rejections with
  upstream wrappers, timeouts, rate-limit text, retryable HTTP statuses,
  reset headers, both `fatalFirst` modes, and multiline/case variants.
  Confirm generic rejections and unavailable policy/safety services remain
  retryable. Reproduced failure before the fix; classifier suite now passes.
- [x] Package `pnpm test`: 201/201 pass; `pnpm run typecheck` and
  `git diff --check` pass after review remediations.
- [ ] Root `pnpm test`: attempted; blocked by unrelated
  `pi-provider-perchai` reporting no test files.
- [ ] Root `pnpm run check`: attempted; blocked by existing lint/format
  diagnostics under `packages/archived`.

## 4. Docs

- [x] README: Key Features, Fork notes (§3 Transient transport & gateway
  failures), classifier precedence.
- [x] OpenSpec scenario: gateway wrappers, statuses, and reset hints cannot
  override policy/safety refusals.

## 5. Process (post-merge)

- [ ] Port this diff to `yofriadi/pi-auto-continue` and re-sync the vendored
  copy (`pnpm run update:pi-auto-continue`) so the changes survive the next
  sync from fork commit `0ff0216`.
