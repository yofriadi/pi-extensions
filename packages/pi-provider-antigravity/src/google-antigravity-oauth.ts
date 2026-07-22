/**
 * Antigravity OAuth (Gemini 3, Claude, GPT-OSS via Google Cloud). Uses
 * dedicated OAuth credentials for access to the Antigravity model catalog.
 *
 * Auth flow:
 * 1. Browser-based OAuth against the Google client embedded in Antigravity
 * 2. Discover an existing Cloud Code Assist project via loadCodeAssist
 * 3. Fall back to the shared default project if discovery returns nothing
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { type GoogleOAuthLoginConfig, loginWithGoogleOAuth } from "./google-oauth-utils.ts";
import { discoverAntigravityModels } from "./model-discovery.ts";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "./vendor/credentials.ts";

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const CALLBACK_ORIGIN = `http://localhost:${CALLBACK_PORT}`;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
}

function readProjectId(value: string | { id?: string } | undefined): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) {
		return value.id;
	}
	return undefined;
}

/** Discover an existing project for the user. */
export async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};

	onProgress?.("Checking for existing project...");
	for (const endpoint of [PROD_ENDPOINT, SANDBOX_ENDPOINT]) {
		try {
			const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
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
			});
			if (!response.ok) continue;
			const data = (await response.json()) as LoadCodeAssistPayload;
			const projectId = readProjectId(data.cloudaicompanionProject);
			if (projectId) return projectId;
		} catch {
			// Try next endpoint.
		}
	}

	if (envProjectId) {
		onProgress?.("Using GOOGLE_CLOUD_PROJECT...");
		return envProjectId;
	}

	onProgress?.("Using default project...");
	return DEFAULT_PROJECT_ID;
}

const LOGIN_CONFIG: GoogleOAuthLoginConfig = {
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	clientId: ANTIGRAVITY_CLIENT_ID,
	clientSecret: ANTIGRAVITY_CLIENT_SECRET,
	redirectUri: REDIRECT_URI,
	callbackPort: CALLBACK_PORT,
	callbackPath: CALLBACK_PATH,
	callbackOrigin: CALLBACK_ORIGIN,
	scopes: SCOPES,
	discoverProject,
};

async function withAvailableModels(
	credentials: OAuthCredentials,
	onProgress?: (message: string) => void,
): Promise<OAuthCredentials> {
	try {
		onProgress?.("Discovering available models...");
		const catalog = await discoverAntigravityModels({
			accessToken: credentials.access,
			signal: AbortSignal.timeout(30_000),
		});
		return {
			...credentials,
			antigravityAvailableModelIds: catalog.models.filter((model) => !model.internal).map((model) => model.id),
		};
	} catch {
		onProgress?.("Model discovery unavailable; using the static catalog.");
		return credentials;
	}
}

export async function loginAntigravity(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
): Promise<OAuthCredentials> {
	const credentials = await loginWithGoogleOAuth(LOGIN_CONFIG, onAuth, onProgress, onManualCodeInput);
	return withAvailableModels(credentials, onProgress);
}

export async function refreshAntigravityAccessToken(
	refreshToken: string,
	projectId: string,
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Antigravity token refresh failed: ${error}`);
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

/** Refresh Antigravity credentials and cache the current public backend catalog. */
export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	return withAvailableModels(await refreshAntigravityAccessToken(refreshToken, projectId));
}
