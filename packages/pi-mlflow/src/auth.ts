/**
 * MLflow tracking-server auth helpers.
 *
 * Mirrors the OSS resolution order used by `mlflow-tracing`'s own
 * `createAuthProvider` (see `mlflow-tracing/dist/auth`):
 *   1. Basic Auth via `MLFLOW_TRACKING_USERNAME` + `MLFLOW_TRACKING_PASSWORD`
 *   2. Bearer token via `MLFLOW_TRACKING_TOKEN`
 *   3. No authentication
 *
 * Experiment resolve-or-create runs *before* `mlflow.init()`, so we cannot
 * call the SDK's post-init `getAuthProvider()`. These helpers keep the setup
 * REST path and the SDK exporter on the same credential contract.
 */

/** Headers for MLflow REST calls (experiment resolve/create, etc.). */
export function resolveTrackingRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const auth = resolveAuthorizationHeader();
	if (auth) {
		headers.Authorization = auth;
	}
	return headers;
}

/**
 * Resolve the `Authorization` value the same way the SDK does for OSS hosts.
 * Returns `undefined` when no env credentials are configured.
 */
export function resolveAuthorizationHeader(): string | undefined {
	const username = process.env.MLFLOW_TRACKING_USERNAME;
	const password = process.env.MLFLOW_TRACKING_PASSWORD;
	const token = process.env.MLFLOW_TRACKING_TOKEN;

	if (username && password) {
		return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	}
	if (token) {
		return `Bearer ${token}`;
	}
	return undefined;
}

/**
 * Redact userinfo credentials from a tracking URI for status/log surfaces.
 * `https://user:token@host:5000` → `https://host:5000/` (WHATWG normalization).
 * Non-URL strings are returned unchanged.
 */
export function redactTrackingUri(uri: string): string {
	if (!uri) {
		return uri;
	}
	try {
		const parsed = new URL(uri);
		if (!parsed.username && !parsed.password) {
			return uri;
		}
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return uri;
	}
}
