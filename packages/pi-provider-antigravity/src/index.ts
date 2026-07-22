import type { Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { ANTIGRAVITY_DAILY_ENDPOINT } from "./antigravity-protocol.ts";
import { filterAvailableAntigravityModels } from "./catalog-validation.ts";
import { streamSimpleGoogleGeminiCli } from "./cloud-code-assist.ts";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity-oauth.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";

const GOOGLE_GEMINI_CLI_API = "google-gemini-cli" satisfies Model<string>["api"];

interface GoogleOAuthCredentials extends OAuthCredentials {
	projectId?: string;
	antigravityAvailableModelIds?: unknown;
}

type GoogleLoginFn = (
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
) => Promise<OAuthCredentials>;

type GoogleRefreshFn = (refreshToken: string, projectId: string) => Promise<OAuthCredentials>;

function makeGoogleOAuthConfig(
	name: string,
	login: GoogleLoginFn,
	refresh: GoogleRefreshFn,
): NonNullable<ProviderConfig["oauth"]> {
	return {
		name,
		login: (callbacks) => login(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput),
		refreshToken: (credentials) => {
			const creds = credentials as GoogleOAuthCredentials;
			if (!creds.projectId) {
				throw new Error(`Missing projectId in ${name} credentials`);
			}
			return refresh(creds.refresh, creds.projectId);
		},
		getApiKey: (credentials) => {
			const creds = credentials as GoogleOAuthCredentials;
			if (!creds.projectId) {
				throw new Error(`Missing projectId in ${name} credentials`);
			}
			return JSON.stringify({ token: creds.access, projectId: creds.projectId });
		},
		modifyModels: (models, credentials) => {
			const availableModelIds = (credentials as GoogleOAuthCredentials).antigravityAvailableModelIds;
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				return models;
			}
			return filterAvailableAntigravityModels(models, new Set(availableModelIds));
		},
	};
}

function streamSimpleForGoogleCli(
	model: Model<string>,
	context: Parameters<typeof streamSimpleGoogleGeminiCli>[1],
	options: Parameters<typeof streamSimpleGoogleGeminiCli>[2],
) {
	if (model.api !== GOOGLE_GEMINI_CLI_API) {
		throw new Error(`Expected model api to be ${GOOGLE_GEMINI_CLI_API}, got ${model.api}`);
	}
	return streamSimpleGoogleGeminiCli(model as Model<"google-gemini-cli">, context, options);
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("google-antigravity", {
		name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
		baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
		api: GOOGLE_GEMINI_CLI_API,
		streamSimple: streamSimpleForGoogleCli,
		oauth: makeGoogleOAuthConfig(
			"Antigravity (Gemini 3, Claude, GPT-OSS)",
			loginAntigravity,
			refreshAntigravityToken,
		),
		models: ANTIGRAVITY_MODELS,
	});
}
