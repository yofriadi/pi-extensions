/**
 * Experiment resolve-or-create against the MLflow REST API.
 *
 * Mirrors the endpoints `mlflow-tracing`'s own `MlflowClient` uses
 * (`experiments/get-by-name`, `experiments/create`) via plain `fetch`,
 * since the SDK's `MlflowClient` does not expose a get-by-name helper.
 *
 * Auth headers come from the same `MLFLOW_TRACKING_*` env contract the
 * SDK uses after `mlflow.init()` (see `src/auth.ts`), so an auth-protected
 * tracking server does not silently disable setup while still being able
 * to export once initialized.
 */

import { resolveTrackingRequestHeaders } from "./auth.ts";

interface GetByNameResponse {
	experiment?: { experiment_id?: string };
}

interface CreateExperimentResponse {
	experiment_id?: string;
}

interface ErrorResponse {
	error_code?: string;
	message?: string;
}

/**
 * Bound setup-path fetches tightly so a blackholed tracking server cannot
 * stall `session_start` for tens of seconds before silent-disable. Longer
 * than a healthy local `mlflow server` round-trip, short enough to keep pi
 * startup snappy. (mlflow-tracing's own client default is 30s — too long for
 * an optional observability add-on on the session-start critical path.)
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Resolve `experimentName` to a numeric experiment ID, creating the experiment
 * if it does not already exist. Throws on any request/parse failure or on a
 * malformed response — callers fold that into the silent-disable path.
 *
 * Concurrent pi processes (or a TOCTOU race between get-by-name and create)
 * can make create return RESOURCE_ALREADY_EXISTS even after a miss. In that
 * case we re-fetch by name so resolve-or-create still succeeds instead of
 * silently disabling tracing for a healthy tracking server.
 */
export async function resolveOrCreateExperiment(trackingUri: string, experimentName: string): Promise<string> {
	const existingId = await getExperimentIdByName(trackingUri, experimentName);
	if (existingId !== undefined) {
		return existingId;
	}
	return await createExperiment(trackingUri, experimentName);
}

/** Join a base tracking URI and an API path without producing a double slash if the base has a trailing one. */
function apiUrl(trackingUri: string, path: string): string {
	return `${trackingUri.replace(/\/+$/, "")}${path}`;
}

async function getExperimentIdByName(trackingUri: string, experimentName: string): Promise<string | undefined> {
	const url = new URL(apiUrl(trackingUri, "/api/2.0/mlflow/experiments/get-by-name"));
	url.searchParams.set("experiment_name", experimentName);

	const response = await fetchWithTimeout(url, {
		method: "GET",
		headers: resolveTrackingRequestHeaders(),
	});
	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		const body = await readErrorBody(response);
		if (body?.error_code === "RESOURCE_DOES_NOT_EXIST") {
			return undefined;
		}
		throw new Error(`GET experiments/get-by-name failed: HTTP ${response.status}${formatErrorCode(body)}`);
	}

	const payload = (await response.json()) as GetByNameResponse;
	const experimentId = payload.experiment?.experiment_id;
	if (!experimentId) {
		throw new Error("experiments/get-by-name response missing experiment.experiment_id");
	}
	return experimentId;
}

async function createExperiment(trackingUri: string, experimentName: string): Promise<string> {
	const url = apiUrl(trackingUri, "/api/2.0/mlflow/experiments/create");
	const response = await fetchWithTimeout(url, {
		method: "POST",
		headers: resolveTrackingRequestHeaders(),
		body: JSON.stringify({ name: experimentName }),
	});

	if (!response.ok) {
		const body = await readErrorBody(response);
		// Another process won the create race, or our earlier get-by-name was a
		// TOCTOU miss. Re-resolve by name so we still attach to the live experiment
		// instead of treating a healthy server as unreachable (D9 silent-disable).
		if (isAlreadyExistsError(response.status, body)) {
			const racedId = await getExperimentIdByName(trackingUri, experimentName);
			if (racedId !== undefined) {
				return racedId;
			}
		}
		throw new Error(`POST experiments/create failed: HTTP ${response.status}${formatErrorCode(body)}`);
	}

	const payload = (await response.json()) as CreateExperimentResponse;
	if (!payload.experiment_id) {
		throw new Error("experiments/create response missing experiment_id");
	}
	return payload.experiment_id;
}

/**
 * True when create failed because the experiment name already exists.
 * Prefer the documented `RESOURCE_ALREADY_EXISTS` code; some backends have
 * historically returned other 4xx codes for the same conflict, so also accept
 * a generic client-error create failure only when the body explicitly says
 * the resource already exists.
 */
function isAlreadyExistsError(status: number, body: ErrorResponse | undefined): boolean {
	if (body?.error_code === "RESOURCE_ALREADY_EXISTS") {
		return true;
	}
	// Defensive: a few MLflow backends have returned BAD_REQUEST / 400 for
	// duplicate names instead of RESOURCE_ALREADY_EXISTS. Only treat those as
	// already-exists when the free-form message clearly indicates a name clash
	// — otherwise a real 400 would incorrectly re-fetch and still fail.
	if (status === 400 && typeof body?.message === "string") {
		const msg = body.message.toLowerCase();
		return msg.includes("already exists") || msg.includes("already exist");
	}
	return false;
}

/**
 * `fetch` with a bounded timeout so a blackholed/hanging tracking-server
 * connection can't stall `session_start` indefinitely — it instead surfaces
 * as a normal setup failure and flows through the silent-disable path (D9).
 */
async function fetchWithTimeout(url: string | URL, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request to ${url.toString()} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function readErrorBody(response: Response): Promise<ErrorResponse | undefined> {
	try {
		return (await response.json()) as ErrorResponse;
	} catch {
		return undefined;
	}
}

/**
 * Include only a sanitized structured `error_code` from a tracking-server
 * error body in thrown messages — never free-form `message` or HTTP
 * `statusText`, both of which are server-controlled text that would otherwise
 * flow into the local `console.warn` / `/mlflow` disabled reason on
 * silent-disable (and could be arbitrarily long, multi-line, or crafted).
 */
function formatErrorCode(body: ErrorResponse | undefined): string {
	if (body?.error_code === undefined || body.error_code === null) return "";
	// Allowlist: short uppercase identifier shape only. Reject anything else
	// rather than truncating free-form text into the log.
	const raw = String(body.error_code);
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)) return "";
	return ` (error_code=${raw})`;
}
