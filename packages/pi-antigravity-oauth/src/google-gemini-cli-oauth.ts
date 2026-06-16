/**
 * Gemini CLI OAuth (Google Cloud Code Assist). Standard Gemini models only
 * (gemini-2.0-flash, gemini-2.5-*).
 *
 * The shared PKCE/callback/token-exchange flow lives in
 * `./google-oauth-utils.ts`. This file holds the Gemini-CLI-specific bits:
 * the OAuth client credentials, the project-discovery flow (loadCodeAssist +
 * onboardUser + pollOperation), and the token refresh request shape.
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { type GoogleOAuthLoginConfig, loginWithGoogleOAuth, withAbortTimeout } from "./google-oauth-utils.ts";
import { GEMINI_CLI_CLIENT_ID, GEMINI_CLI_CLIENT_SECRET } from "./vendor/credentials.ts";

const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const CALLBACK_ORIGIN = `http://localhost:${CALLBACK_PORT}`;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/** Long-running operation response from onboardUser. */
interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

// Tier IDs as used by the Cloud Code API
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

interface GoogleRpcErrorResponse {
	error?: {
		details?: Array<{ reason?: string }>;
	};
}

/** Wait helper for onboarding retries. */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Get the default tier from the allowed-tier list (or legacy fallback). */
function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } {
	if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY };
	const defaultTier = allowedTiers.find((t) => t.isDefault);
	return defaultTier ?? { id: TIER_LEGACY };
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	if (!("error" in payload)) return false;
	const error = (payload as GoogleRpcErrorResponse).error;
	if (!error?.details || !Array.isArray(error.details)) return false;
	return error.details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

/** Poll a long-running operation until completion. */
async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	onProgress?: (message: string) => void,
	maxAttempts: number = 6,
	intervalMs: number = 5000,
): Promise<LongRunningOperationResponse> {
	let attempt = 0;
	while (true) {
		if (attempt >= maxAttempts) {
			throw new Error(`Operation polling exceeded ${maxAttempts} attempts`);
		}
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1})...`);
			await wait(intervalMs);
		}

		const response = await withAbortTimeout(
			(signal) =>
				fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
					method: "GET",
					headers,
					signal,
				}),
			10_000,
		);

		if (!response.ok) {
			throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as LongRunningOperationResponse;
		if (data.done) {
			return data;
		}

		attempt += 1;
	}
}

/** Discover or provision a Google Cloud project for the user. */
export async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await withAbortTimeout(
		(signal) =>
			fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					cloudaicompanionProject: envProjectId,
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
						duetProject: envProjectId,
					},
				}),
				signal,
			}),
		10_000,
	);

	let data: LoadCodeAssistPayload;
	if (!loadResponse.ok) {
		let errorPayload: unknown;
		try {
			errorPayload = await loadResponse.clone().json();
		} catch {
			errorPayload = undefined;
		}

		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			const errorText = await loadResponse.text();
			throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	}

	if (data.currentTier) {
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}
		if (envProjectId) {
			return envProjectId;
		}
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	const tier = getDefaultTier(data.allowedTiers);
	const tierId = tier?.id ?? TIER_FREE;

	if (tierId !== TIER_FREE && !envProjectId) {
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

	const onboardBody: Record<string, unknown> = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};

	const onboardResponse = await withAbortTimeout(
		(signal) =>
			fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
				method: "POST",
				headers,
				body: JSON.stringify(onboardBody),
				signal,
			}),
		10_000,
	);

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
	}

	let lroData = (await onboardResponse.json()) as LongRunningOperationResponse;
	if (!lroData.done && lroData.name) {
		lroData = await pollOperation(lroData.name, headers, onProgress);
	}

	const projectId = lroData.response?.cloudaicompanionProject?.id;
	if (projectId) {
		return projectId;
	}
	if (envProjectId) {
		return envProjectId;
	}

	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
}

const LOGIN_CONFIG: GoogleOAuthLoginConfig = {
	name: "Google Cloud Code Assist (Gemini CLI)",
	clientId: GEMINI_CLI_CLIENT_ID,
	clientSecret: GEMINI_CLI_CLIENT_SECRET,
	redirectUri: REDIRECT_URI,
	callbackPort: CALLBACK_PORT,
	callbackPath: CALLBACK_PATH,
	callbackOrigin: CALLBACK_ORIGIN,
	scopes: SCOPES,
	discoverProject,
};

export async function loginGeminiCli(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
): Promise<OAuthCredentials> {
	return loginWithGoogleOAuth(LOGIN_CONFIG, onAuth, onProgress, onManualCodeInput);
}

/** Refresh Google Cloud Code Assist token. */
export async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: GEMINI_CLI_CLIENT_ID,
			client_secret: GEMINI_CLI_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Google Cloud token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}
