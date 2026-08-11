import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Resolved, validated pi-mlflow configuration. */
export interface PiMlflowConfig {
	trackingUri: string;
	experimentName: string;
	captureContent: boolean;
}

export const DEFAULT_TRACKING_URI = "http://localhost:5055";
export const FALLBACK_EXPERIMENT_NAME = "pi";
export const DEFAULT_CAPTURE_CONTENT = true;

const CONFIG_FILE_NAME = "pi-mlflow.json";

/**
 * File permission policy (task 2.6 / design open question): unlike
 * `pi-langfuse.json` (which holds API keys and is written by the extension
 * itself with 0600 perms), `pi-mlflow.json` holds no secrets — just a local
 * tracking URL, an experiment name, and a boolean. Authentication is
 * environment-variable only; `trackingUri` userinfo is rejected at validation
 * so credentials cannot leak via request/timeout errors. The extension never
 * writes this file (the user authors it manually), so there is no write path
 * to apply a restrictive mode to. Decision: no permission enforcement on
 * read or write.
 */

const KNOWN_CONFIG_KEYS = ["trackingUri", "experimentName", "captureContent"] as const;

/**
 * Resolve the config file path. Project-local `pi-mlflow.json` (relative to `cwd`)
 * takes precedence when present; otherwise falls back to `~/.pi/agent/pi-mlflow.json`
 * style lookup is intentionally not implemented — configuration is read from the
 * project's working directory only, keeping the setup surface small and predictable.
 */
export function getConfigPath(cwd: string): string {
	return join(cwd, CONFIG_FILE_NAME);
}

/**
 * Experiment name used when the config file does not specify one: the
 * basename of the resolved working directory, so each project gets its own
 * experiment. Falls back to `FALLBACK_EXPERIMENT_NAME` when the basename is
 * empty (filesystem root). An explicit `experimentName` in the config file
 * always wins; an explicit empty string remains a validation error
 * (absent ≠ empty).
 */
export function defaultExperimentName(cwd: string): string {
	return basename(resolve(cwd)) || FALLBACK_EXPERIMENT_NAME;
}

/**
 * Load and validate `pi-mlflow.json` from `cwd`. Missing file yields defaults
 * (no tracing config is a fully valid, zero-touch state). Malformed file
 * (invalid JSON, wrong field types, or unknown field names) throws so the
 * caller can fold that into the same silent-disable path as a connection
 * failure. Unknown keys are rejected rather than silently ignored so a typo
 * like `trakcingUri` surfaces instead of falling back to the default.
 */
export async function loadConfig(cwd: string): Promise<PiMlflowConfig> {
	const path = getConfigPath(cwd);
	let raw: unknown = {};

	try {
		const contents = await readFile(path, "utf8");
		raw = JSON.parse(contents) as unknown;
	} catch (error: unknown) {
		if (isNodeErrnoException(error) && error.code === "ENOENT") {
			raw = {};
		} else {
			throw new Error(`Failed to read/parse ${path}: ${(error as Error).message}`);
		}
	}

	return validateConfig(raw, path, defaultExperimentName(cwd));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(raw: unknown, path: string, defaultExperimentName: string): PiMlflowConfig {
	if (!isPlainObject(raw)) {
		throw new Error(`${path}: config root must be a JSON object`);
	}

	const unknownKeys = Object.keys(raw).filter((key) => !(KNOWN_CONFIG_KEYS as readonly string[]).includes(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`${path}: unknown config field(s): ${unknownKeys.join(", ")} (allowed: ${KNOWN_CONFIG_KEYS.join(", ")})`,
		);
	}

	const trackingUri = raw.trackingUri === undefined ? DEFAULT_TRACKING_URI : raw.trackingUri;
	if (typeof trackingUri !== "string" || trackingUri.length === 0) {
		throw new Error(`${path}: "trackingUri" must be a non-empty string`);
	}

	let parsedTrackingUri: URL;
	try {
		parsedTrackingUri = new URL(trackingUri);
	} catch {
		throw new Error(`${path}: "trackingUri" must be a valid absolute HTTP(S) URL`);
	}
	if (parsedTrackingUri.protocol !== "http:" && parsedTrackingUri.protocol !== "https:") {
		throw new Error(`${path}: "trackingUri" must use the http or https scheme`);
	}
	if (!parsedTrackingUri.host) {
		throw new Error(`${path}: "trackingUri" must include a host`);
	}
	if (parsedTrackingUri.username || parsedTrackingUri.password) {
		throw new Error(
			`${path}: "trackingUri" must not contain credentials; use MLFLOW_TRACKING_USERNAME/MLFLOW_TRACKING_PASSWORD or MLFLOW_TRACKING_TOKEN`,
		);
	}

	const experimentName = raw.experimentName === undefined ? defaultExperimentName : raw.experimentName;
	if (typeof experimentName !== "string" || experimentName.length === 0) {
		throw new Error(`${path}: "experimentName" must be a non-empty string`);
	}

	const captureContent = raw.captureContent === undefined ? DEFAULT_CAPTURE_CONTENT : raw.captureContent;
	if (typeof captureContent !== "boolean") {
		throw new Error(`${path}: "captureContent" must be a boolean`);
	}

	return { trackingUri, experimentName, captureContent };
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}
