## Why

Background subagent delivery can be permanently retried with `Extension runtime not initialized. Action methods cannot be called during extension loading.` When a parent validates an agent with selected skills, the skill resolver creates a standalone Pi resource loader that loads the configured Herdr extension for discovery; the extension factory publishes that loader's unbound `ExtensionAPI` into process-global delivery state, replacing the live session API. Foreground completion still works because it returns through the suspended tool call, while async completion loses its delivery path.

The previous delivery-observability change fixed failures after a send was accepted, but this defect prevents `sendMessage` from being accepted at all. The resource-loading and API-ownership boundaries must be hardened now so selected skills, package discovery, and reload cannot poison background delivery.

## What Changes

- Add a resource-resolution mode for selected-skill validation that loads skills without executing configured extensions or allowing discovery-only loaders to mutate session runtime state.
- Make the process-global completion API represent only a session-bound, active extension runtime; extension factory evaluation alone must never publish a delivery API.
- Rebind/adopt the active API at `session_start` and make delivery/retry behavior safe during the reload interval when no active session API is available.
- Keep async completion, caller-ping, and run-ID-keyed launch/resume-error notifications pending and recoverable while the parent runtime is unavailable (bounded by a deferral budget and shown as `awaiting runtime` in the widget), rather than repeatedly calling an uninitialized API; keep status/recovery notifications best-effort (dropped while inactive, never blocking completion).
- Preserve the existing foreground/background queue, delivery barrier, deduplication, wake ordering, and exactly-once semantics.
- Add unit and integration coverage for selected-skill resolution, discovery-only extension loading, session activation/reload, and one-result background delivery.
- Correct integration harness coverage so it exercises the current `packages/pi-subagent-herdr/src/index.ts` extension and a production-like configured-package loading path where needed.

## Capabilities

### New Capabilities

- `extension-runtime-safety`: Isolation of resource discovery from live extension runtime ownership, lifecycle-based API activation, and safe behavior while no session-bound API is available.

### Modified Capabilities

- `completion-delivery`: Background delivery and retry must use only an active session-bound API and must remain recoverable across runtime unavailability and reload.

## Impact

- **Code:** `packages/pi-subagent-herdr/src/index.ts`, `packages/pi-subagent-herdr/src/skills.ts`, and supporting runtime/resource-loading helpers; selected integration harness paths under `packages/pi-subagent-herdr/test/integration/`.
- **Tests:** API ownership/reload tests, selected-skill resolution tests, delivery retry tests, and a real parent/child async completion regression.
- **Runtime:** No public model-facing tool schema change. Selected-skill validation remains pre-admission and permission-compatible. Background delivery may wait for a bound session runtime instead of invoking a discovery-time API.
- **Compatibility:** The fix is scoped to extension lifecycle and resource discovery. Existing subagent definitions, skill selection semantics, foreground/background admission, and delivery envelope remain unchanged.
