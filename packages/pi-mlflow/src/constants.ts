/**
 * One shared "how long we wait on this optional server" figure for the whole
 * extension.
 *
 * Two call sites import it, so the two cannot drift:
 *
 * - the setup path (`src/experiment.ts`'s `fetchWithTimeout`, previously a
 *   local `DEFAULT_TIMEOUT_MS = 5_000`), which bounds the experiment
 *   resolve-or-create requests so a blackholed tracking server cannot stall
 *   `session_start` for tens of seconds before silent-disable;
 * - the settle/shutdown flush wait (`src/lifecycle.ts`'s
 *   `flushTracesBestEffort`), which bounds how long `agent_settled` /
 *   `session_shutdown` handling waits on `mlflow.flushTraces()`.
 *
 * Longer than a healthy local `mlflow server` round-trip, short enough to keep
 * pi's session critical paths snappy: `mlflow-tracing`'s own client default is
 * 30 s (`MLFLOW_HTTP_REQUEST_TIMEOUT`, read per request), which is far too
 * long for an optional observability add-on on a session critical path.
 *
 * This gets its own module rather than living in `src/state.ts` (a state-shape
 * module that owns no constants) or `src/lifecycle.ts` (whose import graph
 * pulls in the OTel API and git helpers the status surface does not need).
 */
export const SERVER_WAIT_GRACE_MS = 5_000;
