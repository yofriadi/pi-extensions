/**
 * Structural metadata (always captured) vs. content (captured by default, opt-out via `captureContent`).
 *
 * Per D6/trace-metadata spec: structural, numeric/small data (token usage, cost,
 * git info, compaction stats, attempt/turn indices, HTTP status/retry counts)
 * is always recorded. Full content (prompt text, tool argument/output bodies,
 * provider request/response payload bodies) is gated behind `captureContent`.
 */

export const TRACE_METADATA_KEYS = {
	SESSION: "mlflow.trace.session",
	GIT_COMMIT: "mlflow.source.git.commit",
	GIT_BRANCH: "mlflow.source.git.branch",
	GIT_REPO_URL: "mlflow.source.git.repoURL",
} as const;

/** MLflow's documented span attribute key for chat token usage. */
export const TOKEN_USAGE_ATTRIBUTE_KEY = "mlflow.chat.tokenUsage";

/**
 * Candidate MLflow-native key for manually-set LLM cost (per MLflow's
 * "Manually Setting Token and Cost Information" docs). Verified against the
 * installed `mlflow-tracing`/MLflow docs at design time (D7) — MLflow accepts
 * arbitrary attributes regardless, so using this key is safe even if a given
 * server version doesn't render it in a built-in cost widget.
 */
export const COST_ATTRIBUTE_KEY = "mlflow.llm.cost";
/** Only include a value when `captureContent` is enabled; otherwise omit the field entirely. */
export function gateContent<T>(captureContent: boolean, value: T): T | undefined {
	return captureContent ? value : undefined;
}
